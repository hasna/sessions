// API-key auth wiring for sessions-serve, built on @hasna/contracts/auth.
//
// Stateless HMAC-verifiable keys (prefix `hasna_sessions_`). In cloud mode the
// revocation check reads the shared RDS `api_keys` table via the vendored kit;
// in local mode revocation is skipped (a cryptographically valid, unexpired key
// is accepted). Fail-closed: when no signing secret is configured, /v1 is
// refused (503) rather than silently opened.

import {
  verifyApiKey,
  ApiKeyStore,
  type ApiKeyVerifier,
  type AuthAuditEvent,
} from "@hasna/contracts/auth";
import { getCloudClient, isCloudMode } from "../db/cloud/client.js";

const APP = "sessions";

/** Resolve the signing secret from the app-specific then shared env var. */
export function resolveSigningSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.HASNA_SESSIONS_API_SIGNING_KEY ?? env.HASNA_API_SIGNING_KEY;
}

let _verifier: ApiKeyVerifier | null | undefined;
let _store: ApiKeyStore | null = null;

/** The api-keys store (cloud only), for revocation checks + schema bootstrap. */
export function getApiKeyStore(): ApiKeyStore | null {
  if (!isCloudMode()) return null;
  if (_store) return _store;
  _store = new ApiKeyStore(getCloudClient());
  return _store;
}

/**
 * Build (once) the request verifier. Returns null when no signing secret is
 * configured — the caller must then refuse /v1 (fail-closed).
 */
export function getVerifier(auditLog?: (e: AuthAuditEvent) => void): ApiKeyVerifier | null {
  if (_verifier !== undefined) return _verifier;
  const signingSecret = resolveSigningSecret();
  if (!signingSecret) {
    _verifier = null;
    return _verifier;
  }
  const store = getApiKeyStore();
  _verifier = verifyApiKey({
    app: APP,
    signingSecret,
    ...(store ? { isRevoked: store.isRevoked } : {}),
    ...(auditLog ? { audit: auditLog } : {}),
  });
  return _verifier;
}

/** Ensure the api_keys table exists (cloud only). Best-effort; safe to call repeatedly. */
export async function ensureAuthSchema(): Promise<void> {
  const store = getApiKeyStore();
  if (store) await store.ensureSchema();
}

/** Test hook. */
export function resetAuth(): void {
  _verifier = undefined;
  _store = null;
}
