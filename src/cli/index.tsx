#!/usr/bin/env bun

/**
 * sessions CLI — Universal AI coding session search and management.
 *
 * This is the main entry point. It wraps the existing @hasna/sessions CLI
 * and adds new commands: relocate, transfer export, transfer import.
 */

import { Command } from "commander";
import { registerEventsCommands } from "@hasna/events/commander";
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

registerEventsCommands(program, { source: "sessions" });

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
    console.log(`  Claude JSONL updated: ${result.jsonlFilesUpdated}`);
    console.log(`  Codex JSONL updated: ${result.codexFilesUpdated}`);
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

program
  .command("machines")
  .description("List machines that have contributed sessions, with counts")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { listMachines } = await import("../db/machines.js");
    const machines = listMachines();
    if (opts.json) return void console.log(JSON.stringify(machines, null, 2));
    if (machines.length === 0) {
      console.log("No machines recorded yet. Run 'sessions ingest' or 'sessions sync'.");
      return;
    }
    for (const m of machines) {
      console.log(`${m.name.padEnd(10)} ${String(m.session_count).padStart(6)} sessions   ${(m.platform ?? "").padEnd(8)} last seen ${m.last_seen_at}`);
    }
  });

program
  .command("sync")
  .description("Ingest local sessions, then sync to/from the cloud so every machine shares one index")
  .option("--no-ingest", "Skip the local ingest before syncing")
  .option("--no-pull", "Push only — don't pull other machines' sessions")
  .option("--json", "Output as JSON")
  .action(async (opts: { ingest?: boolean; pull?: boolean; json?: boolean }) => {
    const { ingestAll } = await import("../lib/ingest/index.js");
    const { recomputeMachineCounts } = await import("../db/machines.js");

    const runCloud = (args: string[]) =>
      new Promise<{ code: number; output: string }>((resolve) => {
        try {
          const p = Bun.spawn(["cloud", ...args], { stdout: "pipe", stderr: "pipe" });
          (async () => {
            const out = await new Response(p.stdout).text();
            const err = await new Response(p.stderr).text();
            const code = await p.exited;
            resolve({ code, output: (out + err).trim() });
          })();
        } catch (e) {
          resolve({ code: 127, output: `failed to run cloud: ${(e as Error).message}` });
        }
      });

    const result: Record<string, unknown> = {};
    if (opts.ingest !== false) {
      result.ingest = ingestAll();
      if (!opts.json) for (const r of (result.ingest as { source: string; sessions: number }[])) console.log(`ingest ${r.source}: +${r.sessions} sessions`);
    }
    if (!opts.json) console.log("pushing to cloud…");
    result.push = await runCloud(["sync", "push", "--service", "sessions"]);
    if (opts.pull !== false) {
      if (!opts.json) console.log("pulling from cloud…");
      result.pull = await runCloud(["sync", "pull", "--service", "sessions"]);
    }
    recomputeMachineCounts();

    if (opts.json) return void console.log(JSON.stringify(result, null, 2));
    const push = result.push as { code: number };
    console.log(`push: ${push.code === 0 ? "ok" : `FAILED (exit ${push.code})`}`);
    if (result.pull) {
      const pull = result.pull as { code: number };
      console.log(`pull: ${pull.code === 0 ? "ok" : `FAILED (exit ${pull.code})`}`);
    }
    console.log("Done. Run 'sessions machines' to see contributors.");
  });

