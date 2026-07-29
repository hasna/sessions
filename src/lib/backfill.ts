import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { SessionParser } from "./ingest/types.js";
import { listParsers } from "./ingest/index.js";
import { getSessionsDir } from "./paths.js";
import type { SessionStore } from "../db/session-store.js";
import { resolveStorageMode } from "../generated/storage-kit/mode.js";
import type {
  MessageInsert,
  ParsedSession,
  SessionContentBackup,
  SessionContentImport,
  SessionInsert,
  SessionSource,
  StagedParsedSession,
  ToolCallInsert,
} from "../types/index.js";
import { isSessionSource } from "../types/index.js";
import {
  checkpointEntry,
  checkpointPath,
  hasSameCheckpointProvenance,
  inventoryParsers,
  materializeEntry,
  parseBackfillKey,
  positiveInt,
  readCheckpoint,
  requestedSourceList,
  selectEntries,
  selectParsers,
  writeCheckpoint,
} from "./backfill-inventory.js";

const CHECKPOINT_VERSION = 2;
const DEFAULT_BATCH_SIZE = 128;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_MAX_SESSION_BYTES = 64 * 1024 * 1024;
const APPLY_CONFIRMATION = "BACKFILL_APPLY";

export interface BackfillKey {
  source: SessionSource;
  sourceId: string;
  key: string;
}

export interface BackfillInventoryEntry extends BackfillKey {
  sourcePath: string | null;
  messageCount: number;
  toolCallCount: number;
  estimatedBytes: number;
  maxBufferedLineBytes: number;
  maxNormalizedBatchRecords: number;
  sourceContentDigest: string;
  runConfigDigest: string;
  duplicateOf: string | null;
}

export interface BackfillCheckpointEntry {
  source: SessionSource;
  sourceId: string;
  sourcePath: string | null;
  estimatedBytes: number;
  messages: number;
  toolCalls: number;
  sourceContentDigest: string;
  runConfigDigest: string;
  updatedAt: string;
  note?: string;
}

export interface BackfillCheckpoint {
  version: typeof CHECKPOINT_VERSION;
  createdAt: string;
  updatedAt: string;
  completed: Record<string, BackfillCheckpointEntry>;
  failed: Record<string, BackfillCheckpointEntry>;
  skipped: Record<string, BackfillCheckpointEntry>;
}

export interface BackfillRunOptions {
  apply?: boolean;
  confirmApply?: string;
  allowProduction?: boolean;
  batchSize?: number;
  concurrency?: number;
  source?: SessionSource | string;
  sources?: Array<SessionSource | string>;
  pilot?: number;
  rangeStart?: string;
  rangeEnd?: string;
  allSources?: boolean;
  knownIds?: string[];
  checkpointPath?: string;
  backupCommand?: string;
  maxSessionBytes?: number;
  maxTotalBytes?: number;
  env?: Record<string, string | undefined>;
  parsers?: SessionParser[];
  store?: SessionStore;
  now?: () => Date;
}

export interface BackfillRunResult {
  target: "self_hosted_api";
  dryRun: boolean;
  mode: "inventory" | "apply";
  inventory: {
    files: number;
    sessions: number;
    selectableSessions: number;
    duplicates: number;
    errors: number;
    messages: number;
    toolCalls: number;
    estimatedBytes: number;
    largestSessionBytes: number;
    maxBufferedLineBytes: number;
    maxNormalizedBatchRecords: number;
  };
  selection: {
    requestedSources: string[];
    pilot: number | null;
    rangeStart: string | null;
    rangeEnd: string | null;
    selected: number;
    selectedMessages: number;
    selectedToolCalls: number;
    selectedEstimatedBytes: number;
    selectedKeys: string[];
    knownIds: Array<BackfillKey & { found: boolean; selected: boolean; verified: boolean | null }>;
  };
  limits: {
    batchSize: number;
    concurrency: number;
    maxSessionBytes: number;
    maxTotalBytes: number | null;
    maxResidentSessionPayloadBytes: number;
  };
  gates: {
    confirmation: { required: string; satisfied: boolean };
    production: { url: string | null; productionLike: boolean; allowed: boolean };
    capacity: { checked: boolean; allowed: boolean; reason: string | null };
    backup: {
      required: boolean;
      configured: boolean;
      ran: boolean;
      exitCode: number | null;
      verified: SessionContentBackup | null;
      reason: string | null;
    };
  };
  checkpoint: {
    path: string;
    loadedCompleted: number;
    completed: number;
    failed: number;
    skipped: number;
    resumedSkipped: number;
  };
  applied: {
    attempted: number;
    pushed: number;
    failed: number;
    skipped: number;
    verifiedKnownIds: number;
    maxMaterializedSessionBytes: number;
    maxMaterializedBatchRecords: number;
  };
  duplicates: Array<{ key: string; kept: string | null; duplicate: string | null }>;
  errors: string[];
  warnings: string[];
}

