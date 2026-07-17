import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAdapter } from "../src/db/sqlite-adapter.js";
import { getDatabase, resetDatabase, closeDatabase, initSchema } from "../src/db/database.js";
import {
  upsertSession,
  getSession,
  getSessionBySource,
  getSessionByPrefix,
  listSessions,
  getRecentSessions,
  getProjectStats,
  getMessages,
  getToolCalls,
  deleteSession,
  saveParsedSession,
} from "../src/db/sessions.js";
import { SessionAmbiguousError, type ParsedSession } from "../src/types/index.js";

beforeEach(() => {
  process.env.SESSIONS_DB_PATH = ":memory:";
  resetDatabase();
  getDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env.SESSIONS_DB_PATH;
});

describe("schema migration", () => {
  it("adds the machine column to a pre-existing DB created before it existed", () => {
    // Simulate an old sessions table without the `machine` column.
    const db = new SqliteAdapter(":memory:");
    // Realistic pre-`machine` schema: every column the current indexes/triggers
    // reference, minus `machine` (the only column the migration must add).
    db.exec(
      `CREATE TABLE sessions (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
        title TEXT, project_path TEXT, project_name TEXT, model TEXT,
        parent_session_id TEXT, started_at TEXT, ingested_at TEXT,
        metadata TEXT DEFAULT '{}', UNIQUE(source, source_id)
      )`
    );
    db.exec("INSERT INTO sessions (id, source, source_id, title) VALUES ('x','claude','old','t')");

    // Before the fix this left the column missing; now initSchema must add it.
    initSchema(db);

    // Would throw "no such column: machine" if the migration didn't run.
    const row = db.prepare("SELECT machine FROM sessions WHERE id = 'x'").get();
    expect(row).toBeTruthy();
    db.close();
  });

  it("rebuilds an old source CHECK constraint transactionally and preserves content, FTS, indexes, and FKs", () => {
    const dir = mkdtempSync(join(tmpdir(), "sessions-source-migration-"));
    const path = join(dir, "sessions.db");
    const db = new SqliteAdapter(path);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.exec(
        `CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL CHECK(source IN ('claude', 'codex', 'gemini')),
          source_id TEXT NOT NULL,
          source_path TEXT,
          title TEXT,
          project_path TEXT,
          project_name TEXT,
          model TEXT,
          model_provider TEXT,
          git_branch TEXT,
          git_sha TEXT,
          git_origin_url TEXT,
          cli_version TEXT,
          is_subagent INTEGER NOT NULL DEFAULT 0,
          parent_session_id TEXT,
          total_input_tokens INTEGER NOT NULL DEFAULT 0,
          total_output_tokens INTEGER NOT NULL DEFAULT 0,
          total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          total_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          total_thinking_tokens INTEGER NOT NULL DEFAULT 0,
          message_count INTEGER NOT NULL DEFAULT 0,
          tool_call_count INTEGER NOT NULL DEFAULT 0,
          started_at TEXT,
          ended_at TEXT,
          duration_seconds REAL,
          ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          source_modified_at TEXT,
          machine TEXT,
          metadata TEXT DEFAULT '{}',
          UNIQUE(source, source_id)
        )`
      );
      db.exec(
        `CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          source_id TEXT,
          parent_message_id TEXT,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool', 'info', 'thinking')),
          content TEXT,
          content_preview TEXT,
          model TEXT,
          is_sidechain INTEGER NOT NULL DEFAULT 0,
          sequence_num INTEGER,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          thinking_tokens INTEGER NOT NULL DEFAULT 0,
          timestamp TEXT,
          metadata TEXT DEFAULT '{}',
          UNIQUE(session_id, source_id)
        )`
      );
      db.exec(
        `CREATE TABLE tool_calls (
          id TEXT PRIMARY KEY,
          message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          tool_name TEXT NOT NULL,
          tool_input TEXT,
          tool_output TEXT,
          duration_ms INTEGER,
          status TEXT CHECK(status IN ('success', 'error', 'timeout')),
          timestamp TEXT,
          metadata TEXT DEFAULT '{}'
        )`
      );
      db.exec(
        `CREATE VIRTUAL TABLE sessions_fts USING fts5(
          session_id UNINDEXED, title, project_name, project_path,
          tokenize='porter unicode61'
        )`
      );
      db.exec(
        `CREATE VIRTUAL TABLE messages_fts USING fts5(
          message_id UNINDEXED, session_id UNINDEXED, content,
          tokenize='porter unicode61'
        )`
      );
      db.exec(
        `CREATE VIRTUAL TABLE tool_calls_fts USING fts5(
          tool_call_id UNINDEXED, session_id UNINDEXED, tool_name, tool_input, tool_output,
          tokenize='porter unicode61'
        )`
      );
      db.exec("CREATE TABLE messages_fts_refs (rowid INTEGER PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL)");
      db.exec("CREATE TABLE tool_calls_fts_refs (rowid INTEGER PRIMARY KEY, session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL)");
      db.exec("CREATE INDEX idx_sessions_source ON sessions(source)");
      db.exec("INSERT INTO sessions (id, source, source_id, title, project_path, project_name, message_count, tool_call_count) VALUES ('s1', 'codex', 'same-native-id', 'Old Codex', '/p/api', 'api', 1, 1)");
      db.exec("INSERT INTO messages (id, session_id, source_id, role, content, sequence_num) VALUES ('m1', 's1', 'm1', 'user', 'migration preserves this message', 0)");
      db.exec("INSERT INTO tool_calls (id, message_id, session_id, tool_name, tool_input, tool_output, status) VALUES ('t1', 'm1', 's1', 'shell', 'echo ok', 'ok', 'success')");
      db.exec("INSERT INTO sessions_fts(session_id, title, project_name, project_path) VALUES ('s1', 'Old Codex', 'api', '/p/api')");
      db.exec("INSERT INTO messages_fts_refs(rowid, session_id, message_id) VALUES (1, 's1', 'm1')");
      db.exec("INSERT INTO messages_fts(rowid, message_id, session_id, content) VALUES (1, 'm1', 's1', 'migration preserves this message')");
      db.exec("INSERT INTO tool_calls_fts_refs(rowid, session_id, tool_call_id) VALUES (1, 's1', 't1')");
      db.exec("INSERT INTO tool_calls_fts(rowid, tool_call_id, session_id, tool_name, tool_input, tool_output) VALUES (1, 't1', 's1', 'shell', 'echo ok', 'ok')");

      initSchema(db);

      const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get() as { sql: string };
      expect(table.sql).toContain("codewith");
      expect((db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS c FROM tool_calls").get() as { c: number }).c).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS c FROM sessions_fts").get() as { c: number }).c).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS c FROM messages_fts").get() as { c: number }).c).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS c FROM tool_calls_fts").get() as { c: number }).c).toBe(1);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      const indexes = (db.prepare("PRAGMA index_list(sessions)").all() as { name: string }[]).map((row) => row.name);
      expect(indexes).toContain("idx_sessions_source");
      const hit = db
        .prepare("SELECT session_id FROM messages_fts WHERE messages_fts MATCH ?")
        .get("preserves") as { session_id: string } | undefined;
      expect(hit?.session_id).toBe("s1");
      db.prepare("INSERT INTO sessions (id, source, source_id) VALUES ('cw1', 'codewith', 'same-native-id')").run();
      expect(() =>
        db.prepare("INSERT INTO sessions (id, source, source_id) VALUES ('bad', 'unknown', 'bad')").run()
      ).toThrow();
      expect(readdirSync(join(dir, "migration-backups")).some((name) => name.startsWith("sessions-pre-codewith-source-"))).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a legacy database usable when source constraint preflight fails", () => {
    const db = new SqliteAdapter(":memory:");
    db.exec(
      `CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        source_id TEXT NOT NULL,
        title TEXT,
        project_path TEXT,
        model TEXT,
        parent_session_id TEXT,
        started_at TEXT,
        UNIQUE(source, source_id)
      )`
    );
    db.exec("INSERT INTO sessions (id, source, source_id, title) VALUES ('legacy', 'unknown', 'bad', 'still readable')");

    expect(() => initSchema(db)).toThrow(/unknown sources/);
    const row = db.prepare("SELECT title FROM sessions WHERE id = 'legacy'").get() as { title: string };
    expect(row.title).toBe("still readable");
    db.close();
  });
});

