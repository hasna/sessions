#!/usr/bin/env bun

/**
 * sessions CLI — Universal AI coding session search and management.
 *
 * This is the main entry point. It wraps the existing @hasna/sessions CLI
 * and adds new commands: relocate, transfer export, transfer import.
 */

import { Command } from "commander";
import { registerEventsCommands } from "@hasna/events/commander";
import { spawnSync } from "node:child_process";
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
  writeSync,
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
  createExternalHandoffBundleV1,
  renderHandoffSkillWrapper,
  type CodewithLaunchMode,
} from "../lib/handoff.js";
import {
  getClaudeProjectsDir,
  getSessionsDir,
  decodePath,
  encodePath,
  findMatchingProjectDirs,
} from "../lib/paths.js";
import { getPackageVersion } from "../lib/package.js";
import type { Session } from "../types/index.js";
import type { SessionStore } from "../db/session-store.js";
import {
  formatLivePaneTable,
  listLivePanes,
  parseLiveStatusFilter,
} from "../lib/live.js";
import {
  buildBulkSessionPlan,
  formatBulkSessionPlan,
  isBulkSessionAction,
  listBulkLivePanes,
  parseConcurrency,
  parseJitterMs,
} from "../lib/bulk.js";

const program = new Command();

function printJson(value: unknown): void {
  writeStdoutFully(`${JSON.stringify(value, null, 2)}\n`);
}

function failCli(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}

function writeStdoutFully(text: string): void {
  const buffer = Buffer.from(text, "utf-8");
  let offset = 0;
  while (offset < buffer.length) {
    try {
      const written = writeSync(1, buffer, offset, buffer.length - offset);
      if (written === 0) {
        sleepSync(10);
        continue;
      }
      offset += written;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") {
        sleepSync(10);
        continue;
      }
      throw error;
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.write(text, () => resolve());
  });
}

function parsePositiveIntOption(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`Error: ${name} must be a positive integer`);
    process.exit(1);
  }
  return value;
}

function parseNonNegativeIntOption(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`Error: ${name} must be a non-negative integer`);
    process.exit(1);
  }
  return value;
}

function parseOptionalNonNegativeNumberOption(raw: string | undefined, name: string): number | undefined {
  if (raw == null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`Error: ${name} must be a non-negative number`);
    process.exit(1);
  }
  return value;
}

function preCloudSyncBackupRecord(): { artifact: null; created_at: string; note: string } {
  return {
    artifact: null,
    created_at: new Date().toISOString(),
    note: "user-supplied backup command completed before self_hosted content import push",
  };
}

function collectRepeatableOption(value: string, previous: string[] = []): string[] {
  previous.push(value);
  return previous;
}

/** Format a table of Store sessions (LocalStore | ApiStore), never the registry. */
function formatSessionTable(sessions: Session[]): string {
  if (sessions.length === 0) {
    return "No sessions found.";
  }

  const headers = ["TITLE", "SOURCE", "PROJECT", "MODEL", "MACHINE", "SESSION"];
  const rows = sessions.map((s) => [
    s.title ?? "(untitled)",
    s.source,
    s.project_name ?? "",
    s.model ?? "-",
    s.machine ?? "?",
    s.id.slice(0, 12),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length))
  );

  const render = (cols: string[]) =>
    cols
      .map((value, index) => value.padEnd(widths[index]))
      .join("  ")
      .trimEnd();

  return [render(headers), ...rows.map(render)].join("\n");
}

/**
 * Build the underlying resume command for a Store session using its provider
 * and provider-native id. Only claude sessions are resumable this way today.
 */
function buildResumeCommand(session: Session): string[] {
  if (session.source === "claude") {
    return ["claude", "--resume", session.source_id];
  }
  throw new Error(`resume is not supported for source '${session.source}' (only claude)`);
}

