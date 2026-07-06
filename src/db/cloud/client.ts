// Cloud Postgres client for open-sessions (PURE REMOTE, Amendment A1).
//
// Opens a single pooled connection to the shared RDS via the vendored storage
// kit. cloud mode reads AND writes go directly to Postgres — there is no sync
// engine, cache, or local mirror in the service path.

import {
  createCloudPoolFromEnv,
  resolveStorageMode,
  type PoolQueryClient,
} from "../../generated/storage-kit/index.js";

export const APP_NAME = "sessions";

let _client: PoolQueryClient | null = null;

/** True when the environment selects cloud storage mode for sessions. */
export function isCloudMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveStorageMode(APP_NAME, env).mode === "cloud";
}

/**
 * Get the process-wide cloud Postgres client, creating it on first use.
 * Throws a clear error (never a silent no-op) when the environment is not in
 * cloud mode or the database URL is missing.
 */
export function getCloudClient(): PoolQueryClient {
  if (_client) return _client;
  const { client } = createCloudPoolFromEnv(APP_NAME, {
    applicationName: "sessions-serve",
    max: 5,
  });
  _client = client;
  return _client;
}

/** Close the cloud client (used on shutdown / in tests). */
export async function closeCloudClient(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
  }
}