describe("upsertSession", () => {
  it("inserts and round-trips a session", () => {
    const s = upsertSession({
      source: "claude",
      source_id: "abc-123",
      title: "Fix the bug",
      project_path: "/Users/h/Workspace/app",
      project_name: "app",
      model: "claude-opus-4",
      is_subagent: true,
      metadata: { foo: "bar" },
    });
    expect(s.id).toBeTruthy();
    expect(s.source).toBe("claude");
    expect(s.is_subagent).toBe(true);
    expect(s.metadata).toEqual({ foo: "bar" });

    const fetched = getSession(s.id);
    expect(fetched.title).toBe("Fix the bug");
    expect(fetched.project_name).toBe("app");
  });

  it("accepts codewith in a fresh database and rejects unknown sources", () => {
    const s = upsertSession({ source: "codewith", source_id: "cw-1", title: "Codewith rollout" });
    expect(s.source).toBe("codewith");
    expect(getSessionBySource("codewith", "cw-1")?.id).toBe(s.id);
    expect(() => upsertSession({ source: "unknown" as never, source_id: "bad" })).toThrow();
  });

  it("is idempotent on (source, source_id) — updates in place, keeps the same id", () => {
    const first = upsertSession({ source: "codex", source_id: "x1", title: "v1" });
    const second = upsertSession({ source: "codex", source_id: "x1", title: "v2" });
    expect(second.id).toBe(first.id);
    expect(getSession(first.id).title).toBe("v2");
    expect(listSessions()).toHaveLength(1);
  });

  it("getSessionBySource finds by natural key", () => {
    upsertSession({ source: "gemini", source_id: "g9", title: "hello" });
    expect(getSessionBySource("gemini", "g9")?.title).toBe("hello");
    expect(getSessionBySource("gemini", "nope")).toBeNull();
  });

  it("getSessionByPrefix resolves full id, source_id, and unique prefix", () => {
    const s = upsertSession({ source: "claude", source_id: "abcdef-1234", title: "prefixed" });
    expect(getSessionByPrefix(s.id)?.id).toBe(s.id);
    expect(getSessionByPrefix("abcdef-1234")?.id).toBe(s.id);
    expect(getSessionByPrefix("abcdef")?.id).toBe(s.id); // unique prefix
    expect(getSessionByPrefix("zzz")).toBeNull();
  });

  it("gives exact internal ids precedence over matching provider-native ids", () => {
    const internal = upsertSession({
      id: "same-string",
      source: "claude",
      source_id: "claude-native",
      title: "internal",
    });
    upsertSession({ source: "codewith", source_id: "same-string", title: "native" });

    expect(getSessionByPrefix("same-string")?.id).toBe(internal.id);
  });

  it("requires source qualification for duplicate provider-native ids", () => {
    const codex = upsertSession({ source: "codex", source_id: "native-duplicate", title: "Codex" });
    const codewith = upsertSession({
      source: "codewith",
      source_id: "native-duplicate",
      title: "Codewith",
    });

    expect(() => getSessionByPrefix("native-duplicate")).toThrow(SessionAmbiguousError);
    expect(getSessionByPrefix("codewith:native-duplicate")?.id).toBe(codewith.id);
    expect(getSessionByPrefix("native-duplicate", { source: "codex" })?.id).toBe(codex.id);
  });

  it("treats exact and prefix collisions as ambiguous instead of picking a row", () => {
    const codex = upsertSession({ source: "codex", source_id: "collision-a", title: "Codex" });
    const codewith = upsertSession({ source: "codewith", source_id: "collision-b", title: "Codewith" });

    expect(() => getSessionByPrefix("collision")).toThrow(SessionAmbiguousError);
    expect(getSessionByPrefix("collision-a")?.id).toBe(codex.id);
    expect(getSessionByPrefix("codewith:collision")?.id).toBe(codewith.id);
  });
});

