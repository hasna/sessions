import { getDatabase } from "../db/database.js";
import { appendProjectFilter } from "./project-filter.js";

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
  machine?: string;
}

function normalizeLimit(limit: number | undefined, fallback = 20): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return fallback;
  const normalized = Math.trunc(limit);
  return normalized > 0 ? normalized : fallback;
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

/**
 * Build safe FTS5 query variants. The first variant preserves the user's
 * whitespace tokens; the second splits identifiers on punctuation so domains,
 * repo names, paths, and dashed project IDs still match unicode61-tokenized
 * content (for example example.com -> "example" "com").
 */
export function toFtsQueries(query: string): string[] {
  const variants = new Set<string>();
  variants.add(toFtsQuery(query));

  const identifierTokens = identifierParts(query);
  if (identifierTokens.length > 0) {
    variants.add(identifierTokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" "));
  }

  return [...variants];
}

function identifierParts(query: string): string[] {
  return query.match(/[A-Za-z0-9_]+/g) ?? [];
}

function filterClause(opts: SearchOptions, params: unknown[]): string {
  const where: string[] = [];
  if (opts.source) {
    where.push("s.source = ?");
    params.push(opts.source);
  }
  if (opts.project_path) {
    appendProjectFilter(where, params, opts.project_path);
  }
  if (opts.machine) {
    where.push("s.machine = ?");
    params.push(opts.machine);
  }
  return where.length ? ` AND ${where.join(" AND ")}` : "";
}

function bestSnippet(...snippets: unknown[]): string {
  const strings = snippets.map((snippet) => (snippet as string | null) ?? "");
  return strings.find((snippet) => snippet.includes("[")) ?? strings.find(Boolean) ?? "";
}

/**
 * Full-text search over message content. Returns one hit per matching session
 * (the best-ranked message snippet), ordered by BM25 relevance then recency.
 */
