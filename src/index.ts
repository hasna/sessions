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
