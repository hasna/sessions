import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { SessionParser } from "./ingest/types.js";
import { listParsers } from "./ingest/index.js";
import { getSessionsDir } from "./paths.js";
import type {
  MessageInsert,
  ParsedSession,
  SessionContentImport,
  SessionInsert,
  StagedParsedSession,
  ToolCallInsert,
} from "../types/index.js";
import { isSessionSource } from "../types/index.js";
import type {
  BackfillCheckpoint,
  BackfillCheckpointEntry,
  BackfillInventoryEntry,
  BackfillKey,
  BackfillRunOptions,
} from "./backfill.js";

const CHECKPOINT_VERSION = 2;

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

export function positiveInt(value: number | undefined, fallback: number, name: string): number {
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

export function hasSameCheckpointProvenance(
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

export function parseBackfillKey(raw: string): BackfillKey {
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

export function checkpointPath(path: string | undefined): string {
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

export function readCheckpoint(path: string, now: () => Date): BackfillCheckpoint {
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

export function writeCheckpoint(path: string, checkpoint: BackfillCheckpoint, now: () => Date): void {
  mkdirSync(dirname(path), { recursive: true });
  checkpoint.updatedAt = nowIso(now);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf-8");
  renameSync(tmp, path);
}

export function checkpointEntry(entry: BackfillInventoryEntry, now: () => Date, note?: string): BackfillCheckpointEntry {
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

export function requestedSourceList(opts: BackfillRunOptions): string[] {
  const requested = opts.source ? [opts.source, ...(opts.sources ?? [])] : (opts.sources ?? []);
  if (requested.length === 0) return [];
  const out: string[] = [];
  for (const source of requested) {
    if (!isSessionSource(String(source))) throw new Error(`unknown session source '${String(source)}'`);
    out.push(String(source));
  }
  return [...new Set(out)].sort();
}

export function selectParsers(opts: BackfillRunOptions): SessionParser[] {
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

export function inventoryParsers(
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

export function selectEntries(
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

export function materializeEntry(
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

