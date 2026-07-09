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
import type { Machine, Message, Session, SessionContentImport, ToolCall } from "../types/index.js";
import type { SessionContentImportResult, UpsertSessionInput } from "./cloud/store.js";
import type { SearchHit, ToolCallHit } from "../lib/search.js";
import type { Entity, EntityType, RelatedSession, SessionGraph } from "../lib/graph.js";
import type { RecallOptions, RecallResponse } from "../lib/recall.js";
import type { EmbedResult } from "../lib/embeddings.js";
import type { MergeResult } from "./merge.js";
import type { IngestResult } from "../lib/ingest/index.js";
import { contentShrinkError } from "../lib/content-import-safety.js";

export interface IngestStoreOptions {
  /** Ingest only this provider (claude | codex | gemini). */
  source?: string;
  /** Ingest only these providers. Ignored when `source` is set. */
  sources?: string[];
  /** Re-ingest even files unchanged since the last run. */
  force?: boolean;
  /** Progress callback (one line per event). */
  onProgress?: (message: string) => void;
}

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
  /** Idempotently import/upsert a session with messages and tool calls. */
  importContent(input: SessionContentImport): Promise<SessionContentImportResult>;
  remove(id: string): Promise<boolean>;
  /**
   * Set a session's title (the "rename" operation), resolving by full id or a
   * unique id/source_id prefix. Local mode updates the on-box SQLite index;
   * self_hosted mode PATCHes `/v1/sessions/{id}` so the shared cloud registry is
   * what actually changes. Returns the updated session, or null if not found.
   */
  rename(idOrPrefix: string, title: string): Promise<Session | null>;
  /**
   * Rewrite session paths after a project directory move (old -> new): updates
   * project_path / source_path in the active index. Local mode touches the
   * on-box SQLite index; self_hosted mode hits `/v1/relocate` so the shared
   * cloud registry is what actually changes (never a split-brain no-op).
   */
  relocatePaths(oldPath: string, newPath: string): Promise<{ rowsUpdated: number }>;
  search(query: string, opts: ListOptions): Promise<SearchHitDto[]>;
  machines(): Promise<Machine[]>;
  stats(): Promise<StoreStats>;
  /** Message bodies for a session (local index only; cloud /v1 does not serve blobs). */
  messages(sessionId: string): Promise<Message[]>;
  /** Tool-call records for a session (local index only; cloud /v1 does not serve blobs). */
  toolCalls(sessionId: string): Promise<ToolCall[]>;
  /** Full content search (message bodies + metadata), one hit per session. */
  searchContent(query: string, opts: ListOptions): Promise<SearchHit[]>;
  /** Tool-call search (name / input / output). */
  searchToolCalls(query: string, opts: ListOptions): Promise<ToolCallHit[]>;
  /** Semantic (embedding) search. */
  semanticSearch(query: string, opts: ListOptions): Promise<SearchHit[]>;
  /** Hybrid full-text + semantic search (RRF). */
  hybridSearch(query: string, opts: ListOptions): Promise<SearchHit[]>;
  /** Natural-language recall with evidence, touched files, and resume metadata. */
  recall(query: string, opts: RecallOptions): Promise<RecallResponse>;
  /** Knowledge-graph entities (projects/tools/models/providers/repos). */
  graphEntities(type?: EntityType): Promise<Entity[]>;
  /** Sessions related to a graph entity. */
  graphRelated(type: EntityType, name: string, limit: number): Promise<RelatedSession[]>;
  /** The entity neighborhood of a single session. */
  graphSession(idOrPrefix: string): Promise<SessionGraph | null>;
  /** Generate embeddings for indexed messages (index maintenance). */
  embed(opts: { limit?: number }): Promise<EmbedResult>;
  /** Merge another machine's local sessions DB into this one (local-to-local sync). */
  mergeFromDb(path: string): Promise<MergeResult>;
  /**
   * Index local transcript files into the on-box session index. This is an
   * inherently LOCAL maintenance operation: even on a flipped (self_hosted)
   * machine, `sync` ingests into the on-box index first and then pushes the
   * metadata to the shared cloud `/v1` registry. The cloud transport has no
   * local index, so it throws rather than pretending to ingest.
   */
  ingest(opts?: IngestStoreOptions): Promise<IngestResult[]>;
  /** Recompute per-machine session counts in the index (index maintenance). */
  recomputeMachines(): Promise<void>;
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
    async importContent(input) {
      const res = await t.post<{ session: Session; imported: { messages: number; toolCalls: number }; backup: SessionContentImport["backup"] | null }>(
        "/sessions/import",
        input,
        {
          idempotencyKey: `${input.session.source}:${input.session.source_id}:content`,
        },
      );
      return {
        session: res.session,
        imported: res.imported,
        backup: res.backup ?? null,
      };
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
    async rename(idOrPrefix, title) {
      try {
        const res = await t.patch<{ session: Session }>(
          `/sessions/${encodeURIComponent(idOrPrefix)}`,
          { title },
        );
        return res.session ?? null;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async relocatePaths(oldPath, newPath) {
      const res = await t.post<{ ok?: boolean; rowsUpdated?: number }>("/relocate", {
        oldPath,
        newPath,
      });
      return { rowsUpdated: res.rowsUpdated ?? 0 };
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
    async messages(sessionId) {
      const res = await t.get<{ messages: Message[] }>(`/sessions/${encodeURIComponent(sessionId)}/messages`);
      return res.messages ?? [];
    },
    async toolCalls(sessionId) {
      const res = await t.get<{ toolCalls: ToolCall[] }>(`/sessions/${encodeURIComponent(sessionId)}/tool-calls`);
      return res.toolCalls ?? [];
    },
    async searchContent(query, opts) {
      const res = await t.get<{ results: SearchHit[] }>("/search/content", {
        query: { q: query, ...listQuery(opts) },
      });
      return res.results ?? [];
    },
    async searchToolCalls(query, opts) {
      const res = await t.get<{ results: ToolCallHit[] }>("/search/tools", {
        query: { q: query, ...listQuery(opts) },
      });
      return res.results ?? [];
    },
    async graphEntities(type) {
      const res = await t.get<{ entities: Entity[] }>("/graph", {
        query: type ? { type } : {},
      });
      return res.entities ?? [];
    },
    async graphRelated(type, name, limit) {
      const res = await t.get<{ sessions: RelatedSession[] }>("/graph", {
        query: { related: `${type}:${name}`, limit },
      });
      return res.sessions ?? [];
    },
    async graphSession(idOrPrefix) {
      try {
        const res = await t.get<{ graph: SessionGraph | null }>("/graph", {
          query: { session: idOrPrefix },
        });
        return res.graph ?? null;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    // Not yet available server-side: these require the local embedding/FTS index
    // or a local-to-local DB merge. Fail loudly instead of silently reading the
    // local SQLite island (that was the split-brain bug).
    semanticSearch() {
      return notAvailableInCloud("semantic search");
    },
    hybridSearch() {
      return notAvailableInCloud("hybrid search");
    },
    recall() {
      return notAvailableInCloud("recall");
    },
    embed() {
      return notAvailableInCloud("embed");
    },
    mergeFromDb() {
      return notAvailableInCloud("import-db");
    },
    ingest() {
      return notAvailableInCloud("ingest");
    },
    recomputeMachines() {
      return notAvailableInCloud("recompute-machines");
    },
  };
}

/**
 * Loud, explicit failure for operations that are not (yet) served by the cloud
 * `/v1` API. NEVER silently fall back to the local SQLite index in cloud mode —
 * that is exactly the split-brain we are eliminating.
 */
function notAvailableInCloud(op: string): never {
  throw new Error(
    `'${op}' is not available in self_hosted mode: it depends on the local session index ` +
      `(embeddings / full recall / local DB merge), which the cloud /v1 API does not serve. ` +
      `Run it on a machine in local mode (unset HASNA_SESSIONS_API_URL/API_KEY).`,
  );
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
    async importContent(input) {
      const { getMessages, getSessionByPrefix, getSessionBySource, getToolCalls, saveParsedSession } = await import("./sessions.js");
      const existing =
        getSessionBySource(input.session.source, input.session.source_id) ??
        (input.session.id ? getSessionByPrefix(input.session.id) : null);
      if (existing) {
        const error = contentShrinkError(input, {
          messages: getMessages(existing.id).length,
          toolCalls: getToolCalls(existing.id).length,
        });
        if (error) throw new Error(error);
      }
      const session = saveParsedSession(input);
      return {
        session,
        imported: {
          messages: input.messages.length,
          toolCalls: input.toolCalls.length,
        },
        backup: input.backup ?? null,
      };
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
    async rename(idOrPrefix, title) {
      const { updateSessionTitle } = await import("./sessions.js");
      return updateSessionTitle(idOrPrefix, title);
    },
    async relocatePaths(oldPath, newPath) {
      const { relocatePathsInDb } = await import("./sessions.js");
      return relocatePathsInDb(oldPath, newPath);
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
    async messages(sessionId) {
      const { getMessages } = await import("./sessions.js");
      return getMessages(sessionId);
    },
    async toolCalls(sessionId) {
      const { getToolCalls } = await import("./sessions.js");
      return getToolCalls(sessionId);
    },
    async searchContent(query, opts) {
      const { search } = await import("../lib/search.js");
      return search(query, opts);
    },
    async searchToolCalls(query, opts) {
      const { searchToolCalls } = await import("../lib/search.js");
      return searchToolCalls(query, opts);
    },
    async semanticSearch(query, opts) {
      const { semanticSearch } = await import("../lib/vector-search.js");
      return semanticSearch(query, opts);
    },
    async hybridSearch(query, opts) {
      const { hybridSearch } = await import("../lib/vector-search.js");
      return hybridSearch(query, opts);
    },
    async recall(query, opts) {
      const { recallSessions } = await import("../lib/recall.js");
      return recallSessions(query, opts);
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
      const { getSessionByPrefix } = await import("./sessions.js");
      const session = getSessionByPrefix(idOrPrefix);
      if (!session) return null;
      return sessionGraph(session.id);
    },
    async embed(opts) {
      const { embedSessions } = await import("../lib/embeddings.js");
      return embedSessions(opts);
    },
    async mergeFromDb(path) {
      const { mergeFromDb } = await import("./merge.js");
      return mergeFromDb(path);
    },
    async ingest(opts = {}) {
      const { ingestAll, ingestSource } = await import("../lib/ingest/index.js");
      if (opts.source) {
        return [ingestSource(opts.source, { force: opts.force, onProgress: opts.onProgress })];
      }
      return ingestAll({ sources: opts.sources, force: opts.force, onProgress: opts.onProgress });
    },
    async recomputeMachines() {
      const { recomputeMachineCounts } = await import("./machines.js");
      recomputeMachineCounts();
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

/**
 * The LocalStore transport, resolved unconditionally (independent of env).
 *
 * Used only by the inherently-local index path: `ingest`/`reindex`/`ingest-watch`
 * populate the on-box index, and `sync` reads the on-box index to push it to the
 * shared cloud `/v1` registry even when the resolved store is `cloud`. This is
 * NOT a per-command local read fallback — the split-brain bug where reads
 * silently drifted to the local SQLite island stays deleted; those paths go
 * through `resolveSessionStore()`.
 */
export function getLocalStore(): SessionStore {
  return localStore();
}
