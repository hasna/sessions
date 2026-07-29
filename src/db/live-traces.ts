import type { SqliteAdapter } from "./sqlite-adapter.js";
import { getDatabase } from "./database.js";
import {
  sanitizeAppendLiveTraceEventInput,
  sanitizeTraceId,
  traceExpiry,
  traceMaxEvents,
  clampTraceCursor,
  clampTraceTailLimit,
} from "../lib/live-trace.js";
import type {
  AppendLiveTraceEventInput,
  AppendLiveTraceEventResult,
  LiveTrace,
  LiveTraceCorrelation,
  LiveTraceEvent,
  TailLiveTraceOptions,
  TailLiveTraceResult,
} from "../types/index.js";

interface TraceRow extends Record<string, unknown> {
  id: string;
  status: string;
  workflow_run_id: string;
  loop_run_id: string;
  step_id: string | null;
  task_id: string | null;
  provider: string | null;
  worktree_path: string | null;
  worktree_policy: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  next_sequence: number;
}

interface EventRow extends Record<string, unknown> {
  trace_id: string;
  id: string;
  sequence: number;
  kind: string;
  level: string;
  message: string;
  event_status: string | null;
  data: string;
  workflow_run_id: string;
  loop_run_id: string;
  step_id: string | null;
  task_id: string | null;
  provider: string | null;
  worktree_path: string | null;
  worktree_policy: string | null;
  occurred_at: string;
  stored_at: string;
  redacted: number | boolean;
  truncated: number | boolean;
}

function rowToTrace(row: TraceRow): LiveTrace {
  return {
    id: row.id,
    status: row.status as LiveTrace["status"],
    workflow_run_id: row.workflow_run_id,
    loop_run_id: row.loop_run_id,
    step_id: row.step_id,
    task_id: row.task_id,
    provider: row.provider,
    worktree_path: row.worktree_path,
    worktree_policy: row.worktree_policy,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at,
    next_sequence: Number(row.next_sequence),
  };
}

function rowToEvent(row: EventRow): LiveTraceEvent {
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.data);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed;
  } catch {
    data = {};
  }
  return {
    id: row.id,
    trace_id: row.trace_id,
    sequence: Number(row.sequence),
    kind: row.kind as LiveTraceEvent["kind"],
    level: row.level as LiveTraceEvent["level"],
    message: row.message,
    event_status: row.event_status,
    data,
    workflow_run_id: row.workflow_run_id,
    loop_run_id: row.loop_run_id,
    step_id: row.step_id,
    task_id: row.task_id,
    provider: row.provider,
    worktree_path: row.worktree_path,
    worktree_policy: row.worktree_policy,
    occurred_at: row.occurred_at,
    stored_at: row.stored_at,
    redacted: Boolean(row.redacted),
    truncated: Boolean(row.truncated),
  };
}

function traceCorrelation(trace: LiveTrace): LiveTraceCorrelation {
  return {
    workflow_run_id: trace.workflow_run_id,
    loop_run_id: trace.loop_run_id,
    step_id: trace.step_id,
    task_id: trace.task_id,
    provider: trace.provider,
    worktree_path: trace.worktree_path,
    worktree_policy: trace.worktree_policy,
  };
}

function assertCorrelationCompatible(
  trace: LiveTrace,
  supplied: Partial<LiveTraceCorrelation> | undefined,
): void {
  if (!supplied) return;
  const current = traceCorrelation(trace);
  for (const key of Object.keys(supplied) as (keyof LiveTraceCorrelation)[]) {
    if (supplied[key] !== undefined && supplied[key] !== current[key]) {
      throw new Error(
        `trace correlation is immutable: ${key} is '${String(current[key])}', not '${String(supplied[key])}'`,
      );
    }
  }
}

function eventCorrelation(
  trace: LiveTrace,
  supplied: Partial<LiveTraceCorrelation>,
): LiveTraceCorrelation {
  if (supplied.workflow_run_id !== undefined && supplied.workflow_run_id !== trace.workflow_run_id) {
    throw new Error("event correlation workflow_run_id must match the trace");
  }
  if (supplied.loop_run_id !== undefined && supplied.loop_run_id !== trace.loop_run_id) {
    throw new Error("event correlation loop_run_id must match the trace");
  }
  return {
    workflow_run_id: trace.workflow_run_id,
    loop_run_id: trace.loop_run_id,
    step_id: supplied.step_id ?? trace.step_id,
    task_id: supplied.task_id ?? trace.task_id,
    provider: supplied.provider ?? trace.provider,
    worktree_path: supplied.worktree_path ?? trace.worktree_path,
    worktree_policy: supplied.worktree_policy ?? trace.worktree_policy,
  };
}

function getTraceRow(db: SqliteAdapter, id: string): TraceRow | null {
  return (db.prepare("SELECT * FROM live_traces WHERE id = ?").get(id) as TraceRow | undefined) ?? null;
}

function getEventRow(db: SqliteAdapter, traceId: string, eventId: string): EventRow | null {
  return (
    (db.prepare("SELECT * FROM live_trace_events WHERE trace_id = ? AND id = ?").get(traceId, eventId) as
      | EventRow
      | undefined) ?? null
  );
}

