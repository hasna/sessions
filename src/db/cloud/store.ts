import type { PoolQueryClient, TypedQueryClient } from "../../generated/storage-kit/index.js";
import type {
  Machine,
  Message,
  MessageInsert,
  Session,
  SessionContentBackup,
  SessionContentImport,
  SessionLookupOptions,
  ToolCall,
  ToolCallInsert,
} from "../../types/index.js";
import {
  SESSION_SOURCES,
  SessionAmbiguousError,
  SessionInvalidIdentifierError,
} from "../../types/index.js";
import { getCloudClient } from "./client.js";
import { encodePath } from "../../lib/paths.js";
import { contentShrinkError } from "../../lib/content-import-safety.js";
import { sanitizeSessionContentImport, sanitizeSessionInsert } from "../../lib/import-sanitizer.js";
import {
  num,
  rowToMessage,
  rowToSession,
  rowToToolCall,
  type MessageRow,
  type SessionRow,
  type ToolCallRow,
} from "./store-rows.js";

export * from "./store-search.js";

export interface ListOptions {
  source?: string;
  project_path?: string;
  machine?: string;
  limit?: number;
}

function buildFilters(opts: ListOptions, params: unknown[]): string {
  const clauses: string[] = [];
  if (opts.source) {
    params.push(opts.source);
    clauses.push(`source = $${params.length}`);
  }
  if (opts.project_path) {
    params.push(opts.project_path);
    clauses.push(`project_path = $${params.length}`);
  }
  if (opts.machine) {
    params.push(opts.machine);
    clauses.push(`machine = $${params.length}`);
  }
  return clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
}

function clampLimit(limit: number | undefined, fallback: number): number {
  const n = Number(limit ?? fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 500);
}

