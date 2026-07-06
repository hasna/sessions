-- API-key records for sessions-serve auth (@hasna/contracts/auth ApiKeyStore).
-- Owner-created so the request-path app role (DML only) never needs DDL rights.
-- Stores ONLY the sha256 token hash + metadata; never the plaintext key.

CREATE TABLE IF NOT EXISTS api_keys (
  kid TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  agent TEXT,
  scopes JSONB NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  last_used_at TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_keys_app_idx ON api_keys (app);
CREATE INDEX IF NOT EXISTS api_keys_token_hash_idx ON api_keys (token_hash);
