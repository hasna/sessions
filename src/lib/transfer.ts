/**
 * Transfer Claude Code sessions between computers.
 *
 * Export: Packs raw session files (.jsonl + sessions-index.json + subagent dirs)
 *         into a portable tar.gz archive with relative paths and a manifest.
 *
 * Import: Unpacks the archive, re-resolves paths for the local machine,
 *         and optionally triggers re-ingestion into the sessions DB.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  copyFileSync,
} from "fs";
import { join } from "path";
import { homedir, hostname, userInfo } from "os";
import {
  encodePath,
  findMatchingProjectDirs,
  getClaudeProjectsDir,
  getSessionsDbPath,
  resolveProjectPath,
} from "./paths.js";

export interface TransferManifest {
  version: number;
  createdAt: string;
  sourceComputer: string;
  sourceUser: string;
  sourceClaudePath: string;
  projects: TransferProject[];
  totalFiles: number;
  totalSize: number;
}

export interface TransferProject {
  /** Original filesystem path (e.g., /Users/hasna/Workspace/foo) */
  originalPath: string;
  /** Encoded directory name (e.g., -Users-hasna-Workspace-foo) */
  encodedDir: string;
  /** Number of session files in this project */
  sessionCount: number;
  /** Number of .jsonl files */
  jsonlCount: number;
}

export interface ExportOptions {
  /** Only export sessions for this project path (default: all) */
  projectPath?: string;
  /** Output directory for the export (default: cwd) */
  outputDir?: string;
  /** Custom archive name (default: sessions-export-YYYY-MM-DD.tar.gz) */
  outputName?: string;
  /** Print detailed progress */
  verbose?: boolean;
  /** Dry run - show what would be exported */
  dryRun?: boolean;
}

export interface ExportResult {
  archivePath: string;
  manifest: TransferManifest;
  errors: Array<{ file: string; error: string }>;
}

export interface ImportOptions {
  /** Remap the home directory (e.g., /Users/hasna → /Users/john) */
  remapHome?: string;
  /** Remap arbitrary path prefix (e.g., /old/path → /new/path) */
  remapPath?: { from: string; to: string };
  /** Also re-ingest imported sessions into the DB */
  reingest?: boolean;
  /** Print detailed progress */
  verbose?: boolean;
  /** Dry run - show what would be imported */
  dryRun?: boolean;
  /** Overwrite existing sessions */
  overwrite?: boolean;
}

export interface ImportResult {
  projectsImported: number;
  filesImported: number;
  filesSkipped: number;
  pathsRemapped: number;
  errors: Array<{ file: string; error: string }>;
}

/**
 * Export sessions to a staging directory that can be tar'd.
 * Returns the path to the staging directory and manifest.
 */
