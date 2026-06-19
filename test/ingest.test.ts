import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestSource, ingestAll } from "../src/lib/ingest/index.js";
import { getDatabase, resetDatabase, closeDatabase } from "../src/db/database.js";
import { listSessions } from "../src/db/sessions.js";
import { getIngestionStats } from "../src/db/ingestion.js";

let root: string;

const CLAUDE_LINES = [
  JSON.stringify({
    type: "user",
    message: { role: "user", content: "build the feature" },
    uuid: "u1",
    timestamp: "2026-05-01T10:00:00Z",
    cwd: "/Users/h/Workspace/app",
    sessionId: "c-ingest-1",
    gitBranch: "main",
  }),
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", model: "claude-opus-4", content: [{ type: "text", text: "done" }], usage: { input_tokens: 5, output_tokens: 7 } },
    uuid: "a1",
    timestamp: "2026-05-01T10:00:02Z",
    sessionId: "c-ingest-1",
  }),
].join("\n");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sessions-ingest-"));
  const cdir = join(root, "claude", "projects", "-Users-h-Workspace-app");
  mkdirSync(cdir, { recursive: true });
  writeFileSync(join(cdir, "c-ingest-1.jsonl"), CLAUDE_LINES);
  process.env.CLAUDE_PATH = join(root, "claude");
  // Point codex/gemini at empty dirs so ingestAll finds nothing for them.
  process.env.CODEX_PATH = join(root, "codex");
  process.env.GEMINI_PATH = join(root, "gemini");

  process.env.HASNA_SESSIONS_DIR = join(root, "sessions");
  process.env.SESSIONS_DB_PATH = ":memory:";
  resetDatabase();
  getDatabase();
});

afterEach(() => {
  closeDatabase();
  rmSync(root, { recursive: true, force: true });
  delete process.env.CLAUDE_PATH;
  delete process.env.CODEX_PATH;
  delete process.env.GEMINI_PATH;
  delete process.env.HASNA_SESSIONS_DIR;
  delete process.env.SESSIONS_DB_PATH;
});

describe("ingestSource", () => {
  it("ingests claude sessions into the database", () => {
    const r = ingestSource("claude");
    expect(r).toMatchObject({ source: "claude", scanned: 1, ingested: 1, sessions: 1, errors: 0 });
    const sessions = listSessions({ source: "claude" });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].source_id).toBe("c-ingest-1");
  });

  it("skips unchanged files on the second run (mtime-gated)", () => {
    ingestSource("claude");
    const second = ingestSource("claude");
    expect(second.skipped).toBe(1);
    expect(second.ingested).toBe(0);
    expect(listSessions()).toHaveLength(1); // no duplicate
  });

  it("re-ingests when --force is set", () => {
    ingestSource("claude");
    const forced = ingestSource("claude", { force: true });
    expect(forced.ingested).toBe(1);
    expect(forced.skipped).toBe(0);
    expect(listSessions()).toHaveLength(1); // still idempotent (upsert)
  });

  it("updates ingestion_stats", () => {
    ingestSource("claude");
    const stats = getIngestionStats().find((s) => s.source === "claude");
    expect(stats?.session_count).toBe(1);
    expect(stats?.message_count).toBe(2);
  });

  it("throws for an unknown source", () => {
    expect(() => ingestSource("nope")).toThrow(/No parser registered/);
  });

  it("fails clearly when another ingest lock is active", () => {
    const lockDir = join(root, "sessions", "ingest.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));

    expect(() => ingestSource("claude")).toThrow(/another sessions ingest is already running/);
  });
});

describe("ingestAll", () => {
  it("runs every registered provider (empty dirs yield zero)", () => {
    const results = ingestAll();
    const bySource = Object.fromEntries(results.map((r) => [r.source, r]));
    expect(bySource.claude.sessions).toBe(1);
    expect(bySource.codex.scanned).toBe(0);
    expect(bySource.gemini.scanned).toBe(0);
  });
});
