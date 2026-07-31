import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeAdapter,
  CodexAdapter,
  autoDetectAdapters,
  getAdapter,
  listAdapters,
  registerAdapter,
} from "../src/lib/adapters/index.js";
import { importCanonicalSessions } from "../src/lib/adapters/import.js";
import type { CanonicalSession, SessionAdapter } from "../src/lib/adapters/types.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sessions-adapters-"));
  process.env.CLAUDE_PATH = join(root, "claude");
  process.env.CODEX_HOME = join(root, "codex");
});

afterEach(() => {
  delete process.env.CLAUDE_PATH;
  delete process.env.CODEX_HOME;
  rmSync(root, { recursive: true, force: true });
});

describe("ClaudeAdapter", () => {
  it("reports availability, session directory, and discovers direct and subagent transcripts", () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.id).toBe("claude");
    expect(adapter.name).toBe("Claude Code");
    expect(adapter.isAvailable()).toBe(false);
    expect(adapter.discoverSessions()).toEqual([]);

    const projects = join(root, "claude", "projects");
    const project = join(projects, "-work-app");
    const subagent = join(project, "subagents");
    mkdirSync(subagent, { recursive: true });
    writeFileSync(join(project, "main.jsonl"), "{}");
    writeFileSync(join(project, "ignore.txt"), "x");
    writeFileSync(join(subagent, "child.jsonl"), "{}");
    writeFileSync(join(subagent, "child.txt"), "x");
    writeFileSync(join(projects, "regular-file"), "x");
    symlinkSync(join(root, "missing-top"), join(projects, "dangling"));
    symlinkSync(join(root, "missing-child"), join(project, "dangling"));

    expect(adapter.isAvailable()).toBe(true);
    expect(adapter.getSessionsDir()).toBe(projects);
    expect(adapter.discoverSessions().sort()).toEqual([
      join(project, "main.jsonl"),
      join(subagent, "child.jsonl"),
    ].sort());
  });

  it("parses metadata and every canonical event variant while ignoring malformed input", () => {
    const file = join(root, "claude-session.jsonl");
    writeFileSync(file, [
      "not-json",
      JSON.stringify({ type: "custom-title", customTitle: "My task", timestamp: "2026-01-01T00:00:00Z", cwd: "/work/app", sessionId: "claude-1" }),
      JSON.stringify({ type: "agent-name", agentName: "helper", timestamp: "2026-01-01T00:00:01Z" }),
      JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:02Z", message: { content: "hello" } }),
      JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:03Z", message: { content: [{ type: "text", text: "structured" }] } }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T00:00:04Z",
        message: {
          model: "claude-test",
          content: [
            { type: "thinking", thinking: "reason" },
            { type: "text", text: "answer" },
            { type: "tool_use", id: "tool-1", name: "Read", input: { file: "a" } },
            { type: "tool_use", id: "tool-2", name: "Empty" },
            { type: "text", text: "" },
          ],
        },
      }),
      JSON.stringify({ type: "ignored", timestamp: "invalid" }),
    ].join("\n"));

    const session = new ClaudeAdapter().parseSession(file)!;
    expect(session).toMatchObject({
      id: "claude-1",
      cwd: "/work/app",
      model: "claude-test",
      title: "My task",
      agentName: "helper",
      source: "claude",
      sourcePath: file,
      startedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:04.000Z",
    });
    expect(session.events.map((event) => event.type)).toEqual(["user", "user", "thinking", "assistant", "tool_call", "tool_call"]);
    expect(session.events[1].content).toContain("structured");
    expect(session.events.at(-1)?.content).toBe("{}");
  });

  it("derives ids and timestamps, returns null for empty/unreadable files", () => {
    const file = join(root, "derived.jsonl");
    writeFileSync(file, JSON.stringify({ type: "user", message: { content: "hello" } }));
    const before = Date.now();
    const session = new ClaudeAdapter().parseSession(file)!;
    expect(session.id).toBe("derived");
    expect(new Date(session.startedAt).getTime()).toBeGreaterThanOrEqual(before);
    expect(session.lastActivityAt).toBeTruthy();

    const empty = join(root, "empty.jsonl");
    writeFileSync(empty, "{}\ninvalid");
    expect(new ClaudeAdapter().parseSession(empty)).toBeNull();
    expect(new ClaudeAdapter().parseSession(join(root, "missing.jsonl"))).toBeNull();
  });
});

