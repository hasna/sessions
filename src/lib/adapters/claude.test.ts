import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ClaudeAdapter } from "./claude.js";

let tempDir: string;
let originalClaudePath: string | undefined;

beforeEach(() => {
  originalClaudePath = process.env.CLAUDE_PATH;
  tempDir = mkdtempSync(join(tmpdir(), "sessions-claude-adapter-test-"));
  process.env.CLAUDE_PATH = join(tempDir, "claude");
});

afterEach(() => {
  if (originalClaudePath === undefined) delete process.env.CLAUDE_PATH;
  else process.env.CLAUDE_PATH = originalClaudePath;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ClaudeAdapter", () => {
  it("reports availability and its configured sessions directory", () => {
    const adapter = new ClaudeAdapter();
    const projectsDir = join(process.env.CLAUDE_PATH!, "projects");

    expect(adapter.id).toBe("claude");
    expect(adapter.name).toBe("Claude Code");
    expect(adapter.getSessionsDir()).toBe(projectsDir);
    expect(adapter.isAvailable()).toBe(false);

    mkdirSync(projectsDir, { recursive: true });
    expect(adapter.isAvailable()).toBe(true);
  });

  it("discovers direct and subagent JSONL files while ignoring other entries", () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.discoverSessions()).toEqual([]);

    const projectsDir = adapter.getSessionsDir();
    const projectDir = join(projectsDir, "-workspace-project");
    const subagentDir = join(projectDir, "subagents");
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(join(projectsDir, "not-a-project"), "file");
    writeFileSync(join(projectDir, "session.jsonl"), "{}");
    writeFileSync(join(projectDir, "notes.txt"), "ignore");
    writeFileSync(join(subagentDir, "agent.jsonl"), "{}");
    writeFileSync(join(subagentDir, "agent.txt"), "ignore");

    expect(adapter.discoverSessions().sort()).toEqual([
      join(projectDir, "session.jsonl"),
      join(subagentDir, "agent.jsonl"),
    ].sort());
  });

  it("parses metadata and supported message parts into canonical events", () => {
    const filePath = join(tempDir, "session.jsonl");
    const records = [
      "not json",
      JSON.stringify({ type: "custom-title", customTitle: "A title" }),
      JSON.stringify({ type: "agent-name", agentName: "planner" }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/workspace/project",
        sessionId: "session-id",
        message: { content: "hello" },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-01-01T00:01:00.000Z",
        message: { content: [{ type: "text", text: "structured" }] },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-01-01T00:02:00.000Z",
        message: {
          model: "claude-test",
          content: [
            { type: "thinking", thinking: "reasoning" },
            { type: "text", text: "answer" },
            { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } },
            { type: "ignored" },
          ],
        },
      }),
    ];
    writeFileSync(filePath, records.join("\n"), "utf-8");

    const parsed = new ClaudeAdapter().parseSession(filePath);

    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      id: "session-id",
      cwd: "/workspace/project",
      startedAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:02:00.000Z",
      model: "claude-test",
      title: "A title",
      agentName: "planner",
      source: "claude",
      sourcePath: filePath,
    });
    expect(parsed!.events).toEqual([
      { type: "user", timestamp: "2026-01-01T00:00:00.000Z", content: "hello" },
      { type: "user", timestamp: "2026-01-01T00:01:00.000Z", content: '[{"type":"text","text":"structured"}]' },
      { type: "thinking", timestamp: "2026-01-01T00:02:00.000Z", model: "claude-test", content: "reasoning" },
      { type: "assistant", timestamp: "2026-01-01T00:02:00.000Z", model: "claude-test", content: "answer" },
      {
        type: "tool_call",
        timestamp: "2026-01-01T00:02:00.000Z",
        model: "claude-test",
        toolName: "Read",
        content: '{"file_path":"README.md"}',
        toolArgs: { file_path: "README.md" },
      },
    ]);
  });

  it("derives the session id from the filename and rejects empty or unreadable input", () => {
    const adapter = new ClaudeAdapter();
    const validPath = join(tempDir, "fallback-id.jsonl");
    writeFileSync(validPath, JSON.stringify({
      type: "user",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { content: "hello" },
    }));

    expect(adapter.parseSession(validPath)).toMatchObject({ id: "fallback-id", cwd: "", model: null, title: null, agentName: null });

    const emptyPath = join(tempDir, "empty.jsonl");
    writeFileSync(emptyPath, "\nnot json\n", "utf-8");
    expect(adapter.parseSession(emptyPath)).toBeNull();
    expect(adapter.parseSession(join(tempDir, "missing.jsonl"))).toBeNull();
  });
});
