import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDatabase, resetDatabase, closeDatabase } from "../src/db/database.js";
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
import type { ParsedSession } from "../src/types/index.js";

beforeEach(() => {
  process.env.SESSIONS_DB_PATH = ":memory:";
  resetDatabase();
  getDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env.SESSIONS_DB_PATH;
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
