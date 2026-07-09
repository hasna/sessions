# @hasna/sessions

Search and resume your AI coding sessions — a unified, full-text searchable index
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
sessions sync --json           # ingest locally; optionally push metadata via self-hosted /v1 API

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
sessions recall "resume building the API auth flow" --json

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

## Cross-agent handoff

`sessions handoff <target>` creates a typed `ExternalHandoffBundleV1` JSON file
under `~/.hasna/sessions/handoffs/` for safe slash-command wrappers such as
`/handoff codewith`.

```bash
# Build and write a bundle, then print the Codewith continuation command
sessions handoff codewith --print-command

# Hook-friendly mode: prefer explicit session/transcript hints when available
sessions handoff codewith \
  --source-agent claude \
  --source-session "$CLAUDE_SESSION_ID" \
  --source-transcript "$CLAUDE_TRANSCRIPT_PATH" \
  --cwd "$PWD" \
  --json

# Preview without writing or launching
sessions handoff codewith --dry-run --json

# Emit installable wrapper skill text named "handoff"; does not write global files
sessions handoff --emit-skill claude
sessions handoff --emit-skill codewith
sessions handoff --emit-skill codex
sessions handoff --emit-skill opencode
sessions handoff --emit-skill cursor
```

The v1 protocol is deliberately not a live tmux paste. It writes redacted
context, recent turns, cwd/repo/git summary, auth/profile references by name
only, verification notes, blockers, a bundle hash, and a rendered target
command. Source exit is not automatic because v1 has no target acknowledgement
protocol.

## MCP Server

```bash
sessions-mcp
```

Exposes session tools for agents/orchestrators: `search_sessions`,
`search_tool_calls`, `recall_session`, `semantic_search`, `recent_sessions`, `list_sessions`,
`get_session`, `ingest`, `embed`, `session_stats`, `knowledge_graph`, plus
registry-backed tools (`sessions_list`, `sessions_history`, `sessions_search`,
`sessions_resume`, `sessions_rename`, `sessions_watch`, `sessions_stats`),
cross-adapter import tools, and agent registry tools. MCP no longer exposes the
removed DSN-on-client push/pull tools or direct feedback write tool.

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

## Local and self-hosted registry mode

By default sessions use the local SQLite index at `~/.hasna/sessions/`.
`sessions sync` ingests local sessions and recomputes machine metadata. In local
mode the on-box index is authoritative, so there is nothing to push or pull.

To share one registry across machines, point the CLI or MCP server at a
self-hosted `sessions-serve` instance with `HASNA_SESSIONS_API_URL` and
`HASNA_SESSIONS_API_KEY`. In that mode `sessions sync` pushes locally indexed
session metadata to the authenticated `/v1` API. Clients do not open a Postgres
DSN, and the former client-side storage subcommand family has been removed.

Run the service-side Postgres schema with `sessions-serve migrate` using the
owner DSN. The current server-side storage mode value is
`HASNA_SESSIONS_STORAGE_MODE=cloud`, but this README uses "self-hosted" for the
deployment mode: the service runs in Hasna-owned infrastructure or your own
server, and clients talk to its `/v1` API.

## Adapter notes

Indexed ingestion currently uses stable local files for Claude Code, local Codex
JSONL, and Gemini. Cursor/cloud Codex/cloud Claude sources should be added
through the existing `SessionParser`/`SessionAdapter` interfaces when they expose
a durable local export or API; avoid scraping transient cloud/cache formats.

## HTTP service (`sessions-serve`) + SDK

`sessions-serve` exposes unauthenticated health/documentation endpoints and a
versioned, API-key-authenticated `/v1` API:

- `GET /health`, `GET /ready`, `GET /version` → `{ status, version, mode }`
- `GET /openapi.json` → OpenAPI 3 document (the SDK is generated from it)
- OpenAPI/SDK-covered routes: `/v1/sessions` (list/create),
  `/v1/sessions/:id` (get/delete), `/v1/search`, `/v1/recent`,
  `/v1/machines`, `/v1/stats`
- Additional authenticated server routes: `PATCH /v1/sessions/:id`,
  `POST /v1/relocate`, `GET /v1/search/content`,
  `GET /v1/search/tools`, `GET /v1/graph`

Legacy unauthenticated content routes such as `/search`, `/recall`,
`/tool-calls`, `/recent`, `/list`, `/machines`, `/stats`, and `/sessions/:id`
are removed and should return 404. Use the `/v1` routes with an API key.

Auth uses `@hasna/contracts` API keys (header `x-api-key` or
`Authorization: Bearer`). Set the signing secret with
`HASNA_SESSIONS_API_SIGNING_KEY` (or the shared `HASNA_API_SIGNING_KEY`) and
issue keys with `bunx @hasna/contracts issue-key --app sessions --scopes
'sessions:read,sessions:write'`.

In self-hosted server mode (`HASNA_SESSIONS_STORAGE_MODE=cloud` +
`HASNA_SESSIONS_DATABASE_URL`) the service reads/writes Postgres directly: no
client-side DSN sync engine and no service-side cache. Apply the schema with
`sessions-serve migrate` (run with the owner DSN). See `docker-compose.yml` for
a self-hosted stack (serve + Postgres) and `Dockerfile` for the ARM64 image.

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
