import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../src/lib/adapters/codex.js";

describe("CodexAdapter", () => {
  let tempDir: string;
  let originalCodexHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sessions-codex-adapter-"));
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tempDir;
  });

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = originalCodexHome;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports unavailable storage and discovers only dated JSONL files", () => {
    const adapter = new CodexAdapter();
    const sessionsDir = join(tempDir, "sessions");

    expect(adapter.id).toBe("codex");
    expect(adapter.name).toBe("OpenAI Codex");
    expect(adapter.getSessionsDir()).toBe(sessionsDir);
    expect(adapter.isAvailable()).toBe(false);
    expect(adapter.discoverSessions()).toEqual([]);

    const dayDir = join(sessionsDir, "2026", "07", "30");
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(join(dayDir, "rollout.jsonl"), "{}\n");
    writeFileSync(join(dayDir, "notes.txt"), "ignored");
    writeFileSync(join(sessionsDir, "not-a-year"), "ignored");

    expect(adapter.isAvailable()).toBe(true);
    expect(adapter.discoverSessions()).toEqual([join(dayDir, "rollout.jsonl")]);
  });

  it("normalizes metadata, messages, tools, and reasoning", () => {
    const adapter = new CodexAdapter();
    const filePath = join(tempDir, "rollout.jsonl");
    const timestamp = "2026-07-30T10:00:00.000Z";
    const records = [
      { timestamp, type: "session_meta", payload: { id: "session-1", cwd: "/work/app", agent_nickname: "Scout", agent_role: "explorer", model_provider: "openai" } },
      { timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Find the bug" }] } },
      { timestamp, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Found it" }] } },
      { timestamp, type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "Be precise" }] } },
      { timestamp, type: "response_item", payload: { type: "function_call", name: "read_file", arguments: { path: "src/app.ts" } } },
      { timestamp, type: "response_item", payload: { type: "function_call_output", name: "read_file", output: "contents" } },
      { timestamp, type: "response_item", payload: { type: "reasoning", content: [{ text: "check edge cases" }] } },
    ];
    writeFileSync(filePath, `not json\n${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

    const parsed = adapter.parseSession(filePath);

    expect(parsed).toMatchObject({
      id: "session-1",
      cwd: "/work/app",
      startedAt: timestamp,
      lastActivityAt: timestamp,
      model: "openai",
      title: "Scout (explorer)",
      agentName: "Scout",
      source: "codex",
      sourcePath: filePath,
    });
    expect(parsed?.events).toEqual([
      { type: "user", timestamp, content: "Find the bug" },
      { type: "assistant", timestamp, model: "openai", content: "Found it" },
      { type: "system", timestamp, content: "Be precise" },
      { type: "tool_call", timestamp, model: "openai", toolName: "read_file", content: '{"path":"src/app.ts"}', toolArgs: { path: "src/app.ts" } },
      { type: "tool_result", timestamp, content: "contents", toolName: "read_file", toolResult: "contents" },
      { type: "thinking", timestamp, model: "openai", content: "check edge cases" },
    ]);
  });

  it("derives a UUID from the filename when metadata is absent", () => {
    const adapter = new CodexAdapter();
    const id = "12345678-1234-1234-1234-123456789abc";
    const filePath = join(tempDir, `rollout-2026-07-30-${id}.jsonl`);
    writeFileSync(filePath, JSON.stringify({
      timestamp: "2026-07-30T11:00:00.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    }));

    expect(adapter.parseSession(filePath)).toMatchObject({ id, cwd: "", model: null, title: null });
  });

  it("returns null for missing files and transcripts without events", () => {
    const adapter = new CodexAdapter();
    const emptyPath = join(tempDir, "empty.jsonl");
    writeFileSync(emptyPath, '{"type":"session_meta","payload":{"id":"empty"}}\ninvalid');

    expect(adapter.parseSession(emptyPath)).toBeNull();
    expect(adapter.parseSession(join(tempDir, "missing.jsonl"))).toBeNull();
  });
});
