/**
 * Relocate Claude Code sessions from one filesystem path to another.
 *
 * When a project directory is moved (e.g., from /Users/hasna/Workspace/old
 * to /Users/hasna/Workspace/new), Claude Code can no longer find the sessions
 * because they're stored under path-encoded directory names.
 *
 * This module handles:
 * 1. Renaming the project directory in ~/.claude/projects/
 * 2. Updating sessions-index.json (projectPath, fullPath)
 * 3. Updating cwd fields in .jsonl session files
 * 4. Updating the sessions DB (project_path, source_path)
 */

import { existsSync, readdirSync, renameSync, readFileSync, writeFileSync, statSync } from "fs";
import { join, basename } from "path";
import { SqliteAdapter as Database } from "@hasna/cloud";
import {
  encodePath,
  findMatchingProjectDirs,
  computeRelocatedDir,
  getClaudeProjectsDir,
  getCodexSessionsDir,
  getSessionsDbPath,
} from "./paths.js";

/**
 * Rewrite a `cwd` value that starts with oldPath to point at newPath.
 * Returns the new value, or null if it doesn't match.
 */
function remapCwd(cwd: unknown, oldPath: string, newPath: string): string | null {
  if (typeof cwd !== "string") return null;
  if (cwd === oldPath) return newPath;
  if (cwd.startsWith(oldPath + "/")) return newPath + cwd.slice(oldPath.length);
  return null;
}

/**
 * Relocate Codex sessions. Unlike Claude, Codex stores rollout JSONL files under
 * date folders (~/.codex/sessions/YYYY/MM/DD/) — not path-encoded dirs — and the
 * project path lives in `cwd` fields, both top-level and nested under `payload`
 * (session_meta, turn_context). So there is no directory to rename; we walk every
 * rollout file and rewrite matching `cwd` fields in place.
 */
function relocateCodexSessions(
  oldPath: string,
  newPath: string,
  options: { dryRun?: boolean; verbose?: boolean }
): { filesUpdated: number; errors: Array<{ file: string; error: string }> } {
  const { dryRun = false, verbose = false } = options;
  const out = { filesUpdated: 0, errors: [] as Array<{ file: string; error: string }> };
  const root = getCodexSessionsDir();
  if (!existsSync(root)) return out;

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err: any) {
      out.errors.push({ file: dir, error: err.message });
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".jsonl")) continue;

      let content: string;
      try {
        content = readFileSync(full, "utf-8");
      } catch (err: any) {
        out.errors.push({ file: full, error: err.message });
        continue;
      }
      // Cheap pre-check: skip files that don't reference the old path at all.
      if (!content.includes(oldPath)) continue;

      let modified = false;
      const lines = content.split("\n").map((line) => {
        if (!line.trim()) return line;
        try {
          const obj = JSON.parse(line);
          // top-level cwd
          const top = remapCwd(obj.cwd, oldPath, newPath);
          if (top !== null) {
            obj.cwd = top;
            modified = true;
          }
          // nested payload.cwd (session_meta, turn_context)
          if (obj.payload && typeof obj.payload === "object") {
            const nested = remapCwd(obj.payload.cwd, oldPath, newPath);
            if (nested !== null) {
              obj.payload.cwd = nested;
              modified = true;
            }
          }
          return modified ? JSON.stringify(obj) : line;
        } catch {
          return line;
        }
      });

      if (modified) {
        if (verbose) console.log(`  Updating codex jsonl: ${full}`);
        if (!dryRun) {
          try {
            writeFileSync(full, lines.join("\n"), "utf-8");
          } catch (err: any) {
            out.errors.push({ file: full, error: err.message });
            continue;
          }
        }
        out.filesUpdated++;
      }
    }
  };

  walk(root);
  return out;
}

export interface RelocateOptions {
  /** Only show what would change without modifying anything. */
  dryRun?: boolean;
  /** Also update the sessions SQLite database. */
  updateDb?: boolean;
  /** Print detailed progress. */
  verbose?: boolean;
}

export interface RelocateResult {
  dirsRenamed: Array<{ from: string; to: string }>;
  indexFilesUpdated: number;
  jsonlFilesUpdated: number;
  codexFilesUpdated: number;
  dbRowsUpdated: number;
  errors: Array<{ file: string; error: string }>;
}

