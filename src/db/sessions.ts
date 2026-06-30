import { getDatabase } from "./database.js";
import { getMachineName } from "../lib/machine.js";
import { appendProjectFilter } from "../lib/project-filter.js";
import {
  SessionNotFoundError,
  type Session,
  type SessionInsert,
  type Message,
  type MessageInsert,
  type ToolCall,
  type ToolCallInsert,
  type ParsedSession,
} from "../types/index.js";

function uuid(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseMeta(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "string") return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function rowToSession(row: Record<string, unknown>): Session {
  return {
    id: row.id as string,
    source: row.source as Session["source"],
    source_id: row.source_id as string,
    source_path: (row.source_path as string) ?? null,
    title: (row.title as string) ?? null,
    project_path: (row.project_path as string) ?? null,
    project_name: (row.project_name as string) ?? null,
    model: (row.model as string) ?? null,
    model_provider: (row.model_provider as string) ?? null,
    git_branch: (row.git_branch as string) ?? null,
    git_sha: (row.git_sha as string) ?? null,
    git_origin_url: (row.git_origin_url as string) ?? null,
    cli_version: (row.cli_version as string) ?? null,
    is_subagent: Boolean(row.is_subagent),
    parent_session_id: (row.parent_session_id as string) ?? null,
    total_input_tokens: Number(row.total_input_tokens ?? 0),
    total_output_tokens: Number(row.total_output_tokens ?? 0),
    total_cache_read_tokens: Number(row.total_cache_read_tokens ?? 0),
    total_cache_write_tokens: Number(row.total_cache_write_tokens ?? 0),
    total_thinking_tokens: Number(row.total_thinking_tokens ?? 0),
    message_count: Number(row.message_count ?? 0),
    tool_call_count: Number(row.tool_call_count ?? 0),
    started_at: (row.started_at as string) ?? null,
    ended_at: (row.ended_at as string) ?? null,
    duration_seconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    ingested_at: row.ingested_at as string,
    updated_at: row.updated_at as string,
    source_modified_at: (row.source_modified_at as string) ?? null,
    machine: (row.machine as string) ?? null,
    metadata: parseMeta(row.metadata),
  };
}

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    source_id: (row.source_id as string) ?? null,
    parent_message_id: (row.parent_message_id as string) ?? null,
    role: row.role as Message["role"],
    content: (row.content as string) ?? null,
    content_preview: (row.content_preview as string) ?? null,
    model: (row.model as string) ?? null,
    is_sidechain: Boolean(row.is_sidechain),
    sequence_num: row.sequence_num == null ? null : Number(row.sequence_num),
    input_tokens: Number(row.input_tokens ?? 0),
    output_tokens: Number(row.output_tokens ?? 0),
    cache_read_tokens: Number(row.cache_read_tokens ?? 0),
    cache_write_tokens: Number(row.cache_write_tokens ?? 0),
    thinking_tokens: Number(row.thinking_tokens ?? 0),
    timestamp: (row.timestamp as string) ?? null,
    metadata: parseMeta(row.metadata),
  };
}

function rowToToolCall(row: Record<string, unknown>): ToolCall {
  return {
    id: row.id as string,
    message_id: (row.message_id as string) ?? null,
    session_id: row.session_id as string,
    tool_name: row.tool_name as string,
    tool_input: (row.tool_input as string) ?? null,
    tool_output: (row.tool_output as string) ?? null,
    duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
    status: (row.status as ToolCall["status"]) ?? null,
    timestamp: (row.timestamp as string) ?? null,
    metadata: parseMeta(row.metadata),
  };
}

