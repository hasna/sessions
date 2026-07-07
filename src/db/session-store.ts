// Client-side session store resolver (local vs self_hosted cloud).
//
// This is the ONE seam the CLI uses for session-record reads/writes. When the
// client-flip resolves to `cloud-http` — HASNA_SESSIONS_MODE=self_hosted (or
// cloud) AND HASNA_SESSIONS_API_URL + HASNA_SESSIONS_API_KEY are set — every
// read and write is routed to the app's cloud `/v1` HTTP API
// (https://sessions.hasna.xyz/v1) with the bearer key, using the
// @hasna/contracts HTTP storage client's transport. NO SQLite, NO DSN, NO raw
// RDS from a client.
//
// Otherwise (env unset) the local SQLite index (~/.hasna/sessions/sessions.db)
// is used exactly as before — `unset => local`.
//
// SAFETY: the API key lives only inside the transport; it is never logged.

import { resolveStorageClient } from "@hasna/contracts/client/storage";
import type { HasnaStorageClient } from "@hasna/contracts/client/storage";
import type { Machine, Session } from "../types/index.js";
import type { UpsertSessionInput } from "./cloud/store.js";

export type Env = Record<string, string | undefined>;

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

export interface StoreStats {
  session_count: number;
  message_count: number;
  tool_call_count: number;
  by_source: { source: string; sessions: number }[];
  projects: { project_name: string | null; project_path: string | null; session_count: number }[];
}

export interface SessionStore {
  readonly mode: "local" | "cloud";
  list(opts: ListOptions): Promise<Session[]>;
  recent(limit: number): Promise<Session[]>;
  get(idOrPrefix: string): Promise<Session | null>;
  create(input: UpsertSessionInput): Promise<Session>;
  remove(id: string): Promise<boolean>;
  search(query: string, opts: ListOptions): Promise<SearchHitDto[]>;
  machines(): Promise<Machine[]>;
  stats(): Promise<StoreStats>;
}

const APP = "sessions";

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: number }).status === 404
  );
}

/** Cloud (self_hosted) store: every op hits `/v1` over HTTPS with the bearer key. */
function cloudStore(client: HasnaStorageClient): SessionStore {
  const t = client.transport;
  const listQuery = (opts: ListOptions): Record<string, string | number> => {
    const q: Record<string, string | number> = {};
    if (opts.source) q.source = opts.source;
    if (opts.project_path) q.project = opts.project_path;
    if (opts.machine) q.machine = opts.machine;
    if (opts.limit !== undefined) q.limit = opts.limit;
    return q;
  };
  return {
    mode: "cloud",
    async list(opts) {
      const res = await t.get<{ sessions: Session[] }>("/sessions", { query: listQuery(opts) });
      return res.sessions ?? [];
    },
    async recent(limit) {
      const res = await t.get<{ sessions: Session[] }>("/recent", { query: { limit } });
      return res.sessions ?? [];
    },
    async get(idOrPrefix) {
      try {
        const res = await t.get<{ session: Session }>(`/sessions/${encodeURIComponent(idOrPrefix)}`);
        return res.session ?? null;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async create(input) {
      const res = await t.post<{ session: Session }>("/sessions", input, {
        idempotencyKey: `${input.source}:${input.source_id}`,
      });
      return res.session;
    },
    async remove(id) {
      try {
        await t.del(`/sessions/${encodeURIComponent(id)}`);
        return true;
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    },
    async search(query, opts) {
      const res = await t.get<{ results: SearchHitDto[] }>("/search", {
        query: { q: query, ...listQuery(opts) },
      });
      return res.results ?? [];
    },
    async machines() {
      const res = await t.get<{ machines: Machine[] }>("/machines");
      return res.machines ?? [];
    },
    async stats() {
      const res = await t.get<{ ok?: boolean } & StoreStats>("/stats");
      const { ok: _ok, ...stats } = res;
      return stats;
    },
  };
}

/** Local store: SQLite index, loaded lazily so cloud-only runs never open the DB. */
function localStore(): SessionStore {
  return {
    mode: "local",
    async list(opts) {
      const { listSessions } = await import("./sessions.js");
      return listSessions(opts);
    },
    async recent(limit) {
      const { getRecentSessions } = await import("./sessions.js");
      return getRecentSessions(limit);
    },
    async get(idOrPrefix) {
      const { getSessionByPrefix } = await import("./sessions.js");
      return getSessionByPrefix(idOrPrefix);
    },
    async create(input) {
      const { upsertSession } = await import("./sessions.js");
      return upsertSession(input as never);
    },
    async remove(id) {
      const { getSession, deleteSession } = await import("./sessions.js");
      try {
        getSession(id);
      } catch {
        return false;
      }
      deleteSession(id);
      return true;
    },
    async search(query, opts) {
      const { searchSessions } = await import("../lib/search.js");
      const { getSession } = await import("./sessions.js");
      const out: SearchHitDto[] = [];
      for (const hit of searchSessions(query, opts)) {
        try {
          out.push({ session: getSession(hit.session_id), match: "title", snippet: hit.snippet });
        } catch {
          // pruned between search and fetch — skip.
        }
      }
      return out;
    },
    async machines() {
      const { listMachines } = await import("./machines.js");
      return listMachines();
    },
    async stats() {
      const { getIngestionStats } = await import("./ingestion.js");
      const { getProjectStats } = await import("./sessions.js");
      const ingestion = getIngestionStats();
      const bySource = ingestion.map((r) => ({ source: r.source, sessions: r.session_count }));
      const projects = getProjectStats().map((p) => ({
        project_name: p.project_name,
        project_path: p.project_path,
        session_count: p.session_count,
      }));
      return {
        session_count: ingestion.reduce((n, r) => n + r.session_count, 0),
        message_count: ingestion.reduce((n, r) => n + r.message_count, 0),
        tool_call_count: ingestion.reduce((n, r) => n + r.tool_call_count, 0),
        by_source: bySource,
        projects,
      };
    },
  };
}

/**
 * Resolve the active session store. Cloud-http when self_hosted + API_URL +
 * API_KEY are set (throws if cloud requested but misconfigured — no silent local
 * drift); local SQLite otherwise.
 */
export function resolveSessionStore(
  env: Env = process.env,
  overrides?: Parameters<typeof resolveStorageClient>[2],
): SessionStore {
  const resolved = resolveStorageClient(APP, env, overrides);
  if (resolved.transport === "cloud-http") return cloudStore(resolved.client);
  return localStore();
}
