import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDatabase, resetDatabase, closeDatabase } from "../src/db/database.js";
import { saveParsedSession } from "../src/db/sessions.js";
import {
  search,
  searchMessages,
  searchSessions,
  searchToolCalls,
  toFtsQuery,
} from "../src/lib/search.js";

beforeEach(() => {
  process.env.SESSIONS_DB_PATH = ":memory:";
  resetDatabase();
  getDatabase();

  saveParsedSession({
    session: { source: "claude", source_id: "s1", title: "Kubernetes deploy", project_path: "/p/infra", project_name: "infra" },
    messages: [
      { session_id: "", role: "user", content: "deploy the kubernetes cluster to production", sequence_num: 0 },
      { session_id: "", role: "assistant", content: "applying manifests with kubectl now", sequence_num: 1 },
    ],
    toolCalls: [{ session_id: "", tool_name: "Bash", tool_input: "kubectl apply -f deploy.yaml", tool_output: "configured" }],
  });
  saveParsedSession({
    session: { source: "codex", source_id: "s2", title: "Fix billing bug", project_path: "/p/web", project_name: "web" },
    messages: [
      { session_id: "", role: "user", content: "the stripe webhook is throwing an error", sequence_num: 0 },
    ],
    toolCalls: [],
  });
});

afterEach(() => {
  closeDatabase();
  delete process.env.SESSIONS_DB_PATH;
});

describe("toFtsQuery", () => {
  it("quotes tokens and neutralizes punctuation", () => {
    expect(toFtsQuery("hello world")).toBe('"hello" "world"');
    expect(toFtsQuery('a "b" c:d')).toBe('"a" """b""" "c:d"');
    expect(toFtsQuery("   ")).toBe('""');
  });
});

describe("searchMessages", () => {
  it("finds sessions by message content", () => {
    const hits = searchMessages("kubernetes");
    expect(hits).toHaveLength(1);
    expect(hits[0].session_id).toBeTruthy();
    expect(hits[0].source).toBe("claude");
    expect(hits[0].snippet).toContain("[kubernetes]");
  });

  it("returns one hit per session even if multiple messages match", () => {
    const hits = searchMessages("the"); // appears in both messages of s1 and in s2
    const ids = hits.map((h) => h.session_id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate sessions
  });

  it("filters by source and project", () => {
    expect(searchMessages("error", { source: "codex" })).toHaveLength(1);
    expect(searchMessages("error", { source: "claude" })).toHaveLength(0);
    expect(searchMessages("kubernetes", { project_path: "/p/infra" })).toHaveLength(1);
    expect(searchMessages("kubernetes", { project_path: "/p/web" })).toHaveLength(0);
  });

  it("returns nothing for non-matching queries", () => {
    expect(search("nonexistentterm")).toHaveLength(0);
  });

  it("does not throw on punctuation-heavy input", () => {
    expect(() => search('what about "this" (and that)?')).not.toThrow();
  });
});

describe("searchSessions", () => {
  it("matches on title / project name", () => {
    const hits = searchSessions("billing");
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Fix billing bug");
  });
});

describe("searchToolCalls", () => {
  it("matches on tool input/output", () => {
    const hits = searchToolCalls("kubectl");
    expect(hits).toHaveLength(1);
    expect(hits[0].tool_name).toBe("Bash");
  });
});
