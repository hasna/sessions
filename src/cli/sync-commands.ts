import type { Command } from "commander";
import { spawnSync } from "node:child_process";
import { formatBytes } from "../lib/transfer.js";
import {
  collectRepeatableOption,
  failCli,
  parseNonNegativeIntOption,
  parsePositiveIntOption,
  preCloudSyncBackupRecord,
  printJson,
  writeStdout,
} from "./common.js";

export function registerSyncCommands(program: Command): void {
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
  .option("--allow-production", "Permit production-like API URLs after separate out-of-band user approval")
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

// Default number of local sessions scanned per content-sync cycle. A bare `sessions sync`
// on a large store (~13k sessions) would otherwise scan and parse every session and hang
// with no progress; both `sync` and `daemon` share this bounded default so a single command
// completes promptly. Pass --limit to scan more.
const DEFAULT_SYNC_LIMIT = 500;

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
  const limit = parsePositiveIntOption(opts.limit, DEFAULT_SYNC_LIMIT, "--limit");
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
  .option("-l, --limit <n>", "Maximum local sessions to scan per cycle", String(DEFAULT_SYNC_LIMIT))
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
  .option("-l, --limit <n>", "Maximum local sessions to scan per cycle", String(DEFAULT_SYNC_LIMIT))
  .option("--interval <seconds>", "Watch interval in seconds (minimum 5)", "60")
  .option("--max-iterations <n>", "Stop after n cycles; pass a larger value for longer supervised runs", "60")
  .option("--backup-command <command>", "Required for live self_hosted pushes; output is suppressed")
  .option("--json", "Emit one JSON object per cycle")
  .action(async (opts: ApiSyncCliOptions) => {
    await runContentSyncCli({ ...opts, watch: true }, "daemon");
  });
}

