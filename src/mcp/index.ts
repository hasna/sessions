#!/usr/bin/env bun
/**
 * MCP server for sessions.
 * Provides session discovery, search, resume resolution, stats, and feedback tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { SqliteAdapter as Database, registerCloudTools } from "@hasna/cloud";
import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { getPackageInfo, getPackageVersion } from "../lib/package.js";
import {
  buildClaudeResumeCommand,
  findSession,
  historySessions,
  latestSession,
  latestSessionForProject,
  listSessions,
  renameSession,
  searchSessions,
} from "../lib/sessions.js";
import {
  listAdapters,
  getAdapter,
  autoDetectAdapters,
} from "../lib/adapters/index.js";
import type { CanonicalSession } from "../lib/adapters/types.js";
import { importCanonicalSessions } from "../lib/adapters/import.js";

const packageInfo = getPackageInfo();

function printHelp(): void {
  console.log(`Usage: sessions-mcp [options]

MCP server for ${packageInfo.name}

Options:
  -V, --version  output the version number
  -h, --help     display help for command

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

const server = new McpServer({ name: "open-sessions", version: packageInfo.version });

function textJson(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

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

server.tool(
  "sessions_list",
  "List known sessions with friendly names and metadata.",
  { project: z.string().optional() },
  async (args: { project?: string }) => {
    return textJson(listSessions({ project: args.project }));
  }
);

server.tool(
  "sessions_history",
  "List historical sessions with optional today/project/agent filters.",
  {
    project: z.string().optional(),
    today: z.boolean().optional(),
    agent: z.string().optional(),
  },
  async (args: { project?: string; today?: boolean; agent?: string }) => {
    return textJson(
      historySessions({
        project: args.project,
        today: args.today,
        agent: args.agent,
      })
    );
  }
);

server.tool(
  "sessions_search",
  "Search session transcripts by text query.",
  {
    query: z.string(),
    project: z.string().optional(),
    limit: z.number().int().positive().optional(),
  },
  async (args: { query: string; project?: string; limit?: number }) => {
    return textJson(
      searchSessions(args.query, {
        project: args.project,
        limit: args.limit,
      })
    );
  }
);

server.tool(
  "sessions_resume",
  "Resolve a session by friendly name, session ID, or latest project session and return the underlying Claude resume command.",
  {
    identifier: z.string().optional(),
    project: z.string().optional(),
    latest: z.boolean().optional(),
  },
  async (args: { identifier?: string; project?: string; latest?: boolean }) => {
    let session = null;
    if (args.project) {
      session = latestSessionForProject(args.project);
    } else if (args.latest || !args.identifier) {
      session = latestSession();
    } else {
      session = findSession(args.identifier);
    }

    if (!session) {
      return {
        content: [{ type: "text" as const, text: "No matching session found" }],
        isError: true,
      };
    }

    return textJson({
      session,
      command: buildClaudeResumeCommand(session),
    });
  }
);

server.tool(
  "sessions_rename",
  "Assign a manual friendly name to a session.",
  { identifier: z.string(), friendly_name: z.string() },
  async (args: { identifier: string; friendly_name: string }) => {
    try {
      return textJson(renameSession(args.identifier, args.friendly_name));
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: String(error) }],
        isError: true,
      };
    }
  }
);

server.tool(
  "sessions_watch",
  "Return the current watch snapshot for known sessions.",
  { project: z.string().optional() },
  async (args: { project?: string }) => {
    return textJson({
      generated_at: new Date().toISOString(),
      sessions: listSessions({ project: args.project }),
    });
  }
);

server.tool(
  "sessions_stats",
  "Return session counts and high-level activity breakdown.",
  { project: z.string().optional() },
  async (args: { project?: string }) => {
    const sessions = listSessions({ project: args.project });
    const active = sessions.filter((session) => session.status === "active").length;
    const idle = sessions.length - active;
    const projectCounts = sessions.reduce<Record<string, number>>((acc, session) => {
      acc[session.projectSlug] = (acc[session.projectSlug] ?? 0) + 1;
      return acc;
    }, {});

    return textJson({
      total_sessions: sessions.length,
      active_sessions: active,
      idle_sessions: idle,
      project_counts: projectCounts,
    });
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
      updateRegistry: true,
    });

    return textJson({
      adapter: adapter.name,
      sessions_found: sessions.length,
      ...result,
    });
  }
);

const transport = new StdioServerTransport();
registerCloudTools(server, "sessions");
await server.connect(transport);
