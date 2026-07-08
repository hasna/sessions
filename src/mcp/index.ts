#!/usr/bin/env bun
/**
 * MCP server for sessions.
 * Provides indexed search/ingest tools, friendly-name registry tools, and cross-adapter import.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getPackageInfo, getPackageVersion } from "../lib/package.js";
import { listAdapters, getAdapter } from "../lib/adapters/index.js";
import type { CanonicalSession } from "../lib/adapters/types.js";
import { importCanonicalSessions } from "../lib/adapters/import.js";
import { resolveSessionStore, getLocalStore } from "../db/session-store.js";
import type { Session } from "../types/index.js";

/**
 * Build the underlying resume command for a Store session using its provider
 * and provider-native id. Only claude sessions are resumable this way today.
 */
function buildResumeCommand(session: Session): string[] {
  if (session.source === "claude") {
    return ["claude", "--resume", session.source_id];
  }
  throw new Error(`resume is not supported for source '${session.source}' (only claude)`);
}

// Session-record store seam (SAME resolver the CLI uses). When the client-flip
// resolves to cloud-http — HASNA_SESSIONS_API_URL + HASNA_SESSIONS_API_KEY set
// (self_hosted) — the core session-record read tools (recent/list/get/machines/
// stats/search) route to https://sessions.hasna.xyz/v1 with the bearer key so
// every machine's MCP sees the ONE shared cloud session registry. Env unset =>
// local SQLite index exactly as before (no regression). Analytical/local-only
// tools (ingest, embed, semantic/graph/recall, tool-call search, adapters) have
// no /v1 surface and always operate on the local transcript index.
function sessionStore() {
  return resolveSessionStore();
}

const packageInfo = getPackageInfo();

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: String((e as Error)?.message ?? e) }], isError: true });

