// Client-side session store resolver (local vs self_hosted cloud).
//
// This is the ONE seam the CLI uses for session-record reads/writes. When the
// client-flip resolves to `cloud-http` — HASNA_SESSIONS_MODE=self_hosted (or
// cloud) AND HASNA_SESSIONS_API_URL + HASNA_SESSIONS_API_KEY are set — every
// read and write is routed to the app's cloud `/v1` HTTP API
// (the configured HASNA_SESSIONS_API_URL, e.g. https://sessions.your-deployment.example/v1)
// with the bearer key, using the
// @hasna/contracts HTTP storage client's transport. NO SQLite, NO DSN, NO raw
// RDS from a client.
//
// Otherwise (env unset) the local SQLite index (~/.hasna/sessions/sessions.db)
// is used exactly as before — `unset => local`.
//
// SAFETY: the API key lives only inside the transport; it is never logged.

import { resolveStorageClient } from "@hasna/contracts/client/storage";
import type { HasnaStorageClient } from "@hasna/contracts/client/storage";
import { normalizeStorageMode } from "@hasna/contracts/mode";
import type {
  Machine,
  Message,
  Session,
  SessionContentImport,
  SessionLookupOptions,
  ToolCall,
} from "../types/index.js";
import type { SessionContentImportResult, UpsertSessionInput } from "./cloud/store.js";
import type { SearchHit, ToolCallHit } from "../lib/search.js";
import type { Entity, EntityType, RelatedSession, SessionGraph } from "../lib/graph.js";
import type { RecallOptions, RecallResponse } from "../lib/recall.js";
import type { EmbedResult } from "../lib/embeddings.js";
import type { MergeResult } from "./merge.js";
import type { IngestResult } from "../lib/ingest/index.js";
import { contentShrinkError } from "../lib/content-import-safety.js";

