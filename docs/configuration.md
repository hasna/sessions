# Configuration reference

Sessions has three distinct configuration surfaces: local indexing, the
self-hosted HTTP client, and the `sessions-serve` data plane. Do not put a
Postgres DSN in a client process; clients use the authenticated `/v1` API.

## Local index

| Variable | Behavior |
| --- | --- |
| `HASNA_SESSIONS_DIR` | Sessions data directory. Default: `~/.hasna/sessions`. |
| `HASNA_SESSIONS_DB_PATH` | Explicit SQLite path. Takes precedence over `SESSIONS_DB_PATH` and the data-directory default. `:memory:` is supported. |
| `SESSIONS_DB_PATH` | Compatibility alias for the explicit SQLite path. |
| `HASNA_MACHINE` | Override the machine name stored with ingested sessions. |
| `CLAUDE_PATH` | Claude base directory; sessions are read from its `projects/` child. Default: `~/.claude`. |
| `CODEX_PATH` | Codex base directory; sessions are read from its `sessions/` child. Default: `~/.codex`. |
| `CODEX_HOME` | Codex base directory used by the cross-adapter MCP import tools. Default: `~/.codex`. Indexed ingestion uses `CODEX_PATH` instead. |
| `CODEWITH_PATH` | Codewith base directory; sessions are read from its `sessions/` child. Default: `~/.codewith`. |
| `GEMINI_PATH` | Gemini base directory; sessions are read from its `tmp/` child. Default: `~/.gemini`. |
| `OPENAI_API_KEY` | Enables embedding generation and semantic search. Full-text search does not require it. |
| `HASNA_SESSIONS_REBUILD_FTS_ON_OPEN=1` | Rebuild repaired FTS reference tables on database open when counts differ. Intended for recovery. |

If `~/.hasna/sessions/sessions.db` does not exist but the legacy
`~/.sessions/sessions.db` does, the legacy database is copied automatically.

## Handoff source hints

`sessions handoff` prefers explicit `--source-session` and
`--source-transcript` values. When they are omitted, Claude hooks may supply
`CLAUDE_SESSION_ID`, `CLAUDE_CODE_SESSION_ID`, or `CLAUDECODE_SESSION_ID` and
`CLAUDE_TRANSCRIPT_PATH`, `CLAUDE_CODE_TRANSCRIPT_PATH`, or
`CLAUDECODE_TRANSCRIPT_PATH`. Codewith hooks may supply `CODEWITH_SESSION_ID` or
`CODEWITH_THREAD_ID`. These values identify source context; they are not storage
credentials.

## Self-hosted client

Configure the `sessions` CLI, MCP active-store tools, or
`@hasna/sessions/storage` with:

```bash
export HASNA_SESSIONS_MODE=self_hosted
export HASNA_SESSIONS_API_URL=https://sessions.example.com
export HASNA_SESSIONS_API_KEY=...
```

`HASNA_SESSIONS_MODE=cloud` is accepted as the same client mode.
`SESSIONS_MODE`, `SESSIONS_API_URL`, and `SESSIONS_API_KEY` are compatibility
aliases used by the shared storage client. Mode plus URL plus key are required;
partial self-hosted configuration fails closed.

| Variable | Behavior |
| --- | --- |
| `HASNA_SESSIONS_PRODUCTION_HOSTS` | Comma- or space-separated host suffixes treated as production-like by backfill safety checks. |
| `HASNA_SESSIONS_PRODUCTION=1` | Force the backfill production gate regardless of URL. |

The generated `@hasna/sessions/sdk` helper
`createSessionsClientFromEnv()` reads `SESSIONS_API_URL` and the optional
`SESSIONS_API_KEY`. Explicit constructor options override environment values.

## MCP transport

| Variable | Behavior |
| --- | --- |
| `MCP_STDIO=1` | Select stdio transport. |
| `MCP_HTTP=1` | Explicitly select HTTP transport, which is already the default. |
| `MCP_HTTP_PORT` | HTTP port. Default: `8877`; `--port` takes precedence. |

HTTP binds to `127.0.0.1`; there is no environment override for the MCP bind
address.

## Service data plane

`sessions-serve` defaults to local mode. A self-hosted service uses Postgres:

```bash
export HASNA_SESSIONS_STORAGE_MODE=cloud
export HASNA_SESSIONS_DATABASE_URL=postgres://...
export HASNA_SESSIONS_API_SIGNING_KEY=...
sessions-serve migrate
sessions-serve
```

| Variable | Behavior |
| --- | --- |
| `HASNA_SESSIONS_STORAGE_MODE` | `local` or `cloud`; default `local`. `SESSIONS_STORAGE_MODE` is an alias. Deprecated `remote`, `hybrid`, and `self_hosted` values normalize to `cloud`. |
| `HASNA_SESSIONS_DATABASE_URL` | Canonical Postgres DSN in cloud mode. `SESSIONS_DATABASE_URL` is the supported alias. |
| `HASNA_SESSIONS_API_SIGNING_KEY` | Preferred HMAC signing key for `/v1` API-key authentication. `HASNA_API_SIGNING_KEY` is the shared fallback. |
| `PORT` | HTTP port. Default: `3456`. |
| `HOST` | Bind hostname. Default: `127.0.0.1`. |
| `HASNA_SESSIONS_MAX_REQUEST_BODY_SIZE` | Request-body limit in bytes or units such as `768MiB`. Cloud mode defaults to `512MiB`. |
| `SESSIONS_SERVE_ENABLE_MCP=1` | Also mount MCP at `/mcp` in the service process. |
| `SESSIONS_MIGRATIONS_DIR` | Override the directory containing SQL migrations. |
| `PGSSLROOTCERT` | CA bundle used by verified Postgres TLS modes. |

`GET /health`, `/ready`, `/version`, and `/openapi.json` are unauthenticated.
The `/v1` data routes require an API key with the appropriate sessions scopes.