export function searchMessages(query: string, opts: SearchOptions = {}): SearchHit[] {
  const db = getDatabase();
  const limit = normalizeLimit(opts.limit);
  // FTS5 auxiliary functions require direct queries against the FTS table, so
  // dedupe in JS. Fetch in batches until enough unique sessions are found;
  // otherwise one chat with many strong message matches can hide other sessions.
  const batchSize = Math.max(limit * 25, 100);
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const match of toFtsQueries(query)) {
    const params: any[] = [match];
    const filter = filterClause(opts, params);
    const stmt = db.prepare(
      `SELECT s.id AS session_id, s.source, s.title, s.project_name, s.project_path, s.started_at,
              snippet(messages_fts, 2, '[', ']', '…', 12) AS snippet,
              bm25(messages_fts) AS rank
       FROM messages_fts
       JOIN sessions s ON s.id = messages_fts.session_id
       WHERE messages_fts MATCH ?${filter}
       ORDER BY rank ASC, s.started_at DESC
       LIMIT ? OFFSET ?`
    );

    for (let offset = 0; hits.length < limit; offset += batchSize) {
      const rows = stmt.all(...params, batchSize, offset) as Record<string, unknown>[];
      if (rows.length === 0) break;
      for (const r of rows) {
        const id = r.session_id as string;
        if (seen.has(id)) continue;
        seen.add(id);
        hits.push(toHit(r));
        if (hits.length >= limit) break;
      }
      if (rows.length < batchSize) break;
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Full-text search over session titles / project names. */
export function searchSessions(query: string, opts: SearchOptions = {}): SearchHit[] {
  const db = getDatabase();
  const limit = normalizeLimit(opts.limit);
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const match of toFtsQueries(query)) {
    const params: any[] = [match];
    const filter = filterClause(opts, params);
    params.push(limit);

    const rows = db
      .prepare(
        `SELECT s.id AS session_id, s.source, s.title, s.project_name, s.project_path, s.started_at,
                snippet(sessions_fts, 1, '[', ']', '…', 12) AS title_snippet,
                snippet(sessions_fts, 2, '[', ']', '…', 12) AS project_name_snippet,
                snippet(sessions_fts, 3, '[', ']', '…', 12) AS project_path_snippet,
                bm25(sessions_fts) AS rank
         FROM sessions_fts
         JOIN sessions s ON s.id = sessions_fts.session_id
         WHERE sessions_fts MATCH ?${filter}
         ORDER BY rank ASC, s.started_at DESC
         LIMIT ?`
      )
      .all(...params) as Record<string, unknown>[];
    for (const r of rows) {
      const id = r.session_id as string;
      if (seen.has(id)) continue;
      seen.add(id);
      hits.push(toHit({ ...r, snippet: bestSnippet(r.title_snippet, r.project_name_snippet, r.project_path_snippet) }));
      if (hits.length >= limit) break;
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

export interface ToolCallHit {
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

/** Full-text search over tool calls (name / input / output). */
export function searchToolCalls(query: string, opts: SearchOptions = {}): ToolCallHit[] {
  const db = getDatabase();
  const limit = normalizeLimit(opts.limit);
  const seen = new Set<string>();
  const hits: ToolCallHit[] = [];
  for (const match of toFtsQueries(query)) {
    const params: any[] = [match];
    const filter = filterClause(opts, params);
    params.push(limit);

    const rows = db
      .prepare(
        `SELECT s.id AS session_id, s.source, s.title, s.project_name, s.project_path, s.started_at,
                tool_calls_fts.tool_name AS tool_name,
                snippet(tool_calls_fts, 2, '[', ']', '…', 12) AS tool_name_snippet,
                snippet(tool_calls_fts, 3, '[', ']', '…', 12) AS tool_input_snippet,
                snippet(tool_calls_fts, 4, '[', ']', '…', 12) AS tool_output_snippet,
                bm25(tool_calls_fts) AS rank
         FROM tool_calls_fts
         JOIN sessions s ON s.id = tool_calls_fts.session_id
         WHERE tool_calls_fts MATCH ?${filter}
         ORDER BY rank ASC
         LIMIT ?`
      )
      .all(...params) as Record<string, unknown>[];
    for (const r of rows) {
      const key = `${String(r.session_id)}:${String(r.tool_name)}:${bestSnippet(r.tool_name_snippet, r.tool_input_snippet, r.tool_output_snippet)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        session_id: r.session_id as string,
        source: r.source as string,
        title: (r.title as string) ?? null,
        project_name: (r.project_name as string) ?? null,
        project_path: (r.project_path as string) ?? null,
        started_at: (r.started_at as string) ?? null,
        tool_name: r.tool_name as string,
        snippet: bestSnippet(r.tool_name_snippet, r.tool_input_snippet, r.tool_output_snippet),
        rank: Number(r.rank ?? 0),
      });
      if (hits.length >= limit) break;
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Primary search entry point across messages, session metadata, and tool calls. */
export function search(query: string, opts: SearchOptions = {}): SearchHit[] {
  const limit = normalizeLimit(opts.limit);
  const broadOpts = { ...opts, limit: Math.max(limit * 2, limit) };
  const candidates = new Map<string, { hit: SearchHit; score: number }>();

  const add = (hit: SearchHit, sourceWeight: number) => {
    const score = sourceWeight + exactnessScore(query, hit);
    const existing = candidates.get(hit.session_id);
    if (!existing || score > existing.score) {
      candidates.set(hit.session_id, { hit, score });
    }
  };

  for (const hit of searchMessages(query, broadOpts)) add(hit, 10);
  for (const hit of searchSessions(query, broadOpts)) add(hit, 35);
  for (const hit of searchToolCalls(query, broadOpts)) {
    add({
      session_id: hit.session_id,
      source: hit.source,
      title: hit.title,
      project_name: hit.project_name,
      project_path: hit.project_path,
      started_at: hit.started_at,
      snippet: `${hit.tool_name}: ${hit.snippet}`,
      rank: hit.rank,
    }, 25);
  }

  return [...candidates.values()]
    .sort((a, b) => b.score - a.score || a.hit.rank - b.hit.rank || String(b.hit.started_at ?? "").localeCompare(String(a.hit.started_at ?? "")))
    .slice(0, limit)
    .map((candidate) => candidate.hit);
}

function exactnessScore(query: string, hit: SearchHit): number {
  const normalizedQuery = query.trim().toLowerCase();
  const parts = identifierParts(query).map((part) => part.toLowerCase());
  const metadata = [hit.title, hit.project_name, hit.project_path].filter(Boolean).join(" ").toLowerCase();
  const snippet = hit.snippet.toLowerCase();
  let score = projectIdentityScore(normalizedQuery, parts, hit);

  if (normalizedQuery && metadata.includes(normalizedQuery)) score += 100;
  if (normalizedQuery && snippet.includes(normalizedQuery)) score += 70;
  if (parts.length > 0 && parts.every((part) => metadata.includes(part))) score += 60;
  if (parts.length > 0 && parts.every((part) => snippet.includes(part))) score += 35;
  return score;
}

function projectIdentityScore(query: string, parts: string[], hit: SearchHit): number {
  const projectName = (hit.project_name ?? "").toLowerCase();
  const projectPath = (hit.project_path ?? "").toLowerCase();
  const pathSegments = projectPath.split("/").filter(Boolean);
  const projectTerms = unique([query, ...parts]).filter(Boolean);

  let score = 0;
  for (const term of projectTerms) {
    if (projectName === term) score = Math.max(score, 140);
    else if (pathSegments.at(-1) === term) score = Math.max(score, 120);
    else if (pathSegments.includes(term)) score = Math.max(score, 90);
  }
  return score;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
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
