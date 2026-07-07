# @hasna/sessions

Search and sync your AI coding sessions — a unified, full-text searchable index
of every Claude Code, OpenAI Codex, and Gemini session on your machine.

[![npm](https://img.shields.io/npm/v/@hasna/sessions)](https://www.npmjs.com/package/@hasna/sessions)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
bun install -g @hasna/sessions
```

## What it does

`sessions` reads the session files written by your coding agents
(`~/.claude/projects`, `~/.codex/sessions`, `~/.gemini`), normalizes them into a
single SQLite database, and makes them full-text searchable — across providers,
projects, and time.

## Index & search

```bash
# Index sessions into the searchable DB (incremental; skips unchanged files)
sessions ingest                # all providers
sessions ingest --source codex # one provider
sessions ingest --force        # re-index everything
sessions sync --json           # ingest locally; remote sync is skipped unless storage is configured

# Full-text search across every session
sessions search "kubernetes deploy"
sessions search "stripe webhook" --source codex --project app
sessions search "kubectl apply" --tools     # search tool calls

# Semantic / hybrid search (run `sessions embed` first; needs OPENAI_API_KEY)
sessions embed
sessions search "how did I fix the auth bug" --semantic
sessions search "auth bug" --hybrid          # blend full-text + semantic (RRF)

# High-level recall for coding threads: FTS + optional semantic + tools + graph
sessions recall "find the thread where we implemented stripe webhooks"
sessions recall "resume building the CLI storage sync" --json

# Knowledge graph — entities (projects/tools/models/repos) and their links
sessions graph                               # all entities with counts
sessions graph --type tool
sessions graph --related project:infra       # sessions in a project
sessions graph --session <id>                # a session's neighborhood

# Browse
sessions recent                # most recently active sessions
sessions indexed-list --project app    # filter indexed sessions by project name or path
sessions show <id>             # full details + message previews
sessions stats                 # per-source + top-project counts

# Live tmux-backed Codewith/session activity (does not require indexed history)
sessions live --open-only
sessions live --open-only --status active
sessions live --open-only --status idle,dead,needs_attention
sessions live --open-only --json | jq '.[] | {target,status,projectPath,lastVisibleLine}'
sessions bulk status --open-only --status active --json
sessions bulk stop --open-only --status idle,dead --dry-run

# Keep the index continuously fresh (fs.watch + periodic safety re-scan)
sessions watch-ingest
sessions watch-ingest --status

# Manual refresh / reindex
sessions reindex
```

## Friendly names & resume

```bash
sessions list --json
sessions history --today
sessions transcript-search "raw Claude-only query"
sessions rename <id-or-name> "my friendly name"
sessions resume --last --print-command
sessions resume <friendly-name-or-id>
```

`sessions list` is the friendly-name registry used for resume workflows.
Use `sessions indexed-list` to browse the SQLite search index.
Use `sessions live` when you need current tmux/Codewith pane state; it reports
active, idle, needs_attention, and dead panes from tmux even when no indexed
session history exists yet.
Use `sessions bulk` when orchestration needs a guarded JSON plan with active
agent/load hints, concurrency and jitter settings, and explicit refusal reasons.
Mutating bulk execution is currently plan-only: use `--dry-run` to inspect the
actions that would be taken.

Existing maintenance commands (`relocate`, `transfer`, `migrate`, `paths`)
remain available.

## MCP Server

```bash
sessions-mcp
```

Exposes session tools for agents/orchestrators: `search_sessions`,
`search_tool_calls`, `recall_session`, `semantic_search`, `recent_sessions`, `list_sessions`,
`get_session`, `ingest`, `embed`, `session_stats`, `knowledge_graph`, plus
registry-backed tools (`sessions_list`, `sessions_history`, `sessions_search`,
`sessions_resume`, `sessions_rename`, `sessions_watch`, `sessions_stats`),
cross-adapter import tools, agent registry, feedback, and storage-sync tools.

## HTTP mode

Long-lived Streamable HTTP transport (default port **8835**, bind `127.0.0.1` only):

```bash
sessions-mcp --http
# or
MCP_HTTP=1 sessions-mcp

# override port
sessions-mcp --http --port 8835
MCP_HTTP_PORT=8835 sessions-mcp --http
```

Endpoints: `GET /health` → `{"status":"ok","name":"sessions"}`, MCP at `/mcp`.
Uses stateless `StreamableHTTPServerTransport` (shared process, many clients).
`sessions-mcp` without flags still uses stdio (unchanged).

## REST API

```bash
sessions-serve
```

Endpoints: `/search?q=`, `/recall?q=`, `/tool-calls?q=`, `/recent`, `/list`, `/sessions/:id`,
`/stats`, `/health`, `/info`.

## Storage Sync

Storage sync is optional. By default sessions use local SQLite at `~/.hasna/sessions/`.
The top-level `sessions sync` command refreshes the local index first and skips
remote push/pull when no storage database is configured. Use the explicit
`sessions storage ...` commands when you want remote PostgreSQL sync.

```bash
sessions storage status
sessions storage push
sessions storage pull
sessions storage sync
```

Set `HASNA_SESSIONS_DATABASE_URL` or configure
`~/.hasna/sessions/storage/config.json` to run in hybrid/remote mode with
PostgreSQL. `SESSIONS_DATABASE_URL` is accepted as a short non-deprecated
fallback for local development.

## Adapter notes

Indexed ingestion currently uses stable local files for Claude Code, local Codex
JSONL, and Gemini. Cursor/cloud Codex/cloud Claude sources should be added
through the existing `SessionParser`/`SessionAdapter` interfaces when they expose
a durable local export or API; avoid scraping transient cloud/cache formats.

## HTTP service (`sessions-serve`) + SDK

`sessions-serve` exposes an HTTP API with the standard health surface and a
versioned, API-key-authenticated `/v1` API:

- `GET /health`, `GET /ready`, `GET /version` → `{ status, version, mode }`
- `GET /openapi.json` → OpenAPI 3 document (the SDK is generated from it)
- `/v1/sessions` (list/create), `/v1/sessions/:id` (get/delete),
  `/v1/search`, `/v1/recent`, `/v1/machines`, `/v1/stats`

Auth uses `@hasna/contracts` API keys (header `x-api-key` or
`Authorization: Bearer`). Set the signing secret with
`HASNA_SESSIONS_API_SIGNING_KEY` (or the shared `HASNA_API_SIGNING_KEY`) and
issue keys with `bunx @hasna/contracts issue-key --app sessions --scopes
'sessions:read,sessions:write'`.

Amendment A1 (PURE REMOTE): in cloud mode (`HASNA_SESSIONS_STORAGE_MODE=cloud`
+ `HASNA_SESSIONS_DATABASE_URL`) the service reads/writes the shared cloud
Postgres directly — no sync engine or cache in the service. Apply the schema
with `sessions-serve migrate` (run with the owner DSN). See `docker-compose.yml`
for a self-host stack (serve + Postgres) and `Dockerfile` for the ARM64 image.

The generated, dependency-free SDK is published at `@hasna/sessions/sdk`:

```ts
import { SessionsApi } from "@hasna/sessions/sdk";
const client = new SessionsApi({ baseUrl: process.env.SESSIONS_API_URL!, apiKey: process.env.SESSIONS_API_KEY });
const { sessions } = await client.listSessions({ limit: 20 });
```

## Data Directory

Data is stored in `~/.hasna/sessions/` (`sessions.db`).

## License

Apache-2.0 -- see [LICENSE](LICENSE)
