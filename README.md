# @hasna/sessions

Session search and management for AI coding agents

[![npm](https://img.shields.io/npm/v/@hasna/sessions)](https://www.npmjs.com/package/@hasna/sessions)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/sessions
```

## CLI Usage

```bash
sessions --help
```

## MCP Server

```bash
sessions-mcp
```

5 tools available.

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