describe("saveParsedSession", () => {
  const parsed: ParsedSession = {
    session: { source: "claude", source_id: "s1", title: "T", project_path: "/p", project_name: "p" },
    messages: [
      { session_id: "", role: "user", content: "deploy the staging server", sequence_num: 0, input_tokens: 10 },
      { session_id: "", role: "assistant", content: "running deploy now", sequence_num: 1, output_tokens: 20 },
    ],
    toolCalls: [
      { session_id: "", tool_name: "Bash", tool_input: "kubectl apply", tool_output: "deployed", status: "success" },
    ],
  };

  it("stores messages + tool calls and recomputes counts/tokens", () => {
    const s = saveParsedSession(parsed);
    expect(s.message_count).toBe(2);
    expect(s.tool_call_count).toBe(1);
    expect(s.total_input_tokens).toBe(10);
    expect(s.total_output_tokens).toBe(20);

    expect(getMessages(s.id)).toHaveLength(2);
    expect(getToolCalls(s.id)[0].tool_name).toBe("Bash");
  });

  it("replaces children on re-ingest (idempotent, no duplicates)", () => {
    const s1 = saveParsedSession(parsed);
    const s2 = saveParsedSession({
      ...parsed,
      messages: [{ session_id: "", role: "user", content: "only one now", sequence_num: 0 }],
      toolCalls: [],
    });
    expect(s2.id).toBe(s1.id);
    expect(getMessages(s2.id)).toHaveLength(1);
    expect(getToolCalls(s2.id)).toHaveLength(0);
    expect(s2.message_count).toBe(1);
  });

  it("populates FTS via triggers (message content searchable)", () => {
    const s = saveParsedSession(parsed);
    const db = getDatabase();
    const hit = db
      .prepare("SELECT session_id FROM messages_fts WHERE messages_fts MATCH ?")
      .get("deploy") as { session_id: string } | undefined;
    expect(hit?.session_id).toBe(s.id);
  });

  it("repairs missing FTS rowid refs from existing FTS rows on schema init", () => {
    saveParsedSession(parsed);
    const db = getDatabase();
    db.exec("DELETE FROM messages_fts_refs");
    db.exec("DELETE FROM tool_calls_fts_refs");

    initSchema(db);

    const messageRefs = db.prepare("SELECT COUNT(*) AS c FROM messages_fts_refs").get() as { c: number };
    const toolRefs = db.prepare("SELECT COUNT(*) AS c FROM tool_calls_fts_refs").get() as { c: number };
    expect(messageRefs.c).toBe(2);
    expect(toolRefs.c).toBe(1);
  });
});

