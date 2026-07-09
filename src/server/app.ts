import { getPackageInfo } from "../lib/package.js";
import { isCloudMode, getCloudClient } from "../db/cloud/client.js";
import { getDataSource, type ListOptions } from "./data-source.js";
import { getVerifier } from "./auth.js";
import { buildOpenApiDocument } from "./openapi.js";
import { checkHealth } from "../generated/storage-kit/index.js";
import { checkCloudReady } from "../db/cloud/migrate.js";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
};

function json(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), { status, headers: jsonHeaders });
}

const ENDPOINTS = [
  "/health",
  "/ready",
  "/version",
  "/openapi.json",
  "/info",
  "/v1/sessions",
  "/v1/sessions/import",
  "/v1/sessions/:id",
  "/v1/sessions/:id/messages",
  "/v1/sessions/:id/tool-calls",
  "/v1/relocate",
  "/v1/search?q=…",
  "/v1/search/content?q=…",
  "/v1/search/tools?q=…",
  "/v1/graph?type=…|related=type:name|session=id",
  "/v1/recent",
  "/v1/machines",
  "/v1/stats",
];

function intParam(url: URL, name: string, fallback: number): number {
  const v = parseInt(url.searchParams.get(name) ?? "", 10);
  return Number.isFinite(v) ? v : fallback;
}

function listOptionsFromUrl(url: URL, defaultLimit: number): ListOptions {
  const opts: ListOptions = { limit: intParam(url, "limit", defaultLimit) };
  const source = url.searchParams.get("source");
  const project = url.searchParams.get("project");
  const machine = url.searchParams.get("machine");
  if (source) opts.source = source;
  if (project) opts.project_path = project;
  if (machine) opts.machine = machine;
  return opts;
}

/** Serve mode string for the health/version contract. */
function serveMode(): "cloud" | "local" {
  return isCloudMode() ? "cloud" : "local";
}

