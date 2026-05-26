#!/usr/bin/env bun
/**
 * MCP server for sessions.
 * Currently provides feedback tool; will be expanded with relocate/transfer tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SqliteAdapter as Database, registerCloudTools } from "@hasna/cloud";
import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { getPackageInfo, getPackageVersion } from "../lib/package.js";
import { search, searchToolCalls } from "../lib/search.js";
import {
  getRecentSessions,
  listSessions,
  getSessionByPrefix,
  getMessages,
  getToolCalls,
  getProjectStats,
} from "../db/sessions.js";
import { ingestAll, ingestSource } from "../lib/ingest/index.js";
import { getIngestionStats } from "../db/ingestion.js";

const packageInfo = getPackageInfo();

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: String((e as Error)?.message ?? e) }], isError: true });

function printHelp(): void {
  console.log(`Usage: sessions-mcp [options]

MCP server for ${packageInfo.name}

Options:
  -V, --version  output the version number
  -h, --help     display help for command

Runs a stdio MCP server with sessions agent and feedback tools.`);
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

const server = new McpServer({ name: "open-sessions", version: packageInfo.version });

// ─── Agent Tools ────────────────────────────────────────────────────────────

const _agentReg = new Map<string, { id: string; name: string; last_seen_at: string; project_id?: string }>();

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

// ─── Session query + ingest tools ────────────────────────────────────────────

server.tool(
  "search_sessions",
  "Full-text search across indexed AI coding sessions (claude/codex/gemini). Returns matching sessions with snippets.",
  {
    query: z.string().describe("Search query"),
    source: z.string().optional().describe("Filter by provider: claude, codex, gemini"),
    project_path: z.string().optional().describe("Filter by project path"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async (a: { query: string; source?: string; project_path?: string; limit?: number }) => {
    try {
      return ok(search(a.query, { source: a.source, project_path: a.project_path, limit: a.limit }));
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
      return ok(searchToolCalls(a.query, { source: a.source, limit: a.limit }));
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
      return ok(getRecentSessions(a.limit ?? 20));
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
    limit: z.number().optional(),
  },
  async (a: { source?: string; project_path?: string; limit?: number }) => {
    try {
      return ok(listSessions({ source: a.source, project_path: a.project_path, limit: a.limit }));
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
      const session = getSessionByPrefix(a.id);
      if (!session) return fail(`Session not found (or ambiguous prefix): ${a.id}`);
      let messages = getMessages(session.id);
      if (a.message_limit) messages = messages.slice(0, a.message_limit);
      return ok({ session, messages, tool_calls: getToolCalls(session.id) });
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
      const results = a.source
        ? [ingestSource(a.source, { force: a.force })]
        : ingestAll({ force: a.force });
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
      return ok({ ingestion: getIngestionStats(), projects: getProjectStats().slice(0, 30) });
    } catch (e) {
      return fail(e);
    }
  }
);

// ─── Feedback ───────────────────────────────────────────────────────────────

function getFeedbackDb(): Database {
  const home = homedir();
  const dbPath = join(home, ".hasna", "sessions", "sessions.db");
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), message TEXT NOT NULL, email TEXT, category TEXT DEFAULT 'general', version TEXT, machine_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  return db;
}

server.tool(
  "send_feedback",
  "Send feedback about this service",
  { message: z.string(), email: z.string().optional(), category: z.enum(["bug", "feature", "general"]).optional() },
  async (params: { message: string; email?: string; category?: string }) => {
    try {
      const db = getFeedbackDb();
      db.run("INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)", [
        params.message,
        params.email || null,
        params.category || "general",
        packageInfo.version,
      ]);
      db.close();
      return { content: [{ type: "text" as const, text: "Feedback saved. Thank you!" }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: String(e) }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
registerCloudTools(server, "sessions");
await server.connect(transport);
