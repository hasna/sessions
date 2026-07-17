import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getParser, ingestSource, ingestAll } from "../src/lib/ingest/index.js";
import { getDatabase, resetDatabase, closeDatabase } from "../src/db/database.js";
import { getMessages, getSessionBySource, listSessions } from "../src/db/sessions.js";
import { getFileState, getIngestionStats } from "../src/db/ingestion.js";

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

const CODEX_SESSION_META = JSON.stringify({
  timestamp: "2026-05-02T09:00:00Z",
  type: "session_meta",
  payload: { id: "codex-ingest-1", cwd: "/Users/h/Workspace/api" },
});

function codexUserLine(timestamp: string, text: string): string {
  return JSON.stringify({
    timestamp,
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });
}

const sharedRolloutLines = (cwd: string) =>
  [
    JSON.stringify({
      timestamp: "2026-05-02T09:00:00Z",
      type: "session_meta",
      payload: {
        id: "shared-openai-rollout-id",
        cwd,
        cli_version: "test",
        model_provider: "openai",
      },
    }),
    JSON.stringify({
      timestamp: "2026-05-02T09:00:01Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `index ${cwd}` }],
      },
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
  process.env.CODEWITH_PATH = join(root, "codewith");
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
  delete process.env.CODEWITH_PATH;
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

  it("persists Codewith rollouts with source-qualified ids distinct from matching Codex ids", () => {
    const codexDir = join(root, "codex", "sessions", "2026", "05", "02");
    const codewithDir = join(root, "codewith", "sessions", "2026", "05", "02");
    mkdirSync(codexDir, { recursive: true });
    mkdirSync(codewithDir, { recursive: true });
    writeFileSync(
      join(codexDir, "rollout-2026-05-02T09-00-00-shared-openai-rollout-id.jsonl"),
      sharedRolloutLines("/Users/h/Workspace/codex-app")
    );
    writeFileSync(
      join(codewithDir, "rollout-2026-05-02T10-00-00-shared-openai-rollout-id.jsonl"),
      sharedRolloutLines("/Users/h/Workspace/codewith-app")
    );

    expect(ingestSource("codex")).toMatchObject({ source: "codex", sessions: 1, errors: 0 });
    expect(ingestSource("codewith")).toMatchObject({ source: "codewith", sessions: 1, errors: 0 });

    const codex = getSessionBySource("codex", "shared-openai-rollout-id");
    const codewith = getSessionBySource("codewith", "shared-openai-rollout-id");
    expect(codex?.project_name).toBe("codex-app");
    expect(codewith?.project_name).toBe("codewith-app");
    expect(codex?.id).not.toBe(codewith?.id);
    expect(listSessions({ source: "codex" }).map((session) => session.source_id)).toContain("shared-openai-rollout-id");
    expect(listSessions({ source: "codewith" }).map((session) => session.source_id)).toEqual([
      "shared-openai-rollout-id",
    ]);

    const codewithStats = getIngestionStats().find((s) => s.source === "codewith");
    expect(codewithStats?.session_count).toBe(1);
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

  it("defers changed rollout files and retries without duplicating content", () => {
    const xdir = join(root, "codex", "sessions", "2026", "05", "02");
    mkdirSync(xdir, { recursive: true });
    const file = join(xdir, "rollout-2026-05-02T09-00-00-codex-ingest-1.jsonl");
    writeFileSync(file, [CODEX_SESSION_META, codexUserLine("2026-05-02T09:00:01Z", "first")].join("\n"));

    const parser = getParser("codex") as NonNullable<ReturnType<typeof getParser>> & {
      parseFileResult: NonNullable<ReturnType<typeof getParser>["parseFileResult"]>;
    };
    const original = parser.parseFileResult.bind(parser);
    parser.parseFileResult = (path: string) => {
      const parsed = original(path);
      appendFileSync(file, `\n${codexUserLine("2026-05-02T09:00:02Z", "second")}`);
      return parsed;
    };

    try {
      const changed = ingestSource("codex");
      expect(changed).toMatchObject({ source: "codex", scanned: 1, ingested: 0, sessions: 0, errors: 0 });
      expect(getFileState("codex", file)?.status).toBe("pending");
      expect(listSessions({ source: "codex" })).toHaveLength(0);
    } finally {
      parser.parseFileResult = original;
    }

    const retried = ingestSource("codex");
    expect(retried).toMatchObject({ source: "codex", scanned: 1, ingested: 1, sessions: 1, errors: 0 });
    const sessions = listSessions({ source: "codex" });
    expect(sessions).toHaveLength(1);
    expect(getMessages(sessions[0].id).map((m) => m.content)).toEqual(["first", "second"]);

    const third = ingestSource("codex");
    expect(third).toMatchObject({ source: "codex", scanned: 1, ingested: 0, skipped: 1, sessions: 0, errors: 0 });
    expect(listSessions({ source: "codex" })).toHaveLength(1);
  });

  it("keeps the existing stored rollout snapshot when a forced re-ingest changes during parsing", () => {
    const xdir = join(root, "codex", "sessions", "2026", "05", "02");
    mkdirSync(xdir, { recursive: true });
    const file = join(xdir, "rollout-2026-05-02T09-00-00-codex-existing.jsonl");
    writeFileSync(file, [CODEX_SESSION_META, codexUserLine("2026-05-02T09:00:01Z", "first")].join("\n"));

    expect(ingestSource("codex").ingested).toBe(1);
    const [existing] = listSessions({ source: "codex" });
    expect(getMessages(existing.id).map((m) => m.content)).toEqual(["first"]);

    const parser = getParser("codex") as NonNullable<ReturnType<typeof getParser>> & {
      parseFileResult: NonNullable<ReturnType<typeof getParser>["parseFileResult"]>;
    };
    const original = parser.parseFileResult.bind(parser);
    parser.parseFileResult = (path, opts) => {
      const parsed = original(path, opts);
      appendFileSync(file, `\n${codexUserLine("2026-05-02T09:00:02Z", "second")}`);
      return parsed;
    };

    try {
      const changed = ingestSource("codex", { force: true });
      expect(changed).toMatchObject({ source: "codex", scanned: 1, ingested: 0, sessions: 0, errors: 0 });
      expect(getFileState("codex", file)?.status).toBe("pending");
      expect(getMessages(existing.id).map((m) => m.content)).toEqual(["first"]);
    } finally {
      parser.parseFileResult = original;
    }

    const retried = ingestSource("codex");
    expect(retried.ingested).toBe(1);
    expect(getMessages(existing.id).map((m) => m.content)).toEqual(["first", "second"]);
  });

  it("defers rollout files with an incomplete trailing record", () => {
    const xdir = join(root, "codex", "sessions", "2026", "05", "02");
    mkdirSync(xdir, { recursive: true });
    const file = join(xdir, "rollout-2026-05-02T09-00-00-codex-partial.jsonl");
    writeFileSync(
      file,
      [
        CODEX_SESSION_META,
        codexUserLine("2026-05-02T09:00:01Z", "complete"),
        '{"timestamp":"2026-05-02T09:00:02Z","type":"response_item","payload":',
      ].join("\n")
    );

    const partial = ingestSource("codex");
    expect(partial).toMatchObject({ source: "codex", scanned: 1, ingested: 0, sessions: 0, errors: 0 });
    expect(getFileState("codex", file)?.status).toBe("pending");
    expect(listSessions({ source: "codex" })).toHaveLength(0);

    writeFileSync(
      file,
      [
        CODEX_SESSION_META,
        codexUserLine("2026-05-02T09:00:01Z", "complete"),
        codexUserLine("2026-05-02T09:00:02Z", "now complete"),
      ].join("\n")
    );
    const retried = ingestSource("codex");
    expect(retried.ingested).toBe(1);
    const [session] = listSessions({ source: "codex" });
    expect(getMessages(session.id).map((m) => m.content)).toEqual(["complete", "now complete"]);
  });

  it("keeps the existing stored rollout snapshot when a forced re-ingest has an incomplete trailing record", () => {
    const xdir = join(root, "codex", "sessions", "2026", "05", "02");
    mkdirSync(xdir, { recursive: true });
    const file = join(xdir, "rollout-2026-05-02T09-00-00-codex-existing-partial.jsonl");
    writeFileSync(file, [CODEX_SESSION_META, codexUserLine("2026-05-02T09:00:01Z", "stable")].join("\n"));

    expect(ingestSource("codex").ingested).toBe(1);
    const [existing] = listSessions({ source: "codex" });
    writeFileSync(
      file,
      [
        CODEX_SESSION_META,
        codexUserLine("2026-05-02T09:00:01Z", "stable"),
        '{"timestamp":"2026-05-02T09:00:02Z","type":"response_item","payload":',
      ].join("\n")
    );

    const partial = ingestSource("codex", { force: true });
    expect(partial).toMatchObject({ source: "codex", scanned: 1, ingested: 0, sessions: 0, errors: 0 });
    expect(getFileState("codex", file)?.status).toBe("pending");
    expect(getMessages(existing.id).map((m) => m.content)).toEqual(["stable"]);
  });
});

describe("ingestAll", () => {
  it("runs every registered provider (empty dirs yield zero)", () => {
    const results = ingestAll();
    const bySource = Object.fromEntries(results.map((r) => [r.source, r]));
    expect(bySource.claude.sessions).toBe(1);
    expect(bySource.codex.scanned).toBe(0);
    expect(bySource.codewith.scanned).toBe(0);
    expect(bySource.gemini.scanned).toBe(0);
  });
});
