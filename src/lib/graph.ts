import { getDatabase } from "../db/database.js";

/**
 * A lightweight knowledge graph derived from the indexed sessions — no LLM
 * extraction, just the entities that already live in the data (projects,
 * tools, models, providers, git repos) and their links to sessions.
 */
export type EntityType = "project" | "tool" | "model" | "provider" | "repo";

export interface Entity {
  type: EntityType;
  name: string;
  session_count: number;
}

const ENTITY_QUERIES: Record<EntityType, string> = {
  project: `SELECT project_name AS name, COUNT(*) AS n FROM sessions WHERE project_name IS NOT NULL AND project_name != '' GROUP BY project_name`,
  model: `SELECT model AS name, COUNT(*) AS n FROM sessions WHERE model IS NOT NULL AND model != '' GROUP BY model`,
  provider: `SELECT model_provider AS name, COUNT(*) AS n FROM sessions WHERE model_provider IS NOT NULL AND model_provider != '' GROUP BY model_provider`,
  repo: `SELECT git_origin_url AS name, COUNT(*) AS n FROM sessions WHERE git_origin_url IS NOT NULL AND git_origin_url != '' GROUP BY git_origin_url`,
  tool: `SELECT tc.tool_name AS name, COUNT(DISTINCT tc.session_id) AS n FROM tool_calls tc GROUP BY tc.tool_name`,
};

/** List entities of a given type (or all types) with how many sessions reference each. */
export function listEntities(type?: EntityType): Entity[] {
  const db = getDatabase();
  const types = type ? [type] : (Object.keys(ENTITY_QUERIES) as EntityType[]);
  const out: Entity[] = [];
  for (const t of types) {
    const rows = db.prepare(`${ENTITY_QUERIES[t]} ORDER BY n DESC`).all() as Record<string, unknown>[];
    for (const r of rows) {
      out.push({ type: t, name: r.name as string, session_count: Number(r.n ?? 0) });
    }
  }
  return out;
}

export interface RelatedSession {
  session_id: string;
  source: string;
  title: string | null;
  project_name: string | null;
  started_at: string | null;
}

const RELATED_SQL: Record<EntityType, string> = {
  project: `SELECT id AS session_id, source, title, project_name, started_at FROM sessions WHERE project_name = ?`,
  model: `SELECT id AS session_id, source, title, project_name, started_at FROM sessions WHERE model = ?`,
  provider: `SELECT id AS session_id, source, title, project_name, started_at FROM sessions WHERE model_provider = ?`,
  repo: `SELECT id AS session_id, source, title, project_name, started_at FROM sessions WHERE git_origin_url = ?`,
  tool: `SELECT s.id AS session_id, s.source, s.title, s.project_name, s.started_at FROM sessions s
         WHERE s.id IN (SELECT DISTINCT session_id FROM tool_calls WHERE tool_name = ?)`,
};

/** Find sessions linked to a specific entity (e.g. all sessions that used tool "Bash"). */
export function relatedSessions(type: EntityType, name: string, limit: number | null = 50): RelatedSession[] {
  const db = getDatabase();
  const sql = `${RELATED_SQL[type]} ORDER BY COALESCE(started_at, ingested_at) DESC${limit == null ? "" : " LIMIT ?"}`;
  const rows = (limit == null
    ? db.prepare(sql).all(name)
    : db.prepare(sql).all(name, limit)) as Record<string, unknown>[];
  return rows.map((r) => ({
    session_id: r.session_id as string,
    source: r.source as string,
    title: (r.title as string) ?? null,
    project_name: (r.project_name as string) ?? null,
    started_at: (r.started_at as string) ?? null,
  }));
}

export interface SessionGraph {
  session_id: string;
  project: string | null;
  model: string | null;
  provider: string | null;
  repo: string | null;
  tools: string[];
}

/** The entities a single session touches — its neighborhood in the graph. */
export function sessionGraph(sessionId: string): SessionGraph | null {
  const db = getDatabase();
  const s = db
    .prepare("SELECT id, project_name, model, model_provider, git_origin_url FROM sessions WHERE id = ?")
    .get(sessionId) as Record<string, unknown> | undefined;
  if (!s) return null;
  const tools = db
    .prepare("SELECT DISTINCT tool_name FROM tool_calls WHERE session_id = ? ORDER BY tool_name")
    .all(sessionId) as { tool_name: string }[];
  return {
    session_id: sessionId,
    project: (s.project_name as string) ?? null,
    model: (s.model as string) ?? null,
    provider: (s.model_provider as string) ?? null,
    repo: (s.git_origin_url as string) ?? null,
    tools: tools.map((t) => t.tool_name),
  };
}
