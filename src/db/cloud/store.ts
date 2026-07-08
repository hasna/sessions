// Cloud (Postgres) data access for open-sessions serve. PURE REMOTE (A1):
// every function reads/writes the shared RDS directly through the vendored kit.
//
// Cloud holds session/message/tool metadata (large blobs stay local / go to S3
// later), so search here is a metadata search (title/project) rather than the
// SQLite FTS5 full-text index used in local mode.

import type { PoolQueryClient } from "../../generated/storage-kit/index.js";
import type { Machine, Session } from "../../types/index.js";
import { getCloudClient } from "./client.js";
import { encodePath } from "../../lib/paths.js";

interface SessionRow {
  id: string;
  source: string;
  source_id: string;
  source_path: string | null;
  title: string | null;
  project_path: string | null;
  project_name: string | null;
  model: string | null;
  model_provider: string | null;
  git_branch: string | null;
  git_sha: string | null;
  git_origin_url: string | null;
  cli_version: string | null;
  is_subagent: boolean;
  parent_session_id: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  total_thinking_tokens: number;
  message_count: number;
  tool_call_count: number;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  ingested_at: string;
  updated_at: string;
  source_modified_at: string | null;
  machine: string | null;
  metadata: string | null;
  [key: string]: unknown;
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function rowToSession(row: SessionRow): Session {
  let metadata: Record<string, unknown> = {};
  if (row.metadata) {
    try {
      const parsed = JSON.parse(row.metadata);
      if (parsed && typeof parsed === "object") metadata = parsed as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }
  return {
    id: row.id,
    source: row.source as Session["source"],
    source_id: row.source_id,
    source_path: row.source_path,
    title: row.title,
    project_path: row.project_path,
    project_name: row.project_name,
    model: row.model,
    model_provider: row.model_provider,
    git_branch: row.git_branch,
    git_sha: row.git_sha,
    git_origin_url: row.git_origin_url,
    cli_version: row.cli_version,
    is_subagent: Boolean(row.is_subagent),
    parent_session_id: row.parent_session_id,
    total_input_tokens: num(row.total_input_tokens),
    total_output_tokens: num(row.total_output_tokens),
    total_cache_read_tokens: num(row.total_cache_read_tokens),
    total_cache_write_tokens: num(row.total_cache_write_tokens),
    total_thinking_tokens: num(row.total_thinking_tokens),
    message_count: num(row.message_count),
    tool_call_count: num(row.tool_call_count),
    started_at: row.started_at,
    ended_at: row.ended_at,
    duration_seconds: row.duration_seconds === null ? null : num(row.duration_seconds),
    ingested_at: row.ingested_at,
    updated_at: row.updated_at,
    source_modified_at: row.source_modified_at,
    machine: row.machine,
    metadata,
  };
}

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
  client: PoolQueryClient = getCloudClient(),
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
  client: PoolQueryClient = getCloudClient(),
): Promise<Session[]> {
  const rows = await client.many<SessionRow>(
    `SELECT * FROM sessions ORDER BY COALESCE(started_at, ingested_at) DESC LIMIT $1`,
    [clampLimit(limit, 20)],
  );
  return rows.map(rowToSession);
}

export async function getSession(
  id: string,
  client: PoolQueryClient = getCloudClient(),
): Promise<Session | null> {
  const row = await client.get<SessionRow>(`SELECT * FROM sessions WHERE id = $1`, [id]);
  return row ? rowToSession(row) : null;
}

export async function getSessionByPrefix(
  idOrPrefix: string,
  client: PoolQueryClient = getCloudClient(),
): Promise<Session | null> {
  const exact = await getSession(idOrPrefix, client);
  if (exact) return exact;
  const row = await client.get<SessionRow>(
    `SELECT * FROM sessions WHERE id LIKE $1 ORDER BY COALESCE(started_at, ingested_at) DESC LIMIT 1`,
    [`${idOrPrefix}%`],
  );
  return row ? rowToSession(row) : null;
}

export interface SessionSearchHit {
  session: Session;
  match: "title" | "project";
}

export async function searchSessions(
  query: string,
  opts: ListOptions = {},
  client: PoolQueryClient = getCloudClient(),
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

export async function listMachines(client: PoolQueryClient = getCloudClient()): Promise<Machine[]> {
  const rows = await client.many<Machine & Record<string, unknown>>(
    `SELECT name, hostname, platform, first_seen_at, last_seen_at, session_count
       FROM machines ORDER BY last_seen_at DESC`,
  );
  return rows.map((row) => ({
    name: String(row.name),
    hostname: (row.hostname as string) ?? null,
    platform: (row.platform as string) ?? null,
    first_seen_at: String(row.first_seen_at),
    last_seen_at: String(row.last_seen_at),
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

export async function getStats(client: PoolQueryClient = getCloudClient()): Promise<CloudStats> {
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
  started_at?: string | null;
  ended_at?: string | null;
  metadata?: Record<string, unknown>;
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Insert or update a session (metadata only). Keyed on id (or a generated id).
 * Also upserts the (source, source_id) natural key on conflict. Returns the
 * stored row. Cloud is authoritative — no local mirror.
 */
export async function upsertSession(
  input: UpsertSessionInput,
  client: PoolQueryClient = getCloudClient(),
): Promise<Session> {
  const validSources = new Set(["claude", "codex", "gemini"]);
  if (!validSources.has(input.source)) {
    throw new Error(`invalid source '${input.source}' (expected claude|codex|gemini)`);
  }
  if (!input.source_id || typeof input.source_id !== "string") {
    throw new Error("source_id is required");
  }
  const id = input.id && input.id.length > 0 ? input.id : randomId();
  const metadata = JSON.stringify(input.metadata ?? {});
  const now = new Date().toISOString();
  await client.execute(
    `INSERT INTO sessions (
        id, source, source_id, source_path, title, project_path, project_name,
        model, model_provider, git_branch, git_sha, git_origin_url, cli_version,
        is_subagent, parent_session_id, started_at, ended_at, machine,
        ingested_at, updated_at, metadata
     ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
        $14, $15, $16, $17, $18, $19, $19, $20
     )
     ON CONFLICT (id) DO UPDATE SET
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
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
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
      input.started_at ?? null,
      input.ended_at ?? null,
      input.machine ?? null,
      now,
      metadata,
    ],
  );
  const stored = await getSession(id, client);
  if (!stored) throw new Error("failed to read back upserted session");
  return stored;
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
  client: PoolQueryClient = getCloudClient(),
): Promise<boolean> {
  const row = await client.get<{ id: string }>(
    `DELETE FROM sessions WHERE id = $1 RETURNING id`,
    [id],
  );
  return row !== null;
}

// ---------------------------------------------------------------------------
// Content search / tool-call search / knowledge graph over the shared RDS.
//
// Cloud holds session + message + tool_call metadata (blobs stay local/S3), so
// this is an ILIKE substring search rather than the SQLite FTS5 index used
// locally — but it reads the SHARED cloud data, so every machine sees one index.
// ---------------------------------------------------------------------------

/** One content-search hit per session (mirrors lib/search `SearchHit`). */
export interface ContentSearchHit {
  session_id: string;
  source: string;
  title: string | null;
  project_name: string | null;
  project_path: string | null;
  started_at: string | null;
  snippet: string;
  rank: number;
}

function sessionFilterClauses(opts: ListOptions, params: unknown[], alias = "s"): string {
  const clauses: string[] = [];
  if (opts.source) {
    params.push(opts.source);
    clauses.push(`${alias}.source = $${params.length}`);
  }
  if (opts.project_path) {
    params.push(opts.project_path);
    clauses.push(`(${alias}.project_path = $${params.length} OR ${alias}.project_name = $${params.length})`);
  }
  if (opts.machine) {
    params.push(opts.machine);
    clauses.push(`${alias}.machine = $${params.length}`);
  }
  return clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
}

/**
 * Full-text-ish content search over the shared cloud: matches on message content
 * and session metadata (title/project), deduped to one best hit per session.
 */
export async function searchContent(
  query: string,
  opts: ListOptions = {},
  client: PoolQueryClient = getCloudClient(),
): Promise<ContentSearchHit[]> {
  const limit = clampLimit(opts.limit, 20);
  const like = `%${query}%`;

  const messageParams: unknown[] = [like];
  const messageFilter = sessionFilterClauses(opts, messageParams, "s");
  messageParams.push(limit * 10);
  const messageRows = await client.many<Record<string, unknown>>(
    `SELECT s.id AS session_id, s.source, s.title, s.project_name, s.project_path, s.started_at,
            LEFT(m.content, 200) AS snippet
       FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE m.content ILIKE $1${messageFilter}
      ORDER BY COALESCE(s.started_at, s.ingested_at) DESC
      LIMIT $${messageParams.length}`,
    messageParams,
  );

  const metaParams: unknown[] = [like];
  const metaFilter = sessionFilterClauses(opts, metaParams, "s");
  metaParams.push(limit * 5);
  const metaRows = await client.many<Record<string, unknown>>(
    `SELECT s.id AS session_id, s.source, s.title, s.project_name, s.project_path, s.started_at,
            COALESCE(s.title, s.project_name, '') AS snippet
       FROM sessions s
      WHERE (s.title ILIKE $1 OR s.project_name ILIKE $1 OR s.project_path ILIKE $1)${metaFilter}
      ORDER BY COALESCE(s.started_at, s.ingested_at) DESC
      LIMIT $${metaParams.length}`,
    metaParams,
  );

  const byId = new Map<string, ContentSearchHit>();
  const add = (rows: Record<string, unknown>[]) => {
    for (const r of rows) {
      const id = String(r.session_id);
      if (byId.has(id)) continue;
      byId.set(id, {
        session_id: id,
        source: String(r.source),
        title: (r.title as string) ?? null,
        project_name: (r.project_name as string) ?? null,
        project_path: (r.project_path as string) ?? null,
        started_at: (r.started_at as string) ?? null,
        snippet: (r.snippet as string) ?? "",
        rank: 0,
      });
      if (byId.size >= limit) break;
    }
  };
  // Metadata matches first (stronger identity signal), then message content.
  add(metaRows);
  add(messageRows);
  return [...byId.values()].slice(0, limit);
}

/** One tool-call hit (mirrors lib/search `ToolCallHit`). */
export interface CloudToolCallHit {
  session_id: string;
  source: string;
  title: string | null;
  project_name: string | null;
  project_path: string | null;
  started_at: string | null;
  tool_name: string;
  snippet: string;
  rank: number;
}

/** Substring search over tool calls (name / input / output) in the shared cloud. */
export async function searchToolCalls(
  query: string,
  opts: ListOptions = {},
  client: PoolQueryClient = getCloudClient(),
): Promise<CloudToolCallHit[]> {
  const limit = clampLimit(opts.limit, 20);
  const params: unknown[] = [`%${query}%`];
  const filter = sessionFilterClauses(opts, params, "s");
  params.push(limit);
  const rows = await client.many<Record<string, unknown>>(
    `SELECT s.id AS session_id, s.source, s.title, s.project_name, s.project_path, s.started_at,
            tc.tool_name AS tool_name,
            LEFT(COALESCE(tc.tool_input, tc.tool_output, tc.tool_name), 200) AS snippet
       FROM tool_calls tc JOIN sessions s ON s.id = tc.session_id
      WHERE (tc.tool_name ILIKE $1 OR tc.tool_input ILIKE $1 OR tc.tool_output ILIKE $1)${filter}
      ORDER BY COALESCE(tc.timestamp, s.started_at, s.ingested_at) DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    session_id: String(r.session_id),
    source: String(r.source),
    title: (r.title as string) ?? null,
    project_name: (r.project_name as string) ?? null,
    project_path: (r.project_path as string) ?? null,
    started_at: (r.started_at as string) ?? null,
    tool_name: String(r.tool_name),
    snippet: (r.snippet as string) ?? "",
    rank: 0,
  }));
}

export type CloudEntityType = "project" | "tool" | "model" | "provider" | "repo";

export interface CloudEntity {
  type: CloudEntityType;
  name: string;
  session_count: number;
}

const ENTITY_QUERIES: Record<CloudEntityType, string> = {
  project: `SELECT project_name AS name, COUNT(*) AS n FROM sessions WHERE project_name IS NOT NULL AND project_name != '' GROUP BY project_name`,
  model: `SELECT model AS name, COUNT(*) AS n FROM sessions WHERE model IS NOT NULL AND model != '' GROUP BY model`,
  provider: `SELECT model_provider AS name, COUNT(*) AS n FROM sessions WHERE model_provider IS NOT NULL AND model_provider != '' GROUP BY model_provider`,
  repo: `SELECT git_origin_url AS name, COUNT(*) AS n FROM sessions WHERE git_origin_url IS NOT NULL AND git_origin_url != '' GROUP BY git_origin_url`,
  tool: `SELECT tc.tool_name AS name, COUNT(DISTINCT tc.session_id) AS n FROM tool_calls tc GROUP BY tc.tool_name`,
};

const RELATED_SQL: Record<CloudEntityType, string> = {
  project: `SELECT id AS session_id, source, title, project_name, started_at FROM sessions WHERE project_name = $1`,
  model: `SELECT id AS session_id, source, title, project_name, started_at FROM sessions WHERE model = $1`,
  provider: `SELECT id AS session_id, source, title, project_name, started_at FROM sessions WHERE model_provider = $1`,
  repo: `SELECT id AS session_id, source, title, project_name, started_at FROM sessions WHERE git_origin_url = $1`,
  tool: `SELECT s.id AS session_id, s.source, s.title, s.project_name, s.started_at FROM sessions s
         WHERE s.id IN (SELECT DISTINCT session_id FROM tool_calls WHERE tool_name = $1)`,
};

const ENTITY_TYPES: CloudEntityType[] = ["project", "tool", "model", "provider", "repo"];

/** Knowledge-graph entities (projects/tools/models/providers/repos) from the shared cloud. */
export async function graphEntities(
  type: CloudEntityType | undefined,
  client: PoolQueryClient = getCloudClient(),
): Promise<CloudEntity[]> {
  const types = type ? [type] : ENTITY_TYPES;
  const out: CloudEntity[] = [];
  for (const t of types) {
    const rows = await client.many<{ name: string; n: number }>(`${ENTITY_QUERIES[t]} ORDER BY n DESC`);
    for (const r of rows) out.push({ type: t, name: String(r.name), session_count: num(r.n) });
  }
  return out;
}

export interface CloudRelatedSession {
  session_id: string;
  source: string;
  title: string | null;
  project_name: string | null;
  started_at: string | null;
}

/** Sessions linked to a specific graph entity in the shared cloud. */
export async function graphRelated(
  type: CloudEntityType,
  name: string,
  limit = 50,
  client: PoolQueryClient = getCloudClient(),
): Promise<CloudRelatedSession[]> {
  const rows = await client.many<Record<string, unknown>>(
    `${RELATED_SQL[type]} ORDER BY COALESCE(started_at, ingested_at) DESC LIMIT $2`,
    [name, clampLimit(limit, 50)],
  );
  return rows.map((r) => ({
    session_id: String(r.session_id),
    source: String(r.source),
    title: (r.title as string) ?? null,
    project_name: (r.project_name as string) ?? null,
    started_at: (r.started_at as string) ?? null,
  }));
}

export interface CloudSessionGraph {
  session_id: string;
  project: string | null;
  model: string | null;
  provider: string | null;
  repo: string | null;
  tools: string[];
}

/** The entity neighborhood of one session (resolved by id or prefix) in the shared cloud. */
export async function graphSession(
  idOrPrefix: string,
  client: PoolQueryClient = getCloudClient(),
): Promise<CloudSessionGraph | null> {
  const session = await getSessionByPrefix(idOrPrefix, client);
  if (!session) return null;
  const tools = await client.many<{ tool_name: string }>(
    `SELECT DISTINCT tool_name FROM tool_calls WHERE session_id = $1 ORDER BY tool_name`,
    [session.id],
  );
  return {
    session_id: session.id,
    project: session.project_name,
    model: session.model,
    provider: session.model_provider,
    repo: session.git_origin_url,
    tools: tools.map((t) => t.tool_name),
  };
}
