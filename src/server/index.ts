#!/usr/bin/env bun

import { createSessionsServer, bootstrapServer } from "./app.js";
import { getPackageInfo, getPackageVersion } from "../lib/package.js";

const packageInfo = getPackageInfo();

function printHelp(): void {
  console.log(`Usage: sessions-serve [command] [options]

REST server for ${packageInfo.name}

Commands:
  (default)      start the HTTP server
  migrate        apply pending cloud (Postgres) migrations and exit
  migrate --dry  report pending migrations without applying

Options:
  -V, --version  output the version number
  -h, --help     display help for command

Environment:
  PORT                          port to listen on (default: 3456)
  HOST                          hostname to bind (default: 127.0.0.1)
  HASNA_SESSIONS_STORAGE_MODE   local | cloud (default: local)
  HASNA_SESSIONS_DATABASE_URL   cloud Postgres DSN (cloud mode)
  HASNA_SESSIONS_API_SIGNING_KEY  HMAC signing key for /v1 API-key auth

Endpoints:
  GET /health    liveness  -> { status, version, mode }
  GET /ready     readiness -> { status, version, mode }
  GET /version   version   -> { status, version, mode }
  GET /openapi.json  OpenAPI 3 document
  /v1/*          versioned API (API-key auth)`);
}

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}

if (args.includes("--version") || args.includes("-V")) {
  console.log(getPackageVersion());
  process.exit(0);
}

if (args[0] === "migrate") {
  const dryRun = args.includes("--dry") || args.includes("--dry-run");
  const { runCloudMigrations } = await import("../db/cloud/migrate.js");
  const { closeCloudClient } = await import("../db/cloud/client.js");
  try {
    const report = await runCloudMigrations({ dryRun });
    console.log(JSON.stringify({ ok: true, ...report }, null, 2));
    await closeCloudClient();
    process.exit(0);
  } catch (err) {
    console.error(`migration failed: ${(err as Error).message}`);
    await closeCloudClient().catch(() => {});
    process.exit(1);
  }
}

const hostname = process.env.HOST ?? "127.0.0.1";
const requestedPort = Number.parseInt(process.env.PORT || "3456", 10);

await bootstrapServer();

const server = createSessionsServer({
  hostname,
  port: Number.isFinite(requestedPort) ? requestedPort : 3456,
  enableMcp: process.env.SESSIONS_SERVE_ENABLE_MCP === "1",
});

console.log(`sessions-serve listening on http://${hostname}:${server.port}`);
