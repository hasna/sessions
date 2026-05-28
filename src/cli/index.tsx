#!/usr/bin/env bun

/**
 * sessions CLI — Universal AI coding session search and management.
 *
 * This is the main entry point. It wraps the existing @hasna/sessions CLI
 * and adds new commands: relocate, transfer export, transfer import.
 */

import { Command } from "commander";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline/promises";
import { relocate } from "../lib/relocate.js";
import {
  exportSessions,
  importSessions,
  formatBytes,
} from "../lib/transfer.js";
import {
  getClaudeProjectsDir,
  decodePath,
  encodePath,
  findMatchingProjectDirs,
  resolveProjectPath,
} from "../lib/paths.js";
import { getPackageVersion } from "../lib/package.js";
import {
  buildClaudeResumeCommand,
  findSession,
  formatSessionTable,
  historySessions,
  latestSession,
  latestSessionForProject,
  listSessions,
  renameSession,
  searchSessions,
} from "../lib/sessions.js";

const program = new Command();

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function pickSessionFromList() {
  const sessions = listSessions().slice(0, 20);
  if (sessions.length === 0) {
    throw new Error("No sessions available to pick from");
  }

  console.log("Select a session to resume:\n");
  sessions.forEach((session, index) => {
    console.log(
      `  ${index + 1}. ${session.friendlyName}  ${session.projectSlug}  ${session.status}  ${session.sessionId.slice(0, 12)}`
    );
  });

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question("\nSession number: ");
    const parsed = Number.parseInt(answer, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > sessions.length) {
      throw new Error("Invalid selection");
    }
    return sessions[parsed - 1];
  } finally {
    rl.close();
  }
}

program
  .name("sessions")
  .version(getPackageVersion())
  .description("Universal AI coding session search and management");

// ─── relocate ──────────────────────────────────────────────────────────────

program
  .command("relocate <old-path> <new-path>")
  .description(
    "Relocate sessions after moving a project directory to a new path"
  )
  .option("-n, --dry-run", "Show what would change without modifying anything")
  .option("--no-db", "Skip updating the sessions SQLite database")
  .option("--json", "Output result as JSON")
  .option("-v, --verbose", "Print detailed progress")
  .action((oldPath: string, newPath: string, opts: any) => {
    // Resolve ~ to home directory
    if (oldPath.startsWith("~")) oldPath = join(homedir(), oldPath.slice(1));
    if (newPath.startsWith("~")) newPath = join(homedir(), newPath.slice(1));

    const result = relocate(oldPath, newPath, {
      dryRun: opts.dryRun,
      updateDb: opts.db !== false,
      verbose: opts.json ? false : opts.verbose,
    });

    if (opts.json) {
      printJson({
        oldPath,
        newPath,
        dryRun: Boolean(opts.dryRun),
        updateDb: opts.db !== false,
        ...result,
      });
      if (result.errors.length > 0) {
        process.exit(1);
      }
      return;
    }

    console.log(`Relocating sessions: ${oldPath} → ${newPath}`);
    if (opts.dryRun) console.log("(dry run — no changes will be made)\n");

    // Summary
    console.log("\nRelocate Summary:");
    console.log(`  Directories renamed: ${result.dirsRenamed.length}`);
    for (const { from, to } of result.dirsRenamed) {
      console.log(`    ${from} → ${to}`);
    }
    console.log(`  Index files updated: ${result.indexFilesUpdated}`);
    console.log(`  JSONL files updated: ${result.jsonlFilesUpdated}`);
    console.log(`  DB rows updated:     ${result.dbRowsUpdated}`);

    if (result.errors.length > 0) {
      console.log(`\n  Errors (${result.errors.length}):`);
      for (const { file, error } of result.errors) {
        console.log(`    ${file}: ${error}`);
      }
      process.exit(1);
    }

    if (!opts.dryRun && result.dirsRenamed.length > 0) {
      console.log("\nDone. Sessions are now accessible from the new path.");
    }
  });

// ─── transfer ──────────────────────────────────────────────────────────────

const transfer = program
  .command("transfer")
  .description("Transfer sessions between computers");

