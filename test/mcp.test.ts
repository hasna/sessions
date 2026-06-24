import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { closeDatabase, getDatabase, resetDatabase } from "../src/db/database.js";
import { saveParsedSession } from "../src/db/sessions.js";

const repoRoot = join(import.meta.dir, "..");
const TEST_DIR = join(import.meta.dir, ".test-mcp");
const DB_PATH = join(TEST_DIR, "sessions.db");

async function listMcpNames(method: string, resultKey: "tools" | "resources" | "prompts"): Promise<string[]> {
  const proc = Bun.spawn(["bun", "run", "src/mcp/index.ts", "--stdio"], {
    cwd: repoRoot,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SESSIONS_DB_PATH: ":memory:" },
  });

  const enc = new TextEncoder();
  const send = (obj: unknown) => proc.stdin.write(enc.encode(JSON.stringify(obj) + "\n"));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method });
  await proc.stdin.flush();

  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let names: string[] = [];
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id === 2 && msg.result?.[resultKey]) {
          names = (msg.result[resultKey] as { name: string }[]).map((t) => t.name);
        }
      } catch {
        // partial / non-JSON line
      }
    }
    if (names.length) break;
  }
  proc.kill();
  return names;
}

async function listTools(): Promise<string[]> {
  return listMcpNames("tools/list", "tools");
}

async function callMcpTool(name: string, args: Record<string, unknown>, env: Record<string, string>): Promise<unknown> {
  const proc = Bun.spawn(["bun", "run", "src/mcp/index.ts", "--stdio"], {
    cwd: repoRoot,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });

  const enc = new TextEncoder();
  const send = (obj: unknown) => proc.stdin.write(enc.encode(JSON.stringify(obj) + "\n"));
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  await proc.stdin.flush();

  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 10000;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id !== 2) continue;
        if (msg.error) throw new Error(JSON.stringify(msg.error));
        return msg.result;
      }
    }
  } finally {
    proc.kill();
  }
  throw new Error(`MCP tool call timed out: ${name}`);
}

function toolText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  expect(content?.[0]?.text).toBeTruthy();
  return content![0].text!;
}

function seedMcpSession() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.SESSIONS_DB_PATH = DB_PATH;
  process.env.HASNA_SESSIONS_DB_PATH = DB_PATH;
  resetDatabase();
  getDatabase();
  saveParsedSession({
    session: {
      source: "claude",
      source_id: "mcp-compact-session",
      title: "MCP compact fixture",
      project_path: "/tmp/mcp",
      project_name: "mcp",
    },
    messages: Array.from({ length: 30 }, (_, index) => ({
      session_id: "",
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index} ${"x".repeat(1000)}`,
      sequence_num: index,
    })),
    toolCalls: Array.from({ length: 25 }, (_, index) => ({
      session_id: "",
      tool_name: `Tool${index}`,
      tool_input: "i".repeat(1000),
      tool_output: "o".repeat(1000),
    })),
  });
  closeDatabase();
  delete process.env.SESSIONS_DB_PATH;
  delete process.env.HASNA_SESSIONS_DB_PATH;
}

function writeClaudeTranscript(eventCount: number): string {
  const path = join(TEST_DIR, "adapter-session.jsonl");
  writeFileSync(
    path,
    Array.from({ length: eventCount }, (_, index) =>
      JSON.stringify({
        type: "user",
        timestamp: `2026-04-10T10:${String(index).padStart(2, "0")}:00.000Z`,
        cwd: "/tmp/mcp-adapter",
        sessionId: "adapter-compact-session",
        message: { role: "user", content: `event ${index} ${"x".repeat(1000)}` },
      })
    ).join("\n"),
    "utf-8"
  );
  return path;
}

describe("sessions MCP server", () => {
  it("registers session query + ingest tools (and preserves existing ones)", async () => {
    const tools = await listTools();
    expect(tools).toContain("search_sessions");
    expect(tools).toContain("search_tool_calls");
    expect(tools).toContain("recall_session");
    expect(tools).toContain("recent_sessions");
    expect(tools).toContain("list_sessions");
    expect(tools).toContain("get_session");
    expect(tools).toContain("ingest");
    expect(tools).toContain("session_stats");
    expect(tools).toContain("semantic_search");
    expect(tools).toContain("embed");
    expect(tools).toContain("knowledge_graph");
    expect(tools).toContain("machines");
    // Preserved from the original stub
    expect(tools).toContain("send_feedback");
    expect(tools).toContain("register_agent");
  }, 15000);

  it("registers session resources and prompts", async () => {
    const resources = await listMcpNames("resources/list", "resources");
    expect(resources).toContain("sessions_stats");
    expect(resources).toContain("recent_sessions");

    const prompts = await listMcpNames("prompts/list", "prompts");
    expect(prompts).toContain("recall_coding_session");
  }, 15000);

  it("returns compact get_session previews by default and full records on request", async () => {
    seedMcpSession();
    try {
      const env = { SESSIONS_DB_PATH: DB_PATH, HASNA_SESSIONS_DB_PATH: DB_PATH };
      const compact = JSON.parse(toolText(await callMcpTool("get_session", { id: "mcp-compact-session" }, env)));
      expect(compact.counts).toEqual({ messages: 30, tool_calls: 25 });
      expect(compact.messages).toHaveLength(20);
      expect(compact.tool_calls).toHaveLength(20);
      expect(compact.truncated).toEqual({ messages: true, tool_calls: true });
      expect(compact.messages[0].metadata).toBeUndefined();
      expect(compact.messages[0].content.length).toBeLessThanOrEqual(600);
      expect(compact.tool_calls[0].tool_input.length).toBeLessThanOrEqual(600);

      const full = JSON.parse(toolText(await callMcpTool("get_session", { id: "mcp-compact-session", include_full: true }, env)));
      expect(full.messages).toHaveLength(30);
      expect(full.tool_calls).toHaveLength(25);
      expect(full.tool_calls[0].tool_input.length).toBe(1000);

      const graph = JSON.parse(toolText(await callMcpTool("knowledge_graph", { type: "tool", limit: 3 }, env)));
      expect(graph.total).toBe(25);
      expect(graph.returned).toBe(3);
      expect(graph.entities).toHaveLength(3);
      expect(graph.truncated).toBe(true);

      const fullGraph = JSON.parse(toolText(await callMcpTool("knowledge_graph", { type: "tool", include_full: true }, env)));
      expect(fullGraph).toHaveLength(25);
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  }, 15000);

  it("returns compact adapter transcript previews from sessions_read by default", async () => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    try {
      const sessionPath = writeClaudeTranscript(25);
      const env = { CLAUDE_PATH: TEST_DIR };
      const compact = JSON.parse(toolText(await callMcpTool("sessions_read", { adapter_id: "claude", session_path: sessionPath }, env)));
      expect(compact.id).toBe("adapter-compact-session");
      expect(compact.event_count).toBe(25);
      expect(compact.returned_events).toBe(20);
      expect(compact.events).toHaveLength(20);
      expect(compact.truncated).toBe(true);
      expect(compact.events[0].content.length).toBeLessThanOrEqual(600);

      const full = JSON.parse(toolText(await callMcpTool("sessions_read", { adapter_id: "claude", session_path: sessionPath, include_full: true }, env)));
      expect(full.events).toHaveLength(25);
      expect(full.events[0].content.length).toBeGreaterThan(1000);
    } finally {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  }, 15000);
});
