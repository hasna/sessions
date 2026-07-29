import type { TypedQueryClient } from "../../generated/storage-kit/index.js";
import type { SessionLookupOptions } from "../../types/index.js";
import { getCloudClient } from "./client.js";
import { getSessionByPrefix, type ListOptions } from "./store.js";
import { num } from "./store-rows.js";

function clampLimit(limit: number | undefined, fallback: number): number {
  const n = Number(limit ?? fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 500);
}

function isTypedQueryClient(value: unknown): value is TypedQueryClient {
  return (
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    "many" in value
  );
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
  client: TypedQueryClient = getCloudClient(),
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
  client: TypedQueryClient = getCloudClient(),
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
  client: TypedQueryClient = getCloudClient(),
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
  client: TypedQueryClient = getCloudClient(),
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
  optionsOrClient: SessionLookupOptions | TypedQueryClient = {},
  maybeClient?: TypedQueryClient,
): Promise<CloudSessionGraph | null> {
  const opts = isTypedQueryClient(optionsOrClient) ? {} : optionsOrClient;
  const client = isTypedQueryClient(optionsOrClient)
    ? optionsOrClient
    : (maybeClient ?? getCloudClient());
  const session = await getSessionByPrefix(idOrPrefix, opts, client);
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
