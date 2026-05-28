import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerCloudTools } from "@hasna/cloud";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const MCP_HTTP_DEFAULT_PORT = 8835;
export const MCP_HTTP_SERVICE_NAME = "sessions";

export function isMcpHttpMode(argv: string[] = process.argv.slice(2)): boolean {
  return argv.includes("--http") || process.env.MCP_HTTP === "1";
}

export function parseMcpHttpPort(argv: string[], defaultPort = MCP_HTTP_DEFAULT_PORT): number {
  const portIdx = argv.indexOf("--port");
  if (portIdx >= 0) {
    const parsed = Number.parseInt(argv[portIdx + 1] ?? "", 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const fromEnv = process.env.MCP_HTTP_PORT;
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return defaultPort;
}

async function connectMcpForNode(): Promise<{
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}> {
  const { buildServer } = await import("./index.js");
  const server = buildServer();
  registerCloudTools(server, MCP_HTTP_SERVICE_NAME);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return { server, transport };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}

export function mcpHealthResponse(): Response {
  return Response.json({ status: "ok", name: MCP_HTTP_SERVICE_NAME });
}

export async function handleMcpHttpFetch(request: Request): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === "/health" && request.method === "GET") {
    return mcpHealthResponse();
  }

  if (url.pathname !== "/mcp") {
    return null;
  }

  const { buildServer } = await import("./index.js");
  const server = buildServer();
  registerCloudTools(server, MCP_HTTP_SERVICE_NAME);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(request);
  response.headers.set("connection", "close");
  transport.close().catch(() => undefined);
  server.close().catch(() => undefined);
  return response;
}

export async function handleMcpHttpNodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", name: MCP_HTTP_SERVICE_NAME }));
    return true;
  }

  if (url.pathname !== "/mcp") {
    return false;
  }

  const { server, transport } = await connectMcpForNode();
  const body = req.method === "POST" ? await readBody(req) : undefined;
  await transport.handleRequest(req, res, body);
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  return true;
}

export async function startSessionsMcpHttpServer(options: {
  port?: number;
  hostname?: string;
} = {}): Promise<ReturnType<typeof createServer>> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? parseMcpHttpPort(process.argv.slice(2));

  const httpServer = createServer(async (req, res) => {
    try {
      const handled = await handleMcpHttpNodeRequest(req, res);
      if (!handled) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, hostname, () => resolve());
  });

  const address = httpServer.address();
  const listenPort = typeof address === "object" && address ? address.port : port;
  console.error(`sessions-mcp HTTP listening on http://${hostname}:${listenPort}/mcp`);
  return httpServer;
}
