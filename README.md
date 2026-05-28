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

# Full-text search across every session
sessions search "kubernetes deploy"
sessions search "stripe webhook" --source codex --project /path/to/app
sessions search "kubectl apply" --tools     # search tool calls

# Semantic / hybrid search (run `sessions embed` first; needs OPENAI_API_KEY)
sessions embed
sessions search "how did I fix the auth bug" --semantic
sessions search "auth bug" --hybrid          # blend full-text + semantic (RRF)

# Knowledge graph — entities (projects/tools/models/repos) and their links
sessions graph                               # all entities with counts
sessions graph --type tool
sessions graph --related project:infra       # sessions in a project
sessions graph --session <id>                # a session's neighborhood

# Browse
sessions recent                # most recently active sessions
sessions list --project /path  # filter by project
sessions show <id>             # full details + message previews
sessions stats                 # per-source + top-project counts

# Keep the index continuously fresh (fs.watch + periodic safety re-scan)
sessions watch
```

## Friendly names & resume

```bash
sessions list --json
sessions history --today
sessions rename <id-or-name> "my friendly name"
sessions resume --last --print-command
sessions resume <friendly-name-or-id>
```

Existing maintenance commands (`relocate`, `transfer`, `migrate`, `paths`)
remain available.

## MCP Server

```bash
sessions-mcp
```

Exposes session tools for agents/orchestrators: `search_sessions`,
`search_tool_calls`, `semantic_search`, `recent_sessions`, `list_sessions`,
`get_session`, `ingest`, `embed`, `session_stats`, `knowledge_graph`, plus
registry-backed tools (`sessions_list`, `sessions_history`, `sessions_search`,
`sessions_resume`, `sessions_rename`, `sessions_watch`, `sessions_stats`),
cross-adapter import tools, agent registry, feedback, and cloud-sync tools.

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

Endpoints: `/search?q=`, `/tool-calls?q=`, `/recent`, `/list`, `/sessions/:id`,
`/stats`, `/health`, `/info`.

## Cloud Sync

This package supports cloud sync via `@hasna/cloud`:

```bash
cloud setup
cloud sync push --service sessions
cloud sync pull --service sessions
```

## Data Directory

Data is stored in `~/.hasna/sessions/` (`sessions.db`).

## License

Apache-2.0 -- see [LICENSE](LICENSE)
