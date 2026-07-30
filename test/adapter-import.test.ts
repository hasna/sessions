import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importCanonicalSessions } from "../src/lib/adapters/import.js";
import type { CanonicalSession } from "../src/lib/adapters/types.js";

const timestamp = "2026-07-30T12:00:00.000Z";

function session(overrides: Partial<CanonicalSession> = {}): CanonicalSession {
  return {
    id: "session-1",
    cwd: "/work/app",
    startedAt: timestamp,
    lastActivityAt: timestamp,
    model: "gpt-test",
    title: "Imported session",
    agentName: "Builder",
    source: "codex",
    sourcePath: "/source/rollout.jsonl",
    events: [
      { type: "user", timestamp, content: "Build it" },
      { type: "assistant", timestamp, content: "Done" },
      { type: "thinking", timestamp, content: "Plan first" },
      { type: "tool_call", timestamp, content: "", toolName: "shell", toolArgs: { command: "pwd" } },
      { type: "tool_result", timestamp, content: "/work/app", toolName: "shell" },
      { type: "system", timestamp, content: "Stay focused" },
    ],
    ...overrides,
  };
}

describe("importCanonicalSessions", () => {
  let tempDir: string;
  let originalClaudePath: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sessions-adapter-import-"));
    originalClaudePath = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = join(tempDir, "claude");
  });

  afterEach(() => {
    if (originalClaudePath === undefined) {
      delete process.env.CLAUDE_PATH;
    } else {
      process.env.CLAUDE_PATH = originalClaudePath;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes canonical events as observable Claude JSONL records", () => {
    const result = importCanonicalSessions([session()]);
    const outputPath = join(process.env.CLAUDE_PATH!, "projects", "-work-app", "session-1.jsonl");
    const records = readFileSync(outputPath, "utf8").split("\n").map((line) => JSON.parse(line));

    expect(result).toEqual({ imported: 1, skipped: 0, errors: [] });
    expect(records[0]).toMatchObject({ type: "header", sessionId: "session-1", cwd: "/work/app" });
    expect(records.map((record) => record.type)).toEqual([
      "header",
      "user",
      "assistant",
      "assistant",
      "assistant",
      "assistant",
      "assistant",
      "custom-title",
      "agent-name",
    ]);
    expect(records[1].message).toEqual({ role: "user", content: "Build it" });
    expect(records[2].message.content[0]).toEqual({ type: "text", text: "Done" });
    expect(records[3].message.content[0]).toEqual({ type: "thinking", thinking: "Plan first" });
    expect(records[4].message.content[0]).toMatchObject({ type: "tool_use", name: "shell", input: { command: "pwd" } });
    expect(records[5].message.content[0].text).toBe("[Tool: shell]\n/work/app");
    expect(records[6].message.content[0].text).toBe("[System context]\nStay focused");
    expect(records[7]).toMatchObject({ type: "custom-title", customTitle: "Imported session" });
    expect(records[8]).toMatchObject({ type: "agent-name", agentName: "Builder" });
  });

  it("skips existing files unless overwrite is requested", () => {
    const outputDir = join(process.env.CLAUDE_PATH!, "projects", "-work-app");
    const outputPath = join(outputDir, "session-1.jsonl");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(outputPath, "existing");

    expect(importCanonicalSessions([session()])).toEqual({ imported: 0, skipped: 1, errors: [] });
    expect(readFileSync(outputPath, "utf8")).toBe("existing");

    expect(importCanonicalSessions([session()], { overwrite: true }).imported).toBe(1);
    expect(readFileSync(outputPath, "utf8")).not.toBe("existing");
  });

  it("supports dry runs and project filtering without filesystem writes", () => {
    const projectsDir = join(process.env.CLAUDE_PATH!, "projects");

    expect(importCanonicalSessions([session()], { dryRun: true })).toEqual({ imported: 1, skipped: 0, errors: [] });
    expect(existsSync(projectsDir)).toBe(false);

    expect(importCanonicalSessions([session()], { projectPath: "/other" })).toEqual({ imported: 0, skipped: 0, errors: [] });
    expect(existsSync(join(projectsDir, "-work-app", "session-1.jsonl"))).toBe(false);
  });
});
