// Mode-aware data source for sessions-serve.
//
// cloud mode (Amendment A1, PURE REMOTE) reads/writes the shared RDS via the
// vendored kit. local mode serves the SQLite index so the same /v1 surface works
// for self-hosters and tests without a Postgres. Both return identical wire
// shapes so the generated SDK/OpenAPI is one contract.

import type { Machine, Session } from "../types/index.js";
import type { SearchHit, ToolCallHit } from "../lib/search.js";
import type { Entity, EntityType, RelatedSession, SessionGraph } from "../lib/graph.js";
import { isCloudMode } from "../db/cloud/client.js";
import * as cloud from "../db/cloud/store.js";

export interface ListOptions {
  source?: string;
  project_path?: string;
  machine?: string;
  limit?: number;
}

export interface SearchHitDto {
  session: Session;
  match: string;
  snippet?: string;
}

export interface Stats {
  session_count: number;
  message_count: number;
  tool_call_count: number;
  by_source: { source: string; sessions: number }[];
  projects: { project_name: string | null; project_path: string | null; session_count: number }[];
}

export interface DataSource {
  readonly mode: "local" | "cloud";
  list(opts: ListOptions): Promise<Session[]>;
  recent(limit: number): Promise<Session[]>;
  get(idOrPrefix: string): Promise<Session | null>;
  search(query: string, opts: ListOptions): Promise<SearchHitDto[]>;
  machines(): Promise<Machine[]>;
  stats(): Promise<Stats>;
  create(input: cloud.UpsertSessionInput): Promise<Session>;
  remove(id: string): Promise<boolean>;
  relocatePaths(oldPath: string, newPath: string): Promise<{ rowsUpdated: number }>;
  searchContent(query: string, opts: ListOptions): Promise<SearchHit[]>;
  searchToolCalls(query: string, opts: ListOptions): Promise<ToolCallHit[]>;
  graphEntities(type?: EntityType): Promise<Entity[]>;
  graphRelated(type: EntityType, name: string, limit: number): Promise<RelatedSession[]>;
  graphSession(idOrPrefix: string): Promise<SessionGraph | null>;
}

const cloudSource: DataSource = {
  mode: "cloud",
  list: (opts) => cloud.listSessions(opts),
  recent: (limit) => cloud.getRecentSessions(limit),
  get: (idOrPrefix) => cloud.getSessionByPrefix(idOrPrefix),
  search: async (query, opts) =>
    (await cloud.searchSessions(query, opts)).map((h) => ({ session: h.session, match: h.match })),
  machines: () => cloud.listMachines(),
  stats: () => cloud.getStats(),
  create: (input) => cloud.upsertSession(input),
  remove: (id) => cloud.deleteSession(id),
  relocatePaths: (oldPath, newPath) => cloud.relocatePaths(oldPath, newPath),
  searchContent: (query, opts) => cloud.searchContent(query, opts),
  searchToolCalls: (query, opts) => cloud.searchToolCalls(query, opts),
  graphEntities: (type) => cloud.graphEntities(type as cloud.CloudEntityType | undefined),
  graphRelated: (type, name, limit) =>
    cloud.graphRelated(type as cloud.CloudEntityType, name, limit),
  graphSession: (idOrPrefix) => cloud.graphSession(idOrPrefix),
};

function localSource(): DataSource {
  return {
    mode: "local",
    async list(opts) {
      const { listSessions } = await import("../db/sessions.js");
      return listSessions(opts);
    },
    async recent(limit) {
      const { getRecentSessions } = await import("../db/sessions.js");
      return getRecentSessions(limit);
    },
    async get(idOrPrefix) {
      const { getSessionByPrefix } = await import("../db/sessions.js");
      return getSessionByPrefix(idOrPrefix);
    },
    async search(query, opts) {
      const { searchSessions } = await import("../lib/search.js");
      const { getSession } = await import("../db/sessions.js");
      const hits = searchSessions(query, opts);
      const out: SearchHitDto[] = [];
      for (const hit of hits) {
        try {
          out.push({ session: getSession(hit.session_id), match: "title", snippet: hit.snippet });
        } catch {
          // session pruned between search and fetch — skip.
        }
      }
      return out;
    },
    async machines() {
      const { listMachines } = await import("../db/machines.js");
      return listMachines();
    },
    async stats() {
      const { getDatabase } = await import("../db/database.js");
      const db = getDatabase();
      const one = (sql: string): number => {
        const row = db.prepare(sql).get() as { c: number } | undefined;
        return Number(row?.c ?? 0);
      };
      const bySource = db
        .prepare("SELECT source, COUNT(*) AS c FROM sessions GROUP BY source ORDER BY c DESC")
        .all() as { source: string; c: number }[];
      const projects = db
        .prepare(
          `SELECT project_name, project_path, COUNT(*) AS c FROM sessions
             GROUP BY project_name, project_path ORDER BY c DESC LIMIT 30`,
        )
        .all() as { project_name: string | null; project_path: string | null; c: number }[];
      return {
        session_count: one("SELECT COUNT(*) AS c FROM sessions"),
        message_count: one("SELECT COUNT(*) AS c FROM messages"),
        tool_call_count: one("SELECT COUNT(*) AS c FROM tool_calls"),
        by_source: bySource.map((r) => ({ source: r.source, sessions: Number(r.c) })),
        projects: projects.map((r) => ({
          project_name: r.project_name,
          project_path: r.project_path,
          session_count: Number(r.c),
        })),
      };
    },
    async create(input) {
      const { upsertSession } = await import("../db/sessions.js");
      return upsertSession(input as never);
    },
    async remove(id) {
      const { getSession, deleteSession } = await import("../db/sessions.js");
      try {
        getSession(id);
      } catch {
        return false;
      }
      deleteSession(id);
      return true;
    },
    async relocatePaths(oldPath, newPath) {
      const { relocatePathsInDb } = await import("../db/sessions.js");
      return relocatePathsInDb(oldPath, newPath);
    },
    async searchContent(query, opts) {
      const { search } = await import("../lib/search.js");
      return search(query, opts);
    },
    async searchToolCalls(query, opts) {
      const { searchToolCalls } = await import("../lib/search.js");
      return searchToolCalls(query, opts);
    },
    async graphEntities(type) {
      const { listEntities } = await import("../lib/graph.js");
      return listEntities(type);
    },
    async graphRelated(type, name, limit) {
      const { relatedSessions } = await import("../lib/graph.js");
      return relatedSessions(type, name, limit);
    },
    async graphSession(idOrPrefix) {
      const { sessionGraph } = await import("../lib/graph.js");
      const { getSessionByPrefix } = await import("../db/sessions.js");
      const session = getSessionByPrefix(idOrPrefix);
      if (!session) return null;
      return sessionGraph(session.id);
    },
  };
}

let _source: DataSource | null = null;

/** Resolve the active data source for the current storage mode (memoized). */
export function getDataSource(): DataSource {
  if (_source) return _source;
  _source = isCloudMode() ? cloudSource : localSource();
  return _source;
}

/** Test hook: reset the memoized data source. */
export function resetDataSource(): void {
  _source = null;
}
