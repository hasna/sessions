import { randomUUID } from "node:crypto";
import { redactHandoffText } from "./handoff.js";
import {
  LIVE_TRACE_EVENT_KINDS,
  LIVE_TRACE_STATUSES,
  type AppendLiveTraceEventInput,
  type LiveTraceCorrelation,
  type LiveTraceEventKind,
  type LiveTraceStatus,
} from "../types/index.js";

export const DEFAULT_TRACE_RETENTION_DAYS = 7;
export const DEFAULT_TRACE_MAX_EVENTS = 10_000;
export const TRACE_MAX_MESSAGE_CHARS = 16 * 1024;
export const TRACE_MAX_DATA_BYTES = 32 * 1024;
export const TRACE_MAX_TAIL_LIMIT = 500;
export const TRACE_MAX_WAIT_MS = 30_000;

const HIDDEN_REASONING_KEY = /(?:reasoning|thinking|chain[_ -]?of[_ -]?thought|internal[_ -]?thought)/i;
const LEVELS = new Set(["info", "warn", "error"]);

export interface SanitizedLiveTraceEvent {
  id: string;
  kind: LiveTraceEventKind;
  level: "info" | "warn" | "error";
  message: string;
  event_status: string | null;
  data: Record<string, unknown>;
  occurred_at: string;
  correlation: Partial<LiveTraceCorrelation>;
  redacted: boolean;
  truncated: boolean;
}

export interface SanitizedAppendLiveTraceEventInput {
  correlation?: LiveTraceCorrelation;
  event: SanitizedLiveTraceEvent;
  trace_status: LiveTraceStatus;
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function traceRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  return boundedInt(env.HASNA_SESSIONS_TRACE_RETENTION_DAYS, DEFAULT_TRACE_RETENTION_DAYS, 1, 90);
}

export function traceMaxEvents(env: NodeJS.ProcessEnv = process.env): number {
  return boundedInt(env.HASNA_SESSIONS_TRACE_MAX_EVENTS, DEFAULT_TRACE_MAX_EVENTS, 100, 100_000);
}

export function traceExpiry(now = new Date(), env: NodeJS.ProcessEnv = process.env): string {
  return new Date(now.getTime() + traceRetentionDays(env) * 86_400_000).toISOString();
}

export function clampTraceTailLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || Number(value) <= 0) return 200;
  return Math.min(TRACE_MAX_TAIL_LIMIT, Math.floor(Number(value)));
}

export function clampTraceCursor(value: number | undefined): number {
  if (!Number.isFinite(value) || Number(value) < 0) return 0;
  return Math.floor(Number(value));
}

export function clampTraceWaitMs(value: number | undefined): number {
  if (!Number.isFinite(value) || Number(value) <= 0) return 0;
  return Math.min(TRACE_MAX_WAIT_MS, Math.floor(Number(value)));
}

