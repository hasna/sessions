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

The runtime boundary is local-first:

- Local capture and search use local provider files plus SQLite/FTS5 only.
- Remote PostgreSQL stores session metadata tables and a redacted
  `session_index_documents` metadata index by default.
- Transcript-bearing tables (`messages`, `tool_calls`, `embeddings`) and
  feedback are skipped for remote push/pull unless explicitly enabled with
  `HASNA_SESSIONS_REMOTE_PAYLOADS=transcripts,tool_payloads,embeddings,feedback`
  or `privacy.remote_payloads` in the storage config.
- S3/AWS object storage is represented only as a future adapter descriptor in
  config/status. This package does not upload private transcripts or objects to
  S3/AWS; live object writes require a separate approval task and implementation.

`sessions storage status --json` reports the active local SQLite, remote
PostgreSQL, and S3/AWS adapter state plus the current privacy gate decisions.

## Adapter notes

Indexed ingestion currently uses stable local files for Claude Code, local Codex
JSONL, and Gemini. Cursor/cloud Codex/cloud Claude sources should be added
through the existing `SessionParser`/`SessionAdapter` interfaces when they expose
a durable local export or API; avoid scraping transient cloud/cache formats.

## Data Directory

Data is stored in `~/.hasna/sessions/` (`sessions.db`).

## License

Apache-2.0 -- see [LICENSE](LICENSE)