transfer
  .command("export")
  .description("Export raw session files to a portable directory")
  .option(
    "-p, --project <path>",
    "Only export sessions for this project path"
  )
  .option("-o, --output <dir>", "Output directory (default: current directory)")
  .option("--name <name>", "Custom export directory name")
  .option("-n, --dry-run", "Show what would be exported without writing")
  .option("--json", "Output result as JSON")
  .option("-v, --verbose", "Print detailed progress")
  .action((opts: any) => {
    let projectPath = opts.project;
    if (projectPath?.startsWith("~"))
      projectPath = join(homedir(), projectPath.slice(1));

    const result = exportSessions({
      projectPath,
      outputDir: opts.output,
      outputName: opts.name,
      verbose: opts.json ? false : opts.verbose,
      dryRun: opts.dryRun,
    });

    if (opts.json) {
      printJson({
        projectPath: projectPath ?? null,
        dryRun: Boolean(opts.dryRun),
        ...result,
      });
      if (result.errors.length > 0) {
        process.exit(1);
      }
      return;
    }

    console.log("Exporting sessions...");
    if (opts.dryRun) console.log("(dry run — no files will be written)\n");

    const m = result.manifest;
    console.log("\nExport Summary:");
    console.log(`  Projects:    ${m.projects.length}`);
    console.log(`  Total files: ${m.totalFiles}`);
    console.log(`  Total size:  ${formatBytes(m.totalSize)}`);
    console.log(`  Output:      ${result.archivePath}`);

    if (m.projects.length > 0 && opts.verbose) {
      console.log("\n  Projects:");
      for (const p of m.projects) {
        console.log(
          `    ${p.originalPath} (${p.sessionCount} sessions, ${p.jsonlCount} .jsonl files)`
        );
      }
    }

    if (result.errors.length > 0) {
      console.log(`\n  Errors (${result.errors.length}):`);
      for (const { file, error } of result.errors) {
        console.log(`    ${file}: ${error}`);
      }
    }

    if (!opts.dryRun && m.totalFiles > 0) {
      console.log(
        "\nTo transfer to another computer:"
      );
      console.log(`  1. Copy ${result.archivePath}/ to the target machine`);
      console.log(`  2. Run: sessions transfer import ${result.archivePath}/`);
      console.log(
        "     (paths will be auto-remapped if the username differs)"
      );
    }
  });

transfer
  .command("import <path>")
  .description("Import sessions from an export directory")
  .option(
    "--remap-home <path>",
    "Remap the source home directory to this path"
  )
  .option(
    "--remap <from:to>",
    "Remap arbitrary path prefix (e.g., /Users/old:/Users/new)"
  )
  .option("--reingest", "Re-ingest imported sessions into the sessions DB")
  .option("--overwrite", "Overwrite existing session files")
  .option("-n, --dry-run", "Show what would be imported without writing")
  .option("--json", "Output result as JSON")
  .option("-v, --verbose", "Print detailed progress")
  .action((importPath: string, opts: any) => {
    let remapPath: { from: string; to: string } | undefined;
    if (opts.remap) {
      const parts = opts.remap.split(":");
      if (parts.length !== 2) {
        console.error(
          "Error: --remap must be in format 'from:to' (e.g., /Users/old:/Users/new)"
        );
        process.exit(1);
      }
      remapPath = { from: parts[0], to: parts[1] };
    }

    let remapHome = opts.remapHome;
    if (remapHome?.startsWith("~"))
      remapHome = join(homedir(), remapHome.slice(1));

    const result = importSessions(importPath, {
      remapHome,
      remapPath,
      reingest: opts.reingest,
      verbose: opts.json ? false : opts.verbose,
      dryRun: opts.dryRun,
      overwrite: opts.overwrite,
    });

    if (opts.json) {
      printJson({
        importPath,
        remapHome: remapHome ?? null,
        remapPath: remapPath ?? null,
        dryRun: Boolean(opts.dryRun),
        reingest: Boolean(opts.reingest),
        overwrite: Boolean(opts.overwrite),
        ...result,
      });
      if (result.errors.length > 0) {
        process.exit(1);
      }
      return;
    }

    console.log(`Importing sessions from: ${importPath}`);
    if (opts.dryRun) console.log("(dry run — no files will be written)\n");

    console.log("\nImport Summary:");
    console.log(`  Projects imported: ${result.projectsImported}`);
    console.log(`  Files imported:    ${result.filesImported}`);
    console.log(`  Files skipped:     ${result.filesSkipped}`);
    console.log(`  Paths remapped:    ${result.pathsRemapped}`);

    if (result.errors.length > 0) {
      console.log(`\n  Errors (${result.errors.length}):`);
      for (const { file, error } of result.errors) {
        console.log(`    ${file}: ${error}`);
      }
    }

    if (!opts.dryRun && result.filesImported > 0) {
      console.log("\nDone. Sessions imported successfully.");
      if (!opts.reingest) {
        console.log(
          "Run 'sessions ingest --force' to index imported sessions in the search DB."
        );
      }
    }
  });