/** Upsert a session keyed by (source, source_id). Returns the stored row. */
export function upsertSession(input: SessionInsert): Session {
  const db = getDatabase();
  const existing = db
    .prepare("SELECT id FROM sessions WHERE source = ? AND source_id = ?")
    .get(input.source, input.source_id) as { id: string } | undefined;

  const id = existing?.id ?? input.id ?? uuid();
  const ts = nowIso();
  const meta = JSON.stringify(input.metadata ?? {});
  const machine = input.machine ?? getMachineName();

  db.prepare(
    `INSERT INTO sessions (
      id, source, source_id, source_path, title, project_path, project_name,
      model, model_provider, git_branch, git_sha, git_origin_url, cli_version,
      is_subagent, parent_session_id, total_input_tokens, total_output_tokens,
      total_cache_read_tokens, total_cache_write_tokens, total_thinking_tokens,
      message_count, tool_call_count, started_at, ended_at, duration_seconds,
      ingested_at, updated_at, source_modified_at, machine, metadata
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(source, source_id) DO UPDATE SET
      source_path = excluded.source_path,
      title = excluded.title,
      project_path = excluded.project_path,
      project_name = excluded.project_name,
      model = excluded.model,
      model_provider = excluded.model_provider,
      git_branch = excluded.git_branch,
      git_sha = excluded.git_sha,
      git_origin_url = excluded.git_origin_url,
      cli_version = excluded.cli_version,
      is_subagent = excluded.is_subagent,
      parent_session_id = excluded.parent_session_id,
      total_input_tokens = excluded.total_input_tokens,
      total_output_tokens = excluded.total_output_tokens,
      total_cache_read_tokens = excluded.total_cache_read_tokens,
      total_cache_write_tokens = excluded.total_cache_write_tokens,
      total_thinking_tokens = excluded.total_thinking_tokens,
      message_count = excluded.message_count,
      tool_call_count = excluded.tool_call_count,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      duration_seconds = excluded.duration_seconds,
      updated_at = excluded.updated_at,
      source_modified_at = excluded.source_modified_at,
      machine = excluded.machine,
      metadata = excluded.metadata`
  ).run(
    id,
    input.source,
    input.source_id,
    input.source_path ?? null,
    input.title ?? null,
    input.project_path ?? null,
    input.project_name ?? null,
    input.model ?? null,
    input.model_provider ?? null,
    input.git_branch ?? null,
    input.git_sha ?? null,
    input.git_origin_url ?? null,
    input.cli_version ?? null,
    input.is_subagent ? 1 : 0,
    input.parent_session_id ?? null,
    input.total_input_tokens ?? 0,
    input.total_output_tokens ?? 0,
    input.total_cache_read_tokens ?? 0,
    input.total_cache_write_tokens ?? 0,
    input.total_thinking_tokens ?? 0,
    input.message_count ?? 0,
    input.tool_call_count ?? 0,
    input.started_at ?? null,
    input.ended_at ?? null,
    input.duration_seconds ?? null,
    ts,
    ts,
    input.source_modified_at ?? null,
    machine,
    meta
  );

  db.prepare("DELETE FROM sessions_fts WHERE session_id = ?").run(id);
  db.prepare(
    `INSERT INTO sessions_fts(session_id, title, project_name, project_path)
     VALUES (?, ?, ?, ?)`
  ).run(id, input.title ?? null, input.project_name ?? null, input.project_path ?? null);

  return getSession(id);
}

export function getSession(id: string): Session {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new SessionNotFoundError(id);
  return rowToSession(row);
}

export function getSessionBySource(source: string, sourceId: string): Session | null {
  const db = getDatabase();
  const row = db
    .prepare("SELECT * FROM sessions WHERE source = ? AND source_id = ?")
    .get(source, sourceId) as Record<string, unknown> | undefined;
  return row ? rowToSession(row) : null;
}

/** Resolve a session by full id or a unique id/source_id prefix (null if none or ambiguous). */
export function getSessionByPrefix(idOrPrefix: string): Session | null {
  const db = getDatabase();
  const exact = db.prepare("SELECT * FROM sessions WHERE id = ? OR source_id = ?").get(idOrPrefix, idOrPrefix) as
    | Record<string, unknown>
    | undefined;
  if (exact) return rowToSession(exact);
  const rows = db
    .prepare("SELECT * FROM sessions WHERE id LIKE ? OR source_id LIKE ? LIMIT 2")
    .all(`${idOrPrefix}%`, `${idOrPrefix}%`) as Record<string, unknown>[];
  if (rows.length === 1) return rowToSession(rows[0]);
  return null;
}

export interface ListSessionsOptions {
  source?: string;
  project_path?: string;
  machine?: string;
  limit?: number;
  offset?: number;
}

