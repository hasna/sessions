# CLI reference

The package installs three binaries:

| Binary | Purpose |
| --- | --- |
| `sessions` | Ingest, search, manage, transfer, and sync session records. |
| `sessions-mcp` | Expose session operations over MCP. Streamable HTTP is the default transport. |
| `sessions-serve` | Run the authenticated `/v1` HTTP API or apply Postgres migrations. |

Run `sessions <command> --help`, `sessions-mcp --help`, or
`sessions-serve --help` for the exact help shipped by the installed version.

## Index and search

| Command | Options and behavior |
| --- | --- |
| `sessions ingest` | Index all providers. `--source`, `--force`, `--verbose`, and `--json` are supported. |
| `sessions reindex` | Alias command with the same behavior and options as `ingest`. |
| `sessions ingest-watch` | Continuously ingest changes. Alias: `watch-ingest`. Supports repeatable `--source`, `--no-initial`, `--debounce` (default `2000` ms), `--poll` (default `10000` ms; `0` disables), `--status`, and `--json`. |
| `sessions search-indexed <query>` | Full-text search. Aliases: `search`, `indexed-search`. Filters: `--source`, `--project`, `--machine`; default `--limit 20`. Add `--tools`, `--semantic`, `--hybrid`, or `--json`. |
| `sessions transcript-search <query>` | Search transcript content through the active store. Alias: `registry-search`. Supports `--project`, `--limit` (default `20`), and `--json`. |
| `sessions recall <query>` | Local-only combined recall. Supports `--source`, `--project`, `--machine`, `--limit` (default `10`), `--no-semantic`, and `--json`. |
| `sessions embed` | Generate local message embeddings. Supports `--limit` (default `200`) and `--json`; requires `OPENAI_API_KEY`. |
| `sessions graph` | List graph entities, use `--related <type:name>`, or inspect `--session <id>`. Also supports `--type`, `--source`, `--limit` (default `50`), and `--json`. |

`recall`, embeddings, and the richer local graph/tool analysis require the local
index. Active-store commands fail clearly when a requested operation has no
self-hosted `/v1` equivalent.

## Browse and manage

| Command | Options and behavior |
| --- | --- |
| `sessions list` | List the active store. Supports `--project`, `--limit` (default `50`), and `--json`. |
| `sessions history` | List with `--project`, `--today`, `--agent`, `--limit` (default `200` before filtering), and `--json`. |
| `sessions recent` | List recent records with `--machine`, `--limit` (default `20`), and `--json`. |
| `sessions list-indexed` | List with `--source`, `--project`, `--machine`, `--limit` (default `50`), and `--json`. Alias: `indexed-list`. |
| `sessions show <id>` | Resolve an internal id, unique prefix, or `--source`-qualified native id. `--messages` defaults to `12`; `--json` returns full structured output. |
| `sessions machines` | List contributing machines and counts; supports `--json`. |
| `sessions paths` | List project paths and counts; supports `--json`. Missing-path markers are local-mode only. |
| `sessions stats` | Show ingestion and project statistics; supports `--json`. |
| `sessions create` | Create a record with required `--source` and `--source-id`; optional `--title`, `--project-path`, `--project-name`, `--model`, `--machine`, and `--json`. |
| `sessions rename <id-or-prefix> <title>` | Set the title. Use `--source` for a provider-native id; supports `--json`. |
| `sessions delete <id>` | Delete a record from the active store; supports `--json`. |
| `sessions resume [id-or-prefix]` | Select by id, `--project`, `--last`, or `--pick`; use `--source` for a native id. `--print-command` does not launch. Only Claude currently has an executable resume command. |
| `sessions watch` | Refresh the active-store table. Supports `--project`, `--interval` (default `5` seconds), `--json`, and `--once`. |

The **active store** is local SQLite by default. It becomes the self-hosted HTTP
store only when self-hosted mode, API URL, and API key are all configured; a
partial self-hosted configuration fails closed rather than silently using local
data.

## Live tmux operations