// ─── migrate ───────────────────────────────────────────────────────────────

program
  .command("migrate <source-project> <target-project>")
  .description(
    "Move sessions from one project to another (e.g., merge after repo rename)"
  )
  .option("-n, --dry-run", "Show what would change without modifying anything")
  .option("-v, --verbose", "Print detailed progress")
  .action((sourcePath: string, targetPath: string, opts: any) => {
    if (sourcePath.startsWith("~"))
      sourcePath = join(homedir(), sourcePath.slice(1));
    if (targetPath.startsWith("~"))
      targetPath = join(homedir(), targetPath.slice(1));

    const projectsDir = getClaudeProjectsDir();
    const sourceEncoded = encodePath(sourcePath);
    const targetEncoded = encodePath(targetPath);
    const sourceDir = join(projectsDir, sourceEncoded);
    const targetDir = join(projectsDir, targetEncoded);

    if (!existsSync(sourceDir)) {
      console.error(`Source project not found: ${sourceDir}`);
      console.error(
        `\nUse 'sessions paths' to see available project directories.`
      );
      process.exit(1);
    }

    console.log(`Migrating sessions: ${sourcePath} → ${targetPath}`);
    if (opts.dryRun) console.log("(dry run — no changes will be made)\n");

    // Count source sessions
    const sourceFiles = readdirSync(sourceDir);
    const sourceJsonl = sourceFiles.filter((f) => f.endsWith(".jsonl"));
    const sourceDirs = sourceFiles.filter((f) => {
      try {
        return statSync(join(sourceDir, f)).isDirectory() && f !== "subagents";
      } catch {
        return false;
      }
    });

    console.log(`  Source sessions: ${sourceJsonl.length} .jsonl files`);
    console.log(`  Source session dirs: ${sourceDirs.length}`);

    if (!opts.dryRun) {
      // Ensure target directory exists
      mkdirSync(targetDir, { recursive: true });

      let moved = 0;
      let errors = 0;

      // Move .jsonl files
      for (const file of sourceJsonl) {
        const src = join(sourceDir, file);
        const dest = join(targetDir, file);

        if (existsSync(dest)) {
          if (opts.verbose) console.log(`  Skipping (exists): ${file}`);
          continue;
        }

        try {
          // Read, update cwd, write to new location
          const content = readFileSync(src, "utf-8");
          const lines = content.split("\n").map((line) => {
            if (!line.trim()) return line;
            try {
              const obj = JSON.parse(line);
              if (obj.cwd && obj.cwd.startsWith(sourcePath)) {
                obj.cwd = targetPath + obj.cwd.slice(sourcePath.length);
                return JSON.stringify(obj);
              }
            } catch {
              // Not JSON
            }
            return line;
          });
          writeFileSync(dest, lines.join("\n"), "utf-8");
          unlinkSync(src);
          moved++;
          if (opts.verbose) console.log(`  Moved: ${file}`);
        } catch (err: any) {
          console.error(`  Error moving ${file}: ${err.message}`);
          errors++;
        }
      }

      // Move session UUID directories
      for (const dir of sourceDirs) {
        const src = join(sourceDir, dir);
        const dest = join(targetDir, dir);

        if (existsSync(dest)) {
          if (opts.verbose) console.log(`  Skipping dir (exists): ${dir}`);
          continue;
        }

        try {
          renameSync(src, dest);
          moved++;
          if (opts.verbose) console.log(`  Moved dir: ${dir}`);
        } catch (err: any) {
          console.error(`  Error moving dir ${dir}: ${err.message}`);
          errors++;
        }
      }

      // Move sessions-index.json (merge if target has one)
      const srcIndex = join(sourceDir, "sessions-index.json");
      const destIndex = join(targetDir, "sessions-index.json");
      if (existsSync(srcIndex)) {
        try {
          const srcData = JSON.parse(readFileSync(srcIndex, "utf-8"));

          // Update paths in entries
          if (srcData.entries) {
            for (const entry of srcData.entries) {
              if (entry.projectPath?.startsWith(sourcePath)) {
                entry.projectPath =
                  targetPath + entry.projectPath.slice(sourcePath.length);
              }
              if (entry.fullPath) {
                entry.fullPath = entry.fullPath.replace(
                  sourceEncoded,
                  targetEncoded
                );
              }
            }
          }

          if (existsSync(destIndex)) {
            // Merge with existing target index
            const destData = JSON.parse(readFileSync(destIndex, "utf-8"));
            const existingIds = new Set(
              (destData.entries || []).map((e: any) => e.sessionId)
            );
            const newEntries = (srcData.entries || []).filter(
              (e: any) => !existingIds.has(e.sessionId)
            );
            destData.entries = [...(destData.entries || []), ...newEntries];
            writeFileSync(destIndex, JSON.stringify(destData, null, 4), "utf-8");
            if (opts.verbose)
              console.log(
                `  Merged ${newEntries.length} entries into target index`
              );
          } else {
            writeFileSync(destIndex, JSON.stringify(srcData, null, 4), "utf-8");
            if (opts.verbose) console.log(`  Moved sessions-index.json`);
          }
          unlinkSync(srcIndex);
        } catch (err: any) {
          console.error(`  Error merging index: ${err.message}`);
          errors++;
        }
      }

      // Try to remove source directory if empty
      try {
        const remaining = readdirSync(sourceDir);
        if (remaining.length === 0 || (remaining.length === 1 && remaining[0] === "memory")) {
          // Leave memory dir alone, but log that it's there
          if (remaining.length === 1) {
            console.log(`  Note: source still has 'memory/' dir (not moved)`);
          } else {
            rmdirSync(sourceDir);
            console.log(`  Removed empty source directory`);
          }
        }
      } catch {
        // Source dir not empty, that's fine
      }

      console.log(`\nMigrate Summary:`);
      console.log(`  Files moved:  ${moved}`);
      console.log(`  Errors:       ${errors}`);
    } else {
      console.log(
        `\nWould move ${sourceJsonl.length} .jsonl files and ${sourceDirs.length} session directories`
      );
    }
  });