export function listSessions(opts: ListSessionsOptions = {}): Session[] {
  const db = getDatabase();
  const where: string[] = [];
  const params: any[] = [];
  if (opts.source) {
    where.push("source = ?");
    params.push(opts.source);
  }
  if (opts.project_path) {
    appendProjectFilter(where, params, opts.project_path, "");
  }
  if (opts.machine) {
    where.push("machine = ?");
    params.push(opts.machine);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const rows = db
    .prepare(
      `SELECT * FROM sessions ${clause} ORDER BY COALESCE(started_at, ingested_at) DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as Record<string, unknown>[];
  return rows.map(rowToSession);
}

export function getRecentSessions(limit = 20): Session[] {
  return listSessions({ limit });
}

export function getMessages(sessionId: string): Message[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      "SELECT * FROM messages WHERE session_id = ? ORDER BY sequence_num ASC, timestamp ASC"
    )
    .all(sessionId) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

export function getToolCalls(sessionId: string): ToolCall[] {
  const db = getDatabase();
  const rows = db
    .prepare("SELECT * FROM tool_calls WHERE session_id = ? ORDER BY timestamp ASC")
    .all(sessionId) as Record<string, unknown>[];
  return rows.map(rowToToolCall);
}

export interface ProjectStat {
  project_path: string;
  project_name: string | null;
  session_count: number;
}

export function getProjectStats(): ProjectStat[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT project_path, MAX(project_name) AS project_name, COUNT(*) AS session_count
       FROM sessions WHERE project_path IS NOT NULL
       GROUP BY project_path ORDER BY session_count DESC`
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    project_path: r.project_path as string,
    project_name: (r.project_name as string) ?? null,
    session_count: Number(r.session_count ?? 0),
  }));
}

