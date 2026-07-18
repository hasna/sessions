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
  createExternalHandoffBundleV1,
  redactHandoffText,
  renderHandoffSkillWrapper,
} from "./lib/handoff.js";
export type {
  CodewithLaunchMode,
  CreateExternalHandoffBundleOptions,
  ExternalHandoffBundleV1,
  ExternalHandoffResultV1,
  HandoffAuthRef,
  HandoffLaunchPlan,
  HandoffStatus,
  HandoffTarget,
  HandoffTurnV1,
} from "./lib/handoff.js";

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

export { APPLY_CONFIRMATION, runSessionBackfill } from "./lib/backfill.js";
export type {
  BackfillCheckpoint,
  BackfillCheckpointEntry,
  BackfillInventoryEntry,
  BackfillKey,
  BackfillRunOptions,
  BackfillRunResult,
} from "./lib/backfill.js";

// NOTE: the raw SQLite escape hatch (SqliteAdapter / getDatabase / closeDatabase /
// resetDatabase / initSchema) is intentionally NOT re-exported from the package
// main. Direct SQLite access outside the Store seam is exactly the split-brain
// this refactor eliminates: a consumer importing it in self_hosted/cloud mode
// would read the local island instead of the shared cloud registry. The on-box
// SQLite index is reachable only behind the Store (LocalStore transport, below).

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