export async function listSessions(
  opts: ListOptions = {},
  client: TypedQueryClient = getCloudClient(),
): Promise<Session[]> {
  const params: unknown[] = [];
  const where = buildFilters(opts, params);
  const limit = clampLimit(opts.limit, 50);
  params.push(limit);
  const rows = await client.many<SessionRow>(
    `SELECT * FROM sessions ${where} ORDER BY COALESCE(started_at, ingested_at) DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(rowToSession);
}

export async function getRecentSessions(
  limit = 20,
  client: TypedQueryClient = getCloudClient(),
): Promise<Session[]> {
  const rows = await client.many<SessionRow>(
    `SELECT * FROM sessions ORDER BY COALESCE(started_at, ingested_at) DESC LIMIT $1`,
    [clampLimit(limit, 20)],
  );
  return rows.map(rowToSession);
}

export async function getSession(
  id: string,
  client: TypedQueryClient = getCloudClient(),
): Promise<Session | null> {
  const row = await client.get<SessionRow>(`SELECT * FROM sessions WHERE id = $1`, [id]);
  return row ? rowToSession(row) : null;
}

function isTypedQueryClient(value: unknown): value is TypedQueryClient {
  return (
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    "many" in value
  );
}

function parseQualifiedSessionIdentifier(
  idOrPrefix: string,
  opts: SessionLookupOptions = {},
): { source: string | null; identifier: string } {
  if (opts.source) return { source: opts.source, identifier: idOrPrefix };
  const colon = idOrPrefix.indexOf(":");
  if (colon > 0) {
    const source = idOrPrefix.slice(0, colon);
    if ((SESSION_SOURCES as readonly string[]).includes(source)) {
      return { source, identifier: idOrPrefix.slice(colon + 1) };
    }
  }
  return { source: null, identifier: idOrPrefix };
}

function uniqueCloudSessionOrThrow(identifier: string, rows: SessionRow[]): Session | null {
  const unique = new Map<string, SessionRow>();
  for (const row of rows) unique.set(row.id, row);
  const deduped = [...unique.values()];
  if (deduped.length === 0) return null;
  if (deduped.length === 1) return rowToSession(deduped[0]);
  throw new SessionAmbiguousError(
    identifier,
    deduped.map((row) => ({ id: row.id, source: row.source, source_id: row.source_id })),
  );
}

function escapedLikePrefix(value: string): string {
  return `${value.replace(/[\\%_]/g, "\\$&")}%`;
}

function rejectEmptySourceQualifiedIdentifier(displayIdentifier: string, identifier: string): void {
  if (identifier.length === 0) {
    throw new SessionInvalidIdentifierError(
      displayIdentifier,
      "source-qualified identifiers must include a non-empty source id",
    );
  }
}

export async function getSessionByPrefix(
  idOrPrefix: string,
  optionsOrClient: SessionLookupOptions | TypedQueryClient = {},
  maybeClient?: TypedQueryClient,
): Promise<Session | null> {
  const opts = isTypedQueryClient(optionsOrClient) ? {} : optionsOrClient;
  const client = isTypedQueryClient(optionsOrClient)
    ? optionsOrClient
    : (maybeClient ?? getCloudClient());
  const lookup = parseQualifiedSessionIdentifier(idOrPrefix, opts);
  if (!lookup.source) {
    const exactId = await getSession(idOrPrefix, client);
    if (exactId) return exactId;
  }

  if (lookup.source) {
    rejectEmptySourceQualifiedIdentifier(idOrPrefix, lookup.identifier);
    const exactSource = await client.many<SessionRow>(
      `SELECT * FROM sessions WHERE source = $1 AND source_id = $2 ORDER BY id LIMIT 6`,
      [lookup.source, lookup.identifier],
    );
    const exact = uniqueCloudSessionOrThrow(idOrPrefix, exactSource);
    if (exact) return exact;
    const prefix = escapedLikePrefix(lookup.identifier);
    const rows = await client.many<SessionRow>(
      `SELECT * FROM sessions WHERE source = $1 AND source_id LIKE $2 ESCAPE '\\' ORDER BY source_id, id LIMIT 6`,
      [lookup.source, prefix],
    );
    return uniqueCloudSessionOrThrow(idOrPrefix, rows);
  }

  const exactNative = await client.many<SessionRow>(
    `SELECT * FROM sessions WHERE source_id = $1 ORDER BY source, id LIMIT 6`,
    [idOrPrefix],
  );
  const exact = uniqueCloudSessionOrThrow(idOrPrefix, exactNative);
  if (exact) return exact;

  const prefix = escapedLikePrefix(idOrPrefix);
  const rows = await client.many<SessionRow>(
    `SELECT * FROM sessions WHERE id LIKE $1 ESCAPE '\\' OR source_id LIKE $1 ESCAPE '\\' ORDER BY id LIMIT 6`,
    [prefix],
  );
  return uniqueCloudSessionOrThrow(idOrPrefix, rows);
}

export interface SessionSearchHit {
  session: Session;
  match: "title" | "project";
}

export async function searchSessions(
  query: string,
  opts: ListOptions = {},
  client: TypedQueryClient = getCloudClient(),
): Promise<SessionSearchHit[]> {
  const params: unknown[] = [`%${query}%`];
  const clauses = ["(title ILIKE $1 OR project_name ILIKE $1 OR project_path ILIKE $1)"];
  if (opts.source) {
    params.push(opts.source);
    clauses.push(`source = $${params.length}`);
  }
  if (opts.project_path) {
    params.push(opts.project_path);
    clauses.push(`project_path = $${params.length}`);
  }
  if (opts.machine) {
    params.push(opts.machine);
    clauses.push(`machine = $${params.length}`);
  }
  const limit = clampLimit(opts.limit, 20);
  params.push(limit);
  const rows = await client.many<SessionRow>(
    `SELECT * FROM sessions WHERE ${clauses.join(" AND ")}
      ORDER BY COALESCE(started_at, ingested_at) DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map((row) => ({
    session: rowToSession(row),
    match: (row.title ?? "").toLowerCase().includes(query.toLowerCase()) ? "title" : "project",
  }));
}

export async function listMachines(client: TypedQueryClient = getCloudClient()): Promise<Machine[]> {
  // Aggregate machines directly from the machine tags carried by stored sessions.
  // The `machines` table is only maintained by the local ingest/recompute path and
  // is never populated when sessions arrive via the /v1 API (upsertSession only
  // writes sessions.machine). Deriving from sessions keeps the counts truthful in
  // self_hosted mode; the machines table is LEFT JOINed purely for optional
  // hostname/platform/first-last-seen metadata when a machine has registered.
  const rows = await client.many<Machine & Record<string, unknown>>(
    `SELECT
        s.machine AS name,
        m.hostname AS hostname,
        m.platform AS platform,
        COALESCE(m.first_seen_at, MIN(COALESCE(s.started_at, s.ingested_at))) AS first_seen_at,
        COALESCE(m.last_seen_at, MAX(COALESCE(s.ended_at, s.started_at, s.updated_at, s.ingested_at))) AS last_seen_at,
        COUNT(*) AS session_count
       FROM sessions s
       LEFT JOIN machines m ON m.name = s.machine
      WHERE s.machine IS NOT NULL AND s.machine <> ''
      GROUP BY s.machine, m.hostname, m.platform, m.first_seen_at, m.last_seen_at
      ORDER BY session_count DESC, name ASC`,
  );
  return rows.map((row) => ({
    name: String(row.name),
    hostname: (row.hostname as string) ?? null,
    platform: (row.platform as string) ?? null,
    first_seen_at: row.first_seen_at == null ? "" : String(row.first_seen_at),
    last_seen_at: row.last_seen_at == null ? "" : String(row.last_seen_at),
    session_count: num(row.session_count),
  }));
}

export interface CloudStats {
  session_count: number;
  message_count: number;
  tool_call_count: number;
  by_source: { source: string; sessions: number }[];
  projects: { project_name: string | null; project_path: string | null; session_count: number }[];
}

export async function getStats(client: TypedQueryClient = getCloudClient()): Promise<CloudStats> {
  const totals = await client.get<{ sessions: number; messages: number; tool_calls: number }>(
    `SELECT
        (SELECT COUNT(*) FROM sessions) AS sessions,
        (SELECT COUNT(*) FROM messages) AS messages,
        (SELECT COUNT(*) FROM tool_calls) AS tool_calls`,
  );
  const bySource = await client.many<{ source: string; sessions: number }>(
    `SELECT source, COUNT(*) AS sessions FROM sessions GROUP BY source ORDER BY sessions DESC`,
  );
  const projects = await client.many<{
    project_name: string | null;
    project_path: string | null;
    session_count: number;
  }>(
    `SELECT project_name, project_path, COUNT(*) AS session_count
       FROM sessions GROUP BY project_name, project_path
       ORDER BY session_count DESC LIMIT 30`,
  );
  return {
    session_count: num(totals?.sessions),
    message_count: num(totals?.messages),
    tool_call_count: num(totals?.tool_calls),
    by_source: bySource.map((r) => ({ source: r.source, sessions: num(r.sessions) })),
    projects: projects.map((r) => ({
      project_name: r.project_name,
      project_path: r.project_path,
      session_count: num(r.session_count),
    })),
  };
}

export interface UpsertSessionInput {
  id?: string;
  source: string;
  source_id: string;
  source_path?: string | null;
  title?: string | null;
  project_path?: string | null;
  project_name?: string | null;
  model?: string | null;
  model_provider?: string | null;
  git_branch?: string | null;
  git_sha?: string | null;
  git_origin_url?: string | null;
  cli_version?: string | null;
  is_subagent?: boolean;
  parent_session_id?: string | null;
  machine?: string | null;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cache_read_tokens?: number;
  total_cache_write_tokens?: number;
  total_thinking_tokens?: number;
  message_count?: number;
  tool_call_count?: number;
  started_at?: string | null;
  ended_at?: string | null;
  duration_seconds?: number | null;
  source_modified_at?: string | null;
  metadata?: Record<string, unknown>;
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Insert or update a session row. The (source, source_id) natural key is the
 * idempotency key; a provided id is used only for new natural-key rows.
 * Cloud is authoritative - no local mirror.
 */
export async function upsertSession(
  input: UpsertSessionInput,
  client: TypedQueryClient = getCloudClient(),
): Promise<Session> {
  input = sanitizeSessionInsert(input);
  const validSources = new Set<string>(SESSION_SOURCES);
  if (!validSources.has(input.source)) {
    throw new Error(`invalid source '${input.source}' (expected ${SESSION_SOURCES.join("|")})`);
  }
  if (!input.source_id || typeof input.source_id !== "string") {
    throw new Error("source_id is required");
  }
  const existing = await client.get<{ id: string }>(
    `SELECT id FROM sessions WHERE source = $1 AND source_id = $2`,
    [input.source, input.source_id],
  );
  const id = existing?.id ?? (input.id && input.id.length > 0 ? input.id : randomId());
  const metadata = JSON.stringify(input.metadata ?? {});
  const now = new Date().toISOString();
  await client.execute(
    `INSERT INTO sessions (
        id, source, source_id, source_path, title, project_path, project_name,
        model, model_provider, git_branch, git_sha, git_origin_url, cli_version,
        is_subagent, parent_session_id, total_input_tokens, total_output_tokens,
        total_cache_read_tokens, total_cache_write_tokens, total_thinking_tokens,
        message_count, tool_call_count, started_at, ended_at, duration_seconds,
        source_modified_at, machine, ingested_at, updated_at, metadata
     ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25,
        $26, $27, $28, $29, $30
     )
     ON CONFLICT (source, source_id) DO UPDATE SET
        source_path = EXCLUDED.source_path,
        title = EXCLUDED.title,
        project_path = EXCLUDED.project_path,
        project_name = EXCLUDED.project_name,
        model = EXCLUDED.model,
        model_provider = EXCLUDED.model_provider,
        git_branch = EXCLUDED.git_branch,
        git_sha = EXCLUDED.git_sha,
        git_origin_url = EXCLUDED.git_origin_url,
        cli_version = EXCLUDED.cli_version,
        is_subagent = EXCLUDED.is_subagent,
        parent_session_id = EXCLUDED.parent_session_id,
        total_input_tokens = EXCLUDED.total_input_tokens,
        total_output_tokens = EXCLUDED.total_output_tokens,
        total_cache_read_tokens = EXCLUDED.total_cache_read_tokens,
        total_cache_write_tokens = EXCLUDED.total_cache_write_tokens,
        total_thinking_tokens = EXCLUDED.total_thinking_tokens,
        message_count = EXCLUDED.message_count,
        tool_call_count = EXCLUDED.tool_call_count,
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        duration_seconds = EXCLUDED.duration_seconds,
        source_modified_at = EXCLUDED.source_modified_at,
        machine = EXCLUDED.machine,
        updated_at = EXCLUDED.updated_at,
        metadata = EXCLUDED.metadata`,
    [
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
      input.is_subagent ?? false,
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
      input.source_modified_at ?? null,
      input.machine ?? null,
      now,
      now,
      metadata,
    ],
  );
  const stored = await getSession(id, client);
  if (!stored) throw new Error("failed to read back upserted session");
  return stored;
}

function sumMessages(messages: MessageInsert[], key: keyof MessageInsert): number {
  let total = 0;
  for (const message of messages) {
    const value = message[key];
    if (typeof value === "number") total += value;
  }
  return total;
}

function messageId(input: MessageInsert): string {
  return input.id && input.id.length > 0 ? input.id : randomId();
}

function toolCallId(input: ToolCallInsert): string {
  return input.id && input.id.length > 0 ? input.id : randomId();
}

function validMessageRole(role: unknown): role is Message["role"] {
  return ["user", "assistant", "system", "tool", "info", "thinking"].includes(String(role));
}

function validToolStatus(status: unknown): status is ToolCall["status"] {
  return status === null || status === undefined || ["success", "error", "timeout"].includes(String(status));
}

export interface SessionContentImportResult {
  session: Session;
  imported: { messages: number; toolCalls: number };
  backup: SessionContentBackup | null;
}

export async function importSessionContent(
  input: SessionContentImport,
  client: PoolQueryClient = getCloudClient(),
): Promise<SessionContentImportResult> {
  if (!input || typeof input !== "object") throw new Error("expected a JSON object body");
  if (!input.session || typeof input.session !== "object") throw new Error("session is required");
  if (!Array.isArray(input.messages)) throw new Error("messages must be an array");
  if (!Array.isArray(input.toolCalls)) throw new Error("toolCalls must be an array");
  input = sanitizeSessionContentImport(input);
  const messages = input.messages;
  const toolCalls = input.toolCalls;
  for (const message of messages) {
    if (!validMessageRole(message.role)) throw new Error(`invalid message role '${String(message.role)}'`);
  }
  for (const toolCall of toolCalls) {
    if (!toolCall.tool_name || typeof toolCall.tool_name !== "string") {
      throw new Error("tool_call.tool_name is required");
    }
    if (!validToolStatus(toolCall.status)) {
      throw new Error(`invalid tool_call status '${String(toolCall.status)}'`);
    }
  }

  return client.transaction(async (tx) => {
    const existing = await tx.get<{ id: string }>(
      `SELECT id FROM sessions WHERE source = $1 AND source_id = $2`,
      [input.session.source, input.session.source_id],
    );
    if (existing) {
      const counts = await tx.get<{ messages: number; tool_calls: number }>(
        `SELECT
            (SELECT COUNT(*) FROM messages WHERE session_id = $1) AS messages,
            (SELECT COUNT(*) FROM tool_calls WHERE session_id = $1) AS tool_calls`,
        [existing.id],
      );
      const error = contentShrinkError(input, {
        messages: num(counts?.messages),
        toolCalls: num(counts?.tool_calls),
      });
      if (error) throw new Error(error);
    }

    const session = await upsertSession(
      {
        ...input.session,
        message_count: messages.length,
        tool_call_count: toolCalls.length,
        total_input_tokens: input.session.total_input_tokens ?? sumMessages(messages, "input_tokens"),
        total_output_tokens: input.session.total_output_tokens ?? sumMessages(messages, "output_tokens"),
        total_cache_read_tokens:
          input.session.total_cache_read_tokens ?? sumMessages(messages, "cache_read_tokens"),
        total_cache_write_tokens:
          input.session.total_cache_write_tokens ?? sumMessages(messages, "cache_write_tokens"),
        total_thinking_tokens:
          input.session.total_thinking_tokens ?? sumMessages(messages, "thinking_tokens"),
      },
      tx,
    );

    await tx.execute(`DELETE FROM tool_calls WHERE session_id = $1`, [session.id]);
    await tx.execute(`DELETE FROM messages WHERE session_id = $1`, [session.id]);

    for (const message of messages) {
      await tx.execute(
        `INSERT INTO messages (
            id, session_id, source_id, parent_message_id, role, content, content_preview,
            model, is_sidechain, sequence_num, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, thinking_tokens, timestamp, metadata
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
          )`,
        [
          messageId(message),
          session.id,
          message.source_id ?? null,
          message.parent_message_id ?? null,
          message.role,
          message.content ?? null,
          message.content_preview ?? (message.content ? message.content.slice(0, 280) : null),
          message.model ?? null,
          message.is_sidechain ?? false,
          message.sequence_num ?? null,
          message.input_tokens ?? 0,
          message.output_tokens ?? 0,
          message.cache_read_tokens ?? 0,
          message.cache_write_tokens ?? 0,
          message.thinking_tokens ?? 0,
          message.timestamp ?? null,
          JSON.stringify(message.metadata ?? {}),
        ],
      );
    }

    for (const toolCall of toolCalls) {
      await tx.execute(
        `INSERT INTO tool_calls (
            id, message_id, session_id, tool_name, tool_input, tool_output,
            duration_ms, status, timestamp, metadata
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
          )`,
        [
          toolCallId(toolCall),
          toolCall.message_id ?? null,
          session.id,
          toolCall.tool_name,
          toolCall.tool_input ?? null,
          toolCall.tool_output ?? null,
          toolCall.duration_ms ?? null,
          toolCall.status ?? null,
          toolCall.timestamp ?? null,
          JSON.stringify(toolCall.metadata ?? {}),
        ],
      );
    }

    const stored = await getSession(session.id, tx);
    if (!stored) throw new Error("failed to read back imported session");
    return {
      session: stored,
      imported: { messages: messages.length, toolCalls: toolCalls.length },
      backup: input.backup ?? null,
    };
  });
}

export async function getMessages(
  sessionId: string,
  client: TypedQueryClient = getCloudClient(),
): Promise<Message[]> {
  const rows = await client.many<MessageRow>(
    `SELECT * FROM messages WHERE session_id = $1 ORDER BY sequence_num ASC, timestamp ASC`,
    [sessionId],
  );
  return rows.map(rowToMessage);
}

export async function getToolCalls(
  sessionId: string,
  client: TypedQueryClient = getCloudClient(),
): Promise<ToolCall[]> {
  const rows = await client.many<ToolCallRow>(
    `SELECT * FROM tool_calls WHERE session_id = $1 ORDER BY timestamp ASC`,
    [sessionId],
  );
  return rows.map(rowToToolCall);
}

export interface RelocateResult {
  /** Number of `sessions` rows whose project_path was rewritten. */
  rowsUpdated: number;
}

/**
 * Rewrite session paths in the shared RDS after a project directory move
 * (old -> new). Mirrors the local relocate: updates `sessions.project_path`,
 * `sessions.source_path`, and the path-encoded `ingestion_state.file_path`.
 * This is the cloud (self_hosted) half of the Store's `relocatePaths`, so a
 * relocate against a machine in self_hosted mode mutates the ONE shared
 * registry instead of a non-authoritative on-box index.
 */
export async function relocatePaths(
  oldPath: string,
  newPath: string,
  client: PoolQueryClient = getCloudClient(),
): Promise<RelocateResult> {
  return client.transaction(async (tx) => {
    const sessions = await tx.query(
      `UPDATE sessions
          SET project_path = $1 || substr(project_path, $2), updated_at = $3
        WHERE project_path LIKE $4 || '%'`,
      [newPath, oldPath.length + 1, new Date().toISOString(), oldPath],
    );
    await tx.execute(
      `UPDATE sessions SET source_path = replace(source_path, $1, $2)
        WHERE source_path LIKE $1 || '%'`,
      [oldPath, newPath],
    );
    await tx.execute(
      `UPDATE ingestion_state SET file_path = replace(file_path, $1, $2)
        WHERE file_path LIKE $1 || '%'`,
      [encodePath(oldPath), encodePath(newPath)],
    );
    return { rowsUpdated: sessions.rowCount ?? 0 };
  });
}

/** Delete a session by id. Returns true if a row was removed. */
export async function deleteSession(
  id: string,
  client: TypedQueryClient = getCloudClient(),
): Promise<boolean> {
  const row = await client.get<{ id: string }>(
    `DELETE FROM sessions WHERE id = $1 RETURNING id`,
    [id],
  );
  return row !== null;
}

/**
 * Set a session's title (the "rename" operation), resolving by full id or a
 * unique id prefix. Title is searched via ILIKE directly on the sessions table,
 * so there is no separate FTS index to keep in sync. Returns the updated
 * Session, or null when no match exists.
 */
export async function updateSessionTitle(
  idOrPrefix: string,
  title: string,
  optionsOrClient: SessionLookupOptions | TypedQueryClient = {},
  maybeClient?: TypedQueryClient,
): Promise<Session | null> {
  const opts = isTypedQueryClient(optionsOrClient) ? {} : optionsOrClient;
  const client = isTypedQueryClient(optionsOrClient)
    ? optionsOrClient
    : (maybeClient ?? getCloudClient());
  const target = await getSessionByPrefix(idOrPrefix, opts, client);
  if (!target) return null;
  const row = await client.get<SessionRow>(
    `UPDATE sessions SET title = $1, updated_at = $2 WHERE id = $3 RETURNING *`,
    [title, new Date().toISOString(), target.id],
  );
  return row ? rowToSession(row) : null;
}