export function deleteSession(id: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM tool_calls_fts WHERE rowid IN (SELECT rowid FROM tool_calls_fts_refs WHERE session_id = ?)").run(id);
  db.prepare("DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages_fts_refs WHERE session_id = ?)").run(id);
  db.prepare("DELETE FROM tool_calls_fts_refs WHERE session_id = ?").run(id);
  db.prepare("DELETE FROM messages_fts_refs WHERE session_id = ?").run(id);
  db.prepare("DELETE FROM sessions_fts WHERE session_id = ?").run(id);
  db.prepare("DELETE FROM tool_calls WHERE session_id = ?").run(id);
  db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
  db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

const INSERT_MESSAGE_SQL = `INSERT INTO messages (
      id, session_id, source_id, parent_message_id, role, content, content_preview,
      model, is_sidechain, sequence_num, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, thinking_tokens, timestamp, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_TOOL_CALL_SQL = `INSERT INTO tool_calls (
      id, message_id, session_id, tool_name, tool_input, tool_output,
      duration_ms, status, timestamp, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_MESSAGE_FTS_REF_SQL = `INSERT INTO messages_fts_refs(session_id, message_id)
     VALUES (?, ?)`;

const INSERT_TOOL_CALL_FTS_REF_SQL = `INSERT INTO tool_calls_fts_refs(session_id, tool_call_id)
     VALUES (?, ?)`;

function messageInsertValues(sessionId: string, input: MessageInsert): any[] {
  return [
    input.id ?? uuid(),
    sessionId,
    input.source_id ?? null,
    input.parent_message_id ?? null,
    input.role,
    input.content ?? null,
    input.content_preview ?? (input.content ? input.content.slice(0, 280) : null),
    input.model ?? null,
    input.is_sidechain ? 1 : 0,
    input.sequence_num ?? null,
    input.input_tokens ?? 0,
    input.output_tokens ?? 0,
    input.cache_read_tokens ?? 0,
    input.cache_write_tokens ?? 0,
    input.thinking_tokens ?? 0,
    input.timestamp ?? null,
    JSON.stringify(input.metadata ?? {})
  ];
}

function toolCallInsertValues(sessionId: string, input: ToolCallInsert): any[] {
  return [
    input.id ?? uuid(),
    input.message_id ?? null,
    sessionId,
    input.tool_name,
    input.tool_input ?? null,
    input.tool_output ?? null,
    input.duration_ms ?? null,
    input.status ?? null,
    input.timestamp ?? null,
    JSON.stringify(input.metadata ?? {})
  ];
}

function insertMessage(sessionId: string, input: MessageInsert): void {
  const db = getDatabase();
  const values = messageInsertValues(sessionId, input);
  db.prepare(INSERT_MESSAGE_SQL).run(...values);
  const ref = db.prepare(INSERT_MESSAGE_FTS_REF_SQL).run(sessionId, values[0]) as { lastInsertRowid?: number | bigint };
  if (ref.lastInsertRowid == null) throw new Error("failed to allocate messages_fts rowid");
  db.prepare(
    `INSERT INTO messages_fts(rowid, message_id, session_id, content)
     VALUES (?, ?, ?, ?)`
  ).run(ref.lastInsertRowid, values[0], sessionId, values[5]);
}

function insertToolCall(sessionId: string, input: ToolCallInsert): void {
  const db = getDatabase();
  const values = toolCallInsertValues(sessionId, input);
  db.prepare(INSERT_TOOL_CALL_SQL).run(...values);
  const ref = db.prepare(INSERT_TOOL_CALL_FTS_REF_SQL).run(sessionId, values[0]) as { lastInsertRowid?: number | bigint };
  if (ref.lastInsertRowid == null) throw new Error("failed to allocate tool_calls_fts rowid");
  db.prepare(
    `INSERT INTO tool_calls_fts(rowid, tool_call_id, session_id, tool_name, tool_input, tool_output)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(ref.lastInsertRowid, values[0], sessionId, values[3], values[4], values[5]);
}

/**
 * Persist a fully-parsed session: upsert the session row, replace its messages
 * and tool calls, and recompute aggregate counts/token totals. Idempotent —
 * re-ingesting the same session replaces its children rather than duplicating.
 */
export function saveParsedSession(parsed: ParsedSession): Session {
  const db = getDatabase();
  return db.transaction(() => {
    const inputTokens = sum(parsed.messages, "input_tokens");
    const outputTokens = sum(parsed.messages, "output_tokens");
    const cacheRead = sum(parsed.messages, "cache_read_tokens");
    const cacheWrite = sum(parsed.messages, "cache_write_tokens");
    const thinking = sum(parsed.messages, "thinking_tokens");

    const session = upsertSession({
      ...parsed.session,
      message_count: parsed.messages.length,
      tool_call_count: parsed.toolCalls.length,
      total_input_tokens: parsed.session.total_input_tokens ?? inputTokens,
      total_output_tokens: parsed.session.total_output_tokens ?? outputTokens,
      total_cache_read_tokens: parsed.session.total_cache_read_tokens ?? cacheRead,
      total_cache_write_tokens: parsed.session.total_cache_write_tokens ?? cacheWrite,
      total_thinking_tokens: parsed.session.total_thinking_tokens ?? thinking,
    });

    db.prepare("DELETE FROM tool_calls_fts WHERE rowid IN (SELECT rowid FROM tool_calls_fts_refs WHERE session_id = ?)").run(session.id);
    db.prepare("DELETE FROM messages_fts WHERE rowid IN (SELECT rowid FROM messages_fts_refs WHERE session_id = ?)").run(session.id);
    db.prepare("DELETE FROM tool_calls_fts_refs WHERE session_id = ?").run(session.id);
    db.prepare("DELETE FROM messages_fts_refs WHERE session_id = ?").run(session.id);
    db.prepare("DELETE FROM tool_calls WHERE session_id = ?").run(session.id);
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(session.id);

    const insertMessageStmt = db.prepare(INSERT_MESSAGE_SQL);
    const insertToolCallStmt = db.prepare(INSERT_TOOL_CALL_SQL);
    const insertMessageFtsRefStmt = db.prepare(INSERT_MESSAGE_FTS_REF_SQL);
    const insertToolCallFtsRefStmt = db.prepare(INSERT_TOOL_CALL_FTS_REF_SQL);
    const insertMessageFtsStmt = db.prepare(
      `INSERT INTO messages_fts(rowid, message_id, session_id, content)
       VALUES (?, ?, ?, ?)`
    );
    const insertToolCallFtsStmt = db.prepare(
      `INSERT INTO tool_calls_fts(rowid, tool_call_id, session_id, tool_name, tool_input, tool_output)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const msg of parsed.messages) {
      const values = messageInsertValues(session.id, msg);
      insertMessageStmt.run(...values);
      const ref = insertMessageFtsRefStmt.run(session.id, values[0]) as { lastInsertRowid?: number | bigint };
      if (ref.lastInsertRowid == null) throw new Error("failed to allocate messages_fts rowid");
      insertMessageFtsStmt.run(ref.lastInsertRowid, values[0], session.id, values[5]);
    }
    for (const tc of parsed.toolCalls) {
      const values = toolCallInsertValues(session.id, tc);
      insertToolCallStmt.run(...values);
      const ref = insertToolCallFtsRefStmt.run(session.id, values[0]) as { lastInsertRowid?: number | bigint };
      if (ref.lastInsertRowid == null) throw new Error("failed to allocate tool_calls_fts rowid");
      insertToolCallFtsStmt.run(ref.lastInsertRowid, values[0], session.id, values[3], values[4], values[5]);
    }

    return getSession(session.id);
  });
}

function sum(messages: MessageInsert[], key: keyof MessageInsert): number {
  let total = 0;
  for (const m of messages) {
    const v = m[key];
    if (typeof v === "number") total += v;
  }
  return total;
}
