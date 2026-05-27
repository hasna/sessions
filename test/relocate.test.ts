import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { relocate } from "../src/lib/relocate";

const TEST_DIR = join(import.meta.dir, ".test-relocate");
const PROJECTS_DIR = join(TEST_DIR, "projects");

function setup() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(PROJECTS_DIR, { recursive: true });

  // Create a fake project directory
  const projectDir = join(PROJECTS_DIR, "-Users-test-old-project");
  mkdirSync(projectDir, { recursive: true });

  // Create sessions-index.json
  writeFileSync(
    join(projectDir, "sessions-index.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          sessionId: "abc-123",
          fullPath: `${PROJECTS_DIR}/-Users-test-old-project/abc-123.jsonl`,
          projectPath: "/Users/test/old/project",
        },
      ],
    }),
    "utf-8"
  );

  // Create a session .jsonl file
  const sessionLines = [
    JSON.stringify({
      type: "user",
      cwd: "/Users/test/old/project",
      message: { role: "user", content: "hello" },
    }),
    JSON.stringify({
      type: "assistant",
      cwd: "/Users/test/old/project",
      message: { role: "assistant", content: "hi" },
    }),
  ];
  writeFileSync(
    join(projectDir, "abc-123.jsonl"),
    sessionLines.join("\n"),
    "utf-8"
  );
}

function cleanup() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.CODEX_PATH;
}

describe("relocate", () => {
  beforeEach(() => {
    setup();
    // Isolate Codex to the test dir so we never touch the real ~/.codex/sessions.
    // TEST_DIR/sessions doesn't exist by default → codex relocation is a no-op.
    process.env.CODEX_PATH = TEST_DIR;
  });
  afterEach(cleanup);

  it("relocates Codex rollout cwd (top-level and nested payload)", () => {
    const origClaude = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = TEST_DIR;
    process.env.CODEX_PATH = TEST_DIR;

    // Fake Codex rollout under a date folder, with cwd both nested and top-level
    const codexDay = join(TEST_DIR, "sessions", "2026", "05", "27");
    mkdirSync(codexDay, { recursive: true });
    const rollout = join(codexDay, "rollout-test.jsonl");
    writeFileSync(
      rollout,
      [
        JSON.stringify({ type: "session_meta", payload: { cwd: "/Users/test/old/project", id: "x" } }),
        JSON.stringify({ type: "turn_context", payload: { cwd: "/Users/test/old/project" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hi" } }),
      ].join("\n"),
      "utf-8"
    );

    const result = relocate("/Users/test/old", "/Users/test/new", {
      dryRun: false,
      updateDb: false,
    });

    process.env.CLAUDE_PATH = origClaude;

    expect(result.codexFilesUpdated).toBe(1);
    const lines = readFileSync(rollout, "utf-8").split("\n");
    expect(JSON.parse(lines[0]).payload.cwd).toBe("/Users/test/new/project");
    expect(JSON.parse(lines[1]).payload.cwd).toBe("/Users/test/new/project");
    // unrelated line untouched
    expect(JSON.parse(lines[2]).payload.message).toBe("hi");
  });

  it("dry-run does not modify files", () => {
    // Override CLAUDE_PATH to use test dir
    const origEnv = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = TEST_DIR;

    const result = relocate("/Users/test/old", "/Users/test/new", {
      dryRun: true,
      updateDb: false,
    });

    process.env.CLAUDE_PATH = origEnv;

    expect(result.dirsRenamed).toHaveLength(1);
    // But the directory should NOT actually be renamed
    expect(
      existsSync(join(PROJECTS_DIR, "-Users-test-old-project"))
    ).toBe(true);
    expect(
      existsSync(join(PROJECTS_DIR, "-Users-test-new-project"))
    ).toBe(false);
  });

  it("renames directory and updates files", () => {
    const origEnv = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = TEST_DIR;

    const result = relocate("/Users/test/old", "/Users/test/new", {
      dryRun: false,
      updateDb: false,
    });

    process.env.CLAUDE_PATH = origEnv;

    // Directory should be renamed
    expect(result.dirsRenamed).toHaveLength(1);
    expect(result.dirsRenamed[0].from).toBe("-Users-test-old-project");
    expect(result.dirsRenamed[0].to).toBe("-Users-test-new-project");
    expect(
      existsSync(join(PROJECTS_DIR, "-Users-test-new-project"))
    ).toBe(true);
    expect(
      existsSync(join(PROJECTS_DIR, "-Users-test-old-project"))
    ).toBe(false);

    // sessions-index.json should have updated paths
    const indexPath = join(
      PROJECTS_DIR,
      "-Users-test-new-project",
      "sessions-index.json"
    );
    const index = JSON.parse(readFileSync(indexPath, "utf-8"));
    expect(index.entries[0].projectPath).toBe("/Users/test/new/project");
    expect(index.entries[0].fullPath).toContain("-Users-test-new-project");

    // .jsonl file should have updated cwd
    const jsonlPath = join(
      PROJECTS_DIR,
      "-Users-test-new-project",
      "abc-123.jsonl"
    );
    const lines = readFileSync(jsonlPath, "utf-8").split("\n");
    const line1 = JSON.parse(lines[0]);
    expect(line1.cwd).toBe("/Users/test/new/project");
  });

  it("reports errors for non-existent paths", () => {
    const origEnv = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = TEST_DIR;

    const result = relocate("/Users/nonexistent", "/Users/other", {
      updateDb: false,
    });

    process.env.CLAUDE_PATH = origEnv;

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain("No session directories found");
  });
});
