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

type ParsedOrStagedSession =
  | { kind: "parsed"; parsed: ParsedSession; maxBufferedLineBytes: number; maxNormalizedBatchRecords: number; sourceContentDigest: string }
  | { kind: "staged"; staged: StagedParsedSession; maxBufferedLineBytes: number; maxNormalizedBatchRecords: number; sourceContentDigest: string };

interface MaterializedSession {
  input: SessionContentImport;
  estimatedBytes: number;
  maxBatchRecords: number;
}

interface FileSnapshot {
  mtimeMs: number;
  size: number;
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInt(value: number | undefined, fallback: number, name: string): number {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function sha256Json(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function snapshotFile(file: string): FileSnapshot | null {
  try {
    const stat = statSync(file);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function sameSnapshot(a: FileSnapshot, b: FileSnapshot): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function hasSameCheckpointProvenance(
  checkpoint: BackfillCheckpointEntry,
  entry: BackfillInventoryEntry,
): boolean {
  return (
    checkpoint.source === entry.source &&
    checkpoint.sourceId === entry.sourceId &&
    checkpoint.sourcePath === entry.sourcePath &&
    checkpoint.messages === entry.messageCount &&
    checkpoint.toolCalls === entry.toolCallCount &&
    checkpoint.estimatedBytes === entry.estimatedBytes &&
    checkpoint.sourceContentDigest === entry.sourceContentDigest &&
    checkpoint.runConfigDigest === entry.runConfigDigest
  );
}

function hasSameInventoryProvenance(
  fresh: BackfillInventoryEntry,
  selected: BackfillInventoryEntry,
): boolean {
  return (
    fresh.source === selected.source &&
    fresh.sourceId === selected.sourceId &&
    fresh.sourcePath === selected.sourcePath &&
    fresh.messageCount === selected.messageCount &&
    fresh.toolCallCount === selected.toolCallCount &&
    fresh.estimatedBytes === selected.estimatedBytes &&
    fresh.sourceContentDigest === selected.sourceContentDigest &&
    fresh.runConfigDigest === selected.runConfigDigest
  );
}

function sessionKey(source: string, sourceId: string): string {
  return `${source}:${sourceId}`;
}

function parseBackfillKey(raw: string): BackfillKey {
  const colon = raw.indexOf(":");
  if (colon <= 0 || colon === raw.length - 1) {
    throw new Error(`backfill ids must be source-qualified as <source>:<source_id>: ${raw}`);
  }
  const source = raw.slice(0, colon);
  if (!isSessionSource(source)) {
    throw new Error(`unknown session source '${source}' in id '${raw}'`);
  }
  const sourceId = raw.slice(colon + 1);
  return { source, sourceId, key: sessionKey(source, sourceId) };
}

function checkpointPath(path: string | undefined): string {
  return path ?? join(getSessionsDir(), "backfill", "checkpoint.json");
}

function emptyCheckpoint(now: () => Date): BackfillCheckpoint {
  const ts = nowIso(now);
  return {
    version: CHECKPOINT_VERSION,
    createdAt: ts,
    updatedAt: ts,
    completed: {},
    failed: {},
    skipped: {},
  };
}

function readCheckpoint(path: string, now: () => Date): BackfillCheckpoint {
  if (!existsSync(path)) return emptyCheckpoint(now);
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as BackfillCheckpoint;
  if (parsed.version !== CHECKPOINT_VERSION) {
    return {
      ...emptyCheckpoint(now),
      skipped: Object.fromEntries(
        Object.entries(parsed.completed ?? {}).map(([key, value]) => [
          key,
          {
            ...value,
            sourceContentDigest: "unsupported-checkpoint-version",
            runConfigDigest: "unsupported-checkpoint-version",
            note: `unsupported checkpoint version ${String(parsed.version)} ignored before re-import`,
          },
        ]),
      ),
    };
  }
  return {
    ...emptyCheckpoint(now),
    ...parsed,
    completed: parsed.completed ?? {},
    failed: parsed.failed ?? {},
    skipped: parsed.skipped ?? {},
  };
}

function writeCheckpoint(path: string, checkpoint: BackfillCheckpoint, now: () => Date): void {
  mkdirSync(dirname(path), { recursive: true });
  checkpoint.updatedAt = nowIso(now);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

function checkpointEntry(entry: BackfillInventoryEntry, now: () => Date, note?: string): BackfillCheckpointEntry {
  return {
    source: entry.source,
    sourceId: entry.sourceId,
    sourcePath: entry.sourcePath,
    estimatedBytes: entry.estimatedBytes,
    messages: entry.messageCount,
    toolCalls: entry.toolCallCount,
    sourceContentDigest: entry.sourceContentDigest,
    runConfigDigest: entry.runConfigDigest,
    updatedAt: nowIso(now),
    note,
  };
}

function requestedSourceList(opts: BackfillRunOptions): string[] {
  const requested = opts.source ? [opts.source, ...(opts.sources ?? [])] : (opts.sources ?? []);
  if (requested.length === 0) return [];
  const out: string[] = [];
  for (const source of requested) {
    if (!isSessionSource(String(source))) throw new Error(`unknown session source '${String(source)}'`);
    out.push(String(source));
  }
  return [...new Set(out)].sort();
}

function selectParsers(opts: BackfillRunOptions): SessionParser[] {
  const requested = new Set(requestedSourceList(opts));
  const parsers = opts.parsers ?? listParsers();
  const selected = requested.size > 0 ? parsers.filter((parser) => requested.has(parser.source)) : parsers;
  selected.sort((a, b) => a.source.localeCompare(b.source));
  return selected;
}

function estimateParsed(parsed: ParsedSession): number {
  return byteLength(parsed.session) + byteLength(parsed.messages) + byteLength(parsed.toolCalls);
}

function estimateStaged(staged: StagedParsedSession, batchSize: number): { bytes: number; maxBatchRecords: number } {
  let bytes = byteLength(staged.session);
  let maxBatchRecords = 0;
  staged.forEachMessageBatch(batchSize, (batch) => {
    maxBatchRecords = Math.max(maxBatchRecords, batch.length);
    bytes += byteLength(batch);
  });
  staged.forEachToolCallBatch(batchSize, (batch) => {
    maxBatchRecords = Math.max(maxBatchRecords, batch.length);
    bytes += byteLength(batch);
  });
  return { bytes, maxBatchRecords };
}

function bindRunConfig(entry: Omit<BackfillInventoryEntry, "runConfigDigest" | "duplicateOf">): BackfillInventoryEntry {
  return {
    ...entry,
    runConfigDigest: sha256Json({
      version: CHECKPOINT_VERSION,
      source: entry.source,
      sourceId: entry.sourceId,
      sourcePath: entry.sourcePath,
      messageCount: entry.messageCount,
      toolCallCount: entry.toolCallCount,
      estimatedBytes: entry.estimatedBytes,
      sourceContentDigest: entry.sourceContentDigest,
    }),
    duplicateOf: null,
  };
}

function entryFromParsed(
  parsed: ParsedSession,
  maxBufferedLineBytes: number,
  maxNormalizedBatchRecords: number,
  sourceContentDigest: string,
): BackfillInventoryEntry {
  return bindRunConfig({
    source: parsed.session.source,
    sourceId: parsed.session.source_id,
    key: sessionKey(parsed.session.source, parsed.session.source_id),
    sourcePath: parsed.session.source_path ?? null,
    messageCount: parsed.messages.length,
    toolCallCount: parsed.toolCalls.length,
    estimatedBytes: estimateParsed(parsed),
    maxBufferedLineBytes,
    maxNormalizedBatchRecords,
    sourceContentDigest,
  });
}

function entryFromStaged(
  staged: StagedParsedSession,
  batchSize: number,
  maxBufferedLineBytes: number,
  maxNormalizedBatchRecords: number,
  sourceContentDigest: string,
): BackfillInventoryEntry {
  const estimate = estimateStaged(staged, batchSize);
  return bindRunConfig({
    source: staged.session.source,
    sourceId: staged.session.source_id,
    key: sessionKey(staged.session.source, staged.session.source_id),
    sourcePath: staged.session.source_path ?? null,
    messageCount: staged.messageCount,
    toolCallCount: staged.toolCallCount,
    estimatedBytes: estimate.bytes,
    maxBufferedLineBytes,
    maxNormalizedBatchRecords: Math.max(maxNormalizedBatchRecords, estimate.maxBatchRecords),
    sourceContentDigest,
  });
}

function cleanupParsedSessions(sessions: ParsedOrStagedSession[]): void {
  for (const session of sessions) {
    if (session.kind === "staged") session.staged.cleanup();
  }
}

function parseFileSessions(parser: SessionParser, file: string, maxBufferedBytes: number): ParsedOrStagedSession[] {
  const before = snapshotFile(file);
  if (!parser.parseFileResult) {
    throw new Error("parser does not expose bounded parseFileResult for safe backfill");
  }
  const result = parser.parseFileResult(file, { preferStaging: true, maxBufferedBytes });
  const stagedSessions = result.stagedSessions ?? [];
  if ((result.malformedRecordCount ?? 0) > 0) {
    for (const staged of stagedSessions) staged.cleanup();
    throw new Error(`malformed JSONL record count ${result.malformedRecordCount}`);
  }
  if (result.incompleteTrailingRecord) {
    for (const staged of stagedSessions) staged.cleanup();
    throw new Error("incomplete trailing JSONL record");
  }
  const after = snapshotFile(file);
  if (before && !after) {
    for (const staged of stagedSessions) staged.cleanup();
    throw new Error("file vanished after parsing");
  }
  if (before && after && !sameSnapshot(before, after)) {
    for (const staged of stagedSessions) staged.cleanup();
    throw new Error("file changed during parsing");
  }
  if (stagedSessions.length > 0 && !result.sourceContentDigest) {
    for (const staged of stagedSessions) staged.cleanup();
    throw new Error("staged parseFileResult requires sourceContentDigest for safe backfill");
  }
  const out: ParsedOrStagedSession[] = [];
  const sourceContentDigest =
    result.sourceContentDigest ??
    sha256Json({
      file,
      sessions: result.sessions,
      staged: stagedSessions.map((staged) => ({
        source: staged.session.source,
        sourceId: staged.session.source_id,
        messages: staged.messageCount,
        toolCalls: staged.toolCallCount,
      })),
    });
  for (const parsed of result.sessions) {
    out.push({
      kind: "parsed",
      parsed,
      maxBufferedLineBytes: result.maxBufferedLineBytes ?? 0,
      maxNormalizedBatchRecords: result.maxNormalizedBatchRecords ?? Math.max(parsed.messages.length, parsed.toolCalls.length),
      sourceContentDigest,
    });
  }
  for (const staged of stagedSessions) {
    out.push({
      kind: "staged",
      staged,
      maxBufferedLineBytes: result.maxBufferedLineBytes ?? 0,
      maxNormalizedBatchRecords: result.maxNormalizedBatchRecords ?? staged.maxNormalizedBatchRecords,
      sourceContentDigest,
    });
  }
  return out;
}

function inventoryParsers(
  parsers: SessionParser[],
  batchSize: number,
  maxBufferedBytes: number,
): { entries: BackfillInventoryEntry[]; files: number; errors: string[] } {
  const entries: BackfillInventoryEntry[] = [];
  const errors: string[] = [];
  let files = 0;
  for (const parser of parsers) {
    const parserFiles = [...parser.listSessionFiles()].sort();
    files += parserFiles.length;
    for (const file of parserFiles) {
      let sessions: ParsedOrStagedSession[] = [];
      try {
        sessions = parseFileSessions(parser, file, maxBufferedBytes);
        for (const session of sessions) {
          if (session.kind === "parsed") {
            entries.push(entryFromParsed(session.parsed, session.maxBufferedLineBytes, session.maxNormalizedBatchRecords, session.sourceContentDigest));
          } else {
            entries.push(entryFromStaged(session.staged, batchSize, session.maxBufferedLineBytes, session.maxNormalizedBatchRecords, session.sourceContentDigest));
          }
        }
      } catch (error) {
        errors.push(`${parser.source}:${file}: ${(error as Error).message}`);
      } finally {
        cleanupParsedSessions(sessions);
      }
    }
  }
  entries.sort((a, b) => a.key.localeCompare(b.key) || String(a.sourcePath).localeCompare(String(b.sourcePath)));

  const firstByKey = new Map<string, BackfillInventoryEntry>();
  for (const entry of entries) {
    const first = firstByKey.get(entry.key);
    if (!first) {
      firstByKey.set(entry.key, entry);
    } else {
      entry.duplicateOf = first.sourcePath;
    }
  }
  return { entries, files, errors };
}

function selectEntries(
  entries: BackfillInventoryEntry[],
  opts: BackfillRunOptions,
): BackfillInventoryEntry[] {
  const rangeStart = opts.rangeStart ? parseBackfillKey(opts.rangeStart).key : null;
  const rangeEnd = opts.rangeEnd ? parseBackfillKey(opts.rangeEnd).key : null;
  const pilot = opts.pilot == null ? null : nonNegativeInt(opts.pilot, 0, "--pilot");
  const knownKeys = new Set((opts.knownIds ?? []).map((id) => parseBackfillKey(id).key));
  const knownIdsOnlyApplyBoundary =
    Boolean(opts.apply) && knownKeys.size > 0 && pilot === null && !rangeStart && !rangeEnd && !opts.allSources;
  let selected = entries.filter((entry) => !entry.duplicateOf);
  if (rangeStart) selected = selected.filter((entry) => entry.key >= rangeStart);
  if (rangeEnd) selected = selected.filter((entry) => entry.key <= rangeEnd);
  if (knownIdsOnlyApplyBoundary) selected = selected.filter((entry) => knownKeys.has(entry.key));
  if (pilot !== null) selected = selected.slice(0, pilot);
  return selected;
}

function materializeParsed(parsed: ParsedSession): MaterializedSession {
  const input = {
    session: { ...parsed.session },
    messages: parsed.messages.map((message) => ({ ...message })),
    toolCalls: parsed.toolCalls.map((toolCall) => ({ ...toolCall })),
  };
  return {
    input,
    estimatedBytes: estimateParsed(parsed),
    maxBatchRecords: Math.max(parsed.messages.length, parsed.toolCalls.length),
  };
}

function materializeStaged(staged: StagedParsedSession, batchSize: number): MaterializedSession {
  const messages: MessageInsert[] = [];
  const toolCalls: ToolCallInsert[] = [];
  let maxBatchRecords = 0;
  staged.forEachMessageBatch(batchSize, (batch) => {
    maxBatchRecords = Math.max(maxBatchRecords, batch.length);
    messages.push(...batch);
  });
  staged.forEachToolCallBatch(batchSize, (batch) => {
    maxBatchRecords = Math.max(maxBatchRecords, batch.length);
    toolCalls.push(...batch);
  });
  const session: SessionInsert = {
    ...staged.session,
    message_count: staged.messageCount,
    tool_call_count: staged.toolCallCount,
    total_input_tokens: staged.session.total_input_tokens ?? staged.totalInputTokens,
    total_output_tokens: staged.session.total_output_tokens ?? staged.totalOutputTokens,
    total_cache_read_tokens: staged.session.total_cache_read_tokens ?? staged.totalCacheReadTokens,
    total_cache_write_tokens: staged.session.total_cache_write_tokens ?? staged.totalCacheWriteTokens,
    total_thinking_tokens: staged.session.total_thinking_tokens ?? staged.totalThinkingTokens,
  };
  const input = { session, messages, toolCalls };
  return {
    input,
    estimatedBytes: byteLength(session) + byteLength(messages) + byteLength(toolCalls),
    maxBatchRecords,
  };
}

function materializeEntry(
  parsers: SessionParser[],
  entry: BackfillInventoryEntry,
  batchSize: number,
  maxBufferedBytes: number,
): MaterializedSession {
  const parser = parsers.find((candidate) => candidate.source === entry.source);
  if (!parser) throw new Error(`no parser registered for ${entry.source}`);
  if (!entry.sourcePath) throw new Error(`${entry.key}: no source path available`);
  let sessions: ParsedOrStagedSession[] = [];
  try {
    sessions = parseFileSessions(parser, entry.sourcePath, maxBufferedBytes);
    const match = sessions.find((session) => {
      const candidate = session.kind === "parsed" ? session.parsed.session : session.staged.session;
      return candidate.source === entry.source && candidate.source_id === entry.sourceId;
    });
    if (!match) throw new Error(`${entry.key}: source file no longer contains this session`);
    const freshEntry =
      match.kind === "parsed"
        ? entryFromParsed(match.parsed, match.maxBufferedLineBytes, match.maxNormalizedBatchRecords, match.sourceContentDigest)
        : entryFromStaged(match.staged, batchSize, match.maxBufferedLineBytes, match.maxNormalizedBatchRecords, match.sourceContentDigest);
    if (!hasSameInventoryProvenance(freshEntry, entry)) {
      throw new Error("source changed after inventory; refusing to import stale selection");
    }
    const materialized = match.kind === "parsed" ? materializeParsed(match.parsed) : materializeStaged(match.staged, batchSize);
    materialized.input.session.metadata = {
      ...(materialized.input.session.metadata ?? {}),
      backfill: {
        version: CHECKPOINT_VERSION,
        sourceContentDigest: entry.sourceContentDigest,
        runConfigDigest: entry.runConfigDigest,
      },
    };
    return materialized;
  } finally {
    cleanupParsedSessions(sessions);
  }
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
 * `HASNA_SESSIONS_PRODUCTION_HOSTS=hasna.xyz`. This published package does not
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