export function relocate(
  oldPath: string,
  newPath: string,
  options: RelocateOptions = {}
): RelocateResult {
  const { dryRun = false, updateDb = true, verbose = false } = options;
  const projectsDir = getClaudeProjectsDir();

  const result: RelocateResult = {
    dirsRenamed: [],
    indexFilesUpdated: 0,
    jsonlFilesUpdated: 0,
    codexFilesUpdated: 0,
    dbRowsUpdated: 0,
    errors: [],
  };

  // Normalize paths (remove trailing slash)
  oldPath = oldPath.replace(/\/+$/, "");
  newPath = newPath.replace(/\/+$/, "");

  // Relocate Codex sessions regardless of whether Claude has any (a project may
  // have been used in only one of the two tools).
  const codex = relocateCodexSessions(oldPath, newPath, { dryRun, verbose });
  result.codexFilesUpdated = codex.filesUpdated;
  result.errors.push(...codex.errors);

  if (!existsSync(projectsDir)) {
    // No Claude projects dir — Codex-only relocation may still have done work.
    if (codex.filesUpdated === 0) {
      result.errors.push({ file: projectsDir, error: "Claude projects directory not found" });
    }
    return result;
  }

  // Find all matching project directories
  const allDirs = readdirSync(projectsDir);
  const matchingDirs = findMatchingProjectDirs(allDirs, oldPath);

  if (matchingDirs.length === 0) {
    // No Claude project dirs — that's fine if Codex sessions were relocated.
    if (codex.filesUpdated === 0) {
      result.errors.push({
        file: oldPath,
        error: `No session directories found for path: ${oldPath}`,
      });
    }
    // Still update the DB below (covers Codex rows), then return.
    if (updateDb) updateSessionsDb(oldPath, newPath, result, verbose);
    return result;
  }

  if (verbose) {
    console.log(`Found ${matchingDirs.length} project directories to relocate`);
  }

  // Phase 1: Update .jsonl files and sessions-index.json INSIDE each directory
  for (const dir of matchingDirs) {
    const dirPath = join(projectsDir, dir);
    const newDir = computeRelocatedDir(dir, oldPath, newPath);
    const newDirPath = join(projectsDir, newDir);

    // Update sessions-index.json
    const indexPath = join(dirPath, "sessions-index.json");
    if (existsSync(indexPath)) {
      try {
        const indexData = JSON.parse(readFileSync(indexPath, "utf-8"));
        let changed = false;

        if (indexData.entries) {
          for (const entry of indexData.entries) {
            // Update projectPath
            if (entry.projectPath && entry.projectPath.startsWith(oldPath)) {
              entry.projectPath = newPath + entry.projectPath.slice(oldPath.length);
              changed = true;
            }
            // Update fullPath (references the project dir name)
            if (entry.fullPath) {
              const oldDirInPath = join(projectsDir, dir);
              const newDirInPath = join(projectsDir, newDir);
              if (entry.fullPath.startsWith(oldDirInPath)) {
                entry.fullPath = newDirInPath + entry.fullPath.slice(oldDirInPath.length);
                changed = true;
              }
            }
          }
        }

        if (changed) {
          if (verbose) console.log(`  Updating index: ${indexPath}`);
          if (!dryRun) {
            writeFileSync(indexPath, JSON.stringify(indexData, null, 4), "utf-8");
          }
          result.indexFilesUpdated++;
        }
      } catch (err: any) {
        result.errors.push({ file: indexPath, error: err.message });
      }
    }

    // Update .jsonl files (cwd field in each line)
    try {
      const files = readdirSync(dirPath);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;

        const filePath = join(dirPath, file);
        try {
          const content = readFileSync(filePath, "utf-8");
          let modified = false;
          const lines = content.split("\n").map((line) => {
            if (!line.trim()) return line;
            try {
              const obj = JSON.parse(line);
              if (obj.cwd && typeof obj.cwd === "string" && obj.cwd.startsWith(oldPath)) {
                obj.cwd = newPath + obj.cwd.slice(oldPath.length);
                modified = true;
                return JSON.stringify(obj);
              }
            } catch {
              // Not valid JSON, leave as-is
            }
            return line;
          });

          if (modified) {
            if (verbose) console.log(`  Updating jsonl: ${filePath}`);
            if (!dryRun) {
              writeFileSync(filePath, lines.join("\n"), "utf-8");
            }
            result.jsonlFilesUpdated++;
          }
        } catch (err: any) {
          result.errors.push({ file: filePath, error: err.message });
        }
      }

      // Also check subdirectories (session UUID folders may contain subagent .jsonl)
      for (const file of files) {
        const subPath = join(dirPath, file);
        try {
          const stat = Bun.file(subPath);
          // Check if it's a directory by trying to readdir
          const subFiles = readdirSync(subPath);
          for (const subFile of subFiles) {
            if (!subFile.endsWith(".jsonl")) continue;
            const subFilePath = join(subPath, subFile);
            try {
              const content = readFileSync(subFilePath, "utf-8");
              let modified = false;
              const lines = content.split("\n").map((line) => {
                if (!line.trim()) return line;
                try {
                  const obj = JSON.parse(line);
                  if (obj.cwd && typeof obj.cwd === "string" && obj.cwd.startsWith(oldPath)) {
                    obj.cwd = newPath + obj.cwd.slice(oldPath.length);
                    modified = true;
                    return JSON.stringify(obj);
                  }
                } catch {
                  // Not valid JSON
                }
                return line;
              });

              if (modified) {
                if (verbose) console.log(`  Updating subagent jsonl: ${subFilePath}`);
                if (!dryRun) {
                  writeFileSync(subFilePath, lines.join("\n"), "utf-8");
                }
                result.jsonlFilesUpdated++;
              }
            } catch (err: any) {
              result.errors.push({ file: subFilePath, error: err.message });
            }
          }
        } catch {
          // Not a directory, skip
        }
      }
    } catch (err: any) {
      result.errors.push({ file: dirPath, error: err.message });
    }

    // Phase 2: Rename the directory itself
    if (dir !== newDir) {
      if (existsSync(newDirPath)) {
        result.errors.push({
          file: newDirPath,
          error: `Target directory already exists: ${newDir}`,
        });
        continue;
      }
      if (verbose) console.log(`  Renaming dir: ${dir} → ${newDir}`);
      if (!dryRun) {
        renameSync(dirPath, newDirPath);
      }
      result.dirsRenamed.push({ from: dir, to: newDir });
    }
  }

  // Phase 3: Update sessions DB
  if (updateDb) updateSessionsDb(oldPath, newPath, result, verbose);

  return result;
}

