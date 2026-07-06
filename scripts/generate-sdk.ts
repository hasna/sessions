#!/usr/bin/env bun
// Generate the typed SDK client from sessions-serve's OpenAPI document.
//
// The SDK is the single source of truth for self_hosted clients: they need only
// SESSIONS_API_URL + SESSIONS_API_KEY. Run: `bun run sdk:generate`.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSdkFromOpenApi } from "@hasna/contracts/sdk";
import { buildOpenApiDocument } from "../src/server/openapi.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outFile = join(repoRoot, "src", "sdk", "client.ts");

const spec = buildOpenApiDocument();
const { code, operations, warnings } = generateSdkFromOpenApi(spec, {
  className: "SessionsApi",
  apiKeyHeader: "x-api-key",
});

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, code, "utf8");

console.log(`wrote ${outFile}`);
console.log(`operations: ${operations.map((o) => o.functionName).join(", ")}`);
if (warnings.length > 0) {
  console.log(`warnings:\n  ${warnings.join("\n  ")}`);
}
