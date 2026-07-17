import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionsServer } from "../src/server/app.js";
import { buildServer } from "../src/mcp/index.js";
import { MCP_HTTP_SERVICE_NAME } from "../src/mcp/http.js";
import { closeDatabase, getDatabase, resetDatabase } from "../src/db/database.js";
import { getSessionBySource, upsertSession } from "../src/db/sessions.js";

async function startHttpServer() {
  const server = createSessionsServer({
    port: 0,
    hostname: "127.0.0.1",
    enableMcp: true,
  });
  return { server, baseUrl: `http://127.0.0.1:${server.port}` };
}

async function mcpInitialize(baseUrl: string) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      },
    }),
  });

  expect(response.status).toBe(200);
  return response.json() as Promise<{ result?: { protocolVersion?: string } }>;
}

async function mcpToolCall(baseUrl: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ result?: { isError?: boolean; content?: Array<{ text?: string }> } }>;
}

describe("sessions MCP HTTP transport", () => {
  it("buildServer returns a server with tools registered", () => {
    const server = buildServer();
    expect(server).toBeDefined();
  });

  it("GET /health returns ok", async () => {
    const { server, baseUrl } = await startHttpServer();
    try {
      const response = await fetch(`${baseUrl}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok", name: MCP_HTTP_SERVICE_NAME });
    } finally {
      server.stop(true);
    }
  });

  it("POST /mcp initialize + tools/list round-trip", async () => {
    const { server, baseUrl } = await startHttpServer();
    try {
      const init = await mcpInitialize(baseUrl);
      expect(init.result?.protocolVersion).toBeDefined();

      const listResponse = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      });

      expect(listResponse.status).toBe(200);
      const listPayload = await listResponse.json() as {
        result?: { tools?: Array<{ name: string }> };
      };
      const toolNames = (listPayload.result?.tools ?? []).map((tool) => tool.name);
      expect(toolNames).toContain("search_sessions");
      expect(toolNames).toContain("register_agent");
      // DSN-on-client storage sync tools were removed in the Store refactor.
      expect(toolNames).not.toContain("sessions_storage_push");
      expect(toolNames).not.toContain("sessions_storage_pull");
      expect(toolNames).not.toContain("sessions_storage_sync");
      expect(toolNames.some((name) => name.toLowerCase().includes("cloud"))).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  it("serves multiple concurrent MCP clients from one process", async () => {
    const { server, baseUrl } = await startHttpServer();
    try {
      const results = await Promise.all([
        mcpInitialize(baseUrl),
        mcpInitialize(baseUrl),
        mcpInitialize(baseUrl),
      ]);
      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result.result?.protocolVersion).toBeDefined();
      }
    } finally {
      server.stop(true);
    }
  });

  it("rejects empty source-qualified MCP rename targets without renaming the sole session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-mcp-empty-source-"));
    process.env.SESSIONS_DB_PATH = join(dir, "sessions.db");
    const oldApiUrl = process.env.HASNA_SESSIONS_API_URL;
    const oldApiKey = process.env.HASNA_SESSIONS_API_KEY;
    const oldMode = process.env.HASNA_SESSIONS_MODE;
    process.env.HASNA_SESSIONS_API_URL = "";
    process.env.HASNA_SESSIONS_API_KEY = "";
    process.env.HASNA_SESSIONS_MODE = "";
    resetDatabase();
    getDatabase();
    upsertSession({ source: "codewith", source_id: "sole-session", title: "Original title" });

    const { server, baseUrl } = await startHttpServer();
    try {
      await mcpInitialize(baseUrl);
      const result = await mcpToolCall(baseUrl, "sessions_rename", {
        identifier: "codewith:",
        title: "Should not apply",
      });
      expect(result.result?.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(
        "source-qualified identifiers must include a non-empty source id",
      );
      expect(getSessionBySource("codewith", "sole-session")?.title).toBe("Original title");
    } finally {
      server.stop(true);
      closeDatabase();
      resetDatabase();
      delete process.env.SESSIONS_DB_PATH;
      if (oldApiUrl === undefined) delete process.env.HASNA_SESSIONS_API_URL;
      else process.env.HASNA_SESSIONS_API_URL = oldApiUrl;
      if (oldApiKey === undefined) delete process.env.HASNA_SESSIONS_API_KEY;
      else process.env.HASNA_SESSIONS_API_KEY = oldApiKey;
      if (oldMode === undefined) delete process.env.HASNA_SESSIONS_MODE;
      else process.env.HASNA_SESSIONS_MODE = oldMode;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
