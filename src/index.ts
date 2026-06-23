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
export {
  getStorageConfig,
  getStorageConnectionString,
  getConnectionString,
  getStorageDatabaseEnv,
  getStorageDatabaseEnvName,
  getStorageDatabaseUrl,
  SESSIONS_STORAGE_ENV,
  SESSIONS_STORAGE_FALLBACK_ENV,
  STORAGE_DATABASE_ENV,
  STORAGE_MODE_ENV,
  type StorageConfig,
  type StorageMode,
  type StorageEnv,
} from "./db/storage-config.js";
export { PgAdapterAsync } from "./db/remote-storage.js";
export { applyPgMigrations } from "./db/pg-migrate.js";
export {
  STORAGE_TABLES,
  SESSIONS_STORAGE_TABLES,
  getStoragePg,
  getStorageStatus,
  parseStorageTables,
  pullStorageChanges,
  pushStorageChanges,
  runStorageMigrations,
  syncStorageChanges,
} from "./db/storage-sync.js";
export type { StorageStatus, SyncResult } from "./db/storage-sync.js";