export interface IngestStoreOptions {
  /** Ingest only this provider (claude | codex | codewith | gemini). */
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
  get(idOrPrefix: string, opts?: SessionLookupOptions): Promise<Session | null>;
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
  rename(idOrPrefix: string, title: string, opts?: SessionLookupOptions): Promise<Session | null>;
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
  graphSession(idOrPrefix: string, opts?: SessionLookupOptions): Promise<SessionGraph | null>;
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

// -- Explicit mode selection -------------------------------------------------
//
// This client PINS the storage mode before calling the contracts resolver. It
// must never depend on that resolver inferring a cloud transition from the mere
// presence of an API URL (or of a credential the resolver can find on disk).
//
// Owner ruling 2026-07-29: a local->network transition must be explicitly
// signalled, never inferred from a credential file appearing on disk. The
// contracts client still infers today, and hasna/contracts#51 removes it. When
// that lands, a consumer that passes `process.env` straight through gets the
// LOCAL SQLite store for a fully-configured cloud client -- silently, at exit 0,
// which is the exact silent-degrade this fleet has spent the day chasing.
//
// Measured 2026-07-30: of the five repos importing the contracts client at
// runtime, `domains`, `logs` and `todos` already pin; `files` and `sessions` did
// not, and were the two that #51 would strand. This is the `sessions` pin, and it
// deliberately mirrors `withImpliedSelfHostedMode` in @hasna/logs so the fleet
// converges on one shape rather than five.
//
// Pinning is also what makes this client immune to WHICH inference is live
// upstream -- env pair, URL alone, or disk credential. The mode is ours to state.

const MODE_KEYS = [
  "HASNA_SESSIONS_STORAGE_MODE",
  "HASNA_SESSIONS_MODE",
  "SESSIONS_STORAGE_MODE",
  "SESSIONS_MODE",
] as const;
const API_URL_KEYS = ["HASNA_SESSIONS_API_URL", "SESSIONS_API_URL"] as const;
const API_KEY_KEYS = ["HASNA_SESSIONS_API_KEY", "SESSIONS_API_KEY"] as const;

/** True when any of `keys` carries a non-blank value. The value is never read out. */
function anySet(source: Env, keys: readonly string[]): boolean {
  return keys.some((k) => (source[k]?.trim() ?? "") !== "");
}

/**
 * The value that means "use the server" in the INSTALLED @hasna/contracts.
 *
 * Derived, never hardcoded, and that is load-bearing rather than tidy. The
 * storage-mode enum has already changed once: contracts <=0.8.5 accepts `cloud`
 * plus the deprecated aliases `self_hosted`/`remote`/`hybrid`, while contracts
 * after the inference removal accepts ONLY `sqlite`/`postgres` and THROWS on
 * everything else. The two valid sets are DISJOINT, so any literal pinned here
 * is a bet on which side of that change a machine is on, and the bet loses on
 * one side or the other.
 *
 * Measured 2026-07-30 against contracts 0.5.2: `postgres` throws, `self_hosted`
 * normalizes. Against contracts main (0.8.6): `postgres` normalizes,
 * `self_hosted` throws. Probing newest-first therefore yields the right token on
 * both generations, and on the next one provided it keeps a server token here.
 *
 * The probe runs through the library's own `normalizeStorageMode`, so the answer
 * comes from the installed code rather than from our belief about it.
 */
export const SERVER_MODE_CANDIDATES = ["postgres", "self_hosted", "cloud"] as const;

/** Accepts a mode token or throws. Injectable so both enum generations are testable. */
export type ModeNormalizer = (value: string) => unknown;

let cachedServerMode: string | null = null;

export function serverStorageMode(normalize: ModeNormalizer = normalizeStorageMode): string {
  const useCache = normalize === (normalizeStorageMode as ModeNormalizer);
  if (useCache && cachedServerMode !== null) return cachedServerMode;
  for (const candidate of SERVER_MODE_CANDIDATES) {
    try {
      normalize(candidate);
      if (useCache) cachedServerMode = candidate;
      return candidate;
    } catch {
      // Not a token this generation of @hasna/contracts understands.
    }
  }
  // Every candidate was rejected: the enum changed again and this list is stale.
  // Fail loudly rather than guess -- guessing is the defect class this pin exists
  // to remove, and a wrong mode silently reads the wrong dataset.
  throw new Error(
    `No known server storage mode is accepted by the installed @hasna/contracts ` +
      `(tried ${SERVER_MODE_CANDIDATES.join(", ")}). The storage-mode enum has changed; ` +
      `add the new server token to SERVER_MODE_CANDIDATES in src/db/session-store.ts.`,
  );
}

/**
 * Return an env whose storage mode is explicit.
 *
 * An already-set mode -- through any of the four documented variables -- is left
 * exactly as it is, so an operator pinning `local` is never overridden. Only the
 * complete API url + key pair implies `self_hosted`; half a pair implies nothing,
 * because half a pair is not a statement of intent.
 */
export function sessionsCloudEnv(source: Env = process.env): Env {
  if (anySet(source, MODE_KEYS)) return source;
  if (anySet(source, API_URL_KEYS) && anySet(source, API_KEY_KEYS)) {
    return { ...source, HASNA_SESSIONS_STORAGE_MODE: serverStorageMode() };
  }
  return source;
}

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
  const lookupQuery = (opts: SessionLookupOptions = {}): Record<string, string> => {
    const q: Record<string, string> = {};
    if (opts.source) q.source = opts.source;
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
    async get(idOrPrefix, opts = {}) {
      try {
        const res = await t.get<{ session: Session }>(`/sessions/${encodeURIComponent(idOrPrefix)}`, {
          query: lookupQuery(opts),
        });
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
    async rename(idOrPrefix, title, opts = {}) {
      try {
        const res = await t.patch<{ session: Session }>(
          `/sessions/${encodeURIComponent(idOrPrefix)}`,
          { title },
          { query: lookupQuery(opts) },
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
      const res = await t.get<{ messages: Message[] }>(
        `/sessions/${encodeURIComponent(sessionId)}/messages`,
      );
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
    async graphSession(idOrPrefix, opts = {}) {
      try {
        const res = await t.get<{ graph: SessionGraph | null }>("/graph", {
          query: { session: idOrPrefix, ...lookupQuery(opts) },
        });
        return res.graph ?? null;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    // These require the local embedding/FTS index or a local-to-local DB merge;
    // recall is intentionally local-only. Fail loudly instead of silently
    // reading the local SQLite island (that was the split-brain bug).
    semanticSearch() {
      return notAvailableInCloud("semantic search");
    },
    hybridSearch() {
      return notAvailableInCloud("hybrid search");
    },
    async recall() {
      return recallNotAvailableInCloud();
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

function recallNotAvailableInCloud(): never {
  throw new Error(
    `'recall' is local-only and is not available in hosted/self-hosted mode. ` +
      `Use 'sessions list', 'sessions show <id>', or 'sessions search <query>' against the hosted store, ` +
      `or run recall on a machine in local mode.`,
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
    async get(idOrPrefix, opts = {}) {
      const { getSessionByPrefix } = await import("./sessions.js");
      return getSessionByPrefix(idOrPrefix, opts);
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
    async rename(idOrPrefix, title, opts = {}) {
      const { updateSessionTitle } = await import("./sessions.js");
      return updateSessionTitle(idOrPrefix, title, opts);
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
    async graphSession(idOrPrefix, opts = {}) {
      const { sessionGraph } = await import("../lib/graph.js");
      const { getSessionByPrefix } = await import("./sessions.js");
      const session = getSessionByPrefix(idOrPrefix, opts);
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
  const resolved = resolveStorageClient(APP, sessionsCloudEnv(env), overrides);
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