async function completedCheckpointHasVerifiedDestination(
  store: SessionStore,
  entry: BackfillInventoryEntry,
  completed: BackfillCheckpointEntry,
): Promise<boolean> {
  if (!hasSameCheckpointProvenance(completed, entry)) return false;
  const session = await store.get(entry.sourceId, { source: entry.source });
  const backfill = session?.metadata?.backfill as Record<string, unknown> | undefined;
  const destinationMatches = Boolean(
    session &&
      session.source === entry.source &&
      session.source_id === entry.sourceId &&
      session.source_path === entry.sourcePath &&
      session.message_count === entry.messageCount &&
      session.tool_call_count === entry.toolCallCount,
  );
  return Boolean(
    destinationMatches &&
    backfill &&
      backfill?.version === CHECKPOINT_VERSION &&
      backfill?.sourceContentDigest === entry.sourceContentDigest &&
      backfill?.runConfigDigest === entry.runConfigDigest,
  );
}

function runBackupCommand(command: string | undefined, apply: boolean): BackfillRunResult["gates"]["backup"] {
  const trimmed = command?.trim();
  if (!apply) {
    return {
      required: false,
      configured: Boolean(trimmed),
      ran: false,
      exitCode: null,
      verified: null,
      reason: trimmed ? "dry-run" : null,
    };
  }
  if (!trimmed) {
    return {
      required: true,
      configured: false,
      ran: false,
      exitCode: null,
      verified: null,
      reason: "apply requires --backup-command to complete a backup/capacity preflight gate",
    };
  }
  const result = spawnSync(trimmed, { shell: true, stdio: "ignore" });
  const exitCode = result.error ? 1 : result.status ?? (result.signal ? 1 : 0);
  return {
    required: true,
    configured: true,
    ran: true,
    exitCode,
    verified:
      exitCode === 0
        ? {
            artifact: null,
            created_at: new Date().toISOString(),
            note: "user-supplied backfill backup command completed before apply",
          }
        : null,
    reason: exitCode === 0 ? null : `backup command failed with exit ${exitCode}`,
  };
}

/**
 * Operator-configured production host suffixes (comma/space separated), e.g.
 * `HASNA_SESSIONS_PRODUCTION_HOSTS=your-domain.example`. This published package does not
 * ship a built-in production hostname — operators who want the API URL alone to
 * trip the production safety gate must set this (or the blanket
 * `HASNA_SESSIONS_PRODUCTION=1` override) explicitly.
 */
function productionHostSuffixes(env: Record<string, string | undefined>): string[] {
  const raw = env.HASNA_SESSIONS_PRODUCTION_HOSTS?.trim();
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((suffix) => suffix.trim().toLowerCase())
    .filter((suffix) => suffix.length > 0);
}

