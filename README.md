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
sessions search "stripe webhook" --source codex --project /path/to/app
sessions search "kubectl apply" --tools     # search tool calls

# Semantic / hybrid search (run `sessions embed` first; needs OPENAI_API_KEY)
sessions embed
sessions search "how did I fix the auth bug" --semantic
sessions search "auth bug" --hybrid          # blend full-text + semantic (RRF)

# High-level recall for coding threads: FTS + optional semantic + tools + graph
sessions recall "find the thread where we implemented stripe webhooks"
sessions recall "resume building the CLI storage sync" --json

# Knowledge graph — entities (projects/tools/models/repos) and their links
sessions graph                               # first page of entities with counts
sessions graph --type tool --limit 20
sessions graph --related project:infra       # sessions in a project
sessions graph --session <id>                # a session's neighborhood

# Browse
sessions recent                # most recently active sessions
sessions indexed-list --project /path --limit 20
sessions show <id>             # details + compact message previews
sessions show <id> --messages 50
sessions stats                 # per-source + top-project counts

# Agent automation state (compact JSON by default)
sessions active-agents                 # live tmux agent panes, cwd, command, composer state
sessions active-agents --human         # compact table for operators
sessions session-health                # recent indexed sessions with health/classification
sessions session-health <id>           # one session by id or unique prefix

# Keep the index continuously fresh (fs.watch + periodic safety re-scan)
sessions watch-ingest
sessions watch-ingest --status

# Manual refresh / reindex
sessions reindex
```

## Friendly names & resume

```bash
sessions list --json
sessions list --limit 10
sessions list --all
sessions history --today --limit 10
sessions transcript-search "raw Claude-only query"
sessions rename <id-or-name> "my friendly name"
sessions resume --last --print-command
sessions resume <friendly-name-or-id>
```

`sessions list` is the friendly-name registry used for resume workflows.
Use `sessions indexed-list` to browse the SQLite search index.

Existing maintenance commands (`relocate`, `transfer`, `migrate`, `paths`)
remain available.

## Compact output

Human-facing list and graph commands are compact by default so they are safe to
run in agent terminals. Commands such as `sessions list`, `sessions history`,
`sessions watch --once`, `sessions paths`, and `sessions graph --type tool`
print a bounded first page with totals and a hint for the next detail command.

Use gradual disclosure when you need more:

```bash
sessions list                  # first 20 friendly-name sessions
sessions list --limit 50       # larger human page
sessions list --all            # all rows for humans
sessions list --json           # full machine-readable payload
sessions list --json --limit 5 # explicitly limited JSON payload

sessions graph --type tool             # first 50 tools by session count
sessions graph --type tool --limit 20
sessions graph --type tool --all
sessions graph --type tool --json      # full machine-readable entity list

sessions show <id>             # session summary + 12 message previews
sessions show <id> --messages 50
sessions show <id> --verbose   # all message previews and tool names
sessions show <id> --json      # machine-readable detail payload
```

`--json` remains the compatibility path for automation. Existing JSON commands
keep their prior payload shape; commands with new `--limit` support only limit
JSON when you pass `--limit` explicitly.

`sessions active-agents` and `sessions session-health` are agent-first APIs and
therefore emit compact deterministic JSON by default. They include stable
`schema_version` values, bounded arrays, redacted command/path fields, and raw
artifacts only as evidence paths such as `tmux://…`, `sessions://session/…`, or
the indexed transcript path. Use `--human` for a table view.

## MCP Server

```bash
sessions-mcp
```

Exposes session tools for agents/orchestrators: `search_sessions`,
`search_tool_calls`, `recall_session`, `semantic_search`, `recent_sessions`, `list_sessions`,
`get_session`, `ingest`, `embed`, `session_stats`, `knowledge_graph`,
`active_agents`, `session_health`, plus
registry-backed tools (`sessions_list`, `sessions_history`, `sessions_search`,
`sessions_resume`, `sessions_rename`, `sessions_watch`, `sessions_stats`),
cross-adapter import tools, agent registry, feedback, and storage-sync tools.

MCP tools also avoid unbounded transcript dumps by default. `get_session`
returns compact message/tool previews plus counts; pass `include_full: true` or
raise `message_limit` / `tool_call_limit` for full detail. `knowledge_graph`,
`sessions_list`, `sessions_history`, and `sessions_watch` return compact pages
unless callers raise `limit` or request `include_full`. `sessions_read`
returns compact adapter-event previews unless callers raise `event_limit` or
request `include_full`.

`active_agents` returns live tmux agent composer summaries for dispatch and
loops: target, cwd, pane command, composer state, send/queue capability,
classification reason, and evidence refs. `session_health` returns indexed
session cwd, resume command when available, activity/health classification,
bounded issue lists, and transcript evidence paths.

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

Endpoints: `/search?q=`, `/recall?q=`, `/tool-calls?q=`, `/active-agents`,
`/session-health`, `/session-health/:id`, `/recent`, `/list`, `/sessions/:id`,
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

## Data Directory

Data is stored in `~/.hasna/sessions/` (`sessions.db`).

## License

Apache-2.0 -- see [LICENSE](LICENSE)
