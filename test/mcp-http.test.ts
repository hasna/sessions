import { describe, expect, it } from "bun:test";
import { createSessionsServer } from "../src/server/app.js";
import { buildServer } from "../src/mcp/index.js";
import { MCP_HTTP_SERVICE_NAME } from "../src/mcp/http.js";

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
      expect(toolNames).toContain("sessions_storage_status");
      expect(toolNames).toContain("sessions_storage_push");
      expect(toolNames).toContain("sessions_storage_pull");
      expect(toolNames).toContain("sessions_storage_sync");
      expect(toolNames).toContain("sessions_storage_feedback");
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
});