program
  .command("import-db <path>")
  .description("Merge another machine's sessions database into this one (preserves machine tags) — RDS-free sync")
  .option("--json", "Output as JSON")
  .action(async (path: string, opts: { json?: boolean }) => {
    const { mergeFromDb } = await import("../db/merge.js");
    try {
      const r = mergeFromDb(path);
      if (opts.json) return void console.log(JSON.stringify(r, null, 2));
      console.log(`Merged from ${path}: +${r.sessions} sessions, +${r.messages} messages, +${r.tool_calls} tool calls, +${r.embeddings} embeddings`);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

program
  .command("ingest-watch")
  .description("Continuously index new/changed sessions as they happen (Ctrl-C to stop)")
  .option("--debounce <ms>", "Debounce window after a change before ingesting", "2000")
  .action(async (opts: { debounce?: string }) => {
    const { ingestAll } = await import("../lib/ingest/index.js");
    const { startWatch } = await import("../lib/watch.js");
    console.log("Initial ingest…");
    for (const r of ingestAll()) {
      console.log(`  ${r.source}: ${r.sessions} sessions (${r.ingested} files, ${r.skipped} unchanged)`);
    }
    const watcher = startWatch({
      debounceMs: parseInt(opts.debounce ?? "2000", 10) || 2000,
      onIngest: (r) => {
        if (r.ingested > 0 || r.errors > 0) {
          console.log(`[${new Date().toLocaleTimeString()}] ${r.source}: +${r.sessions} sessions (${r.ingested} files${r.errors ? `, ${r.errors} errors` : ""})`);
        }
      },
      onError: (e) => console.error("watch error:", e.message),
    });
    console.log(`Watching: ${watcher.sources.join(", ") || "(no provider dirs found)"}. Press Ctrl-C to stop.`);
    const shutdown = () => {
      watcher.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise<void>(() => {});
  });

program
  .command("recent")
  .description("Show the most recently active sessions across all providers")
  .option("-m, --machine <name>", "Filter by machine")
  .option("-l, --limit <n>", "Maximum results", "20")
  .option("--json", "Output as JSON")
  .action(async (opts: { machine?: string; limit?: string; json?: boolean }) => {
    const { listSessions } = await import("../db/sessions.js");
    const sessions = listSessions({ machine: opts.machine, limit: parseInt(opts.limit ?? "20", 10) || 20 });
    if (opts.json) return void console.log(JSON.stringify(sessions, null, 2));
    for (const s of sessions) {
      console.log(
        `${(s.started_at ?? "").slice(0, 16).padEnd(16)}  ${(s.machine ?? "?").padEnd(9)} ${s.source.padEnd(7)} ${(s.project_name ?? "").padEnd(18)} ${s.title ?? "(untitled)"}  ${s.id.slice(0, 8)}`
      );
    }
  });

program
  .command("list-indexed")
  .description("List indexed sessions, optionally filtered")
  .option("-s, --source <source>", "Filter by provider")
  .option("-p, --project <path>", "Filter by project path")
  .option("-m, --machine <name>", "Filter by machine")
  .option("-l, --limit <n>", "Maximum results", "50")
  .option("--json", "Output as JSON")
  .action(async (opts: { source?: string; project?: string; machine?: string; limit?: string; json?: boolean }) => {
    const { listSessions } = await import("../db/sessions.js");
    const sessions = listSessions({
      source: opts.source,
      project_path: opts.project,
      machine: opts.machine,
      limit: parseInt(opts.limit ?? "50", 10) || 50,
    });
    if (opts.json) return void console.log(JSON.stringify(sessions, null, 2));
    for (const s of sessions) {
      console.log(`${(s.machine ?? "?").padEnd(9)} ${s.source.padEnd(7)} ${(s.project_name ?? "").padEnd(18)} ${s.title ?? "(untitled)"}  ${s.id.slice(0, 8)}`);
    }
  });

program
  .command("show <id>")
  .description("Show a session's details and message previews (id or unique prefix)")
  .option("-m, --messages <n>", "How many messages to preview", "12")
  .option("--json", "Output as JSON")
  .action(async (id: string, opts: { messages?: string; json?: boolean }) => {
    const { getSessionByPrefix, getMessages, getToolCalls } = await import("../db/sessions.js");
    const s = getSessionByPrefix(id);
    if (!s) {
      console.error(`Session not found (or ambiguous prefix): ${id}`);
      process.exit(1);
    }
    const messages = getMessages(s.id);
    const tools = getToolCalls(s.id);
    if (opts.json) return void console.log(JSON.stringify({ session: s, messages, tools }, null, 2));
    console.log(`${s.title ?? "(untitled)"}`);
    console.log(`  source:   ${s.source}   model: ${s.model ?? "?"}`);
    console.log(`  project:  ${s.project_name ?? "?"} (${s.project_path ?? "?"})`);
    console.log(`  git:      ${s.git_branch ?? "?"}`);
    console.log(`  when:     ${s.started_at ?? "?"} → ${s.ended_at ?? "?"}`);
    console.log(`  counts:   ${s.message_count} messages, ${s.tool_call_count} tool calls, ${s.total_input_tokens + s.total_output_tokens} tokens`);
    console.log(`  id:       ${s.id}`);
    const n = parseInt(opts.messages ?? "12", 10) || 12;
    console.log("");
    for (const m of messages.slice(0, n)) {
      console.log(`  [${m.role}] ${(m.content ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
    }
    if (tools.length) console.log(`\n  tools used: ${[...new Set(tools.map((t) => t.tool_name))].join(", ")}`);
  });

program
  .command("stats")
  .description("Show ingestion and project statistics")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { getIngestionStats } = await import("../db/ingestion.js");
    const { getProjectStats } = await import("../db/sessions.js");
    const ingestion = getIngestionStats();
    const projects = getProjectStats();
    if (opts.json) return void console.log(JSON.stringify({ ingestion, projects }, null, 2));
    console.log("By source:");
    for (const s of ingestion) {
      console.log(`  ${s.source.padEnd(8)} ${s.session_count} sessions, ${s.message_count} messages, ${s.tool_call_count} tool calls`);
    }
    console.log("\nTop projects:");
    for (const p of projects.slice(0, 15)) {
      console.log(`  ${String(p.session_count).padStart(4)}  ${p.project_name ?? p.project_path}`);
    }
  });

program
  .command("graph")
  .description("Explore the session knowledge graph — entities (projects/tools/models/repos) and links")
  .option("-t, --type <type>", "List one entity type: project, tool, model, provider, repo")
  .option("-r, --related <type:name>", "Sessions related to an entity, e.g. tool:Bash or project:infra")
  .option("--session <id>", "Show a single session's entity neighborhood")
  .option("-l, --limit <n>", "Max results", "50")
  .option("--json", "Output as JSON")
  .action(async (opts: { type?: string; related?: string; session?: string; limit?: string; json?: boolean }) => {
    const { listEntities, relatedSessions, sessionGraph } = await import("../lib/graph.js");
    type EntityType = "project" | "tool" | "model" | "provider" | "repo";
    const TYPES = ["project", "tool", "model", "provider", "repo"];
    const limit = parseInt(opts.limit ?? "50", 10) || 50;

    if (opts.session) {
      const { getSessionByPrefix } = await import("../db/sessions.js");
      const s = getSessionByPrefix(opts.session);
      if (!s) {
        console.error(`Session not found: ${opts.session}`);
        process.exit(1);
      }
      const g = sessionGraph(s.id);
      if (opts.json) return void console.log(JSON.stringify(g, null, 2));
      console.log(`project: ${g?.project ?? "?"}`);
      console.log(`model:   ${g?.model ?? "?"} (${g?.provider ?? "?"})`);
      console.log(`repo:    ${g?.repo ?? "?"}`);
      console.log(`tools:   ${g?.tools.join(", ") || "none"}`);
      return;
    }

    if (opts.related) {
      const idx = opts.related.indexOf(":");
      const type = idx >= 0 ? opts.related.slice(0, idx) : "";
      const name = idx >= 0 ? opts.related.slice(idx + 1) : "";
      if (!TYPES.includes(type) || !name) {
        console.error("--related must be <type>:<name>, e.g. tool:Bash (type: project|tool|model|provider|repo)");
        process.exit(1);
      }
      const sessions = relatedSessions(type as EntityType, name, limit);
      if (opts.json) return void console.log(JSON.stringify(sessions, null, 2));
      for (const s of sessions) {
        console.log(`${s.source.padEnd(7)} ${(s.project_name ?? "").padEnd(20)} ${s.title ?? "(untitled)"}  ${s.session_id.slice(0, 8)}`);
      }
      return;
    }

    if (opts.type && !TYPES.includes(opts.type)) {
      console.error(`Unknown type '${opts.type}'. Use: ${TYPES.join(", ")}`);
      process.exit(1);
    }
    const entities = listEntities(opts.type as EntityType | undefined);
    if (opts.json) return void console.log(JSON.stringify(entities, null, 2));
    let lastType = "";
    for (const e of entities.slice(0, opts.type ? entities.length : 100)) {
      if (e.type !== lastType) {
        console.log(`\n${e.type}:`);
        lastType = e.type;
      }
      console.log(`  ${String(e.session_count).padStart(4)}  ${e.name}`);
    }
  });

program
  .command("embed")
  .description("Generate embeddings for indexed messages (enables semantic search; needs OPENAI_API_KEY)")
  .option("-l, --limit <n>", "Max messages to embed this run", "200")
  .option("--json", "Output as JSON")
  .action(async (opts: { limit?: string; json?: boolean }) => {
    const { embedSessions } = await import("../lib/embeddings.js");
    try {
      const result = await embedSessions({ limit: parseInt(opts.limit ?? "200", 10) || 200 });
      if (opts.json) return void console.log(JSON.stringify(result, null, 2));
      console.log(`Embedded ${result.chunksEmbedded} chunks across ${result.messagesProcessed} messages.`);
    } catch (err) {
      console.error(`Embed failed (is OPENAI_API_KEY set?): ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("search-indexed <query>")
  .description("Full-text search across your indexed AI coding sessions")
  .option("-s, --source <source>", "Filter by provider: claude, codex, or gemini")
  .option("-p, --project <path>", "Filter by project path")
  .option("-m, --machine <name>", "Filter by machine (apple03, spark01, …)")
  .option("-l, --limit <n>", "Maximum results", "20")
  .option("--tools", "Search tool calls (name/input/output) instead of message content")
  .option("--semantic", "Semantic (embedding) search — requires 'sessions embed' first")
  .option("--hybrid", "Blend full-text + semantic results (RRF)")
  .option("--json", "Output as JSON")
  .action(
    async (
      query: string,
      opts: { source?: string; project?: string; machine?: string; limit?: string; tools?: boolean; semantic?: boolean; hybrid?: boolean; json?: boolean }
    ) => {
      const { search, searchToolCalls } = await import("../lib/search.js");
      const limit = parseInt(opts.limit ?? "20", 10) || 20;
      const o = { limit, source: opts.source, project_path: opts.project, machine: opts.machine };

      if (opts.tools) {
        const hits = searchToolCalls(query, o);
        if (opts.json) return void console.log(JSON.stringify(hits, null, 2));
        if (hits.length === 0) return void console.log("No matching tool calls.");
        for (const h of hits) {
          console.log(`${h.source}  ${h.tool_name}${h.project_name ? `  [${h.project_name}]` : ""}`);
          console.log(`  ${h.snippet}`);
        }
        return;
      }

      let hits;
      if (opts.semantic || opts.hybrid) {
        const { semanticSearch, hybridSearch } = await import("../lib/vector-search.js");
        try {
          hits = opts.hybrid ? await hybridSearch(query, o) : await semanticSearch(query, o);
        } catch (err) {
          console.error(`Semantic search failed (is OPENAI_API_KEY set and have you run 'sessions embed'?): ${(err as Error).message}`);
          process.exit(1);
        }
      } else {
        hits = search(query, o);
      }
      if (opts.json) return void console.log(JSON.stringify(hits, null, 2));
      if (hits.length === 0) return void console.log("No matching sessions.");
      for (const h of hits) {
        console.log(
          `${h.source}  ${h.title ?? "(untitled)"}${h.project_name ? `  [${h.project_name}]` : ""}`
        );
        console.log(`  ${h.snippet}`);
        console.log(`  ${h.session_id}  ${h.started_at ?? ""}`);
      }
    }
  );

program
  .command("ingest")
  .description("Index AI coding sessions (claude, codex, gemini) into the searchable database")
  .option("-s, --source <source>", "Only ingest one provider: claude, codex, or gemini")
  .option("-f, --force", "Re-ingest even files that are unchanged since last run")
  .option("-v, --verbose", "Print each file as it is ingested")
  .option("--json", "Output the result as JSON")
  .action(async (opts: { source?: string; force?: boolean; verbose?: boolean; json?: boolean }) => {
    const { ingestAll, ingestSource } = await import("../lib/ingest/index.js");
    const onProgress = opts.verbose ? (m: string) => console.log(m) : undefined;
    try {
      const results = opts.source
        ? [ingestSource(opts.source, { force: opts.force, onProgress })]
        : ingestAll({ force: opts.force, onProgress });
      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      for (const r of results) {
        console.log(
          `${r.source}: scanned ${r.scanned}, ingested ${r.ingested}, skipped ${r.skipped}, sessions ${r.sessions}, errors ${r.errors}`
        );
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program.parse();
