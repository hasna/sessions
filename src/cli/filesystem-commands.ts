import type { Command } from "commander";
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
import { relocate } from "../lib/relocate.js";
import { exportSessions, importSessions, formatBytes } from "../lib/transfer.js";
import {
  createExternalHandoffBundleV1,
  renderHandoffSkillWrapper,
  type CodewithLaunchMode,
} from "../lib/handoff.js";
import { getClaudeProjectsDir, encodePath } from "../lib/paths.js";
import {
  collectRepeatableOption,
  parsePositiveIntOption,
  printJson,
  writeStdout,
} from "./common.js";

export function registerFilesystemCommands(program: Command): void {
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
}