describe("CodexAdapter", () => {
  it("reports availability and discovers only date-foldered JSONL files", () => {
    const adapter = new CodexAdapter();
    expect(adapter.id).toBe("codex");
    expect(adapter.name).toBe("OpenAI Codex");
    expect(adapter.isAvailable()).toBe(false);
    expect(adapter.discoverSessions()).toEqual([]);

    const sessions = join(root, "codex", "sessions");
    const day = join(sessions, "2026", "07", "29");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout.jsonl"), "{}");
    writeFileSync(join(day, "ignore.txt"), "x");
    writeFileSync(join(sessions, "not-a-year"), "x");
    writeFileSync(join(sessions, "2026", "not-a-month"), "x");
    writeFileSync(join(sessions, "2026", "07", "not-a-day"), "x");
    symlinkSync(join(root, "missing-year"), join(sessions, "dangling"));
    symlinkSync(join(root, "missing-month"), join(sessions, "2026", "dangling"));
    symlinkSync(join(root, "missing-day"), join(sessions, "2026", "07", "dangling"));

    expect(adapter.isAvailable()).toBe(true);
    expect(adapter.getSessionsDir()).toBe(sessions);
    expect(adapter.discoverSessions()).toEqual([join(day, "rollout.jsonl")]);

    rmSync(sessions, { recursive: true, force: true });
    writeFileSync(sessions, "not a directory");
    expect(adapter.discoverSessions()).toEqual([]);
  });

  it("parses messages, tool calls/results, reasoning, metadata, and malformed records", () => {
    const file = join(root, "rollout.jsonl");
    writeFileSync(file, [
      "bad-json",
      JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type: "session_meta", payload: { id: "codex-1", cwd: "/work/api", agent_nickname: "Ada", agent_role: "reviewer", model_provider: "openai" } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "question" }, { type: "other" }] } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:02Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:03Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "instructions" }] } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:04Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{\"cmd\":\"test\"}" } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:05Z", type: "response_item", payload: { name: "write", arguments: { path: "a" } } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:06Z", type: "response_item", payload: { type: "function_call_output", name: "shell", output: "ok" } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:07Z", type: "response_item", payload: { name: "empty", output: "" } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:08Z", type: "response_item", payload: { type: "reasoning", content: [{ text: "think" }] } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:09Z", type: "response_item", payload: { type: "message", role: "other", content: [], parsed: { reasoning: true } } }),
      JSON.stringify({ timestamp: "invalid", type: "ignored" }),
    ].join("\n"));

    const session = new CodexAdapter().parseSession(file)!;
    expect(session).toMatchObject({
      id: "codex-1",
      cwd: "/work/api",
      model: "openai",
      title: "Ada (reviewer)",
      agentName: "Ada",
      source: "codex",
      startedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:09.000Z",
    });
    expect(session.events.map((event) => event.type)).toEqual([
      "user", "assistant", "system", "tool_call", "tool_call", "tool_result", "tool_result", "thinking", "thinking",
    ]);
    expect(session.events[3].toolArgs).toBeUndefined();
    expect(session.events[4].toolArgs).toEqual({ path: "a" });
    expect(session.events[6].content).toContain("empty");
  });

  it("derives UUID and fallback ids and returns null for empty or unreadable files", () => {
    const uuid = "12345678-1234-1234-1234-123456789abc";
    const uuidFile = join(root, `rollout-time-${uuid}.jsonl`);
    writeFileSync(uuidFile, JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } }));
    expect(new CodexAdapter().parseSession(uuidFile)?.id).toBe(uuid);

    const fallback = join(root, "rollout-fallback.jsonl");
    writeFileSync(fallback, JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "x", arguments: {} } }));
    expect(new CodexAdapter().parseSession(fallback)?.id).toBe("rollout-fallback");

    const empty = join(root, "empty.jsonl");
    writeFileSync(empty, "{}\ninvalid");
    expect(new CodexAdapter().parseSession(empty)).toBeNull();
    expect(new CodexAdapter().parseSession(join(root, "missing.jsonl"))).toBeNull();
  });
});

