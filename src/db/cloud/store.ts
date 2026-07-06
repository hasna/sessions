// Cloud (Postgres) data access for open-sessions serve. PURE REMOTE (A1):
// every function reads/writes the shared RDS directly through the vendored kit.
//
// Cloud holds session/message/tool metadata (large blobs stay local / go to S3
// later), so search here is a metadata search (title/project) rather than the
// SQLite FTS5 full-text index used in local mode.

import type { PoolQueryClient } from "../../generated/storage-kit/index.js";
import type { Machine, Session } from "../../types/index.js";
import { getCloudClient } from "./client.js";

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
