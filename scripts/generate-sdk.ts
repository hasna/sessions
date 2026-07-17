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
const { code: generatedCode, operations, warnings } = generateSdkFromOpenApi(spec, {
  className: "SessionsApi",
  apiKeyHeader: "x-api-key",
});

function addBackwardCompatibleSourceLookupOverloads(code: string): string {
  const sourceQuery = `{ "source"?: string }`;
  let out = code.replace(
    `export class SessionsApi {`,
    `type SourceLookupQuery = ${sourceQuery};

function isRequestInit(value: SourceLookupQuery | RequestInit | undefined): value is RequestInit {
  if (value === undefined) return false;
  return (
    "headers" in value ||
    "signal" in value ||
    "method" in value ||
    "body" in value ||
    "cache" in value ||
    "credentials" in value ||
    "integrity" in value ||
    "keepalive" in value ||
    "mode" in value ||
    "redirect" in value ||
    "referrer" in value ||
    "referrerPolicy" in value ||
    "window" in value
  );
}

function splitSourceLookupArgs(
  queryOrInit?: SourceLookupQuery | RequestInit,
  init?: RequestInit,
): { query?: SourceLookupQuery; init?: RequestInit } {
  return isRequestInit(queryOrInit) ? { init: queryOrInit } : { query: queryOrInit, init };
}

export class SessionsApi {`,
  );

  out = out.replace(
    `    /** Get a session by internal id, source-qualified id, or unique prefix */
    async getSession(id: string, query?: { "source"?: string }, init?: RequestInit): Promise<SessionResponse> {
      return this.request("GET", \`/v1/sessions/\${encodeURIComponent(String(id))}\`, {
        body: undefined,
        query,
        init,
      });
    }`,
    `    /** Get a session by internal id, source-qualified id, or unique prefix */
    async getSession(id: string, init?: RequestInit): Promise<SessionResponse>;
    async getSession(id: string, query?: SourceLookupQuery, init?: RequestInit): Promise<SessionResponse>;
    async getSession(id: string, queryOrInit?: SourceLookupQuery | RequestInit, init?: RequestInit): Promise<SessionResponse> {
      const args = splitSourceLookupArgs(queryOrInit, init);
      return this.request("GET", \`/v1/sessions/\${encodeURIComponent(String(id))}\`, {
        body: undefined,
        query: args.query,
        init: args.init,
      });
    }`,
  );

  out = out.replace(
    `    /** Set a session title */
    async renameSession(id: string, body: { "title": string }, query?: { "source"?: string }, init?: RequestInit): Promise<SessionResponse> {
      return this.request("PATCH", \`/v1/sessions/\${encodeURIComponent(String(id))}\`, {
        body,
        query,
        init,
      });
    }`,
    `    /** Set a session title */
    async renameSession(id: string, body: { "title": string }, init?: RequestInit): Promise<SessionResponse>;
    async renameSession(id: string, body: { "title": string }, query?: SourceLookupQuery, init?: RequestInit): Promise<SessionResponse>;
    async renameSession(id: string, body: { "title": string }, queryOrInit?: SourceLookupQuery | RequestInit, init?: RequestInit): Promise<SessionResponse> {
      const args = splitSourceLookupArgs(queryOrInit, init);
      return this.request("PATCH", \`/v1/sessions/\${encodeURIComponent(String(id))}\`, {
        body,
        query: args.query,
        init: args.init,
      });
    }`,
  );

  out = out.replace(
    `    /** List messages for a session */
    async listSessionMessages(id: string, query?: { "source"?: string }, init?: RequestInit): Promise<MessageListResponse> {
      return this.request("GET", \`/v1/sessions/\${encodeURIComponent(String(id))}/messages\`, {
        body: undefined,
        query,
        init,
      });
    }`,
    `    /** List messages for a session */
    async listSessionMessages(id: string, init?: RequestInit): Promise<MessageListResponse>;
    async listSessionMessages(id: string, query?: SourceLookupQuery, init?: RequestInit): Promise<MessageListResponse>;
    async listSessionMessages(id: string, queryOrInit?: SourceLookupQuery | RequestInit, init?: RequestInit): Promise<MessageListResponse> {
      const args = splitSourceLookupArgs(queryOrInit, init);
      return this.request("GET", \`/v1/sessions/\${encodeURIComponent(String(id))}/messages\`, {
        body: undefined,
        query: args.query,
        init: args.init,
      });
    }`,
  );

  out = out.replace(
    `    /** List tool calls for a session */
    async listSessionToolCalls(id: string, query?: { "source"?: string }, init?: RequestInit): Promise<ToolCallListResponse> {
      return this.request("GET", \`/v1/sessions/\${encodeURIComponent(String(id))}/tool-calls\`, {
        body: undefined,
        query,
        init,
      });
    }`,
    `    /** List tool calls for a session */
    async listSessionToolCalls(id: string, init?: RequestInit): Promise<ToolCallListResponse>;
    async listSessionToolCalls(id: string, query?: SourceLookupQuery, init?: RequestInit): Promise<ToolCallListResponse>;
    async listSessionToolCalls(id: string, queryOrInit?: SourceLookupQuery | RequestInit, init?: RequestInit): Promise<ToolCallListResponse> {
      const args = splitSourceLookupArgs(queryOrInit, init);
      return this.request("GET", \`/v1/sessions/\${encodeURIComponent(String(id))}/tool-calls\`, {
        body: undefined,
        query: args.query,
        init: args.init,
      });
    }`,
  );

  return out;
}

const code = addBackwardCompatibleSourceLookupOverloads(generatedCode);

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, code, "utf8");

console.log(`wrote ${outFile}`);
console.log(`operations: ${operations.map((o) => o.functionName).join(", ")}`);
if (warnings.length > 0) {
  console.log(`warnings:\n  ${warnings.join("\n  ")}`);
}
