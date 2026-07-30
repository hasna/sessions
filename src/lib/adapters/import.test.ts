import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { importCanonicalSessions } from "./import.js";
import type { CanonicalSession } from "./types.js";

let tempDir: string;
let originalClaudePath: string | undefined;

function session(overrides: Partial<CanonicalSession> = {}): CanonicalSession {
  return {
    id: "session-1",
    cwd: "/workspace/project",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:06:00.000Z",
    model: "session-model",
    title: "Imported session",
    agentName: "reviewer",
    source: "codex",
    sourcePath: "/source/session.jsonl",
    events: [],
    ...overrides,
  };
}

beforeEach(() => {
  originalClaudePath = process.env.CLAUDE_PATH;
  tempDir = mkdtempSync(join(tmpdir(), "sessions-import-test-"));
  process.env.CLAUDE_PATH = join(tempDir, "claude");
});

afterEach(() => {
  if (originalClaudePath === undefined) delete process.env.CLAUDE_PATH;
  else process.env.CLAUDE_PATH = originalClaudePath;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("importCanonicalSessions", () => {
  it("writes every canonical event type as Claude JSONL", () => {
    const imported = session({
      events: [
        { type: "user", timestamp: "2026-01-01T00:00:00.000Z", content: "hello" },
        { type: "assistant", timestamp: "2026-01-01T00:01:00.000Z", content: "hi" },
        { type: "thinking", timestamp: "2026-01-01T00:02:00.000Z", content: "reason", model: "event-model" },
        { type: "tool_call", timestamp: "2026-01-01T00:03:00.000Z", content: "", toolName: "Read", toolArgs: { path: "README.md" } },
        { type: "tool_result", timestamp: "2026-01-01T00:04:00.000Z", content: "contents" },
        { type: "system", timestamp: "2026-01-01T00:05:00.000Z", content: "be precise" },
      ],
    });

    expect(importCanonicalSessions([imported])).toEqual({ imported: 1, skipped: 0, errors: [] });

    const outputPath = join(process.env.CLAUDE_PATH!, "projects", "-workspace-project", "session-1.jsonl");
    const records = readFileSync(outputPath, "utf-8").split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(9);
    expect(records[0]).toEqual({ type: "header", sessionId: "session-1", cwd: "/workspace/project", version: "1.0.0" });
    expect(records[1].message).toEqual({ role: "user", content: "hello" });
    expect(records[2].message).toMatchObject({ role: "assistant", model: "session-model", content: [{ type: "text", text: "hi" }] });
    expect(records[3].message).toMatchObject({ model: "event-model", content: [{ type: "thinking", thinking: "reason" }] });
    expect(records[4].message.content[0]).toMatchObject({ type: "tool_use", name: "Read", input: { path: "README.md" } });
    expect(records[4].message.content[0].id.startsWith("tool_")).toBe(true);
    expect(records[5].message.content[0].text).toBe("[Tool: unknown]\ncontents");
    expect(records[6].message.content[0].text).toBe("[System context]\nbe precise");
    expect(records[7]).toMatchObject({ type: "custom-title", customTitle: "Imported session" });
    expect(records[8]).toMatchObject({ type: "agent-name", agentName: "reviewer" });
  });

  it("filters projects during a dry run without creating storage", () => {
    const result = importCanonicalSessions(
      [session(), session({ id: "other", cwd: "/workspace/other" })],
      { projectPath: "/workspace/project", dryRun: true }
    );

    expect(result).toEqual({ imported: 1, skipped: 0, errors: [] });
    expect(existsSync(join(process.env.CLAUDE_PATH!, "projects"))).toBe(false);
  });

  it("skips an existing transcript unless overwrite is enabled", () => {
    const destDir = join(process.env.CLAUDE_PATH!, "projects", "-workspace-project");
    const destFile = join(destDir, "session-1.jsonl");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(destFile, "original", "utf-8");

    expect(importCanonicalSessions([session()])).toEqual({ imported: 0, skipped: 1, errors: [] });
    expect(readFileSync(destFile, "utf-8")).toBe("original");

    expect(importCanonicalSessions([session()], { overwrite: true })).toEqual({ imported: 1, skipped: 0, errors: [] });
    expect(JSON.parse(readFileSync(destFile, "utf-8").split("\n")[0])).toMatchObject({ sessionId: "session-1" });
  });

  it("handles empty input and surfaces an unwritable destination", () => {
    expect(importCanonicalSessions([])).toEqual({ imported: 0, skipped: 0, errors: [] });

    const blocker = join(tempDir, "not-a-directory");
    writeFileSync(blocker, "file", "utf-8");
    process.env.CLAUDE_PATH = blocker;
    expect(() => importCanonicalSessions([session()])).toThrow();
  });
});
