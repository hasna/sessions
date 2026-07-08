// Server-only surface (`@hasna/sessions/server`).
//
// This is the Postgres (RDS) data plane + HTTP serve surface. It reads
// DATABASE_URL and opens a `pg` pool, so it MUST NOT be reachable from any
// client (CLI / MCP / SDK / agent) import path. It is deliberately kept OUT of
// the package main (`@hasna/sessions`) — clients use `@hasna/sessions/storage`
// (the Store) which never touches a DSN. Only a self-hosting server process
// (the `sessions-serve` bin or an equivalent host) should import this.
export { isCloudMode, getCloudClient, closeCloudClient, APP_NAME } from "./db/cloud/client.js";
export { runCloudMigrations } from "./db/cloud/migrate.js";
export { loadMigrations, resolveMigrationsDir } from "./db/cloud/migrations.js";
export * as cloudStore from "./db/cloud/store.js";
export { buildOpenApiDocument } from "./server/openapi.js";
export { createSessionsServer, bootstrapServer } from "./server/app.js";
