// OpenAPI 3.0 document for sessions-serve. This is the single source of truth
// for the /v1 wire contract and the input to the SDK generator
// (@hasna/contracts/sdk). Keep it in lock-step with app.ts.

import { getPackageInfo } from "../lib/package.js";

const sessionSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    source: { type: "string", enum: ["claude", "codex", "gemini"] },
    source_id: { type: "string" },
    source_path: { type: "string", nullable: true },
    title: { type: "string", nullable: true },
    project_path: { type: "string", nullable: true },
    project_name: { type: "string", nullable: true },
    model: { type: "string", nullable: true },
    model_provider: { type: "string", nullable: true },
    git_branch: { type: "string", nullable: true },
    git_sha: { type: "string", nullable: true },
    git_origin_url: { type: "string", nullable: true },
    cli_version: { type: "string", nullable: true },
    is_subagent: { type: "boolean" },
    parent_session_id: { type: "string", nullable: true },
    total_input_tokens: { type: "integer" },
    total_output_tokens: { type: "integer" },
    total_cache_read_tokens: { type: "integer" },
    total_cache_write_tokens: { type: "integer" },
    total_thinking_tokens: { type: "integer" },
    message_count: { type: "integer" },
    tool_call_count: { type: "integer" },
    started_at: { type: "string", nullable: true },
    ended_at: { type: "string", nullable: true },
    duration_seconds: { type: "number", nullable: true },
    ingested_at: { type: "string" },
    updated_at: { type: "string" },
    source_modified_at: { type: "string", nullable: true },
    machine: { type: "string", nullable: true },
    metadata: { type: "object", additionalProperties: true },
  },
  required: ["id", "source", "source_id", "is_subagent"],
} as const;

const machineSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    hostname: { type: "string", nullable: true },
    platform: { type: "string", nullable: true },
    first_seen_at: { type: "string" },
    last_seen_at: { type: "string" },
    session_count: { type: "integer" },
  },
  required: ["name"],
} as const;

