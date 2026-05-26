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

# Browse
sessions recent                # most recently active sessions
sessions list --project /path  # filter by project
sessions show <id>             # full details + message previews
sessions stats                 # per-source + top-project counts

# Keep the index continuously fresh (fs.watch + periodic safety re-scan)
sessions watch
```

Existing maintenance commands (`relocate`, `transfer`, `migrate`, `paths`)
remain available.

## MCP Server

```bash
sessions-mcp
```

Exposes session tools for agents/orchestrators: `search_sessions`,
`search_tool_calls`, `recent_sessions`, `list_sessions`, `get_session`,
`ingest`, `session_stats` (plus agent registry, feedback, and cloud-sync tools).

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
