import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { closeDatabase, getDatabase, resetDatabase } from "../src/db/database.js";
import { saveParsedSession } from "../src/db/sessions.js";

const repoRoot = join(import.meta.dir, "..");
const TEST_DIR = join(import.meta.dir, ".test-compact-output");
const DB_PATH = join(TEST_DIR, "sessions.db");

function runCli(args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.tsx", ...args],
    cwd: repoRoot,
    env: {
      ...process.env,
      SESSIONS_DB_PATH: DB_PATH,
      HASNA_SESSIONS_DB_PATH: DB_PATH,
      HASNA_SESSIONS_DIR: join(TEST_DIR, "sessions-home"),
      CLAUDE_PATH: join(TEST_DIR, "claude"),
      CODEX_PATH: join(TEST_DIR, "codex"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function parseJsonOutput(result: ReturnType<typeof Bun.spawnSync>) {
  expect(result.exitCode).toBe(0);
  expect(Buffer.from(result.stderr).toString("utf-8")).toBe("");
  return JSON.parse(Buffer.from(result.stdout).toString("utf-8"));
}

function seedIndexedSession() {
  process.env.SESSIONS_DB_PATH = DB_PATH;
  process.env.HASNA_SESSIONS_DB_PATH = DB_PATH;
  resetDatabase();
  getDatabase();
  saveParsedSession({
    session: {
      source: "claude",
      source_id: "compact-session",
      title: "Compact output fixture",
      project_path: "/tmp/compact",
      project_name: "compact",
      model: "claude-sonnet-4",
      model_provider: "anthropic",
    },
    messages: Array.from({ length: 30 }, (_, index) => ({
      session_id: "",
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message ${index} ${"x".repeat(500)}`,
      sequence_num: index,
    })),
    toolCalls: Array.from({ length: 55 }, (_, index) => ({
      session_id: "",
      tool_name: `Tool${String(index).padStart(2, "0")}`,
      tool_input: "i".repeat(1000),
      tool_output: "o".repeat(1000),
    })),
  });
  closeDatabase();
  delete process.env.SESSIONS_DB_PATH;
  delete process.env.HASNA_SESSIONS_DB_PATH;
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  seedIndexedSession();
});

afterEach(() => {
  closeDatabase();
  delete process.env.SESSIONS_DB_PATH;
  delete process.env.HASNA_SESSIONS_DB_PATH;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("compact indexed CLI output", () => {
  it("caps graph entity output by default and keeps graph JSON complete", () => {
    const compact = runCli(["graph", "--type", "tool"]);
    expect(compact.exitCode).toBe(0);
    const stdout = Buffer.from(compact.stdout).toString("utf-8");
    expect(stdout).toContain("Showing 50 of 55.");
    expect(stdout.split(/\r?\n/).filter((line) => line.trim().startsWith("1  Tool"))).toHaveLength(50);

    const limited = runCli(["graph", "--type", "tool", "--limit", "5"]);
    expect(limited.exitCode).toBe(0);
    const limitedStdout = Buffer.from(limited.stdout).toString("utf-8");
    expect(limitedStdout).toContain("Showing 5 of 55.");
    expect(limitedStdout.split(/\r?\n/).filter((line) => line.trim().startsWith("1  Tool"))).toHaveLength(5);

    const json = parseJsonOutput(runCli(["graph", "--type", "tool", "--json"]));
    expect(json).toHaveLength(55);
  });

  it("keeps show output compact and points to detail flags", () => {
    const result = runCli(["show", "compact-session"]);
    expect(result.exitCode).toBe(0);
    const stdout = Buffer.from(result.stdout).toString("utf-8");
    expect(stdout).toContain("Showing 12 of 30 messages.");
    expect(stdout).toContain("use --verbose");
    expect(stdout).toContain("(+35 more; use --verbose)");
  });
});