async function pickSessionFromList(store: SessionStore): Promise<Session> {
  const sessions = await store.recent(20);
  if (sessions.length === 0) {
    throw new Error("No sessions available to pick from");
  }

  console.log("Select a session to resume:\n");
  sessions.forEach((session, index) => {
    console.log(
      `  ${index + 1}. ${session.title ?? "(untitled)"}  ${session.project_name ?? ""}  ${session.source}  ${session.id.slice(0, 12)}`
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
  .action(async (oldPath: string, newPath: string, opts: any) => {
    // Resolve ~ to home directory
    if (oldPath.startsWith("~")) oldPath = join(homedir(), oldPath.slice(1));
    if (newPath.startsWith("~")) newPath = join(homedir(), newPath.slice(1));

    // Phase 1: on-box transcript files (always local — this machine's raw files).
    const result = relocate(oldPath, newPath, {
      dryRun: opts.dryRun,
      verbose: opts.json ? false : opts.verbose,
    });

    // Phase 2: the session INDEX (project_path/source_path) — routed through the
    // Store so self_hosted mode updates the shared cloud registry, not a raw
    // on-box SQLite write. `--no-db` skips it; dry-run never mutates.
    const updateDb = opts.db !== false;
    let dbRowsUpdated = 0;
    if (updateDb && !opts.dryRun) {
      const { resolveSessionStore } = await import("../db/session-store.js");
      try {
        const r = await resolveSessionStore().relocatePaths(oldPath, newPath);
        dbRowsUpdated = r.rowsUpdated;
      } catch (err) {
        result.errors.push({ file: "<store>", error: (err as Error).message });
      }
    }

    if (opts.json) {
      printJson({
        oldPath,
        newPath,
        dryRun: Boolean(opts.dryRun),
        updateDb,
        ...result,
        dbRowsUpdated,
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
    console.log(`  DB rows updated:     ${dbRowsUpdated}`);

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

// ─── handoff ───────────────────────────────────────────────────────────────

program
  .command("handoff [target]")
  .description("Create an ExternalHandoffBundleV1 for safe cross-agent handoff")
  .option("--source-agent <agent>", "Source agent name, e.g. claude or codewith")
  .option("--source-session <id>", "Source provider-native session id")
  .option("--source-transcript <path>", "Source transcript JSONL path")
  .option("--cwd <path>", "Source working directory (default: current cwd)")
  .option("--idempotency-key <key>", "Stable key for repeatable bundle id/path")
  .option("--context-summary <text>", "Redacted human summary to include in the bundle")
  .option("--auth-ref <ref>", "Auth/profile reference by name only, e.g. codewith:live-codewith", collectRepeatableOption, [])
  .option("--codewith-auth-profile <name>", "Add --auth-profile <name> to rendered Codewith commands")
  .option("--codewith-mode <mode>", "Rendered Codewith launch mode: interactive or exec", "interactive")
  .option("--verification <text>", "Verification note to include in the bundle", collectRepeatableOption, [])
  .option("--blocker <text>", "Blocker note to include in the bundle", collectRepeatableOption, [])
  .option("--max-turns <n>", "Maximum recent transcript turns to include", "8")
  .option("--max-turn-chars <n>", "Maximum characters per recent turn", "1200")
  .option("--dry-run", "Build the bundle preview without writing or launching")
  .option("--print-command", "Print only the rendered target command")
  .option("--launch", "Launch the rendered target command; never exits/kills the source")
  .option("--emit-skill <agent>", "Print installable wrapper skill text named 'handoff' for claude, codewith, codex, opencode, or cursor")
  .option("--json", "Output JSON")
  .action(async (target: string | undefined, opts: any) => {
    if (opts.emitSkill) {
      try {
        const content = renderHandoffSkillWrapper(opts.emitSkill);
        if (opts.json) {
          printJson({ name: "handoff", agent: opts.emitSkill, content });
          return;
        }
        await writeStdout(content);
        return;
      } catch (error: any) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
    }

    if (!target) {
      console.error("Error: target is required (for example: sessions handoff codewith)");
      process.exit(1);
    }

    const mode = String(opts.codewithMode ?? "interactive");
    if (mode !== "interactive" && mode !== "exec") {
      console.error("Error: --codewith-mode must be interactive or exec");
      process.exit(1);
    }
    if (opts.printCommand && opts.json) {
      console.error("Error: --print-command cannot be combined with --json");
      process.exit(1);
    }
    if (opts.launch && opts.printCommand) {
      console.error("Error: --launch cannot be combined with --print-command");
      process.exit(1);
    }
    if (opts.launch && (opts.dryRun || opts.json)) {
      console.error("Error: --launch cannot be combined with --dry-run or --json");
      process.exit(1);
    }
    if (opts.launch && target.trim().toLowerCase() !== "codewith") {
      console.error(`Error: target '${target}' does not have a v1 launch command`);
      process.exit(1);
    }

    try {
      const result = createExternalHandoffBundleV1({
        target,
        sourceAgent: opts.sourceAgent,
        sourceSession: opts.sourceSession,
        sourceTranscript: opts.sourceTranscript,
        cwd: opts.cwd,
        idempotencyKey: opts.idempotencyKey,
        contextSummary: opts.contextSummary,
        authRefs: opts.authRef,
        verification: opts.verification,
        blockers: opts.blocker,
        dryRun: Boolean(opts.dryRun),
        maxTurns: parsePositiveIntOption(opts.maxTurns, 8, "--max-turns"),
        maxTurnChars: parsePositiveIntOption(opts.maxTurnChars, 1200, "--max-turn-chars"),
        codewithAuthProfile: opts.codewithAuthProfile,
        codewithMode: mode as CodewithLaunchMode,
      });

      if (opts.json) {
        printJson(result);
        return;
      }

      if (opts.printCommand) {
        if (!result.launch) {
          console.error(`Error: target '${target}' does not have a v1 launch command`);
          process.exit(1);
        }
        console.log(result.launch.shell_command);
        return;
      }

      console.log(`${result.written ? "Created" : "Prepared"} handoff bundle: ${result.bundle_path}`);
      console.log(`  id:      ${result.bundle.id}`);
      console.log(`  target:  ${result.bundle.target.agent}`);
      console.log(`  hash:    ${result.bundle.bundle_hash}`);
      console.log(`  status:  ${result.bundle.status}`);
      console.log("  source exit: not automatic (v1 has no target ack/source-kill protocol)");
      if (result.bundle.warnings.length > 0) {
        console.log("\nWarnings:");
        for (const warning of result.bundle.warnings) console.log(`  - ${warning}`);
      }
      if (result.launch) {
        console.log("\nCommand:");
        console.log(`  ${result.launch.shell_command}`);
      }

      if (opts.launch) {
        if (!result.launch) {
          console.error(`Error: target '${target}' does not have a v1 launch command`);
          process.exit(1);
        }
        const proc = Bun.spawn({
          cmd: result.launch.command,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        });
        const exitCode = await proc.exited;
        process.exit(exitCode);
      }
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
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
  .description("List known sessions from the active store (local index, or the self_hosted /v1 API when HASNA_SESSIONS_API_URL + HASNA_SESSIONS_API_KEY are set)")
  .option("-p, --project <value>", "Filter by project name or path")
  .option("-l, --limit <n>", "Maximum results", "50")
  .option("--json", "Output as JSON")
  .action(async (opts: any) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    const sessions = await resolveSessionStore().list({
      project_path: opts.project,
      limit: parsePositiveIntOption(opts.limit, 50, "--limit"),
    });
    if (opts.json) {
      printJson(sessions);
      return;
    }

    console.log(formatSessionTable(sessions));
  });

program
  .command("rename <id-or-prefix> <title>")
  .description("Set a session's title in the active store (local index, or the self_hosted /v1 API when HASNA_SESSIONS_API_URL + HASNA_SESSIONS_API_KEY are set)")
  .option("-s, --source <source>", "Resolve the identifier as a native source id for this source")
  .option("--json", "Output as JSON")
  .action(async (identifier: string, title: string, opts: any) => {
    const trimmed = title.trim();
    if (!trimmed) {
      console.error("Error: title cannot be empty");
      process.exit(1);
    }
    const { resolveSessionStore } = await import("../db/session-store.js");
    let session: Session | null;
    try {
      session = await resolveSessionStore().rename(identifier, trimmed, { source: opts.source });
    } catch (error) {
      failCli(error);
    }
    if (!session) {
      console.error(`Error: session not found (or ambiguous prefix): ${identifier}`);
      process.exit(1);
    }
    if (opts.json) {
      printJson(session);
      return;
    }
    console.log(`Renamed ${session.id} -> ${session.title}`);
  });

program
  .command("resume [id-or-prefix]")
  .description("Resume a session by id/prefix, latest project session, or the most recent session (resolved via the active store)")
  .option("-p, --project <value>", "Resume the most recent session for a project")
  .option("-s, --source <source>", "Resolve the identifier as a native source id for this source")
  .option("--last", "Resume the most recently active session")
  .option("--pick", "Interactively pick a session from the most recent results")
  .option("--print-command", "Print the underlying resume command without executing it")
  .option("--json", "Output the selected session as JSON")
  .action(async (identifier: string | undefined, opts: any) => {
    try {
      const { resolveSessionStore } = await import("../db/session-store.js");
      const store = resolveSessionStore();
      let session: Session | null = null;

      if (opts.pick) {
        session = await pickSessionFromList(store);
      } else if (opts.project) {
        session = (await store.list({ project_path: opts.project, limit: 1 }))[0] ?? null;
      } else if (opts.last || !identifier) {
        session = (await store.recent(1))[0] ?? null;
      } else {
        session = await store.get(identifier, { source: opts.source });
      }

      if (!session) {
        throw new Error("No matching session found");
      }

      const command = buildResumeCommand(session);
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
  .description("Show sessions from the active store with history filters")
  .option("-p, --project <value>", "Filter by project name or path")
  .option("--today", "Only include sessions active today")
  .option("--agent <value>", "Filter by provider (source) or title substring")
  .option("-l, --limit <n>", "Maximum results before filtering", "200")
  .option("--json", "Output as JSON")
  .action(async (opts: any) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    let sessions = await resolveSessionStore().list({
      project_path: opts.project,
      limit: parsePositiveIntOption(opts.limit, 200, "--limit"),
    });

    if (opts.today) {
      const today = new Date().toISOString().slice(0, 10);
      sessions = sessions.filter((s) => (s.started_at ?? s.ingested_at ?? "").startsWith(today));
    }

    if (opts.agent) {
      const needle = String(opts.agent).toLowerCase();
      sessions = sessions.filter(
        (s) =>
          s.source.toLowerCase().includes(needle) ||
          (s.title ?? "").toLowerCase().includes(needle) ||
          (s.model ?? "").toLowerCase().includes(needle)
      );
    }

    if (opts.json) {
      printJson(sessions);
      return;
    }

    console.log(formatSessionTable(sessions));
  });

program
  .command("transcript-search <query>")
  .alias("registry-search")
  .description("Full-text search across indexed session transcripts via the active store (local index, or the self_hosted /v1 API)")
  .option("-p, --project <value>", "Filter by project name or path")
  .option("--limit <count>", "Maximum matches to return", "20")
  .option("--json", "Output as JSON")
  .action(async (query: string, opts: any) => {
    const limit = parsePositiveIntOption(opts.limit, 20, "--limit");
    const { resolveSessionStore } = await import("../db/session-store.js");
    const matches = await resolveSessionStore().searchContent(query, {
      project_path: opts.project,
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
      console.log(`${match.source}  ${match.title ?? "(untitled)"}${match.project_name ? `  [${match.project_name}]` : ""}`);
      console.log(`  ${match.snippet}`);
      console.log(`  ${match.session_id}`);
    }
  });

program
  .command("live")
  .description("List live tmux-backed Codewith/session panes")
  .option("--open-only", "Only include open-* tmux sessions or projects")
  .option("-p, --project <value>", "Filter by project slug or path")
  .option("-m, --machine <name>", "Filter by machine name")
  .option("--status <values>", "Filter by status: active,idle,needs_attention,dead")
  .option("--interval <seconds>", "Refresh interval with --watch", "5")
  .option("--json", "Output JSON")
  .option("--once", "Render a single snapshot and exit")
  .option("--watch", "Keep refreshing until interrupted")
  .action(async (opts: any) => {
    const intervalSeconds = Number.parseInt(opts.interval, 10);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      console.error("Error: --interval must be a positive integer");
      process.exit(1);
    }

    let statuses;
    try {
      statuses = parseLiveStatusFilter(opts.status);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }

    const shouldWatch = Boolean(opts.watch) && !opts.once;
    const render = async () => {
      const panes = listLivePanes({
        openOnly: Boolean(opts.openOnly),
        project: opts.project,
        machine: opts.machine,
        statuses,
      });

      if (opts.json) {
        await writeStdout(`${JSON.stringify(panes, null, shouldWatch ? 0 : 2)}\n`);
        return;
      }

      if (shouldWatch) console.clear();
      console.log(`sessions live (${new Date().toISOString()})\n`);
      console.log(formatLivePaneTable(panes));
    };

    await render();
    if (!shouldWatch) {
      return;
    }

    const timer = setInterval(() => {
      void render();
    }, intervalSeconds * 1000);
    process.on("SIGINT", () => {
      clearInterval(timer);
      process.exit(0);
    });
  });

program
  .command("bulk <action>")
  .description("Plan safe bulk operations for live tmux-backed sessions")
  .option("--open-only", "Only include open-* tmux sessions or projects")
  .option("-p, --project <value>", "Filter by project slug or path")
  .option("-m, --machine <name>", "Filter by machine name")
  .option("--status <values>", "Filter by status: active,idle,needs_attention,dead")
  .option("--json", "Output JSON")
  .option("--dry-run", "Show the plan without mutating tmux")
  .option("--yes", "Confirm a mutating bulk operation")
  .option("--no-queue", "Do not mark confirmed work as locally queued")
  .option("--concurrency <count>", "Maximum queued operations to run at once", "2")
  .option("--jitter <ms>", "Deterministic delay jitter per target in milliseconds", "0")
  .option("--max-active-agents <count>", "Refuse mutating work when active agent count is above this value", "12")
  .option("--max-load1 <value>", "Refuse mutating work when 1 minute load is above this value")
  .option("--max-load-per-core <value>", "Refuse mutating work when 1 minute load per CPU core is above this value", "1.5")
  .action(async (action: string, opts: any) => {
    if (!isBulkSessionAction(action)) {
      console.error(`Error: unknown bulk action '${action}'. Use: status, capture, ensure, start, stop, restart, doctor`);
      process.exit(1);
    }

    let statuses;
    let concurrency;
    let jitterMs;
    try {
      statuses = parseLiveStatusFilter(opts.status);
      concurrency = parseConcurrency(opts.concurrency);
      jitterMs = parseJitterMs(opts.jitter);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }

    const panes = listBulkLivePanes({
      openOnly: Boolean(opts.openOnly),
      project: opts.project,
    });
    const plan = buildBulkSessionPlan({
      action,
      panes,
      openOnly: Boolean(opts.openOnly),
      project: opts.project,
      machine: opts.machine,
      statuses,
      statusFilterExplicit: Boolean(opts.status),
      dryRun: Boolean(opts.dryRun),
      yes: Boolean(opts.yes),
      queue: opts.queue !== false,
      executionEnabled: false,
      concurrency,
      jitterMs,
      maxActiveAgents: parsePositiveIntOption(opts.maxActiveAgents, 12, "--max-active-agents"),
      maxLoad1: parseOptionalNonNegativeNumberOption(opts.maxLoad1, "--max-load1"),
      maxLoadPerCore: parseOptionalNonNegativeNumberOption(opts.maxLoadPerCore, "--max-load-per-core"),
    });

    if (opts.json) {
      await writeStdout(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      console.log(formatBulkSessionPlan(plan));
      if (!opts.dryRun && ["ensure", "start", "stop", "restart"].includes(action)) {
        console.log("\nMutating execution is intentionally disabled in this build; use --dry-run for planning.");
      }
    }

    if (["ensure", "start", "stop", "restart"].includes(action) && (!plan.guard.ok || plan.summary.refused > 0)) {
      process.exit(1);
    }
  });

program
  .command("watch")
  .description("Watch session activity in a live-updating table")
  .option("-p, --project <value>", "Filter by project slug or path")
  .option("--interval <seconds>", "Refresh interval in seconds", "5")
  .option("--json", "Output one JSON snapshot and exit")
  .option("--once", "Render a single snapshot and exit")
  .action(async (opts: any) => {
    const intervalSeconds = Number.parseInt(opts.interval, 10);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      console.error("Error: --interval must be a positive integer");
      process.exit(1);
    }

    const { resolveSessionStore } = await import("../db/session-store.js");
    const store = resolveSessionStore();
    const render = async () => {
      const sessions = await store.list({ project_path: opts.project });
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

    await render();
    if (opts.json || opts.once) {
      return;
    }

    const timer = setInterval(() => void render(), intervalSeconds * 1000);
    process.on("SIGINT", () => {
      clearInterval(timer);
      process.exit(0);
    });
  });

program
  .command("paths")
  .description("List all project paths with session counts")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    // Route through the Store so this is mode-aware: local mode reads the on-box
    // index; self_hosted mode hits /v1/stats and reports the SHARED cloud
    // registry's project paths. Never scan the local filesystem in cloud mode —
    // that was the split-brain bug (byte-identical local output regardless of
    // mode). The orphaned-path (`!`) marker is a local-filesystem concern and is
    // only meaningful for on-box projects, so it is shown in local mode only.
    const { resolveSessionStore } = await import("../db/session-store.js");
    const store = resolveSessionStore();
    const stats = await store.stats();

    const projects = stats.projects
      .map((p) => {
        const path = p.project_path ?? p.project_name ?? "(unknown)";
        const exists =
          store.mode === "local" && p.project_path ? existsSync(p.project_path) : true;
        return { path, sessions: p.session_count, exists };
      })
      .sort((a, b) => b.sessions - a.sessions);

    if (opts.json) {
      printJson(projects);
      return;
    }

    console.log(`Session Paths (${store.mode})\n`);
    const maxPath = Math.max(60, ...projects.map((p) => p.path.length));

    for (const p of projects) {
      const marker = p.exists ? " " : "!";
      const countStr = String(p.sessions).padStart(4);
      console.log(`${marker} ${p.path.padEnd(maxPath)} ${countStr} sessions`);
    }

    if (store.mode === "local") {
      const orphaned = projects.filter((p) => !p.exists);
      if (orphaned.length > 0) {
        console.log(
          `\n! = path no longer exists (${orphaned.length} orphaned, use 'sessions relocate' to fix)`
        );
      }
    }
    console.log(
      `\nTotal: ${projects.length} projects, ${projects.reduce((s, p) => s + p.sessions, 0)} sessions`
    );
  });

program
  .command("machines")
  .description("List machines that have contributed sessions, with counts")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    const machines = await resolveSessionStore().machines();
    if (opts.json) return void printJson(machines);
    if (machines.length === 0) {
      console.log("No machines recorded yet. Run 'sessions ingest' or 'sessions sync'.");
      return;
    }
    for (const m of machines) {
      console.log(`${m.name.padEnd(10)} ${String(m.session_count).padStart(6)} sessions   ${(m.platform ?? "").padEnd(8)} last seen ${m.last_seen_at}`);
    }
  });

interface BackfillCliOptions {
  apply?: boolean;
  confirmApply?: string;
  allowProduction?: boolean;
  batchSize?: string;
  concurrency?: string;
  source?: string;
  pilot?: string;
  rangeStart?: string;
  rangeEnd?: string;
  allSources?: boolean;
  knownId?: string[];
  checkpoint?: string;
  backupCommand?: string;
  maxSessionBytes?: string;
  maxTotalBytes?: string;
  json?: boolean;
}

function printBackfillSummary(result: Awaited<ReturnType<typeof import("../lib/backfill.js").runSessionBackfill>>): void {
  console.log(`backfill ${result.mode}`);
  console.log(`  files:      ${result.inventory.files}`);
  console.log(`  inventory:  ${result.inventory.selectableSessions} selectable session(s), ${result.inventory.duplicates} duplicate(s), ${result.inventory.errors} error(s)`);
  console.log(`  selected:   ${result.selection.selected} session(s), ${formatBytes(result.selection.selectedEstimatedBytes)} estimated`);
  console.log(`  content:    ${result.selection.selectedMessages} messages, ${result.selection.selectedToolCalls} tool calls`);
  console.log(`  limits:     batch=${result.limits.batchSize}, concurrency=${result.limits.concurrency}, max-session=${formatBytes(result.limits.maxSessionBytes)}`);
  console.log(`  checkpoint: ${result.checkpoint.path}`);
  if (result.dryRun) {
    console.log("  apply:      not run (dry-run/inventory mode)");
  } else {
    console.log(`  applied:    ${result.applied.pushed} pushed, ${result.applied.skipped} skipped, ${result.applied.failed} failed`);
  }
  for (const warning of result.warnings) console.log(`  warning:    ${warning}`);
  for (const error of result.errors.slice(0, 8)) console.error(`  error:      ${error}`);
  if (result.errors.length > 8) console.error(`  error:      ... ${result.errors.length - 8} more`);
}

program
  .command("backfill")
  .description("Inventory or explicitly apply a bounded, checkpointed self_hosted session-content backfill")
  .option("--apply", "Apply the selected backfill to the self_hosted /v1 API (default is inventory/dry-run)")
  .option("--confirm-apply <token>", "Required with --apply; pass BACKFILL_APPLY")
  .option("--allow-production", "Permit production-like hasna.xyz API URLs after separate out-of-band user approval")
  .option("-s, --source <source>", "Only backfill one provider: claude, codex, codewith, gemini")
  .option("--pilot <n>", "Deterministically select the first n sessions after sorting by source/source_id")
  .option("--range-start <source:id>", "Inclusive deterministic range start")
  .option("--range-end <source:id>", "Inclusive deterministic range end")
  .option("--all-sources", "With --apply, explicitly acknowledge selecting every non-duplicate inventoried session")
  .option("--known-id <source:id>", "Require and verify a known source-qualified id; with --apply and no pilot/range, selects only known ids", collectRepeatableOption, [])
  .option("--batch-size <n>", "Maximum staged child records materialized per parser batch", "128")
  .option("--concurrency <n>", "Maximum concurrent session payload imports", "1")
  .option("--max-session-bytes <n>", "Fail closed if any selected session estimate exceeds this many bytes", String(64 * 1024 * 1024))
  .option("--max-total-bytes <n>", "Required with --apply; fail closed if selected estimate exceeds this many bytes")
  .option("--checkpoint <path>", "Durable checkpoint JSON path")
  .option("--backup-command <command>", "Required with --apply; output is suppressed")
  .option("--json", "Output machine-readable JSON")
  .action(async (opts: BackfillCliOptions) => {
    try {
      const { runSessionBackfill } = await import("../lib/backfill.js");
      const result = await runSessionBackfill({
        apply: Boolean(opts.apply),
        confirmApply: opts.confirmApply,
        allowProduction: Boolean(opts.allowProduction),
        source: opts.source,
        pilot: opts.pilot == null ? undefined : parseNonNegativeIntOption(opts.pilot, 0, "--pilot"),
        rangeStart: opts.rangeStart,
        rangeEnd: opts.rangeEnd,
        allSources: Boolean(opts.allSources),
        knownIds: opts.knownId ?? [],
        batchSize: parsePositiveIntOption(opts.batchSize, 128, "--batch-size"),
        concurrency: parsePositiveIntOption(opts.concurrency, 1, "--concurrency"),
        maxSessionBytes: parsePositiveIntOption(opts.maxSessionBytes, 64 * 1024 * 1024, "--max-session-bytes"),
        maxTotalBytes: opts.maxTotalBytes == null ? undefined : parsePositiveIntOption(opts.maxTotalBytes, 0, "--max-total-bytes"),
        checkpointPath: opts.checkpoint,
        backupCommand: opts.backupCommand,
      });
      if (opts.json) printJson(result);
      else printBackfillSummary(result);
      if (result.errors.length > 0 || result.applied.failed > 0) process.exit(1);
    } catch (error) {
      failCli(error);
    }
  });

interface ApiSyncCliOptions {
  dryRun?: boolean;
  watch?: boolean;
  ingest?: boolean;
  json?: boolean;
  source?: string;
  project?: string;
  machine?: string;
  limit?: string;
  interval?: string;
  maxIterations?: string;
  backupCommand?: string;
}

interface ContentSyncResult {
  target: "self_hosted_api";
  dryRun: boolean;
  scanned: number;
  attempted: number;
  pushed: number;
  skipped: number;
  failed: number;
  messages: number;
  toolCalls: number;
  backup: {
    guidance: string;
    verified: { artifact: null; created_at: string; note: string } | null;
    hook: {
      configured: boolean;
      ran: boolean;
      exitCode: number | null;
      skippedReason?: string;
    };
  };
  warnings: string[];
  errors: string[];
  ingest?: unknown;
}

const CLOUD_SYNC_BACKUP_GUIDANCE =
  "Live self_hosted pushes require a successful --backup-command. Raw SQLite file copies are not treated as a safe backup while the DB may be active.";

function runBackupCommand(command: string | undefined, dryRun: boolean): ContentSyncResult["backup"]["hook"] {
  const trimmed = command?.trim();
  if (!trimmed) return { configured: false, ran: false, exitCode: null };
  if (dryRun) return { configured: true, ran: false, exitCode: null, skippedReason: "dry-run" };
  const result = spawnSync("bash", ["-lc", trimmed], { stdio: "ignore" });
  return {
    configured: true,
    ran: true,
    exitCode: result.error ? 1 : result.status ?? (result.signal ? 1 : 0),
  };
}

function contentSyncSignature(result: ContentSyncResult): string {
  return JSON.stringify({
    scanned: result.scanned,
    attempted: result.attempted,
    pushed: result.pushed,
    failed: result.failed,
    messages: result.messages,
    toolCalls: result.toolCalls,
    warnings: result.warnings,
    errors: result.errors,
  });
}

function printContentSyncResult(result: ContentSyncResult, prefix = "sync"): void {
  const mode = result.dryRun ? "dry-run" : "live";
  console.log(`${prefix} (${mode})`);
  console.log(`  scanned:   ${result.scanned}`);
  console.log(`  attempted: ${result.attempted}`);
  console.log(`  pushed:    ${result.pushed}`);
  console.log(`  skipped:   ${result.skipped}`);
  console.log(`  failed:    ${result.failed}`);
  console.log(`  content:   ${result.messages} messages, ${result.toolCalls} tool calls`);
  if (result.backup.verified) {
    console.log("  backup:    verified by user hook");
  } else if (result.dryRun) {
    console.log(`  backup:    not created (dry-run). ${result.backup.guidance}`);
  } else {
    console.log(`  backup:    ${result.backup.guidance}`);
  }
  if (result.backup.hook.configured) {
    const state = result.backup.hook.ran
      ? `ran exit=${result.backup.hook.exitCode}`
      : `not run${result.backup.hook.skippedReason ? ` (${result.backup.hook.skippedReason})` : ""}`;
    console.log(`  backup hook: ${state}`);
  }
  for (const warning of result.warnings) console.log(`  warning:   ${warning}`);
  for (const error of result.errors.slice(0, 5)) console.error(`  error:     ${error}`);
  if (result.errors.length > 5) console.error(`  error:     ... ${result.errors.length - 5} more`);
}

async function runContentSyncOnce(opts: ApiSyncCliOptions): Promise<ContentSyncResult> {
  const { resolveSessionStore, getLocalStore } = await import("../db/session-store.js");
  const dryRun = Boolean(opts.dryRun);
  const limit = parsePositiveIntOption(opts.limit, opts.watch ? 500 : 100000, "--limit");
  const local = getLocalStore();
  const result: ContentSyncResult = {
    target: "self_hosted_api",
    dryRun,
    scanned: 0,
    attempted: 0,
    pushed: 0,
    skipped: 0,
    failed: 0,
    messages: 0,
    toolCalls: 0,
    backup: {
      guidance: CLOUD_SYNC_BACKUP_GUIDANCE,
      verified: null,
      hook: { configured: Boolean(opts.backupCommand?.trim()), ran: false, exitCode: null, skippedReason: dryRun ? "dry-run" : undefined },
    },
    warnings: [],
    errors: [],
  };

  if (opts.ingest !== false) {
    result.ingest = await local.ingest({ source: opts.source });
  }
  await local.recomputeMachines();

  const localSessions = await local.list({
    source: opts.source,
    project_path: opts.project,
    machine: opts.machine,
    limit,
  });
  result.scanned = localSessions.length;

  const sessionsWithContent = [];
  for (const s of localSessions) {
    const sessionMessages = await local.messages(s.id);
    const sessionToolCalls = await local.toolCalls(s.id);
    result.messages += sessionMessages.length;
    result.toolCalls += sessionToolCalls.length;
    if (s.message_count > 0 && sessionMessages.length === 0) {
      result.warnings.push(`${s.id}: local index reports ${s.message_count} message(s), but none were loaded`);
    }
    if (s.tool_call_count > 0 && sessionToolCalls.length === 0) {
      result.warnings.push(`${s.id}: local index reports ${s.tool_call_count} tool call(s), but none were loaded`);
    }
    sessionsWithContent.push({ session: s, messages: sessionMessages, toolCalls: sessionToolCalls });
  }

  if (dryRun) {
    result.skipped = result.scanned;
    return result;
  }

  const store = resolveSessionStore();
  if (store.mode === "local") {
    result.skipped = result.scanned;
    result.warnings.push("local mode; on-box index is authoritative. Configure HASNA_SESSIONS_MODE=self_hosted, HASNA_SESSIONS_API_URL, and HASNA_SESSIONS_API_KEY to push to the shared cloud registry.");
    return result;
  }

  result.backup.hook = runBackupCommand(opts.backupCommand, false);
  if (!result.backup.hook.configured) {
    result.errors.push("live self_hosted sync requires --backup-command to complete a SQLite-safe backup/export before pushing content");
    result.failed = 1;
    return result;
  }
  if (result.backup.hook.exitCode !== 0) {
    result.errors.push(`backup command failed with exit ${result.backup.hook.exitCode}`);
    result.failed = 1;
    return result;
  }
  result.backup.verified = preCloudSyncBackupRecord();

  for (const { session: s, messages, toolCalls } of sessionsWithContent) {
    if (s.message_count > 0 && messages.length === 0) {
      result.errors.push(`${s.id}: local index reports ${s.message_count} message(s), but none were loaded; refusing to replace cloud content`);
      result.failed++;
      continue;
    }
    if (s.tool_call_count > 0 && toolCalls.length === 0) {
      result.errors.push(`${s.id}: local index reports ${s.tool_call_count} tool call(s), but none were loaded; refusing to replace cloud content`);
      result.failed++;
      continue;
    }
    result.attempted++;
    try {
      const imported = await store.importContent({
        session: {
          id: s.id,
          source: s.source,
          source_id: s.source_id,
          source_path: s.source_path,
          title: s.title,
          project_path: s.project_path,
          project_name: s.project_name,
          model: s.model,
          model_provider: s.model_provider,
          git_branch: s.git_branch,
          git_sha: s.git_sha,
          git_origin_url: s.git_origin_url,
          cli_version: s.cli_version,
          is_subagent: s.is_subagent,
          parent_session_id: s.parent_session_id,
          total_input_tokens: s.total_input_tokens,
          total_output_tokens: s.total_output_tokens,
          total_cache_read_tokens: s.total_cache_read_tokens,
          total_cache_write_tokens: s.total_cache_write_tokens,
          total_thinking_tokens: s.total_thinking_tokens,
          message_count: s.message_count,
          tool_call_count: s.tool_call_count,
          machine: s.machine,
          started_at: s.started_at,
          ended_at: s.ended_at,
          duration_seconds: s.duration_seconds,
          source_modified_at: s.source_modified_at,
          metadata: s.metadata,
        },
        messages,
        toolCalls,
        backup: result.backup.verified ?? undefined,
      });
      result.messages += Math.max(0, imported.imported.messages - messages.length);
      result.toolCalls += Math.max(0, imported.imported.toolCalls - toolCalls.length);
      result.pushed++;
    } catch (e) {
      result.errors.push(`${s.id}: ${(e as Error).message}`);
      result.failed++;
    }
  }

  return result;
}

async function runContentSyncCli(opts: ApiSyncCliOptions, commandName = "sync"): Promise<void> {
  const intervalSeconds = parsePositiveIntOption(opts.interval, 60, "--interval");
  if (intervalSeconds < 5) {
    console.error("Error: --interval must be at least 5 seconds");
    process.exit(1);
  }
  const maxIterations = parsePositiveIntOption(opts.maxIterations, 60, "--max-iterations");

  let iteration = 0;
  let lastSignature: string | null = null;
  if (!opts.watch) {
    const result = await runContentSyncOnce(opts);
    if (opts.json) printJson(result);
    else printContentSyncResult(result, commandName);
    if (result.errors.length > 0 || result.failed > 0) process.exit(1);
    return;
  }

  if (!opts.json) {
    console.log(`${commandName} watch started; interval=${intervalSeconds}s, max-iterations=${maxIterations}`);
    console.log("Unchanged cycles are suppressed to avoid log spam.");
  }
  const shutdown = () => process.exit(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (iteration < maxIterations) {
    const result = await runContentSyncOnce(opts);
    const signature = contentSyncSignature(result);
    const changed = signature !== lastSignature;
    if (opts.json) {
      await writeStdout(`${JSON.stringify({ iteration: iteration + 1, ...result })}\n`);
    } else if (changed || iteration === 0) {
      printContentSyncResult(result, `${commandName} iteration ${iteration + 1}`);
    }
    lastSignature = signature;
    iteration++;
    if (result.errors.length > 0 || result.failed > 0) process.exitCode = 1;
    if (iteration >= maxIterations) break;
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }
}

program
  .command("sync")
  .description("Ingest local sessions; in self_hosted (api) mode, push sessions/messages/tool calls to the shared cloud registry")
  .option("--no-ingest", "Skip the local ingest before pushing")
  .option("-n, --dry-run", "Plan content sync without creating backups or pushing to the API")
  .option("--watch", "Run content sync repeatedly as a bounded-poll daemon")
  .option("-s, --source <source>", "Only sync one provider: claude, codex, codewith, gemini")
  .option("-p, --project <value>", "Only sync sessions for this project path/name")
  .option("-m, --machine <name>", "Only sync sessions from this machine")
  .option("-l, --limit <n>", "Maximum local sessions to scan per cycle")
  .option("--interval <seconds>", "Watch interval in seconds (minimum 5)")
  .option("--max-iterations <n>", "Stop watch mode after n cycles", "60")
  .option("--backup-command <command>", "Required for live self_hosted pushes; output is suppressed")
  .option("--json", "Output as JSON")
  .action(async (opts: ApiSyncCliOptions) => {
    await runContentSyncCli(opts);
  });

program
  .command("daemon")
  .description("Watch local session changes and periodically push session content to the self_hosted /v1 API")
  .option("--no-ingest", "Skip the local ingest before each sync cycle")
  .option("-n, --dry-run", "Plan each sync cycle without creating backups or pushing to the API")
  .option("-s, --source <source>", "Only sync one provider: claude, codex, codewith, gemini")
  .option("-p, --project <value>", "Only sync sessions for this project path/name")
  .option("-m, --machine <name>", "Only sync sessions from this machine")
  .option("-l, --limit <n>", "Maximum local sessions to scan per cycle", "500")
  .option("--interval <seconds>", "Watch interval in seconds (minimum 5)", "60")
  .option("--max-iterations <n>", "Stop after n cycles; pass a larger value for longer supervised runs", "60")
  .option("--backup-command <command>", "Required for live self_hosted pushes; output is suppressed")
  .option("--json", "Emit one JSON object per cycle")
  .action(async (opts: ApiSyncCliOptions) => {
    await runContentSyncCli({ ...opts, watch: true }, "daemon");
  });

program
  .command("import-db <path>")
  .description("Merge another machine's sessions database into this one (preserves machine tags) — RDS-free sync")
  .option("--json", "Output as JSON")
  .action(async (path: string, opts: { json?: boolean }) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    try {
      const r = await resolveSessionStore().mergeFromDb(path);
      if (opts.json) return void printJson(r);
      console.log(`Merged from ${path}: +${r.sessions} sessions, +${r.messages} messages, +${r.tool_calls} tool calls, +${r.embeddings} embeddings`);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

program
  .command("ingest-watch")
  .alias("watch-ingest")
  .description("Continuously index new/changed sessions as they happen (Ctrl-C to stop)")
  .option("-s, --source <source...>", "Only watch one or more providers: claude, codex, codewith, gemini")
  .option("--no-initial", "Skip the startup ingest and only ingest future changes/poll ticks")
  .option("--debounce <ms>", "Debounce window after a change before ingesting", "2000")
  .option("--poll <ms>", "Safety-net poll interval; set 0 to disable", "10000")
  .option("--status", "Print provider watch status and exit")
  .option("--json", "Output status as JSON with --status")
  .action(async (opts: { source?: string[]; initial?: boolean; debounce?: string; poll?: string; status?: boolean; json?: boolean }) => {
    const { getLocalStore } = await import("../db/session-store.js");
    const { getWatchStatus, startWatch } = await import("../lib/watch.js");
    const sources = opts.source?.length ? opts.source : undefined;
    const debounceMs = parsePositiveIntOption(opts.debounce, 2000, "--debounce");
    const pollMs = parseNonNegativeIntOption(opts.poll, 10000, "--poll");
    if (opts.status) {
      const status = getWatchStatus({ sources, debounceMs, pollMs });
      if (opts.json) return void printJson(status);
      console.log("watch-ingest status");
      console.log(`  sources:  ${status.sources.join(", ") || "(no provider dirs found)"}`);
      console.log(`  debounce: ${status.debounceMs}ms`);
      console.log(`  poll:     ${status.pollMs}ms`);
      for (const root of status.roots) {
        console.log(`  ${root.exists ? "ok " : "miss"} ${root.source.padEnd(7)} ${root.root}`);
      }
      return;
    }
    if (opts.initial !== false) {
      console.log("Initial ingest…");
      for (const r of await getLocalStore().ingest({ sources })) {
        console.log(`  ${r.source}: ${r.sessions} sessions (${r.ingested} files, ${r.skipped} unchanged)`);
      }
    } else {
      console.log("Initial ingest skipped.");
    }
    const watcher = startWatch({
      sources,
      debounceMs,
      pollMs,
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
    const { resolveSessionStore } = await import("../db/session-store.js");
    const sessions = await resolveSessionStore().list({ machine: opts.machine, limit: parseInt(opts.limit ?? "20", 10) || 20 });
    if (opts.json) return void printJson(sessions);
    for (const s of sessions) {
      console.log(
        `${(s.started_at ?? "").slice(0, 16).padEnd(16)}  ${(s.machine ?? "?").padEnd(9)} ${s.source.padEnd(7)} ${(s.project_name ?? "").padEnd(18)} ${s.title ?? "(untitled)"}  ${s.id.slice(0, 8)}`
      );
    }
  });

program
  .command("list-indexed")
  .alias("indexed-list")
  .description("List indexed sessions, optionally filtered")
  .option("-s, --source <source>", "Filter by provider")
  .option("-p, --project <value>", "Filter by project name or path")
  .option("-m, --machine <name>", "Filter by machine")
  .option("-l, --limit <n>", "Maximum results", "50")
  .option("--json", "Output as JSON")
  .action(async (opts: { source?: string; project?: string; machine?: string; limit?: string; json?: boolean }) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    const sessions = await resolveSessionStore().list({
      source: opts.source,
      project_path: opts.project,
      machine: opts.machine,
      limit: parseInt(opts.limit ?? "50", 10) || 50,
    });
    if (opts.json) return void printJson(sessions);
    for (const s of sessions) {
      console.log(`${(s.machine ?? "?").padEnd(9)} ${s.source.padEnd(7)} ${(s.project_name ?? "").padEnd(18)} ${s.title ?? "(untitled)"}  ${s.id.slice(0, 8)}`);
    }
  });

program
  .command("show <id>")
  .description("Show a session's details and message previews (id or unique prefix)")
  .option("-s, --source <source>", "Resolve the id as a native source id for this source")
  .option("-m, --messages <n>", "How many messages to preview", "12")
  .option("--json", "Output as JSON")
  .action(async (id: string, opts: { source?: string; messages?: string; json?: boolean }) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    const store = resolveSessionStore();
    let s: Session | null;
    try {
      s = await store.get(id, { source: opts.source });
    } catch (error) {
      failCli(error);
    }
    if (!s) {
      console.error(`Session not found (or ambiguous prefix): ${id}`);
      process.exit(1);
    }
    // Message/tool-call bodies come through the Store: local SQLite in local mode
    // or the authenticated /v1 content endpoints in self_hosted mode.
    const messages = await store.messages(s.id);
    const tools = await store.toolCalls(s.id);
    const n = parsePositiveIntOption(opts.messages, 12, "--messages");
    const previewMessages = messages.slice(0, n);
    if (opts.json) return void printJson({ session: s, messages: previewMessages, tools });
    console.log(`${s.title ?? "(untitled)"}`);
    console.log(`  source:   ${s.source}   model: ${s.model ?? "?"}`);
    console.log(`  project:  ${s.project_name ?? "?"} (${s.project_path ?? "?"})`);
    console.log(`  git:      ${s.git_branch ?? "?"}`);
    console.log(`  when:     ${s.started_at ?? "?"} → ${s.ended_at ?? "?"}`);
    console.log(`  counts:   ${s.message_count} messages, ${s.tool_call_count} tool calls, ${s.total_input_tokens + s.total_output_tokens} tokens`);
    console.log(`  id:       ${s.id}`);
    console.log("");
    for (const m of previewMessages) {
      console.log(`  [${m.role}] ${(m.content ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
    }
    if (tools.length) console.log(`\n  tools used: ${[...new Set(tools.map((t) => t.tool_name))].join(", ")}`);
  });

program
  .command("stats")
  .description("Show ingestion and project statistics")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    const stats = await resolveSessionStore().stats();
    if (opts.json) return void printJson(stats);
    console.log("By source:");
    for (const s of stats.by_source) {
      console.log(`  ${s.source.padEnd(8)} ${s.sessions} sessions`);
    }
    console.log(`\nTotals: ${stats.session_count} sessions, ${stats.message_count} messages, ${stats.tool_call_count} tool calls`);
    console.log("\nTop projects:");
    for (const p of stats.projects.slice(0, 15)) {
      console.log(`  ${String(p.session_count).padStart(4)}  ${p.project_name ?? p.project_path}`);
    }
  });

program
  .command("create")
  .description("Create a session record in the active store (local index, or the self_hosted /v1 API when HASNA_SESSIONS_API_URL + HASNA_SESSIONS_API_KEY are set)")
  .requiredOption("--source <source>", "Session source: claude, codex, codewith, or gemini")
  .requiredOption("--source-id <id>", "Provider-native session id")
  .option("--title <title>", "Session title")
  .option("--project-path <path>", "Project path")
  .option("--project-name <name>", "Project name")
  .option("--model <model>", "Model")
  .option("--machine <machine>", "Machine name")
  .option("--json", "Output as JSON")
  .action(async (opts: {
    source: string;
    sourceId: string;
    title?: string;
    projectPath?: string;
    projectName?: string;
    model?: string;
    machine?: string;
    json?: boolean;
  }) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    const session = await resolveSessionStore().create({
      source: opts.source,
      source_id: opts.sourceId,
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.projectPath !== undefined ? { project_path: opts.projectPath } : {}),
      ...(opts.projectName !== undefined ? { project_name: opts.projectName } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.machine !== undefined ? { machine: opts.machine } : {}),
    });
    if (opts.json) return void printJson(session);
    console.log(`Created session ${session.id} (${session.source}:${session.source_id})`);
  });

program
  .command("delete <id>")
  .description("Delete a session record from the active store (local index, or the self_hosted /v1 API when HASNA_SESSIONS_API_URL + HASNA_SESSIONS_API_KEY are set)")
  .option("--json", "Output as JSON")
  .action(async (id: string, opts: { json?: boolean }) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    const deleted = await resolveSessionStore().remove(id);
    if (opts.json) return void printJson({ deleted, id });
    if (deleted) console.log(`Deleted session ${id}`);
    else {
      console.error(`Session not found: ${id}`);
      process.exit(1);
    }
  });

program
  .command("graph")
  .description("Explore the session knowledge graph — entities (projects/tools/models/repos) and links")
  .option("-t, --type <type>", "List one entity type: project, tool, model, provider, repo")
  .option("-r, --related <type:name>", "Sessions related to an entity, e.g. tool:Bash or project:infra")
  .option("--session <id>", "Show a single session's entity neighborhood")
  .option("-s, --source <source>", "Resolve --session as a native source id for this source")
  .option("-l, --limit <n>", "Max results", "50")
  .option("--json", "Output as JSON")
  .action(async (opts: { type?: string; related?: string; session?: string; source?: string; limit?: string; json?: boolean }) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    const store = resolveSessionStore();
    type EntityType = "project" | "tool" | "model" | "provider" | "repo";
    const TYPES = ["project", "tool", "model", "provider", "repo"];
    const limit = parseInt(opts.limit ?? "50", 10) || 50;

    if (opts.session) {
      let g;
      try {
        g = await store.graphSession(opts.session, { source: opts.source });
      } catch (error) {
        failCli(error);
      }
      if (!g) {
        console.error(`Session not found: ${opts.session}`);
        process.exit(1);
      }
      if (opts.json) return void printJson(g);
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
      const sessions = await store.graphRelated(type as EntityType, name, limit);
      if (opts.json) return void printJson(sessions);
      for (const s of sessions) {
        console.log(`${s.source.padEnd(7)} ${(s.project_name ?? "").padEnd(20)} ${s.title ?? "(untitled)"}  ${s.session_id.slice(0, 8)}`);
      }
      return;
    }

    if (opts.type && !TYPES.includes(opts.type)) {
      console.error(`Unknown type '${opts.type}'. Use: ${TYPES.join(", ")}`);
      process.exit(1);
    }
    const entities = await store.graphEntities(opts.type as EntityType | undefined);
    if (opts.json) return void printJson(entities);
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
    const { resolveSessionStore } = await import("../db/session-store.js");
    try {
      const result = await resolveSessionStore().embed({ limit: parseInt(opts.limit ?? "200", 10) || 200 });
      if (opts.json) return void printJson(result);
      console.log(`Embedded ${result.chunksEmbedded} chunks across ${result.messagesProcessed} messages.`);
    } catch (err) {
      console.error(`Embed failed (is OPENAI_API_KEY set?): ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("search-indexed <query>")
  .aliases(["search", "indexed-search"])
  .description("Full-text search across your indexed AI coding sessions")
  .option("-s, --source <source>", "Filter by provider: claude, codex, codewith, or gemini")
  .option("-p, --project <value>", "Filter by project name or path")
  .option("-m, --machine <name>", "Filter by machine (laptop-a, workstation-b, ...)")
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
      const { resolveSessionStore } = await import("../db/session-store.js");
      const store = resolveSessionStore();
      const limit = parsePositiveIntOption(opts.limit, 20, "--limit");
      const o = { limit, source: opts.source, project_path: opts.project, machine: opts.machine };

      if (opts.tools) {
        const hits = await store.searchToolCalls(query, o);
        if (opts.json) return void printJson(hits);
        if (hits.length === 0) return void console.log("No matching tool calls.");
        for (const h of hits) {
          console.log(`${h.source}  ${h.tool_name}${h.project_name ? `  [${h.project_name}]` : ""}`);
          console.log(`  ${h.snippet}`);
        }
        return;
      }

      let hits;
      if (opts.semantic || opts.hybrid) {
        try {
          hits = opts.hybrid ? await store.hybridSearch(query, o) : await store.semanticSearch(query, o);
        } catch (err) {
          console.error(`Semantic search failed (is OPENAI_API_KEY set and have you run 'sessions embed'?): ${(err as Error).message}`);
          process.exit(1);
        }
      } else {
        hits = await store.searchContent(query, o);
      }
      if (opts.json) return void printJson(hits);
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
  .command("recall <query>")
  .description("Recall a coding session by natural language, with evidence, touched files, graph context, and resume metadata")
  .option("-s, --source <source>", "Filter by provider: claude, codex, codewith, or gemini")
  .option("-p, --project <value>", "Filter by project name or path")
  .option("-m, --machine <name>", "Filter by machine")
  .option("-l, --limit <n>", "Maximum results", "10")
  .option("--no-semantic", "Disable semantic/vector recall even when embeddings are available")
  .option("--json", "Output as JSON")
  .action(
    async (
      query: string,
      opts: { source?: string; project?: string; machine?: string; limit?: string; semantic?: boolean; json?: boolean }
    ) => {
      const limit = parsePositiveIntOption(opts.limit, 10, "--limit");
      const { resolveSessionStore } = await import("../db/session-store.js");
      const response = await resolveSessionStore().recall(query, {
        source: opts.source,
        project_path: opts.project,
        machine: opts.machine,
        limit,
        semantic: opts.semantic,
      });

      if (opts.json) return void printJson(response);
      if (response.results.length === 0) {
        console.log("No matching sessions found.");
        if (response.metadata.semantic.reason) {
          console.log(`semantic: ${response.metadata.semantic.reason}`);
        }
        return;
      }

      for (const result of response.results) {
        console.log(
          `#${result.rank} ${result.source}  ${result.title ?? "(untitled)"}${result.project_name ? `  [${result.project_name}]` : ""}`
        );
        console.log(`  score: ${result.score}  id: ${result.session_id}  updated: ${result.updated_at ?? "?"}`);
        console.log(`  reason: ${result.reason}`);
        for (const evidence of result.evidence.slice(0, 3)) {
          console.log(`  evidence (${evidence.kind}): ${evidence.snippet.replace(/\s+/g, " ")}`);
        }
        if (result.touched_file_paths.length > 0) {
          console.log(`  files: ${result.touched_file_paths.slice(0, 6).join(", ")}`);
        }
        if (result.related_graph_entities.tools.length > 0) {
          console.log(`  graph: project=${result.related_graph_entities.project ?? "?"} tools=${result.related_graph_entities.tools.slice(0, 6).join(", ")}`);
        }
        if (result.resume.available) {
          console.log(`  resume: ${result.resume.shell_command}`);
        } else {
          console.log(`  resume: unavailable (${result.resume.reason})`);
        }
      }

      if (response.metadata.semantic.reason) {
        console.log(`\nsemantic: ${response.metadata.semantic.reason}`);
      }
    }
  );

async function runIngestCommand(opts: { source?: string; force?: boolean; verbose?: boolean; json?: boolean }) {
  const { getLocalStore } = await import("../db/session-store.js");
  const onProgress = opts.verbose ? (m: string) => console.log(m) : undefined;
  try {
    const results = await getLocalStore().ingest({
      source: opts.source,
      force: opts.force,
      onProgress,
    });
    if (opts.json) {
      printJson(results);
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
}

function addIngestCommand(name: string, description: string) {
  program
    .command(name)
    .description(description)
    .option("-s, --source <source>", "Only ingest one provider: claude, codex, codewith, or gemini")
    .option("-f, --force", "Re-ingest even files that are unchanged since last run")
    .option("-v, --verbose", "Print each file as it is ingested")
    .option("--json", "Output the result as JSON")
    .action(runIngestCommand);
}

addIngestCommand("ingest", "Index AI coding sessions (claude, codex, codewith, gemini) into the searchable database");
addIngestCommand("reindex", "Alias for ingest; refresh the searchable session index");

// Use parseAsync + a single top-level catch so async command actions that throw
// (e.g. a cloud /v1 HTTP error, or an operation not served by the cloud API like
// `recall` in self_hosted mode) surface a clean one-line message and a non-zero
// exit — never an unhandled-rejection stack trace.
program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