async function handleV1(url: URL, request: Request): Promise<Response> {
  const source = getDataSource();
  const method = request.method;
  const path = url.pathname;

  // GET /v1/sessions (list) | POST /v1/sessions (create)
  if (path === "/v1/sessions") {
    if (method === "GET") {
      const sessions = await source.list(listOptionsFromUrl(url, 50));
      return json({ ok: true, count: sessions.length, sessions });
    }
    if (method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return json({ ok: false, error: "invalid JSON body" }, 400);
      }
      if (!body || typeof body !== "object") {
        return json({ ok: false, error: "expected a JSON object body" }, 400);
      }
      try {
        const session = await source.create(body as never);
        return json({ ok: true, session }, 201);
      } catch (err) {
        return json({ ok: false, error: (err as Error).message }, 400);
      }
    }
    return json({ ok: false, error: "Method not allowed", allowedMethods: ["GET", "POST"] }, 405);
  }

  // POST /v1/sessions/import — idempotently upsert a session with messages/tool calls.
  if (path === "/v1/sessions/import") {
    if (method !== "POST") {
      return json({ ok: false, error: "Method not allowed", allowedMethods: ["POST"] }, 405);
    }
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return json({ ok: false, error: "invalid JSON body" }, 400);
    }
    if (!body || typeof body !== "object") {
      return json({ ok: false, error: "expected a JSON object body" }, 400);
    }
    if (!Array.isArray(body.messages)) {
      return json({ ok: false, error: "messages must be an array" }, 400);
    }
    if (!Array.isArray(body.toolCalls)) {
      return json({ ok: false, error: "toolCalls must be an array" }, 400);
    }
    try {
      const result = await source.importContent(body as never);
      return json({ ok: true, ...result }, 201);
    } catch (err) {
      return json({ ok: false, error: (err as Error).message }, 400);
    }
  }

  // POST /v1/relocate — rewrite session paths after a project dir move.
  if (path === "/v1/relocate") {
    if (method !== "POST") {
      return json({ ok: false, error: "Method not allowed", allowedMethods: ["POST"] }, 405);
    }
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const oldPath = typeof body?.oldPath === "string" ? body.oldPath : "";
    const newPath = typeof body?.newPath === "string" ? body.newPath : "";
    if (!oldPath || !newPath) {
      return json({ ok: false, error: "oldPath and newPath are required non-empty strings" }, 400);
    }
    try {
      const result = await source.relocatePaths(oldPath, newPath);
      return json({ ok: true, ...result });
    } catch (err) {
      return json({ ok: false, error: (err as Error).message }, 400);
    }
  }

  // /v1/sessions/:id (GET | DELETE)
  if (path.startsWith("/v1/sessions/")) {
    const rest = path.slice("/v1/sessions/".length);
    const parts = rest.split("/");
    const id = decodeURIComponent(parts[0] ?? "");
    if (!id) return json({ ok: false, error: "missing session id" }, 400);
    if (parts.length === 2 && parts[1] === "messages") {
      if (method !== "GET") {
        return json({ ok: false, error: "Method not allowed", allowedMethods: ["GET"] }, 405);
      }
      const session = await source.get(id);
      if (!session) return json({ ok: false, error: `session not found: ${id}` }, 404);
      const messages = await source.messages(session.id);
      return json({ ok: true, count: messages.length, messages });
    }
    if (parts.length === 2 && parts[1] === "tool-calls") {
      if (method !== "GET") {
        return json({ ok: false, error: "Method not allowed", allowedMethods: ["GET"] }, 405);
      }
      const session = await source.get(id);
      if (!session) return json({ ok: false, error: `session not found: ${id}` }, 404);
      const toolCalls = await source.toolCalls(session.id);
      return json({ ok: true, count: toolCalls.length, toolCalls });
    }
    if (parts.length !== 1) {
      return json({ ok: false, error: "Not found", endpoints: ENDPOINTS }, 404);
    }
    if (method === "GET") {
      const session = await source.get(id);
      if (!session) return json({ ok: false, error: `session not found: ${id}` }, 404);
      return json({ ok: true, session });
    }
    if (method === "DELETE") {
      const deleted = await source.remove(id);
      if (!deleted) return json({ ok: false, error: `session not found: ${id}`, deleted: false }, 404);
      return json({ ok: true, deleted: true, id });
    }
    // PATCH /v1/sessions/:id — rename (set the session title).
    if (method === "PATCH") {
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return json({ ok: false, error: "invalid JSON body" }, 400);
      }
      const title = typeof body?.title === "string" ? body.title.trim() : "";
      if (!title) {
        return json({ ok: false, error: "title is required and must be a non-empty string" }, 400);
      }
      const session = await source.rename(id, title);
      if (!session) return json({ ok: false, error: `session not found: ${id}` }, 404);
      return json({ ok: true, session });
    }
    return json({ ok: false, error: "Method not allowed", allowedMethods: ["GET", "PATCH", "DELETE"] }, 405);
  }

  if (method !== "GET") {
    return json({ ok: false, error: "Method not allowed", allowedMethods: ["GET"] }, 405);
  }

  if (path === "/v1/search") {
    const q = url.searchParams.get("q");
    if (!q) return json({ ok: false, error: "missing query param 'q'" }, 400);
    const results = await source.search(q, listOptionsFromUrl(url, 20));
    return json({ ok: true, query: q, count: results.length, results });
  }

  // Full content search (message bodies + metadata), deduped per session.
  if (path === "/v1/search/content") {
    const q = url.searchParams.get("q");
    if (!q) return json({ ok: false, error: "missing query param 'q'" }, 400);
    const results = await source.searchContent(q, listOptionsFromUrl(url, 20));
    return json({ ok: true, query: q, count: results.length, results });
  }

  // Tool-call search (name / input / output).
  if (path === "/v1/search/tools") {
    const q = url.searchParams.get("q");
    if (!q) return json({ ok: false, error: "missing query param 'q'" }, 400);
    const results = await source.searchToolCalls(q, listOptionsFromUrl(url, 20));
    return json({ ok: true, query: q, count: results.length, results });
  }

  // Knowledge graph: ?session=<id> | ?related=<type:name>[&limit] | [?type=<type>]
  if (path === "/v1/graph") {
    const TYPES = ["project", "tool", "model", "provider", "repo"];
    const sessionId = url.searchParams.get("session");
    if (sessionId) {
      const graph = await source.graphSession(sessionId);
      if (!graph) return json({ ok: false, error: `session not found: ${sessionId}` }, 404);
      return json({ ok: true, graph });
    }
    const related = url.searchParams.get("related");
    if (related) {
      const idx = related.indexOf(":");
      const type = idx >= 0 ? related.slice(0, idx) : "";
      const name = idx >= 0 ? related.slice(idx + 1) : "";
      if (!TYPES.includes(type) || !name) {
        return json({ ok: false, error: "related must be <type>:<name> (type: project|tool|model|provider|repo)" }, 400);
      }
      const sessions = await source.graphRelated(type as never, name, intParam(url, "limit", 50));
      return json({ ok: true, count: sessions.length, sessions });
    }
    const type = url.searchParams.get("type");
    if (type && !TYPES.includes(type)) {
      return json({ ok: false, error: `unknown type '${type}' (use: ${TYPES.join(", ")})` }, 400);
    }
    const entities = await source.graphEntities((type as never) ?? undefined);
    return json({ ok: true, count: entities.length, entities });
  }

  if (path === "/v1/recent") {
    const sessions = await source.recent(intParam(url, "limit", 20));
    return json({ ok: true, count: sessions.length, sessions });
  }

  if (path === "/v1/machines") {
    return json({ ok: true, machines: await source.machines() });
  }

  if (path === "/v1/stats") {
    return json({ ok: true, ...(await source.stats()) });
  }

  return json({ ok: false, error: "Not found", endpoints: ENDPOINTS }, 404);
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

      try {
        // --- Health / readiness / version (unauthenticated) ---
        if (url.pathname === "/health") {
          return json({ status: "ok", version: pkg.version, mode: serveMode() });
        }

        if (url.pathname === "/version") {
          return json({ status: "ok", version: pkg.version, mode: serveMode() });
        }

        if (url.pathname === "/ready") {
          if (isCloudMode()) {
            const ready = await checkCloudReady();
            if (!ready.ok) {
              return json(
                {
                  status: "not_ready",
                  version: pkg.version,
                  mode: "cloud",
                  pendingMigrations: ready.pendingMigrations,
                  error: ready.error ?? null,
                },
                503,
              );
            }
            return json({ status: "ready", version: pkg.version, mode: "cloud" });
          }
          return json({ status: "ready", version: pkg.version, mode: "local" });
        }

        if (url.pathname === "/openapi.json") {
          return json(buildOpenApiDocument());
        }

        // --- Package info (unauthenticated; no session content) ---
        if (url.pathname === "/" || url.pathname === "/info") {
          return json({
            ok: true,
            name: pkg.name,
            version: pkg.version,
            description: pkg.description,
            mode: serveMode(),
            endpoints: ENDPOINTS,
          });
        }

        // --- Authenticated versioned API ---
        if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
          const verifier = getVerifier();
          if (!verifier) {
            return json(
              {
                ok: false,
                error:
                  "API auth not configured: set HASNA_SESSIONS_API_SIGNING_KEY (or HASNA_API_SIGNING_KEY).",
              },
              503,
            );
          }
          const requiredScopes =
            request.method === "GET" ? ["sessions:read"] : ["sessions:write"];
          const decision = await verifier.authenticate(request.headers, {
            method: request.method,
            path: url.pathname,
            requiredScopes,
          });
          if (!decision.ok) {
            return json({ ok: false, error: decision.message, reason: decision.reason }, decision.status);
          }
          return await handleV1(url, request);
        }

        return json({ ok: false, error: "Not found", endpoints: ENDPOINTS }, 404);
      } catch (err) {
        return json({ ok: false, error: (err as Error).message }, 500);
      }
    },
  });
}

/**
 * Bootstrap async prerequisites. In cloud mode the api_keys table is created by
 * the owner-run migration (0002), NOT here — the request-path app role has DML
 * rights only. We prime the verifier so a signing-key misconfiguration surfaces
 * at boot rather than per-request.
 */
export async function bootstrapServer(): Promise<void> {
  getVerifier();
}

/** Health probe used by the CLI/`/ready` path. */
export async function probeCloudHealth() {
  return checkHealth(getCloudClient());
}
