// Re-export everything from the existing @hasna/sessions package
// Plus new relocate and transfer modules

export { relocate } from "./lib/relocate.js";
export type { RelocateOptions, RelocateResult } from "./lib/relocate.js";

export { exportSessions, importSessions, formatBytes } from "./lib/transfer.js";
export type {
  ExportOptions,
  ExportResult,
  ImportOptions,
  ImportResult,
  TransferManifest,
  TransferProject,
} from "./lib/transfer.js";

export {
  encodePath,
  decodePath,
  getClaudeProjectsDir,
  getClaudeBaseDir,
  getSessionsDbPath,
  getSessionsDir,
  findMatchingProjectDirs,
  computeRelocatedDir,
} from "./lib/paths.js";

export {
  loadSessionRegistry,
  saveSessionRegistry,
  refreshSessionRegistry,
  listSessions,
  findSession,
  latestSession,
  latestSessionForProject,
  renameSession,
  buildClaudeResumeCommand,
  formatSessionTable,
  historySessions,
  searchSessions,
} from "./lib/sessions.js";

export type { SessionRecord, SessionSearchResult, SessionStatus } from "./lib/sessions.js";

export {
  buildLivePane,
  classifyLivePane,
  filterLivePanes,
  formatLivePaneTable,
  listLivePanes,
  listLivePanesFromTmuxOutput,
  normalizeProjectPath,
  parseLiveStatusFilter,
  parseTmuxPaneLine,
} from "./lib/live.js";
export type {
  LivePane,
  LivePaneStatus,
  ListLivePanesOptions,
  TmuxCommandResult,
  TmuxPaneRecord,
  TmuxRunner,
} from "./lib/live.js";

export {
  BULK_SESSION_ACTIONS,
  buildBulkGuardDecision,
  buildBulkSessionPlan,
  formatBulkSessionPlan,
  isBulkSessionAction,
  listBulkLivePanes,
  parseConcurrency,
  parseJitterMs,
} from "./lib/bulk.js";
export type {
  BulkEntryDecision,
  BulkGuardDecision,
  BulkGuardHints,
  BulkLiveDiscoveryOptions,
  BulkPlanEntry,
  BulkSessionAction,
  BulkSessionOptions,
  BulkSessionPlan,
} from "./lib/bulk.js";

export {
  recallSessions,
  buildQueryVariants,
  extractCodingEntities,
  significantTerms,
} from "./lib/recall.js";
export type {
  CodingThreadEntities,
  RecallEvidence,
  RecallGraphContext,
  RecallMetadata,
  RecallOptions,
  RecallResponse,
  RecallResult,
  RecallResume,
  RecallToolCall,
} from "./lib/recall.js";

export { SqliteAdapter } from "./db/sqlite-adapter.js";
export { getDatabase, closeDatabase, resetDatabase, initSchema } from "./db/database.js";

// --- Client storage abstraction (the ONE seam: LocalStore | ApiStore) ---
export {
  resolveSessionStore,
  type SessionStore,
  type Env,
  type ListOptions,
  type SearchHitDto,
  type StoreStats,
} from "./db/session-store.js";

// NOTE: the Postgres (RDS) data plane + HTTP serve surface (getCloudClient /
// isCloudMode / cloudStore / createSessionsServer / migrations / OpenAPI) reads
// DATABASE_URL and opens a `pg` pool. It is server-only and lives behind the
// `@hasna/sessions/server` subpath — it is intentionally NOT re-exported here so
// the client-importable package main never reaches a DSN data plane. Clients use
// `@hasna/sessions/storage` (the Store).

// --- Generated SDK ---
export {
  SessionsApi,
  SessionsClient,
  ApiError,
  createSessionsClientFromEnv,
} from "./sdk/index.js";
export type { SessionsApiOptions } from "./sdk/index.js";