describe("queries", () => {
  it("lists recent sessions ordered by start time, filters by source/project", () => {
    upsertSession({ source: "claude", source_id: "a", started_at: "2026-01-01T00:00:00Z", project_path: "/p1" });
    upsertSession({ source: "codex", source_id: "b", started_at: "2026-02-01T00:00:00Z", project_path: "/p2" });
    const recent = getRecentSessions(10);
    expect(recent[0].source_id).toBe("b"); // most recent first
    expect(listSessions({ source: "claude" })).toHaveLength(1);
    expect(listSessions({ project_path: "/p2" })).toHaveLength(1);
  });

  it("aggregates project stats", () => {
    upsertSession({ source: "claude", source_id: "a", project_path: "/p", project_name: "p" });
    upsertSession({ source: "codex", source_id: "b", project_path: "/p", project_name: "p" });
    const stats = getProjectStats();
    expect(stats[0]).toEqual({ project_path: "/p", project_name: "p", session_count: 2 });
  });
});

describe("deleteSession", () => {
  it("removes the session and its children", () => {
    const s = saveParsedSession({
      session: { source: "claude", source_id: "del" },
      messages: [{ session_id: "", role: "user", content: "x" }],
      toolCalls: [{ session_id: "", tool_name: "Read" }],
    });
    deleteSession(s.id);
    expect(listSessions()).toHaveLength(0);
    expect(getMessages(s.id)).toHaveLength(0);
    expect(getToolCalls(s.id)).toHaveLength(0);
  });
});