/** Update project_path / source_path / ingestion_state in the sessions DB. */
function updateSessionsDb(
  oldPath: string,
  newPath: string,
  result: RelocateResult,
  verbose: boolean
): void {
  const dbPath = getSessionsDbPath();
  if (!existsSync(dbPath)) return;
  try {
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");

    // Update project_path in sessions table
    const sessionUpdate = db.prepare(
      "UPDATE sessions SET project_path = ? || substr(project_path, ?) WHERE project_path LIKE ? || '%'"
    );
    const sessionResult = sessionUpdate.run(newPath, oldPath.length + 1, oldPath);

    // Update source_path in sessions table
    const sourceUpdate = db.prepare(
      "UPDATE sessions SET source_path = replace(source_path, ?, ?) WHERE source_path LIKE ? || '%'"
    );
    sourceUpdate.run(oldPath, newPath, oldPath);

    // Update ingestion_state file_path (Claude encodes the path into the file path)
    const stateUpdate = db.prepare(
      "UPDATE ingestion_state SET file_path = replace(file_path, ?, ?) WHERE file_path LIKE ? || '%'"
    );
    stateUpdate.run(encodePath(oldPath), encodePath(newPath), encodePath(oldPath));

    result.dbRowsUpdated += (sessionResult as any).changes || 0;

    db.close();
    if (verbose) console.log(`  Updated ${result.dbRowsUpdated} DB rows`);
  } catch (err: any) {
    result.errors.push({ file: dbPath, error: err.message });
  }
}