function safeText(value: unknown, name: string, maxChars: number, required = false): {
  value: string | null;
  redacted: boolean;
  truncated: boolean;
} {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${name} is required`);
    return { value: null, redacted: false, truncated: false };
  }
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if (required && value.length === 0) throw new Error(`${name} is required`);
  const redacted = redactHandoffText(value);
  return {
    value: redacted.slice(0, maxChars),
    redacted: redacted !== value,
    truncated: redacted.length > maxChars,
  };
}

function correlationText(value: unknown, name: string, required = false): string | null {
  return safeText(value, name, name.includes("path") ? 2048 : 512, required).value;
}

export function sanitizeTraceId(traceId: unknown): string {
  const id = correlationText(traceId, "trace_id", true) as string;
  if (id === "." || id === "..") throw new Error("trace_id is invalid");
  return id;
}

export function sanitizeTraceCorrelation(
  input: LiveTraceCorrelation | Partial<LiveTraceCorrelation> | undefined,
  required: boolean,
): LiveTraceCorrelation | Partial<LiveTraceCorrelation> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    if (required) throw new Error("correlation is required on the first append");
    return {};
  }
  const out: Partial<LiveTraceCorrelation> = {};
  const workflow = correlationText(input.workflow_run_id, "correlation.workflow_run_id", required);
  const loop = correlationText(input.loop_run_id, "correlation.loop_run_id", required);
  if (workflow !== null) out.workflow_run_id = workflow;
  if (loop !== null) out.loop_run_id = loop;
  for (const key of ["step_id", "task_id", "provider", "worktree_path", "worktree_policy"] as const) {
    if (input[key] !== undefined) out[key] = correlationText(input[key], `correlation.${key}`);
  }
  return out as LiveTraceCorrelation | Partial<LiveTraceCorrelation>;
}

function sanitizeDataValue(
  value: unknown,
  state: { redacted: boolean; truncated: boolean; seen: WeakSet<object> },
  depth: number,
): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const redacted = redactHandoffText(value);
    if (redacted !== value) state.redacted = true;
    if (redacted.length > 8192) state.truncated = true;
    return redacted.slice(0, 8192);
  }
  if (typeof value !== "object") return String(value);
  if (depth >= 8) {
    state.truncated = true;
    return "[TRUNCATED_DEPTH]";
  }
  if (state.seen.has(value)) {
    state.truncated = true;
    return "[TRUNCATED_CYCLE]";
  }
  state.seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > 100) state.truncated = true;
    return value.slice(0, 100).map((item) => sanitizeDataValue(item, state, depth + 1));
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 100) state.truncated = true;
  for (const [rawKey, item] of entries.slice(0, 100)) {
    const key = redactHandoffText(rawKey).slice(0, 256);
    if (key !== rawKey) state.redacted = true;
    if (HIDDEN_REASONING_KEY.test(rawKey)) {
      out[key] = "[OMITTED_HIDDEN_REASONING]";
      state.redacted = true;
      continue;
    }
    out[key] = sanitizeDataValue(item, state, depth + 1);
  }
  return out;
}

export function sanitizeTraceData(input: unknown): {
  data: Record<string, unknown>;
  redacted: boolean;
  truncated: boolean;
} {
  if (input === undefined) return { data: {}, redacted: false, truncated: false };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("event.data must be an object");
  }
  const state = { redacted: false, truncated: false, seen: new WeakSet<object>() };
  let data = sanitizeDataValue(input, state, 0) as Record<string, unknown>;
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json, "utf8") > TRACE_MAX_DATA_BYTES) {
    state.truncated = true;
    data = {
      truncated: true,
      preview: json.slice(0, 24 * 1024),
    };
  }
  return { data, redacted: state.redacted, truncated: state.truncated };
}

export function sanitizeAppendLiveTraceEventInput(
  input: AppendLiveTraceEventInput,
): SanitizedAppendLiveTraceEventInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("expected a JSON object body");
  }
  if (!input.event || typeof input.event !== "object" || Array.isArray(input.event)) {
    throw new Error("event is required");
  }
  if (!(LIVE_TRACE_EVENT_KINDS as readonly unknown[]).includes(input.event.kind)) {
    throw new Error(
      `invalid event.kind '${String(input.event.kind)}'; hidden reasoning is not accepted (use ${LIVE_TRACE_EVENT_KINDS.join("|")})`,
    );
  }
  if (input.trace_status !== undefined && !(LIVE_TRACE_STATUSES as readonly unknown[]).includes(input.trace_status)) {
    throw new Error(`invalid trace_status '${String(input.trace_status)}'`);
  }
  if (input.event.level !== undefined && !LEVELS.has(input.event.level)) {
    throw new Error(`invalid event.level '${String(input.event.level)}'`);
  }

  const message = safeText(input.event.message, "event.message", TRACE_MAX_MESSAGE_CHARS, true);
  const status = safeText(input.event.event_status, "event.event_status", 256);
  const id = safeText(input.event.id ?? randomUUID(), "event.id", 512, true);
  const data = sanitizeTraceData(input.event.data);
  const occurredAt = input.event.occurred_at ?? new Date().toISOString();
  if (typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt))) {
    throw new Error("event.occurred_at must be an ISO-8601 timestamp");
  }

  return {
    correlation: input.correlation
      ? (sanitizeTraceCorrelation(input.correlation, true) as LiveTraceCorrelation)
      : undefined,
    event: {
      id: id.value as string,
      kind: input.event.kind,
      level: input.event.level ?? "info",
      message: message.value as string,
      event_status: status.value,
      data: data.data,
      occurred_at: new Date(occurredAt).toISOString(),
      correlation: sanitizeTraceCorrelation(input.event.correlation, false),
      redacted: message.redacted || status.redacted || data.redacted,
      truncated: message.truncated || status.truncated || data.truncated,
    },
    trace_status: input.trace_status ?? "active",
  };
}