describe("adapter registry and canonical import", () => {
  it("gets, lists, detects, and replaces adapters", () => {
    const id = `test-${Date.now()}`;
    const adapter: SessionAdapter = {
      id,
      name: "Test",
      isAvailable: () => true,
      discoverSessions: () => [],
      parseSession: () => null,
      getSessionsDir: () => root,
    };
    registerAdapter(id, adapter);
    expect(getAdapter(id)).toBe(adapter);
    expect(getAdapter("missing-adapter")).toBeUndefined();
    expect(listAdapters()).toContainEqual({ id, available: true });
    expect(autoDetectAdapters()).toContain(adapter);

    const unavailable = { ...adapter, isAvailable: () => false };
    registerAdapter(id, unavailable);
    expect(autoDetectAdapters()).not.toContain(unavailable);
  });

  it("imports every event type, metadata, defaults, filtering, dry-run, skip, and overwrite", () => {
    const projects = join(root, "claude", "projects");
    const session: CanonicalSession = {
      id: "session-1",
      cwd: "/work/app",
      startedAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:01:00Z",
      model: "model-default",
      title: "Imported task",
      agentName: "importer",
      source: "codex",
      sourcePath: "/source/session.jsonl",
      events: [
        { type: "user", timestamp: "2026-01-01T00:00:00Z", content: "hello" },
        { type: "assistant", timestamp: "2026-01-01T00:00:01Z", content: "answer" },
        { type: "thinking", timestamp: "2026-01-01T00:00:02Z", content: "thought", model: "event-model" },
        { type: "tool_call", timestamp: "2026-01-01T00:00:03Z", content: "", toolName: "Read", toolArgs: { file: "a" } },
        { type: "tool_result", timestamp: "2026-01-01T00:00:04Z", content: "contents", toolName: "Read" },
        { type: "system", timestamp: "2026-01-01T00:00:05Z", content: "context" },
      ],
    };

    expect(importCanonicalSessions([session], { projectPath: "/other", dryRun: true })).toEqual({ imported: 0, skipped: 0, errors: [] });
    expect(importCanonicalSessions([session], { dryRun: true, verbose: true })).toEqual({ imported: 1, skipped: 0, errors: [] });
    expect(() => readFileSync(join(projects, "-work-app", "session-1.jsonl"))).toThrow();

    expect(importCanonicalSessions([session], { verbose: true })).toEqual({ imported: 1, skipped: 0, errors: [] });
    const destination = join(projects, "-work-app", "session-1.jsonl");
    const records = readFileSync(destination, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.map((record) => record.type)).toEqual([
      "header", "user", "assistant", "assistant", "assistant", "assistant", "assistant", "custom-title", "agent-name",
    ]);
    expect(records[2].message.model).toBe("model-default");
    expect(records[3].message.model).toBe("event-model");
    expect(records[4].message.content[0]).toMatchObject({ type: "tool_use", name: "Read", input: { file: "a" } });
    expect(records[5].message.content[0].text).toContain("[Tool: Read]");
    expect(records[6].message.content[0].text).toContain("[System context]");

    expect(importCanonicalSessions([session], { verbose: true })).toEqual({ imported: 0, skipped: 1, errors: [] });
    expect(importCanonicalSessions([session], { overwrite: true })).toEqual({ imported: 1, skipped: 0, errors: [] });
  });

  it("uses fallback cwd, model, tool metadata, and omits optional records", () => {
    const session: CanonicalSession = {
      id: "fallback",
      cwd: "",
      startedAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:01:00Z",
      model: null,
      title: null,
      agentName: null,
      source: "codex",
      sourcePath: "source",
      events: [
        { type: "assistant", timestamp: "2026-01-01T00:00:00Z", content: "a" },
        { type: "thinking", timestamp: "2026-01-01T00:00:01Z", content: "b" },
        { type: "tool_call", timestamp: "2026-01-01T00:00:02Z", content: "" },
        { type: "tool_result", timestamp: "2026-01-01T00:00:03Z", content: "c" },
      ],
    };
    expect(importCanonicalSessions([session])).toMatchObject({ imported: 1 });
    const records = readFileSync(join(root, "claude", "projects", "fallback.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    expect(records[0].cwd).toBe("/tmp");
    expect(records[1].message.model).toBe("claude-sonnet-4-6");
    expect(records[3].message.content[0]).toMatchObject({ name: "unknown", input: {} });
    expect(records[4].message.content[0].text).toContain("[Tool: unknown]");
    expect(records.some((record) => record.type === "custom-title")).toBe(false);
  });
});