/** Append one visible event, assigning a strictly increasing per-trace sequence. */
export function appendLocalLiveTraceEvent(
  rawTraceId: string,
  input: AppendLiveTraceEventInput,
  db: SqliteAdapter = getDatabase(),
): AppendLiveTraceEventResult {
  const traceId = sanitizeTraceId(rawTraceId);
  const safe = sanitizeAppendLiveTraceEventInput(input);
  const now = new Date();
  const storedAt = now.toISOString();
  const expiresAt = traceExpiry(now);

  return db.transaction(() => {
    db.prepare("DELETE FROM live_traces WHERE expires_at <= ?").run(storedAt);
    let row = getTraceRow(db, traceId);
    if (!row) {
      if (!safe.correlation) throw new Error("correlation is required on the first append");
      const c = safe.correlation;
      db.prepare(
        `INSERT INTO live_traces (
          id, status, workflow_run_id, loop_run_id, step_id, task_id, provider,
          worktree_path, worktree_policy, created_at, updated_at, expires_at, next_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      ).run(
        traceId,
        safe.trace_status,
        c.workflow_run_id,
        c.loop_run_id,
        c.step_id ?? null,
        c.task_id ?? null,
        c.provider ?? null,
        c.worktree_path ?? null,
        c.worktree_policy ?? null,
        storedAt,
        storedAt,
        expiresAt,
      );
      row = getTraceRow(db, traceId);
    }
    if (!row) throw new Error(`failed to create trace: ${traceId}`);
    let trace = rowToTrace(row);
    assertCorrelationCompatible(trace, safe.correlation);

    const duplicate = getEventRow(db, traceId, safe.event.id);
    if (duplicate) {
      return { trace, event: rowToEvent(duplicate), idempotent: true };
    }
    if (trace.status !== "active") {
      throw new Error(`trace '${traceId}' is ${trace.status}; new events cannot be appended`);
    }

    const sequence = trace.next_sequence;
    const c = eventCorrelation(trace, safe.event.correlation);
    db.prepare(
      `INSERT INTO live_trace_events (
        trace_id, id, sequence, kind, level, message, event_status, data,
        workflow_run_id, loop_run_id, step_id, task_id, provider, worktree_path,
        worktree_policy, occurred_at, stored_at, redacted, truncated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      traceId,
      safe.event.id,
      sequence,
      safe.event.kind,
      safe.event.level,
      safe.event.message,
      safe.event.event_status,
      JSON.stringify(safe.event.data),
      c.workflow_run_id,
      c.loop_run_id,
      c.step_id ?? null,
      c.task_id ?? null,
      c.provider ?? null,
      c.worktree_path ?? null,
      c.worktree_policy ?? null,
      safe.event.occurred_at,
      storedAt,
      safe.event.redacted ? 1 : 0,
      safe.event.truncated ? 1 : 0,
    );
    db.prepare(
      "UPDATE live_traces SET status = ?, updated_at = ?, expires_at = ?, next_sequence = ? WHERE id = ?",
    ).run(safe.trace_status, storedAt, expiresAt, sequence + 1, traceId);
    db.prepare("DELETE FROM live_trace_events WHERE trace_id = ? AND sequence <= ?").run(
      traceId,
      sequence - traceMaxEvents(),
    );

    row = getTraceRow(db, traceId);
    const event = getEventRow(db, traceId, safe.event.id);
    if (!row || !event) throw new Error(`failed to persist trace event: ${safe.event.id}`);
    trace = rowToTrace(row);
    return { trace, event: rowToEvent(event), idempotent: false };
  });
}

/** Read a replay page after a sequence cursor. Live waiting is handled by callers. */
export function tailLocalLiveTrace(
  rawTraceId: string,
  options: TailLiveTraceOptions = {},
  db: SqliteAdapter = getDatabase(),
): TailLiveTraceResult | null {
  const traceId = sanitizeTraceId(rawTraceId);
  const now = new Date().toISOString();
  db.prepare("DELETE FROM live_traces WHERE expires_at <= ?").run(now);
  const row = getTraceRow(db, traceId);
  if (!row) return null;
  const after = clampTraceCursor(options.after);
  const limit = clampTraceTailLimit(options.limit);
  const rows = db
    .prepare(
      "SELECT * FROM live_trace_events WHERE trace_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?",
    )
    .all(traceId, after, limit) as EventRow[];
  const earliestRow = db
    .prepare("SELECT MIN(sequence) AS sequence FROM live_trace_events WHERE trace_id = ?")
    .get(traceId) as { sequence: number | null } | undefined;
  const earliest = earliestRow?.sequence == null ? null : Number(earliestRow.sequence);
  const events = rows.map(rowToEvent);
  return {
    trace: rowToTrace(row),
    events,
    next_after: events.at(-1)?.sequence ?? after,
    earliest_sequence: earliest,
    cursor_expired: earliest !== null && after < earliest - 1,
  };
}
