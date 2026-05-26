import { getDatabase } from "../db/database.js";

export interface SearchHit {
  session_id: string;
  source: string;
  title: string | null;
  project_name: string | null;
  project_path: string | null;
  started_at: string | null;
  snippet: string;
  rank: number;
}

export interface SearchOptions {
  limit?: number;
  source?: string;
  project_path?: string;
}

/**
 * Convert a free-text query into a safe FTS5 MATCH expression. Each whitespace
 * token is wrapped in double quotes (escaping embedded quotes) and combined with
 * implicit AND, which avoids FTS5 syntax errors on punctuation in user input.
 */
export function toFtsQuery(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

function filterClause(opts: SearchOptions, params: unknown[]): string {
  const where: string[] = [];
  if (opts.source) {
    where.push("s.source = ?");
    params.push(opts.source);
  }
  if (opts.project_path) {
    where.push("s.project_path = ?");
    params.push(opts.project_path);
  }
  return where.length ? ` AND ${where.join(" AND ")}` : "";
}

/**
 * Full-text search over message content. Returns one hit per matching session
 * (the best-ranked message snippet), ordered by BM25 relevance then recency.
 */
export function searchMessages(query: string, opts: SearchOptions = {}): SearchHit[] {
  const db = getDatabase();
  const match = toFtsQuery(query);
  const params: unknown[] = [match];
  const filter = filterClause(opts, params);
  const limit = opts.limit ?? 20;
  // FTS5 auxiliary functions (bm25/snippet) require a direct query against the
  // FTS table — they error inside subqueries/aggregates. So fetch ranked message
  // rows directly and dedupe to one hit per session (best rank) in JS.
  params.push(limit * 5);

  const rows = db
    .prepare(
      `SELECT s.id AS session_id, s.source, s.title, s.project_name, s.project_path, s.started_at,
              snippet(messages_fts, 2, '[', ']', '…', 12) AS snippet,
              bm25(messages_fts) AS rank
       FROM messages_fts
       JOIN sessions s ON s.id = messages_fts.session_id
       WHERE messages_fts MATCH ?${filter}
       ORDER BY rank ASC, s.started_at DESC
       LIMIT ?`
    )
    .all(...params) as Record<string, unknown>[];

  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const r of rows) {
    const id = r.session_id as string;
    if (seen.has(id)) continue;
    seen.add(id);
    hits.push(toHit(r));
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Full-text search over session titles / project names. */
export function searchSessions(query: string, opts: SearchOptions = {}): SearchHit[] {
  const db = getDatabase();
  const match = toFtsQuery(query);
  const params: unknown[] = [match];
  const filter = filterClause(opts, params);
  const limit = opts.limit ?? 20;
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT s.id AS session_id, s.source, s.title, s.project_name, s.project_path, s.started_at,
              snippet(sessions_fts, 1, '[', ']', '…', 12) AS snippet,
              bm25(sessions_fts) AS rank
       FROM sessions_fts
       JOIN sessions s ON s.id = sessions_fts.session_id
       WHERE sessions_fts MATCH ?${filter}
       ORDER BY rank ASC, s.started_at DESC
       LIMIT ?`
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map(toHit);
}

export interface ToolCallHit {
  session_id: string;
  source: string;
  project_name: string | null;
  tool_name: string;
  snippet: string;
  rank: number;
}

/** Full-text search over tool calls (name / input / output). */
export function searchToolCalls(query: string, opts: SearchOptions = {}): ToolCallHit[] {
  const db = getDatabase();
  const match = toFtsQuery(query);
  const params: unknown[] = [match];
  const filter = filterClause(opts, params);
  const limit = opts.limit ?? 20;
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT s.id AS session_id, s.source, s.project_name,
              tool_calls_fts.tool_name AS tool_name,
              snippet(tool_calls_fts, 3, '[', ']', '…', 12) AS snippet,
              bm25(tool_calls_fts) AS rank
       FROM tool_calls_fts
       JOIN sessions s ON s.id = tool_calls_fts.session_id
       WHERE tool_calls_fts MATCH ?${filter}
       ORDER BY rank ASC
       LIMIT ?`
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map((r) => ({
    session_id: r.session_id as string,
    source: r.source as string,
    project_name: (r.project_name as string) ?? null,
    tool_name: r.tool_name as string,
    snippet: (r.snippet as string) ?? "",
    rank: Number(r.rank ?? 0),
  }));
}

/** Primary search entry point — searches message content (the common case). */
export function search(query: string, opts: SearchOptions = {}): SearchHit[] {
  return searchMessages(query, opts);
}

function toHit(r: Record<string, unknown>): SearchHit {
  return {
    session_id: r.session_id as string,
    source: r.source as string,
    title: (r.title as string) ?? null,
    project_name: (r.project_name as string) ?? null,
    project_path: (r.project_path as string) ?? null,
    started_at: (r.started_at as string) ?? null,
    snippet: (r.snippet as string) ?? "",
    rank: Number(r.rank ?? 0),
  };
}
