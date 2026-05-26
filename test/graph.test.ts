import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDatabase, resetDatabase, closeDatabase } from "../src/db/database.js";
import { saveParsedSession } from "../src/db/sessions.js";
import { listEntities, relatedSessions, sessionGraph } from "../src/lib/graph.js";

let s1Id: string;

beforeEach(() => {
  process.env.SESSIONS_DB_PATH = ":memory:";
  resetDatabase();
  getDatabase();
  const s1 = saveParsedSession({
    session: { source: "claude", source_id: "g-s1", title: "Infra", project_path: "/p/infra", project_name: "infra", model: "claude-opus-4", model_provider: "anthropic", git_origin_url: "https://github.com/h/infra" },
    messages: [{ session_id: "", role: "user", content: "x", sequence_num: 0 }],
    toolCalls: [
      { session_id: "", tool_name: "Bash", tool_input: "ls" },
      { session_id: "", tool_name: "Read", tool_input: "file" },
    ],
  });
  s1Id = s1.id;
  saveParsedSession({
    session: { source: "codex", source_id: "g-s2", title: "Web", project_path: "/p/web", project_name: "web", model: "gpt-5", model_provider: "openai" },
    messages: [{ session_id: "", role: "user", content: "y", sequence_num: 0 }],
    toolCalls: [{ session_id: "", tool_name: "Bash", tool_input: "pwd" }],
  });
});

afterEach(() => {
  closeDatabase();
  delete process.env.SESSIONS_DB_PATH;
});

describe("listEntities", () => {
  it("derives entities of all types with session counts", () => {
    const all = listEntities();
    const byType = (t: string) => all.filter((e) => e.type === t).map((e) => e.name).sort();
    expect(byType("project")).toEqual(["infra", "web"]);
    expect(byType("model")).toEqual(["claude-opus-4", "gpt-5"]);
    expect(byType("provider")).toEqual(["anthropic", "openai"]);
    expect(byType("repo")).toEqual(["https://github.com/h/infra"]);
    expect(byType("tool")).toEqual(["Bash", "Read"]);
  });

  it("counts sessions per tool across sessions", () => {
    const tools = listEntities("tool");
    expect(tools.find((e) => e.name === "Bash")?.session_count).toBe(2);
    expect(tools.find((e) => e.name === "Read")?.session_count).toBe(1);
  });
});

describe("relatedSessions", () => {
  it("finds sessions linked to a tool", () => {
    expect(relatedSessions("tool", "Bash")).toHaveLength(2);
    expect(relatedSessions("tool", "Read")).toHaveLength(1);
  });

  it("finds sessions linked to a project / model / repo", () => {
    expect(relatedSessions("project", "infra")).toHaveLength(1);
    expect(relatedSessions("model", "gpt-5")).toHaveLength(1);
    expect(relatedSessions("repo", "https://github.com/h/infra")).toHaveLength(1);
  });
});

describe("sessionGraph", () => {
  it("returns a session's entity neighborhood", () => {
    const g = sessionGraph(s1Id);
    expect(g?.project).toBe("infra");
    expect(g?.model).toBe("claude-opus-4");
    expect(g?.provider).toBe("anthropic");
    expect(g?.repo).toBe("https://github.com/h/infra");
    expect(g?.tools.sort()).toEqual(["Bash", "Read"]);
  });

  it("returns null for an unknown session", () => {
    expect(sessionGraph("nope")).toBeNull();
  });
});
