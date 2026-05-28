import { getPackageInfo } from "../lib/package.js";
import { search, searchToolCalls } from "../lib/search.js";
import {
  getRecentSessions,
  listSessions,
  getSessionByPrefix,
  getMessages,
  getToolCalls,
  getProjectStats,
} from "../db/sessions.js";
import { getIngestionStats } from "../db/ingestion.js";
import { listMachines } from "../db/machines.js";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
};

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), { status, headers: jsonHeaders });
}

const ENDPOINTS = [
  "/health",
  "/info",
  "/search?q=…",
  "/tool-calls?q=…",
  "/recent",
  "/list",
  "/sessions/:id",
  "/stats",
  "/machines",
];

function intParam(url: URL, name: string, fallback: number): number {
  const v = parseInt(url.searchParams.get(name) ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
}

export function createSessionsServer(options: {
  port?: number;
  hostname?: string;
  enableMcp?: boolean;
} = {}) {
  const pkg = getPackageInfo();
  const hostname = options.hostname ?? process.env.HOST ?? "127.0.0.1";
  const port = Number.isFinite(options.port)
    ? options.port
    : Number.parseInt(process.env.PORT || "3456", 10);

  return Bun.serve({
    hostname,
    port: Number.isFinite(port) ? port : 3456,
    async fetch(request) {
      if (options.enableMcp) {
        const { handleMcpHttpFetch } = await import("../mcp/http.js");
        const mcpResponse = await handleMcpHttpFetch(request);
        if (mcpResponse) return mcpResponse;
      }

      const url = new URL(request.url);

      if (request.method !== "GET") {
        return json({ ok: false, error: "Method not allowed", allowedMethods: ["GET"] }, 405);
      }

      try {
        if (url.pathname === "/" || url.pathname === "/info") {
          return json({ ok: true, name: pkg.name, version: pkg.version, description: pkg.description, endpoints: ENDPOINTS });
        }

        if (url.pathname === "/health") {
          return json({ ok: true, service: pkg.name, version: pkg.version });
        }

        if (url.pathname === "/search") {
          const q = url.searchParams.get("q");
          if (!q) return json({ ok: false, error: "missing query param 'q'" }, 400);
          const results = search(q, {
            source: url.searchParams.get("source") ?? undefined,
            project_path: url.searchParams.get("project") ?? undefined,
            machine: url.searchParams.get("machine") ?? undefined,
            limit: intParam(url, "limit", 20),
          });
          return json({ ok: true, query: q, count: results.length, results });
        }

        if (url.pathname === "/tool-calls") {
          const q = url.searchParams.get("q");
          if (!q) return json({ ok: false, error: "missing query param 'q'" }, 400);
          const results = searchToolCalls(q, {
            source: url.searchParams.get("source") ?? undefined,
            limit: intParam(url, "limit", 20),
          });
          return json({ ok: true, query: q, count: results.length, results });
        }

        if (url.pathname === "/recent") {
          return json({ ok: true, sessions: getRecentSessions(intParam(url, "limit", 20)) });
        }

        if (url.pathname === "/list") {
          return json({
            ok: true,
            sessions: listSessions({
              source: url.searchParams.get("source") ?? undefined,
              project_path: url.searchParams.get("project") ?? undefined,
              machine: url.searchParams.get("machine") ?? undefined,
              limit: intParam(url, "limit", 50),
            }),
          });
        }

        if (url.pathname === "/machines") {
          return json({ ok: true, machines: listMachines() });
        }

        if (url.pathname === "/stats") {
          return json({ ok: true, ingestion: getIngestionStats(), projects: getProjectStats().slice(0, 30) });
        }

        if (url.pathname.startsWith("/sessions/")) {
          const id = decodeURIComponent(url.pathname.slice("/sessions/".length));
          const session = getSessionByPrefix(id);
          if (!session) return json({ ok: false, error: `session not found: ${id}` }, 404);
          return json({
            ok: true,
            session,
            messages: getMessages(session.id),
            tool_calls: getToolCalls(session.id),
          });
        }

        return json({ ok: false, error: "Not found", endpoints: ENDPOINTS }, 404);
      } catch (err) {
        return json({ ok: false, error: (err as Error).message }, 500);
      }
    },
  });
}