function textJson(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function printHelp(): void {
  console.log(`Usage: sessions-mcp [options]

MCP server for ${packageInfo.name}

Options:
  -V, --version  output the version number
  -h, --help     display help for command
  --http         run Streamable HTTP transport on 127.0.0.1 (default port 8877)
  --port <n>     HTTP port (--http or MCP_HTTP=1)

Runs a stdio MCP server with session discovery, resume, search, stats, and feedback tools.`);
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

const _agentReg = new Map<string, { id: string; name: string; last_seen_at: string; project_id?: string }>();

export function buildServer(): McpServer {
  const server = new McpServer({ name: "open-sessions", version: packageInfo.version });

function jsonResource(uri: URL, value: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

server.registerResource(
  "sessions_stats",
  "sessions://stats",
  {
    title: "Session Index Statistics",
    description: "Current ingestion, project, and machine statistics for the local sessions index.",
    mimeType: "application/json",
  },
  async (uri) => {
    const store = sessionStore();
    const [s, machines] = await Promise.all([store.stats(), store.machines()]);
    return jsonResource(uri, { ingestion: s.by_source, projects: s.projects.slice(0, 30), machines });
  }
);

server.registerResource(
  "recent_sessions",
  "sessions://recent",
  {
    title: "Recent Sessions",
    description: "Most recently active indexed sessions.",
    mimeType: "application/json",
  },
  async (uri) => jsonResource(uri, { sessions: await sessionStore().recent(20) })
);

server.registerResource(
  "session_detail",
  new ResourceTemplate("sessions://session/{id}", { list: undefined }),
  {
    title: "Session Detail",
    description: "Indexed session metadata, messages, and tool calls by exact ID or unique prefix.",
    mimeType: "application/json",
  },
  async (uri, variables) => {
    const id = String(variables.id ?? "");
    const store = sessionStore();
    const session = await store.get(id);
    if (!session) return jsonResource(uri, { ok: false, error: `session not found: ${id}` });
    return jsonResource(uri, {
      ok: true,
      session,
      messages: await store.messages(session.id),
      tool_calls: await store.toolCalls(session.id),
    });
  }
);

server.registerPrompt(
  "recall_coding_session",
  {
    title: "Recall Coding Session",
    description: "Build a prompt that asks an agent to recall the most relevant prior coding session with evidence.",
    argsSchema: {
      query: z.string().describe("What to recall, e.g. 'aws deployment example.com'"),
      limit: z.string().optional().describe("Maximum number of sessions to inspect"),
    },
  },
  async (args: { query: string; limit?: string }) => ({
    description: "Use open-sessions recall to find the best prior thread.",
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Use the open-sessions MCP tools to recall prior coding work for this query: ${args.query}\n\nCall recall_session with limit ${args.limit ?? "5"}, inspect the evidence snippets and resume metadata, and answer with the most specific session IDs, project paths, and why each result is relevant.`,
        },
      },
    ],
  })
);

// ─── Agent Tools ────────────────────────────────────────────────────────────

server.tool(
  "register_agent",
  "Register an agent session (idempotent). Auto-updates last_seen_at on re-register.",
  { name: z.string(), session_id: z.string().optional() },
  async (a: { name: string; session_id?: string }) => {
    const existing = [..._agentReg.values()].find(x => x.name === a.name);
    if (existing) { existing.last_seen_at = new Date().toISOString(); return { content: [{ type: "text" as const, text: JSON.stringify(existing) }] }; }
    const id = Math.random().toString(36).slice(2, 10);
    const ag = { id, name: a.name, last_seen_at: new Date().toISOString() };
    _agentReg.set(id, ag);
    return { content: [{ type: "text" as const, text: JSON.stringify(ag) }] };
  }
);

server.tool(
  "heartbeat",
  "Update last_seen_at to signal agent is active.",
  { agent_id: z.string() },
  async (a: { agent_id: string }) => {
    const ag = _agentReg.get(a.agent_id);
    if (!ag) return { content: [{ type: "text" as const, text: `Agent not found: ${a.agent_id}` }], isError: true };
    ag.last_seen_at = new Date().toISOString();
    return { content: [{ type: "text" as const, text: JSON.stringify({ id: ag.id, name: ag.name, last_seen_at: ag.last_seen_at }) }] };
  }
);

server.tool(
  "set_focus",
  "Set active project context for this agent session.",
  { agent_id: z.string(), project_id: z.string().nullable().optional() },
  async (a: { agent_id: string; project_id?: string | null }) => {
    const ag = _agentReg.get(a.agent_id);
    if (!ag) return { content: [{ type: "text" as const, text: `Agent not found: ${a.agent_id}` }], isError: true };
    (ag as any).project_id = a.project_id ?? undefined;
    return { content: [{ type: "text" as const, text: a.project_id ? `Focus: ${a.project_id}` : "Focus cleared" }] };
  }
);

server.tool(
  "list_agents",
  "List all registered agents.",
  {},
  async () => {
    const agents = [..._agentReg.values()];
    if (agents.length === 0) return { content: [{ type: "text" as const, text: "No agents registered." }] };
    return { content: [{ type: "text" as const, text: JSON.stringify(agents, null, 2) }] };
  }
);

// ─── Indexed session query + ingest tools ────────────────────────────────────

server.tool(
  "search_sessions",
  "Full-text search across indexed AI coding sessions (claude/codex/gemini). Returns matching sessions with snippets.",
  {
    query: z.string().describe("Search query"),
    source: z.string().optional().describe("Filter by provider: claude, codex, gemini"),
    project_path: z.string().optional().describe("Filter by project name or path"),
    machine: z.string().optional().describe("Filter by machine (laptop-a, workstation-b, ...)"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async (a: { query: string; source?: string; project_path?: string; machine?: string; limit?: number }) => {
    try {
      return ok(await sessionStore().searchContent(a.query, { source: a.source, project_path: a.project_path, machine: a.machine, limit: a.limit }));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "search_tool_calls",
  "Search tool calls (name/input/output) across sessions — e.g. find where a command was run.",
  {
    query: z.string(),
    source: z.string().optional(),
    limit: z.number().optional(),
  },
  async (a: { query: string; source?: string; limit?: number }) => {
    try {
      return ok(await sessionStore().searchToolCalls(a.query, { source: a.source, limit: a.limit }));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "recall_session",
  "High-level recall for coding threads. Combines FTS, optional semantic search, tool calls, graph context, touched files, evidence snippets, and resume metadata.",
  {
    query: z.string().describe("Natural-language recall query, e.g. 'find the thread where we implemented stripe webhook'"),
    source: z.string().optional().describe("Filter by provider: claude, codex, gemini"),
    project_path: z.string().optional().describe("Filter by project name or path"),
    machine: z.string().optional().describe("Filter by machine"),
    limit: z.number().optional().describe("Max results (default 10)"),
    semantic: z.boolean().optional().describe("Set false to disable semantic/vector recall"),
  },
  async (a: { query: string; source?: string; project_path?: string; machine?: string; limit?: number; semantic?: boolean }) => {
    try {
      return ok(await sessionStore().recall(a.query, {
        source: a.source,
        project_path: a.project_path,
        machine: a.machine,
        limit: a.limit,
        semantic: a.semantic,
      }));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "recent_sessions",
  "List the most recently active sessions across all providers — what's been happening lately.",
  { limit: z.number().optional().describe("Max results (default 20)") },
  async (a: { limit?: number }) => {
    try {
      return ok(await sessionStore().recent(a.limit ?? 20));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "list_sessions",
  "List indexed sessions, optionally filtered by provider or project.",
  {
    source: z.string().optional(),
    project_path: z.string().optional(),
    machine: z.string().optional(),
    limit: z.number().optional(),
  },
  async (a: { source?: string; project_path?: string; machine?: string; limit?: number }) => {
    try {
      return ok(await sessionStore().list({ source: a.source, project_path: a.project_path, machine: a.machine, limit: a.limit }));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "machines",
  "List machines that have contributed sessions, with per-machine session counts.",
  {},
  async () => {
    try {
      return ok(await sessionStore().machines());
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "get_session",
  "Get a session's full details, messages, and tool calls by id or unique id prefix.",
  {
    id: z.string().describe("Session id or unique prefix"),
    message_limit: z.number().optional().describe("Cap messages returned (default all)"),
  },
  async (a: { id: string; message_limit?: number }) => {
    try {
      const store = sessionStore();
      // Everything routes through the Store (LocalStore | ApiStore). The cloud
      // /v1 registry stores session metadata only, so message/tool transcripts
      // come back empty in self_hosted mode (they live on the producing machine).
      const session = await store.get(a.id);
      if (!session) return fail(`Session not found (or ambiguous prefix): ${a.id}`);
      let messages = await store.messages(session.id);
      if (a.message_limit) messages = messages.slice(0, a.message_limit);
      const tool_calls = await store.toolCalls(session.id);
      const note =
        store.mode === "local"
          ? undefined
          : "self_hosted registry: metadata only; message/tool transcripts live on the producing machine's local index";
      return ok(note ? { session, messages, tool_calls, note } : { session, messages, tool_calls });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "ingest",
  "Index session files into the database (mtime-gated). Run before searching to pick up new sessions.",
  {
    source: z.string().optional().describe("Only this provider: claude, codex, gemini"),
    force: z.boolean().optional().describe("Re-ingest unchanged files"),
  },
  async (a: { source?: string; force?: boolean }) => {
    try {
      // Ingest is an on-box index operation (staging source for `sync`), so it
      // always routes through the explicit LocalStore accessor — never a raw
      // db/lib-ingest import in the tool layer.
      const results = await getLocalStore().ingest({ source: a.source, force: a.force });
      return ok(results);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "session_stats",
  "Ingestion and project statistics — per-source counts and top projects by session count.",
  {},
  async () => {
    try {
      const s = await sessionStore().stats();
      return ok({ ingestion: s.by_source, projects: s.projects.slice(0, 30), totals: { session_count: s.session_count, message_count: s.message_count, tool_call_count: s.tool_call_count } });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "semantic_search",
  "Semantic (embedding) search across sessions, or hybrid (full-text + semantic). Requires embeddings (run 'embed') and OPENAI_API_KEY.",
  {
    query: z.string(),
    hybrid: z.boolean().optional().describe("Blend full-text + semantic (RRF)"),
    source: z.string().optional(),
    project_path: z.string().optional(),
    limit: z.number().optional(),
  },
  async (a: { query: string; hybrid?: boolean; source?: string; project_path?: string; limit?: number }) => {
    try {
      const o = { source: a.source, project_path: a.project_path, limit: a.limit };
      const store = sessionStore();
      return ok(a.hybrid ? await store.hybridSearch(a.query, o) : await store.semanticSearch(a.query, o));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "embed",
  "Generate embeddings for indexed messages (enables semantic_search). Needs OPENAI_API_KEY.",
  { limit: z.number().optional().describe("Max messages to embed this run (default 200)") },
  async (a: { limit?: number }) => {
    try {
      return ok(await sessionStore().embed({ limit: a.limit }));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "knowledge_graph",
  "Explore the session knowledge graph: list entities (projects/tools/models/providers/repos), find sessions related to an entity, or a session's entity neighborhood.",
  {
    type: z.enum(["project", "tool", "model", "provider", "repo"]).optional().describe("List entities of this type"),
    related_type: z.enum(["project", "tool", "model", "provider", "repo"]).optional(),
    related_name: z.string().optional().describe("With related_type: sessions linked to this entity"),
    session_id: z.string().optional().describe("A session's entity neighborhood"),
    limit: z.number().optional(),
  },
  async (a: {
    type?: "project" | "tool" | "model" | "provider" | "repo";
    related_type?: "project" | "tool" | "model" | "provider" | "repo";
    related_name?: string;
    session_id?: string;
    limit?: number;
  }) => {
    try {
      const store = sessionStore();
      if (a.session_id) return ok(await store.graphSession(a.session_id));
      if (a.related_type && a.related_name) return ok(await store.graphRelated(a.related_type, a.related_name, a.limit ?? 50));
      return ok(await store.graphEntities(a.type));
    } catch (e) {
      return fail(e);
    }
  }
);

// ─── Session listing / resume / rename tools (Store-backed) ───────────────────
// Every tool below routes through the SAME resolveSessionStore() seam as the
// core query tools: local SQLite index by default, or the shared self_hosted
// /v1 cloud registry when HASNA_SESSIONS_API_URL + HASNA_SESSIONS_API_KEY are
// set. There is no separate on-box friendly-name registry any more (that was the
// split-brain: a second session view that ignored the shared cloud).

server.tool(
  "sessions_list",
  "List sessions from the active store (local index, or the shared self_hosted /v1 registry).",
  { project: z.string().optional(), limit: z.number().int().positive().optional() },
  async (args: { project?: string; limit?: number }) => {
    try {
      return textJson(await sessionStore().list({ project_path: args.project, limit: args.limit }));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "sessions_history",
  "List sessions from the active store with optional today/project/agent filters.",
  {
    project: z.string().optional(),
    today: z.boolean().optional(),
    agent: z.string().optional(),
    limit: z.number().int().positive().optional(),
  },
  async (args: { project?: string; today?: boolean; agent?: string; limit?: number }) => {
    try {
      let sessions = await sessionStore().list({ project_path: args.project, limit: args.limit ?? 200 });
      if (args.today) {
        const today = new Date().toISOString().slice(0, 10);
        sessions = sessions.filter((s) => (s.started_at ?? s.ingested_at ?? "").startsWith(today));
      }
      if (args.agent) {
        const needle = args.agent.toLowerCase();
        sessions = sessions.filter(
          (s) =>
            s.source.toLowerCase().includes(needle) ||
            (s.title ?? "").toLowerCase().includes(needle) ||
            (s.model ?? "").toLowerCase().includes(needle)
        );
      }
      return textJson(sessions);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "sessions_search",
  "Full-text search across indexed session transcripts via the active store.",
  {
    query: z.string(),
    project: z.string().optional(),
    limit: z.number().int().positive().optional(),
  },
  async (args: { query: string; project?: string; limit?: number }) => {
    try {
      return textJson(await sessionStore().searchContent(args.query, { project_path: args.project, limit: args.limit }));
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "sessions_resume",
  "Resolve a session by id/prefix, latest project session, or the most recent session, and return the underlying Claude resume command.",
  {
    identifier: z.string().optional(),
    project: z.string().optional(),
    latest: z.boolean().optional(),
  },
  async (args: { identifier?: string; project?: string; latest?: boolean }) => {
    try {
      const store = sessionStore();
      let session: Session | null = null;
      if (args.project) {
        session = (await store.list({ project_path: args.project, limit: 1 }))[0] ?? null;
      } else if (args.latest || !args.identifier) {
        session = (await store.recent(1))[0] ?? null;
      } else {
        session = await store.get(args.identifier);
      }

      if (!session) {
        return { content: [{ type: "text" as const, text: "No matching session found" }], isError: true };
      }

      return textJson({ session, command: buildResumeCommand(session) });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "sessions_rename",
  "Set a session's title in the active store (local index, or the shared self_hosted /v1 registry).",
  { identifier: z.string(), title: z.string() },
  async (args: { identifier: string; title: string }) => {
    try {
      const title = args.title.trim();
      if (!title) return fail("title cannot be empty");
      const session = await sessionStore().rename(args.identifier, title);
      if (!session) return fail(`session not found (or ambiguous prefix): ${args.identifier}`);
      return textJson(session);
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "sessions_watch",
  "Return the current session snapshot from the active store.",
  { project: z.string().optional() },
  async (args: { project?: string }) => {
    try {
      return textJson({
        generated_at: new Date().toISOString(),
        sessions: await sessionStore().list({ project_path: args.project }),
      });
    } catch (e) {
      return fail(e);
    }
  }
);

server.tool(
  "sessions_stats",
  "Return session counts and a per-source / per-project breakdown from the active store.",
  {},
  async () => {
    try {
      const s = await sessionStore().stats();
      return textJson({
        total_sessions: s.session_count,
        total_messages: s.message_count,
        total_tool_calls: s.tool_call_count,
        by_source: s.by_source,
        projects: s.projects.slice(0, 30),
      });
    } catch (e) {
      return fail(e);
    }
  }
);

// ─── Cross-Adapter Tools ────────────────────────────────────────────────────

server.tool(
  "adapters_list",
  "List all available session adapters (claude, codex, etc.) and whether they are available on this machine.",
  {},
  async () => {
    return textJson(listAdapters());
  }
);

server.tool(
  "sessions_discover_external",
  "Discover sessions from a specific adapter (e.g., codex). Returns session file paths and metadata.",
  {
    adapter_id: z.string().describe("Adapter ID: 'codex', 'claude', etc."),
  },
  async (args: { adapter_id: string }) => {
    const adapter = getAdapter(args.adapter_id);
    if (!adapter) {
      return {
        content: [{ type: "text" as const, text: `Adapter not found: ${args.adapter_id}` }],
        isError: true,
      };
    }
    if (!adapter.isAvailable()) {
      return {
        content: [{ type: "text" as const, text: `${adapter.name} sessions not found on this machine.` }],
        isError: true,
      };
    }
    const files = adapter.discoverSessions();
    const sessions: CanonicalSession[] = [];
    for (const file of files) {
      const parsed = adapter.parseSession(file);
      if (parsed) sessions.push(parsed);
    }
    return textJson({
      adapter: adapter.name,
      adapter_id: adapter.id,
      sessions_dir: adapter.getSessionsDir(),
      count: sessions.length,
      sessions: sessions.map((s) => ({
        id: s.id,
        cwd: s.cwd,
        startedAt: s.startedAt,
        lastActivityAt: s.lastActivityAt,
        model: s.model,
        agentName: s.agentName,
        title: s.title,
        event_count: s.events.length,
        sourcePath: s.sourcePath,
      })),
    });
  }
);

server.tool(
  "sessions_read",
  "Read the full transcript of a session from a specific adapter.",
  {
    adapter_id: z.string().describe("Adapter ID: 'codex', 'claude', etc."),
    session_path: z.string().describe("Full path to the session file."),
  },
  async (args: { adapter_id: string; session_path: string }) => {
    const adapter = getAdapter(args.adapter_id);
    if (!adapter) {
      return {
        content: [{ type: "text" as const, text: `Adapter not found: ${args.adapter_id}` }],
        isError: true,
      };
    }
    const session = adapter.parseSession(args.session_path);
    if (!session) {
      return {
        content: [{ type: "text" as const, text: `Failed to parse session: ${args.session_path}` }],
        isError: true,
      };
    }
    return textJson({
      id: session.id,
      cwd: session.cwd,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
      model: session.model,
      agentName: session.agentName,
      title: session.title,
      source: session.source,
      events: session.events,
    });
  }
);

server.tool(
  "sessions_import",
  "Import sessions from an external adapter (e.g., codex) into Claude Code format so they are readable by all tools.",
  {
    adapter_id: z.string().describe("Source adapter ID: 'codex', etc."),
    session_paths: z.array(z.string()).optional().describe("Specific session file paths to import. Omit to import all."),
    overwrite: z.boolean().optional().describe("Overwrite existing sessions."),
    project: z.string().optional().describe("Only import sessions for this project path."),
    dry_run: z.boolean().optional().describe("Show what would be imported without writing."),
    verbose: z.boolean().optional().describe("Print detailed progress."),
  },
  async (args: {
    adapter_id: string;
    session_paths?: string[];
    overwrite?: boolean;
    project?: string;
    dry_run?: boolean;
    verbose?: boolean;
  }) => {
    const adapter = getAdapter(args.adapter_id);
    if (!adapter) {
      return {
        content: [{ type: "text" as const, text: `Adapter not found: ${args.adapter_id}` }],
        isError: true,
      };
    }
    if (!adapter.isAvailable()) {
      return {
        content: [{ type: "text" as const, text: `${adapter.name} not available on this machine.` }],
        isError: true,
      };
    }

    const files = args.session_paths || adapter.discoverSessions();
    const sessions: CanonicalSession[] = [];
    for (const file of files) {
      const parsed = adapter.parseSession(file);
      if (parsed) sessions.push(parsed);
    }

    const result = importCanonicalSessions(sessions, {
      overwrite: args.overwrite,
      dryRun: args.dry_run,
      verbose: args.verbose,
      projectPath: args.project,
    });

    return textJson({
      adapter: adapter.name,
      sessions_found: sessions.length,
      ...result,
    });
  }
);

  return server;
}

async function main(): Promise<void> {
  const { isMcpStdioMode, parseMcpHttpPort } = await import("./http.js");

  if (isMcpStdioMode(args)) {
    const server = buildServer();
    await server.connect(new StdioServerTransport());
    return;
  }

  // Default: shared Streamable HTTP server (one process per MCP, many agents).
  const { createSessionsServer } = await import("../server/app.js");
  const port = parseMcpHttpPort(args);
  const hostname = "127.0.0.1";
  const server = createSessionsServer({ port, hostname, enableMcp: true });
  console.error(`sessions-mcp HTTP listening on http://${hostname}:${server.port}/mcp`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("MCP server error:", error);
    process.exit(1);
  });
}