export function buildOpenApiDocument(): Record<string, unknown> {
  const pkg = getPackageInfo();
  return {
    openapi: "3.0.3",
    info: {
      title: "SessionsApi",
      version: pkg.version,
      description: "HTTP API for @hasna/sessions — search and manage AI coding session metadata.",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" },
      },
      schemas: {
        Session: sessionSchema,
        Machine: machineSchema,
        SessionCreate: {
          type: "object",
          properties: {
            id: { type: "string" },
            source: { type: "string", enum: ["claude", "codex", "gemini"] },
            source_id: { type: "string" },
            source_path: { type: "string", nullable: true },
            title: { type: "string", nullable: true },
            project_path: { type: "string", nullable: true },
            project_name: { type: "string", nullable: true },
            model: { type: "string", nullable: true },
            model_provider: { type: "string", nullable: true },
            git_branch: { type: "string", nullable: true },
            git_sha: { type: "string", nullable: true },
            git_origin_url: { type: "string", nullable: true },
            cli_version: { type: "string", nullable: true },
            is_subagent: { type: "boolean" },
            parent_session_id: { type: "string", nullable: true },
            machine: { type: "string", nullable: true },
            started_at: { type: "string", nullable: true },
            ended_at: { type: "string", nullable: true },
            metadata: { type: "object", additionalProperties: true },
          },
          required: ["source", "source_id"],
        },
        HealthResponse: {
          type: "object",
          properties: {
            status: { type: "string" },
            version: { type: "string" },
            mode: { type: "string" },
          },
          required: ["status", "version", "mode"],
        },
        SessionResponse: {
          type: "object",
          properties: { ok: { type: "boolean" }, session: { $ref: "#/components/schemas/Session" } },
          required: ["ok", "session"],
        },
        SessionListResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            count: { type: "integer" },
            sessions: { type: "array", items: { $ref: "#/components/schemas/Session" } },
          },
          required: ["ok", "sessions"],
        },
        SearchResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            query: { type: "string" },
            count: { type: "integer" },
            results: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  session: { $ref: "#/components/schemas/Session" },
                  match: { type: "string" },
                  snippet: { type: "string" },
                },
                required: ["session", "match"],
              },
            },
          },
          required: ["ok", "results"],
        },
        MachinesResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            machines: { type: "array", items: { $ref: "#/components/schemas/Machine" } },
          },
          required: ["ok", "machines"],
        },
        StatsResponse: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            session_count: { type: "integer" },
            message_count: { type: "integer" },
            tool_call_count: { type: "integer" },
            by_source: {
              type: "array",
              items: {
                type: "object",
                properties: { source: { type: "string" }, sessions: { type: "integer" } },
                required: ["source", "sessions"],
              },
            },
            projects: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  project_name: { type: "string", nullable: true },
                  project_path: { type: "string", nullable: true },
                  session_count: { type: "integer" },
                },
                required: ["session_count"],
              },
            },
          },
          required: ["ok", "session_count"],
        },
        DeleteResponse: {
          type: "object",
          properties: { ok: { type: "boolean" }, deleted: { type: "boolean" }, id: { type: "string" } },
          required: ["ok", "deleted"],
        },
        ErrorResponse: {
          type: "object",
          properties: { ok: { type: "boolean" }, error: { type: "string" } },
          required: ["ok", "error"],
        },
      },
    },
    security: [{ ApiKeyAuth: [] }],
    paths: {
      "/health": {
        get: {
          operationId: "getHealth",
          summary: "Liveness probe",
          security: [],
          responses: json200("HealthResponse", "Service is live"),
        },
      },
      "/ready": {
        get: {
          operationId: "getReady",
          summary: "Readiness probe (DB reachable + migrated)",
          security: [],
          responses: {
            ...json200("HealthResponse", "Service is ready"),
            "503": jsonRef("HealthResponse", "Service not ready"),
          },
        },
      },
      "/version": {
        get: {
          operationId: "getVersion",
          summary: "Version + mode",
          security: [],
          responses: json200("HealthResponse", "Version info"),
        },
      },
      "/v1/sessions": {
        get: {
          operationId: "listSessions",
          summary: "List sessions",
          parameters: [
            queryParam("source", "string"),
            queryParam("project", "string"),
            queryParam("machine", "string"),
            queryParam("limit", "integer"),
          ],
          responses: json200("SessionListResponse", "Session list"),
        },
        post: {
          operationId: "createSession",
          summary: "Create or upsert a session",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/SessionCreate" } } },
          },
          responses: {
            "201": jsonRef("SessionResponse", "Created"),
            ...json200("SessionResponse", "Upserted"),
            "400": jsonRef("ErrorResponse", "Invalid input"),
          },
        },
      },
      "/v1/sessions/{id}": {
        get: {
          operationId: "getSession",
          summary: "Get a session by id or id prefix",
          parameters: [pathParam("id")],
          responses: {
            ...json200("SessionResponse", "Session"),
            "404": jsonRef("ErrorResponse", "Not found"),
          },
        },
        delete: {
          operationId: "deleteSession",
          summary: "Delete a session",
          parameters: [pathParam("id")],
          responses: {
            ...json200("DeleteResponse", "Deleted"),
            "404": jsonRef("ErrorResponse", "Not found"),
          },
        },
      },
      "/v1/search": {
        get: {
          operationId: "searchSessions",
          summary: "Search sessions by title/project",
          parameters: [
            queryParam("q", "string", true),
            queryParam("source", "string"),
            queryParam("project", "string"),
            queryParam("machine", "string"),
            queryParam("limit", "integer"),
          ],
          responses: {
            ...json200("SearchResponse", "Search results"),
            "400": jsonRef("ErrorResponse", "Missing query"),
          },
        },
      },
      "/v1/recent": {
        get: {
          operationId: "recentSessions",
          summary: "Most recent sessions",
          parameters: [queryParam("limit", "integer")],
          responses: json200("SessionListResponse", "Recent sessions"),
        },
      },
      "/v1/machines": {
        get: {
          operationId: "listMachines",
          summary: "List known machines",
          responses: json200("MachinesResponse", "Machines"),
        },
      },
      "/v1/stats": {
        get: {
          operationId: "getStats",
          summary: "Aggregate counts",
          responses: json200("StatsResponse", "Stats"),
        },
      },
    },
  };
}

function json200(ref: string, description: string): Record<string, unknown> {
  return { "200": jsonRef(ref, description) };
}

function jsonRef(ref: string, description: string): Record<string, unknown> {
  return {
    description,
    content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } },
  };
}

function queryParam(name: string, type: string, required = false): Record<string, unknown> {
  return { name, in: "query", required, schema: { type } };
}

function pathParam(name: string): Record<string, unknown> {
  return { name, in: "path", required: true, schema: { type: "string" } };
}
