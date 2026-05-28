# @hasna/sessions

Session search and management for AI coding agents

[![npm](https://img.shields.io/npm/v/@hasna/sessions)](https://www.npmjs.com/package/@hasna/sessions)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
bun install -g @hasna/sessions
```

## CLI Usage

```bash
sessions --help
sessions list --json
sessions history --today
sessions search "fix auth bug"
sessions resume --last --print-command
```

## MCP Server

```bash
sessions-mcp
```

Available tools include `sessions_list`, `sessions_history`, `sessions_search`,
`sessions_resume`, `sessions_rename`, `sessions_watch`, `sessions_stats`,
agent registration helpers, and feedback/cloud sync tools.

## REST API

```bash
sessions-serve
```

## Cloud Sync

This package supports cloud sync via `@hasna/cloud`:

```bash
cloud setup
cloud sync push --service sessions
cloud sync pull --service sessions
```

## Data Directory

Data is stored in `~/.hasna/sessions/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