| Command | Options and behavior |
| --- | --- |
| `sessions live` | Inspect tmux-backed Codewith/session panes. Filters: `--open-only`, `--project`, `--machine`, `--status`; `--interval` defaults to `5`. Use `--watch`, `--once`, or `--json`. |
| `sessions bulk <action>` | Plan `status`, `capture`, `doctor`, `ensure`, `start`, `stop`, or `restart`. Supports live filters, `--dry-run`, `--yes`, `--no-queue`, `--concurrency` (default `2`), `--jitter` (default `0`), `--max-active-agents` (default `12`), optional `--max-load1`, and `--max-load-per-core` (default `1.5`). Mutating execution is intentionally disabled; use `--dry-run` to inspect plans. |

The JSON schemas and guard semantics are defined in the
[live status contract](live-status-contract.md).

## Transfer and maintenance

| Command | Options and behavior |
| --- | --- |
| `sessions relocate <old-path> <new-path>` | Rewrite transcript paths and, unless `--no-db`, active-store paths. Supports `--dry-run`, `--verbose`, and `--json`. |
| `sessions migrate <source-project> <target-project>` | Move Claude project session files. Supports `--dry-run` and `--verbose`. |
| `sessions transfer export` | Export raw files. Supports `--project`, `--output`, `--name`, `--dry-run`, `--verbose`, and `--json`. |
| `sessions transfer import <path>` | Import an export. Supports `--remap-home`, `--remap <from:to>`, `--reingest`, `--overwrite`, `--dry-run`, `--verbose`, and `--json`. |
| `sessions import-db <path>` | Merge another local sessions database, preserving machine tags; supports `--json`. This operation is local-only. |
| `sessions handoff [target]` | Create an `ExternalHandoffBundleV1`. Source/context flags: `--source-agent`, `--source-session`, `--source-transcript`, `--cwd`, `--idempotency-key`, and `--context-summary`. Repeatable fields: `--auth-ref`, `--verification`, and `--blocker`. Codewith settings: `--codewith-auth-profile` and `--codewith-mode` (default `interactive`). Size limits: `--max-turns` (default `8`) and `--max-turn-chars` (default `1200`). Output/action flags: `--dry-run`, `--print-command`, `--launch`, `--emit-skill`, and `--json`. |

## Self-hosted sync

| Command | Options and behavior |
| --- | --- |
| `sessions sync` | Ingest, then push content in self-hosted mode. Supports `--no-ingest`, `--dry-run`, `--watch`, source/project/machine filters, `--limit` (default `500`), `--interval`, `--max-iterations` (default `60`), `--backup-command`, and `--json`. |
| `sessions daemon` | Run bounded sync polling. Same filters and safety options as `sync`; `--interval` defaults to `60` seconds and `--max-iterations` defaults to `60`. |
| `sessions backfill` | Inventory by default or apply a bounded historical backfill. Selection flags are `--source`, `--pilot`, `--range-start`, `--range-end`, repeatable `--known-id`, and `--all-sources`. Apply requires `--apply`, `--confirm-apply BACKFILL_APPLY`, `--max-total-bytes`, and `--backup-command`; production-like targets additionally require `--allow-production` after separate approval. `--batch-size` defaults to `128`, `--concurrency` to `1`, and `--max-session-bytes` to `67108864`. `--checkpoint` overrides the default `~/.hasna/sessions/backfill/checkpoint.json`; `--json` emits machine-readable output. |

Live self-hosted sync and backfill apply require a successful backup command.
Dry runs do not execute the backup command or push content.

## MCP binary

`sessions-mcp` binds Streamable HTTP to `127.0.0.1:8877` by default. The MCP
endpoint is `/mcp` and `GET /health` returns
`{"status":"ok","name":"sessions"}`.

| Selector | Effect |
| --- | --- |
| `--stdio` or `MCP_STDIO=1` | Use stdio transport. |
| `--http` or `MCP_HTTP=1` | Explicitly select the default HTTP transport. |
| `--port <n>` or `MCP_HTTP_PORT=<n>` | Override the HTTP port. The CLI flag wins. |

## Service binary

`sessions-serve` starts the HTTP service on `127.0.0.1:3456` by default.
`sessions-serve migrate` applies Postgres migrations, while
`sessions-serve migrate --dry-run` only reports pending migrations. See the
[configuration reference](configuration.md) for server mode, auth, database,
body-limit, and bind settings.