export function exportSessions(options: ExportOptions = {}): ExportResult {
  const { projectPath, verbose = false, dryRun = false } = options;
  const projectsDir = getClaudeProjectsDir();
  const outputDir = options.outputDir || process.cwd();
  const datestamp = new Date().toISOString().slice(0, 10);
  const exportName = options.outputName || `sessions-export-${datestamp}`;
  const stagingDir = join(outputDir, exportName);

  const result: ExportResult = {
    archivePath: stagingDir,
    manifest: {
      version: 1,
      createdAt: new Date().toISOString(),
      sourceComputer: hostname(),
      sourceUser: userInfo().username,
      sourceClaudePath: getClaudeProjectsDir(),
      projects: [],
      totalFiles: 0,
      totalSize: 0,
    },
    errors: [],
  };

  if (!existsSync(projectsDir)) {
    result.errors.push({ file: projectsDir, error: "Claude projects directory not found" });
    return result;
  }

  // Find project directories to export
  const allDirs = readdirSync(projectsDir);
  let targetDirs: string[];

  if (projectPath) {
    targetDirs = findMatchingProjectDirs(allDirs, projectPath);
    if (targetDirs.length === 0) {
      result.errors.push({
        file: projectPath,
        error: `No session directories found for path: ${projectPath}`,
      });
      return result;
    }
  } else {
    targetDirs = allDirs;
  }

  if (verbose) console.log(`Exporting ${targetDirs.length} project directories`);

  if (!dryRun) {
    mkdirSync(stagingDir, { recursive: true });
  }

  for (const dir of targetDirs) {
    const srcDir = join(projectsDir, dir);

    // Skip if not a directory
    try {
      if (!statSync(srcDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const project: TransferProject = {
      originalPath: resolveProjectPath(projectsDir, dir),
      encodedDir: dir,
      sessionCount: 0,
      jsonlCount: 0,
    };

    const destDir = join(stagingDir, "projects", dir);

    try {
      const files = readdirSync(srcDir);

      for (const file of files) {
        const srcFile = join(srcDir, file);

        try {
          const stat = statSync(srcFile);

          if (stat.isFile()) {
            // Copy .jsonl and sessions-index.json
            if (file.endsWith(".jsonl") || file === "sessions-index.json") {
              if (!dryRun) {
                mkdirSync(destDir, { recursive: true });
                copyFileSync(srcFile, join(destDir, file));
              }
              result.manifest.totalFiles++;
              result.manifest.totalSize += stat.size;

              if (file.endsWith(".jsonl")) {
                project.jsonlCount++;
                project.sessionCount++;
              }
            }
          } else if (stat.isDirectory()) {
            // Copy session UUID directories (contain subagents, tool-results)
            const subFiles = copyDirRecursive(srcFile, join(destDir, file), dryRun);
            result.manifest.totalFiles += subFiles.count;
            result.manifest.totalSize += subFiles.size;
            project.jsonlCount += subFiles.jsonlCount;
          }
        } catch (err: any) {
          result.errors.push({ file: srcFile, error: err.message });
        }
      }

      result.manifest.projects.push(project);
    } catch (err: any) {
      result.errors.push({ file: srcDir, error: err.message });
    }
  }

  // Write manifest
  if (!dryRun) {
    writeFileSync(
      join(stagingDir, "manifest.json"),
      JSON.stringify(result.manifest, null, 2),
      "utf-8"
    );
  }

  return result;
}

/**
 * Import sessions from an export directory.
 */
export function importSessions(
  importPath: string,
  options: ImportOptions = {}
): ImportResult {
  const {
    remapHome,
    remapPath,
    reingest = false,
    verbose = false,
    dryRun = false,
    overwrite = false,
  } = options;

  const projectsDir = getClaudeProjectsDir();
  const result: ImportResult = {
    projectsImported: 0,
    filesImported: 0,
    filesSkipped: 0,
    pathsRemapped: 0,
    errors: [],
  };

  // Read manifest
  const manifestPath = join(importPath, "manifest.json");
  if (!existsSync(manifestPath)) {
    result.errors.push({ file: manifestPath, error: "manifest.json not found in import directory" });
    return result;
  }

  let manifest: TransferManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch (err: any) {
    result.errors.push({ file: manifestPath, error: `Failed to parse manifest: ${err.message}` });
    return result;
  }

  // Determine path remapping
  let pathFrom: string | null = null;
  let pathTo: string | null = null;

  if (remapPath) {
    pathFrom = remapPath.from;
    pathTo = remapPath.to;
  } else if (remapHome) {
    // Auto-detect source home from manifest
    const sourceHome = `/Users/${manifest.sourceUser}`;
    pathFrom = sourceHome;
    pathTo = remapHome;
  } else {
    // Auto-detect: if source user differs from current user, remap home dirs
    const currentUser = userInfo().username;
    const currentHome = homedir();
    if (manifest.sourceUser !== currentUser) {
      pathFrom = `/Users/${manifest.sourceUser}`;
      pathTo = currentHome;
      if (verbose) {
        console.log(`Auto-remapping: ${pathFrom} → ${pathTo}`);
      }
    }
  }

  const srcProjectsDir = join(importPath, "projects");
  if (!existsSync(srcProjectsDir)) {
    result.errors.push({ file: srcProjectsDir, error: "projects/ directory not found in import" });
    return result;
  }

  const importDirs = readdirSync(srcProjectsDir);

  for (const dir of importDirs) {
    const srcDir = join(srcProjectsDir, dir);

    try {
      if (!statSync(srcDir).isDirectory()) continue;
    } catch {
      continue;
    }

    // Compute target directory name (with optional path remapping)
    let targetDir = dir;
    if (pathFrom && pathTo) {
      const oldEncoded = encodePath(pathFrom);
      const newEncoded = encodePath(pathTo);
      if (targetDir.startsWith(oldEncoded)) {
        targetDir = newEncoded + targetDir.slice(oldEncoded.length);
        result.pathsRemapped++;
      }
    }

    const destDir = join(projectsDir, targetDir);

    if (verbose) {
      if (targetDir !== dir) {
        console.log(`  Importing: ${dir} → ${targetDir}`);
      } else {
        console.log(`  Importing: ${dir}`);
      }
    }

    if (!dryRun) {
      mkdirSync(destDir, { recursive: true });
    }

    try {
      const files = readdirSync(srcDir);

      for (const file of files) {
        const srcFile = join(srcDir, file);
        const destFile = join(destDir, file);

        try {
          const stat = statSync(srcFile);

          if (stat.isFile()) {
            if (existsSync(destFile) && !overwrite) {
              result.filesSkipped++;
              continue;
            }

            if (file.endsWith(".jsonl") && pathFrom && pathTo) {
              // Remap paths inside .jsonl files
              if (!dryRun) {
                const content = readFileSync(srcFile, "utf-8");
                const remapped = remapPathsInContent(content, pathFrom, pathTo);
                writeFileSync(destFile, remapped, "utf-8");
              }
              result.filesImported++;
            } else if (file === "sessions-index.json" && pathFrom && pathTo) {
              // Remap paths in sessions-index.json
              if (!dryRun) {
                const content = readFileSync(srcFile, "utf-8");
                const remapped = remapPathsInJson(content, pathFrom, pathTo, dir, targetDir, projectsDir);
                writeFileSync(destFile, remapped, "utf-8");
              }
              result.filesImported++;
            } else {
              if (!dryRun) {
                copyFileSync(srcFile, destFile);
              }
              result.filesImported++;
            }
          } else if (stat.isDirectory()) {
            // Recursively copy subdirectories (subagents, tool-results)
            const subResult = importDirRecursive(srcFile, join(destDir, file), {
              pathFrom,
              pathTo,
              dryRun,
              overwrite,
            });
            result.filesImported += subResult.imported;
            result.filesSkipped += subResult.skipped;
          }
        } catch (err: any) {
          result.errors.push({ file: srcFile, error: err.message });
        }
      }

      result.projectsImported++;
    } catch (err: any) {
      result.errors.push({ file: srcDir, error: err.message });
    }
  }

  return result;
}

// --- Helpers ---

function copyDirRecursive(
  src: string,
  dest: string,
  dryRun: boolean
): { count: number; size: number; jsonlCount: number } {
  let count = 0;
  let size = 0;
  let jsonlCount = 0;

  try {
    const files = readdirSync(src);

    if (!dryRun) {
      mkdirSync(dest, { recursive: true });
    }

    for (const file of files) {
      const srcFile = join(src, file);
      const destFile = join(dest, file);

      try {
        const stat = statSync(srcFile);

        if (stat.isFile()) {
          if (!dryRun) {
            copyFileSync(srcFile, destFile);
          }
          count++;
          size += stat.size;
          if (file.endsWith(".jsonl")) jsonlCount++;
        } else if (stat.isDirectory()) {
          const sub = copyDirRecursive(srcFile, destFile, dryRun);
          count += sub.count;
          size += sub.size;
          jsonlCount += sub.jsonlCount;
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Skip directories we can't read
  }

  return { count, size, jsonlCount };
}

function importDirRecursive(
  src: string,
  dest: string,
  opts: { pathFrom: string | null; pathTo: string | null; dryRun: boolean; overwrite: boolean }
): { imported: number; skipped: number } {
  let imported = 0;
  let skipped = 0;

  try {
    const files = readdirSync(src);

    if (!opts.dryRun) {
      mkdirSync(dest, { recursive: true });
    }

    for (const file of files) {
      const srcFile = join(src, file);
      const destFile = join(dest, file);

      try {
        const stat = statSync(srcFile);

        if (stat.isFile()) {
          if (existsSync(destFile) && !opts.overwrite) {
            skipped++;
            continue;
          }

          if (file.endsWith(".jsonl") && opts.pathFrom && opts.pathTo) {
            if (!opts.dryRun) {
              const content = readFileSync(srcFile, "utf-8");
              const remapped = remapPathsInContent(content, opts.pathFrom, opts.pathTo);
              writeFileSync(destFile, remapped, "utf-8");
            }
          } else {
            if (!opts.dryRun) {
              copyFileSync(srcFile, destFile);
            }
          }
          imported++;
        } else if (stat.isDirectory()) {
          const sub = importDirRecursive(srcFile, destFile, opts);
          imported += sub.imported;
          skipped += sub.skipped;
        }
      } catch {
        skipped++;
      }
    }
  } catch {
    // Can't read source dir
  }

  return { imported, skipped };
}

/**
 * Replace all occurrences of oldPath with newPath in JSONL content.
 * Handles both the cwd field and path references within tool call content.
 */
function remapPathsInContent(content: string, oldPath: string, newPath: string): string {
  // Simple string replacement works because paths appear as literal strings in JSON
  return content.replaceAll(oldPath, newPath);
}

/**
 * Remap paths in sessions-index.json.
 */
function remapPathsInJson(
  content: string,
  oldPath: string,
  newPath: string,
  oldDir: string,
  newDir: string,
  projectsDir: string
): string {
  try {
    const data = JSON.parse(content);

    if (data.entries) {
      for (const entry of data.entries) {
        if (entry.projectPath && typeof entry.projectPath === "string") {
          entry.projectPath = entry.projectPath.replaceAll(oldPath, newPath);
        }
        if (entry.fullPath && typeof entry.fullPath === "string") {
          // Replace both the path prefix AND the directory encoding
          const oldFullDir = join(projectsDir, oldDir);
          const newFullDir = join(projectsDir, newDir);
          entry.fullPath = entry.fullPath.replace(oldFullDir, newFullDir);
          entry.fullPath = entry.fullPath.replaceAll(oldPath, newPath);
        }
      }
    }

    return JSON.stringify(data, null, 4);
  } catch {
    // If we can't parse JSON, do simple string replacement
    return content.replaceAll(oldPath, newPath);
  }
}

/**
 * Format bytes into human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