// ─── list-projects (helper to see what's available) ────────────────────────

program
  .command("list")
  .description("List known sessions with friendly names")
  .option("-p, --project <value>", "Filter by project slug or path")
  .option("--json", "Output as JSON")
  .action((opts: any) => {
    const sessions = listSessions({ project: opts.project });
    if (opts.json) {
      printJson(sessions);
      return;
    }

    console.log(formatSessionTable(sessions));
  });

program
  .command("rename <id-or-name> <friendly-name>")
  .description("Assign a manual friendly name to a session")
  .option("--json", "Output as JSON")
  .action((identifier: string, friendlyName: string, opts: any) => {
    try {
      const session = renameSession(identifier, friendlyName);
      if (opts.json) {
        printJson(session);
        return;
      }

      console.log(
        `Renamed ${session.sessionId} -> ${session.friendlyName}`
      );
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command("resume [id-or-name]")
  .description("Resume a session by friendly name, session ID, or latest project session")
  .option("-p, --project <value>", "Resume the most recent session for a project")
  .option("--last", "Resume the most recently active session")
  .option("--pick", "Interactively pick a session from the most recent results")
  .option("--print-command", "Print the underlying resume command without executing it")
  .option("--json", "Output the selected session as JSON")
  .action(async (identifier: string | undefined, opts: any) => {
    try {
      let session = null;

      if (opts.pick) {
        session = await pickSessionFromList();
      } else if (opts.project) {
        session = latestSessionForProject(opts.project);
      } else if (opts.last || !identifier) {
        session = latestSession();
      } else {
        session = findSession(identifier);
      }

      if (!session) {
        throw new Error("No matching session found");
      }

      const command = buildClaudeResumeCommand(session);
      if (opts.json) {
        printJson({
          session,
          command,
        });
        return;
      }

      if (opts.printCommand) {
        console.log(command.join(" "));
        return;
      }

      const proc = Bun.spawn({
        cmd: command,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = await proc.exited;
      process.exit(exitCode);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command("history")
  .description("Show known sessions with history filters")
  .option("-p, --project <value>", "Filter by project slug or path")
  .option("--today", "Only include sessions active today")
  .option("--agent <value>", "Filter by provider, agent name, or custom title")
  .option("--json", "Output as JSON")
  .action((opts: any) => {
    const sessions = historySessions({
      project: opts.project,
      today: Boolean(opts.today),
      agent: opts.agent,
    });

    if (opts.json) {
      printJson(sessions);
      return;
    }

    console.log(formatSessionTable(sessions));
  });

program
  .command("search <query>")
  .description("Search session transcripts by text")
  .option("-p, --project <value>", "Filter by project slug or path")
  .option("--limit <count>", "Maximum matches to return", "20")
  .option("--json", "Output as JSON")
  .action((query: string, opts: any) => {
    const limit = Number.parseInt(opts.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) {
      console.error("Error: --limit must be a positive integer");
      process.exit(1);
    }

    const matches = searchSessions(query, {
      project: opts.project,
      limit,
    });

    if (opts.json) {
      printJson(matches);
      return;
    }

    if (matches.length === 0) {
      console.log("No matching sessions found.");
      return;
    }

    for (const match of matches) {
      console.log(`${match.session.friendlyName}  ${match.session.projectSlug}`);
      console.log(`  ${match.snippet}`);
    }
  });

program
  .command("watch")
  .description("Watch session activity in a live-updating table")
  .option("-p, --project <value>", "Filter by project slug or path")
  .option("--interval <seconds>", "Refresh interval in seconds", "5")
  .option("--json", "Output one JSON snapshot and exit")
  .option("--once", "Render a single snapshot and exit")
  .action((opts: any) => {
    const intervalSeconds = Number.parseInt(opts.interval, 10);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      console.error("Error: --interval must be a positive integer");
      process.exit(1);
    }

    const render = () => {
      const sessions = listSessions({ project: opts.project });
      if (opts.json) {
        printJson(sessions);
        return;
      }

      console.clear();
      console.log(
        `sessions watch (${new Date().toISOString()})\n`
      );
      console.log(formatSessionTable(sessions));
    };

    render();
    if (opts.json || opts.once) {
      return;
    }

    const timer = setInterval(render, intervalSeconds * 1000);
    process.on("SIGINT", () => {
      clearInterval(timer);
      process.exit(0);
    });
  });

program
  .command("paths")
  .description("List all project paths with session counts")
  .option("--json", "Output as JSON")
  .action((opts: any) => {
    const projectsDir = getClaudeProjectsDir();

    if (!existsSync(projectsDir)) {
      console.error("Claude projects directory not found:", projectsDir);
      process.exit(1);
    }

    const dirs = readdirSync(projectsDir);
    const projects: Array<{
      path: string;
      encodedDir: string;
      sessions: number;
      exists: boolean;
    }> = [];

    for (const dir of dirs) {
      const dirPath = join(projectsDir, dir);
      try {
        if (!statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const resolvedPath = resolveProjectPath(projectsDir, dir);
      const files = readdirSync(dirPath);
      const sessionCount = files.filter((f) => f.endsWith(".jsonl")).length;
      const pathExists = existsSync(resolvedPath);

      projects.push({
        path: resolvedPath,
        encodedDir: dir,
        sessions: sessionCount,
        exists: pathExists,
      });
    }

    // Sort by session count descending
    projects.sort((a, b) => b.sessions - a.sessions);

    if (opts.json) {
      console.log(JSON.stringify(projects, null, 2));
    } else {
      console.log("Claude Code Session Paths\n");
      const maxPath = Math.max(60, ...projects.map((p) => p.path.length));

      for (const p of projects) {
        const marker = p.exists ? " " : "!";
        const countStr = String(p.sessions).padStart(4);
        console.log(
          `${marker} ${p.path.padEnd(maxPath)} ${countStr} sessions`
        );
      }

      const orphaned = projects.filter((p) => !p.exists);
      if (orphaned.length > 0) {
        console.log(
          `\n! = path no longer exists (${orphaned.length} orphaned, use 'sessions relocate' to fix)`
        );
      }
      console.log(`\nTotal: ${projects.length} projects, ${projects.reduce((s, p) => s + p.sessions, 0)} sessions`);
    }
  });

program.parse();
