#!/usr/bin/env bun

import { createSessionsServer } from "./app.js";
import { getPackageInfo, getPackageVersion } from "../lib/package.js";

const packageInfo = getPackageInfo();

function printHelp(): void {
  console.log(`Usage: sessions-serve [options]

REST server for ${packageInfo.name}

Options:
  -V, --version  output the version number
  -h, --help     display help for command

Environment:
  PORT           port to listen on (default: 3456)
  HOST           hostname to bind (default: 127.0.0.1)

Endpoints:
  GET /health    health check
  GET /info      service metadata`);
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

const hostname = process.env.HOST ?? "127.0.0.1";
const requestedPort = Number.parseInt(process.env.PORT || "3456", 10);
const server = createSessionsServer({
  hostname,
  port: Number.isFinite(requestedPort) ? requestedPort : 3456,
});

console.log(
  `sessions-serve listening on http://${hostname}:${server.port}`
);
