import { describe, expect, it } from "bun:test";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");

async function listTools(): Promise<string[]> {
  const proc = Bun.spawn(["bun", "run", "src/mcp/index.ts"], {
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
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await proc.stdin.flush();

  const reader = proc.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let tools: string[] = [];
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
        if (msg.id === 2 && msg.result?.tools) {
          tools = (msg.result.tools as { name: string }[]).map((t) => t.name);
        }
      } catch {
        // partial / non-JSON line
      }
    }
    if (tools.length) break;
  }
  proc.kill();
  return tools;
}

describe("sessions MCP server", () => {
  it("registers session query + ingest tools (and preserves existing ones)", async () => {
    const tools = await listTools();
    expect(tools).toContain("search_sessions");
    expect(tools).toContain("search_tool_calls");
    expect(tools).toContain("recent_sessions");
    expect(tools).toContain("list_sessions");
    expect(tools).toContain("get_session");
    expect(tools).toContain("ingest");
    expect(tools).toContain("session_stats");
    // Preserved from the original stub
    expect(tools).toContain("send_feedback");
    expect(tools).toContain("register_agent");
  }, 15000);
});