function isProductionLikeUrl(raw: string | undefined, env: Record<string, string | undefined> = process.env): boolean {
  if (env.HASNA_SESSIONS_PRODUCTION === "1" || env.HASNA_SESSIONS_PRODUCTION === "true") return true;
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return productionHostSuffixes(env).some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function isProductionLikeTarget(opts: BackfillRunOptions, apiUrl: string | null, env: Record<string, string | undefined>): boolean {
  return isProductionLikeUrl(apiUrl ?? undefined, env) || Boolean(opts.apply && opts.store?.mode === "cloud" && !apiUrl);
}

function productionTargetDescription(opts: BackfillRunOptions, apiUrl: string | null): string {
  if (apiUrl) return `API URL ${apiUrl}`;
  if (opts.store?.mode === "cloud") return "injected cloud store";
  return "target";
}

const API_URL_ENV_KEYS = ["HASNA_SESSIONS_API_URL", "SESSIONS_API_URL"];

function firstEnv(env: Record<string, string | undefined>, keys: string[]): string | null {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
}

function isApplyStoreModeAllowed(opts: BackfillRunOptions, env: Record<string, string | undefined>): boolean {
  if (!opts.apply) return true;
  if (opts.store) return opts.store.mode === "cloud";
  const clientMode = firstEnv(env, ["HASNA_SESSIONS_MODE", "SESSIONS_MODE"]);
  const storageMode = resolveStorageMode("sessions", env).mode;
  const normalizedMode = (clientMode ?? storageMode).toLowerCase().replace(/-/g, "_");
  const cloudLikeMode = normalizedMode === "cloud" || normalizedMode === "self_hosted" || normalizedMode === "remote" || normalizedMode === "hybrid";
  const apiUrlPresent = Boolean(firstEnv(env, API_URL_ENV_KEYS));
  const apiKeyPresent = Boolean(firstEnv(env, ["HASNA_SESSIONS_API_KEY", "SESSIONS_API_KEY"]));
  return cloudLikeMode && apiUrlPresent && apiKeyPresent;
}

async function resolveApplyStore(opts: BackfillRunOptions): Promise<SessionStore> {
  if (opts.store) return opts.store;
  const { resolveSessionStore } = await import("../db/session-store.js");
  return resolveSessionStore();
}

function createResult(
  opts: BackfillRunOptions,
  entries: BackfillInventoryEntry[],
  selected: BackfillInventoryEntry[],
  files: number,
  inventoryErrors: string[],
  checkpoint: BackfillCheckpoint,
  path: string,
  batchSize: number,
  concurrency: number,
  maxSessionBytes: number,
  maxTotalBytes: number | null,
): BackfillRunResult {
  const apply = Boolean(opts.apply);
  const env = opts.env ?? process.env;
  const apiUrl = firstEnv(env, API_URL_ENV_KEYS);
  const duplicateEntries = entries.filter((entry) => entry.duplicateOf);
  const known = (opts.knownIds ?? []).map(parseBackfillKey);
  const selectedKeys = new Set(selected.map((entry) => entry.key));
  const allKeys = new Set(entries.map((entry) => entry.key));
  const selectedEstimatedBytes = selected.reduce((sum, entry) => sum + entry.estimatedBytes, 0);
  const largestSessionBytes = entries.reduce((max, entry) => Math.max(max, entry.estimatedBytes), 0);
  const selectedLargestSessionBytes = selected.reduce((max, entry) => Math.max(max, entry.estimatedBytes), 0);
  const productionLike = isProductionLikeTarget(opts, apiUrl, env);
  const capacityReason =
    apply && maxTotalBytes === null
      ? "apply requires --max-total-bytes so the capacity gate is explicit"
      : selectedLargestSessionBytes > maxSessionBytes
        ? `selected session estimate ${selectedLargestSessionBytes} exceeds max session bytes ${maxSessionBytes}`
        : maxTotalBytes !== null && selectedEstimatedBytes > maxTotalBytes
          ? `selected estimate ${selectedEstimatedBytes} exceeds max total bytes ${maxTotalBytes}`
          : null;
  const confirmationSatisfied = !apply || opts.confirmApply === APPLY_CONFIRMATION;
  const productionAllowed = !apply || !productionLike || Boolean(opts.allowProduction);
  const hasSourceBoundary = requestedSourceList(opts).length > 0;
  const hasRangeBoundary = Boolean(opts.rangeStart || opts.rangeEnd);
  const hasPilotBoundary = opts.pilot != null;
  const hasKnownIdBoundary = known.length > 0;
  const contradictorySelectors = Boolean(opts.allSources && known.length > 0);
  const applyBoundaryAllowed =
    !apply ||
    (!contradictorySelectors &&
      ((hasSourceBoundary && (hasRangeBoundary || hasPilotBoundary || hasKnownIdBoundary)) || Boolean(opts.allSources)));
  const capacityAllowed = capacityReason === null;
  const storeModeAllowed = isApplyStoreModeAllowed(opts, env);
  const backupPreflightAllowed = apply && confirmationSatisfied && productionAllowed && applyBoundaryAllowed && capacityAllowed && storeModeAllowed;
  const backup = backupPreflightAllowed
    ? runBackupCommand(opts.backupCommand, true)
    : runBackupCommand(opts.backupCommand, false);
  if (apply && !backupPreflightAllowed) {
    backup.required = true;
    backup.reason = "backup command not run because earlier apply preflight gates failed";
  }
  const result: BackfillRunResult = {
    target: "self_hosted_api",
    dryRun: !apply,
    mode: apply ? "apply" : "inventory",
    inventory: {
      files,
      sessions: entries.length,
      selectableSessions: entries.length - duplicateEntries.length,
      duplicates: duplicateEntries.length,
      errors: inventoryErrors.length,
      messages: entries.reduce((sum, entry) => sum + entry.messageCount, 0),
      toolCalls: entries.reduce((sum, entry) => sum + entry.toolCallCount, 0),
      estimatedBytes: entries.reduce((sum, entry) => sum + entry.estimatedBytes, 0),
      largestSessionBytes,
      maxBufferedLineBytes: entries.reduce((max, entry) => Math.max(max, entry.maxBufferedLineBytes), 0),
      maxNormalizedBatchRecords: entries.reduce((max, entry) => Math.max(max, entry.maxNormalizedBatchRecords), 0),
    },
    selection: {
      requestedSources: requestedSourceList(opts),
      pilot: opts.pilot ?? null,
      rangeStart: opts.rangeStart ?? null,
      rangeEnd: opts.rangeEnd ?? null,
      selected: selected.length,
      selectedMessages: selected.reduce((sum, entry) => sum + entry.messageCount, 0),
      selectedToolCalls: selected.reduce((sum, entry) => sum + entry.toolCallCount, 0),
      selectedEstimatedBytes,
      selectedKeys: [...selectedKeys],
      knownIds: known.map((id) => ({
        ...id,
        found: allKeys.has(id.key),
        selected: selectedKeys.has(id.key),
        verified: null,
      })),
    },
    limits: {
      batchSize,
      concurrency,
      maxSessionBytes,
      maxTotalBytes,
      maxResidentSessionPayloadBytes: maxSessionBytes * concurrency,
    },
    gates: {
      confirmation: { required: APPLY_CONFIRMATION, satisfied: confirmationSatisfied },
      production: { url: apiUrl, productionLike, allowed: productionAllowed },
      capacity: { checked: true, allowed: capacityAllowed, reason: capacityReason },
      backup,
    },
    checkpoint: {
      path,
      loadedCompleted: Object.keys(checkpoint.completed).length,
      completed: 0,
      failed: 0,
      skipped: 0,
      resumedSkipped: 0,
    },
    applied: {
      attempted: 0,
      pushed: 0,
      failed: 0,
      skipped: 0,
      verifiedKnownIds: 0,
      maxMaterializedSessionBytes: 0,
      maxMaterializedBatchRecords: 0,
    },
    duplicates: duplicateEntries.map((entry) => ({
      key: entry.key,
      kept: entry.duplicateOf,
      duplicate: entry.sourcePath,
    })),
    errors: [...inventoryErrors],
    warnings: [],
  };

  for (const knownId of result.selection.knownIds) {
    if (!knownId.found) result.errors.push(`known id not found in inventory: ${knownId.key}`);
    else if (!knownId.selected) result.errors.push(`known id is outside the selected backfill range: ${knownId.key}`);
  }
  if (apply && !result.gates.confirmation.satisfied) {
    result.errors.push(`apply requires --confirm-apply ${APPLY_CONFIRMATION}`);
  }
  if (apply && !applyBoundaryAllowed) {
    result.errors.push("apply requires an explicit boundary: --source plus --pilot, --range-start/--range-end, or --known-id; use --all-sources to acknowledge all non-duplicate sessions");
  }
  if (apply && contradictorySelectors) {
    result.errors.push("apply selectors are contradictory: --all-sources cannot be combined with --known-id");
  }
  if (apply && !result.gates.production.allowed) {
    result.errors.push(`production-like ${productionTargetDescription(opts, apiUrl)} requires --allow-production and separate out-of-band user approval`);
  }
  if (apply && !result.gates.capacity.allowed && result.gates.capacity.reason) {
    result.errors.push(result.gates.capacity.reason);
  }
  if (apply && !storeModeAllowed) {
    result.errors.push("apply requires self_hosted/cloud API mode; local mode is inventory-only");
  }
  if (apply && backup.reason) result.errors.push(backup.reason);
  return result;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

export async function runSessionBackfill(opts: BackfillRunOptions = {}): Promise<BackfillRunResult> {
  const now = opts.now ?? (() => new Date());
  const batchSize = positiveInt(opts.batchSize, DEFAULT_BATCH_SIZE, "--batch-size");
  const concurrency = positiveInt(opts.concurrency, DEFAULT_CONCURRENCY, "--concurrency");
  const maxSessionBytes = positiveInt(opts.maxSessionBytes, DEFAULT_MAX_SESSION_BYTES, "--max-session-bytes");
  const maxTotalBytes = opts.maxTotalBytes == null ? null : positiveInt(opts.maxTotalBytes, DEFAULT_MAX_SESSION_BYTES, "--max-total-bytes");
  const parsers = selectParsers(opts);
  const checkpointFile = checkpointPath(opts.checkpointPath);
  const checkpoint = readCheckpoint(checkpointFile, now);
  const inventory = inventoryParsers(parsers, batchSize, maxSessionBytes);
  const selected = selectEntries(inventory.entries, opts);
  const result = createResult(
    opts,
    inventory.entries,
    selected,
    inventory.files,
    inventory.errors,
    checkpoint,
    checkpointFile,
    batchSize,
    concurrency,
    maxSessionBytes,
    maxTotalBytes,
  );

  if (!opts.apply || result.errors.length > 0) return result;

  const store = await resolveApplyStore(opts);
  if (store.mode !== "cloud") {
    result.errors.push("apply requires self_hosted/cloud API mode; local mode is inventory-only");
    return result;
  }

  const pending: BackfillInventoryEntry[] = [];
  for (const entry of selected) {
    const completed = checkpoint.completed[entry.key];
    if (completed && (await completedCheckpointHasVerifiedDestination(store, entry, completed))) {
      result.checkpoint.resumedSkipped++;
      result.applied.skipped++;
      continue;
    }
    if (completed) {
      result.warnings.push(`${entry.key}: quarantined invalid completed checkpoint entry; current inventory will be re-imported`);
      checkpoint.skipped[entry.key] = checkpointEntry(entry, now, "invalid completed checkpoint entry quarantined before re-import");
      delete checkpoint.completed[entry.key];
      writeCheckpoint(checkpointFile, checkpoint, now);
    }
    pending.push(entry);
  }

  await runWithConcurrency(pending, concurrency, async (entry) => {
    result.applied.attempted++;
    try {
      const materialized = materializeEntry(parsers, entry, batchSize, maxSessionBytes);
      result.applied.maxMaterializedSessionBytes = Math.max(
        result.applied.maxMaterializedSessionBytes,
        materialized.estimatedBytes,
      );
      result.applied.maxMaterializedBatchRecords = Math.max(
        result.applied.maxMaterializedBatchRecords,
        materialized.maxBatchRecords,
      );
      if (materialized.estimatedBytes > maxSessionBytes) {
        throw new Error(`${entry.key}: materialized payload ${materialized.estimatedBytes} exceeds max session bytes ${maxSessionBytes}`);
      }
      await store.importContent({
        ...materialized.input,
        backup: result.gates.backup.verified ?? undefined,
      });
      checkpoint.completed[entry.key] = checkpointEntry(entry, now);
      delete checkpoint.failed[entry.key];
      delete checkpoint.skipped[entry.key];
      result.applied.pushed++;
      result.checkpoint.completed++;
      writeCheckpoint(checkpointFile, checkpoint, now);
    } catch (error) {
      const message = (error as Error).message;
      checkpoint.failed[entry.key] = checkpointEntry(entry, now, message);
      result.errors.push(`${entry.key}: ${message}`);
      result.applied.failed++;
      result.checkpoint.failed++;
      writeCheckpoint(checkpointFile, checkpoint, now);
    }
  });

  for (const known of result.selection.knownIds) {
    if (!known.selected) continue;
    const session = await store.get(known.sourceId, { source: known.source });
    known.verified = Boolean(session);
    if (session) {
      result.applied.verifiedKnownIds++;
    } else {
      result.errors.push(`known id did not verify after apply: ${known.key}`);
    }
  }

  return result;
}

export { APPLY_CONFIRMATION };
