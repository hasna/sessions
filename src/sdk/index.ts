// Typed SDK for @hasna/sessions, generated from the sessions-serve OpenAPI
// document by @hasna/contracts. Self_hosted clients need only SESSIONS_API_URL
// + SESSIONS_API_KEY. Regenerate with `bun run sdk:generate`.

export * from "./client.js";
export { SessionsApi as SessionsClient } from "./client.js";

import { SessionsApi, type SessionsApiOptions } from "./client.js";

/**
 * Build a SessionsApi client from the environment (SESSIONS_API_URL +
 * SESSIONS_API_KEY), the Hasna self_hosted client convention. Overrides win.
 */
export function createSessionsClientFromEnv(
  overrides: Partial<SessionsApiOptions> = {},
  env: NodeJS.ProcessEnv = process.env,
): SessionsApi {
  const baseUrl = overrides.baseUrl ?? env.SESSIONS_API_URL;
  if (!baseUrl) {
    throw new Error("SESSIONS_API_URL is required to build the sessions client.");
  }
  const apiKey = overrides.apiKey ?? env.SESSIONS_API_KEY;
  return new SessionsApi({ baseUrl, ...(apiKey ? { apiKey } : {}), ...overrides });
}
