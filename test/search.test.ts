import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDatabase, resetDatabase, closeDatabase } from "../src/db/database.js";
import { saveParsedSession } from "../src/db/sessions.js";
import {
  search,
  searchMessages,
  searchSessions,
  searchToolCalls,
  toFtsQueries,
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

  it("adds punctuation-split variants for identifiers and domains", () => {
    expect(toFtsQueries("example.com")).toEqual(['"example.com"', '"example" "com"']);
    expect(toFtsQueries("project-alpha")).toEqual(['"project-alpha"', '"project" "alpha"']);
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

  it("continues past dense matches from one session to fill the unique-session limit", () => {
    saveParsedSession({
      session: { source: "claude", source_id: "many", title: "many", started_at: "2026-05-02T00:00:00.000Z" },
      messages: Array.from({ length: 20 }, (_, index) => ({
        session_id: "",
        role: "user" as const,
        content: `needle repeated hit ${index}`,
        sequence_num: index,
      })),
      toolCalls: [],
    });
    saveParsedSession({
      session: { source: "claude", source_id: "other", title: "other", started_at: "2026-05-01T00:00:00.000Z" },
      messages: [{ session_id: "", role: "user", content: "needle single other", sequence_num: 0 }],
      toolCalls: [],
    });

    const hits = searchMessages("needle", { limit: 2 });
    expect(hits).toHaveLength(2);
    expect(hits.map((hit) => hit.title).sort()).toEqual(["many", "other"]);
  });

  it("filters by source and project", () => {
    expect(searchMessages("error", { source: "codex" })).toHaveLength(1);
    expect(searchMessages("error", { source: "claude" })).toHaveLength(0);
    expect(searchMessages("kubernetes", { project_path: "/p/infra" })).toHaveLength(1);
    expect(searchMessages("kubernetes", { project_path: "/p/web" })).toHaveLength(0);
    expect(searchMessages("kubernetes", { project_path: "infra" })).toHaveLength(1);
  });

  it("returns nothing for non-matching queries", () => {
    expect(search("nonexistentterm")).toHaveLength(0);
  });

  it("normalizes non-positive limits to the default limit", () => {
    expect(searchMessages("the", { limit: -1 })).toHaveLength(2);
  });

  it("does not throw on punctuation-heavy input", () => {
    expect(() => search('what about "this" (and that)?')).not.toThrow();
  });

  it("matches dotted domains through punctuation-aware variants", () => {
    saveParsedSession({
      session: { source: "codex", source_id: "domain", title: "Domain lookup", project_path: "/p/project-alpha", project_name: "project-alpha" },
      messages: [{ session_id: "", role: "user", content: "ship example.com next", sequence_num: 0 }],
      toolCalls: [],
    });

    const hits = searchMessages("example.com");
    expect(hits).toHaveLength(1);
    expect(hits[0].project_name).toBe("project-alpha");
  });
});

describe("searchSessions", () => {
  it("matches on title / project name", () => {
    const hits = searchSessions("billing");
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Fix billing bug");
  });

  it("returns a snippet from the session field that matched", () => {
    const hits = searchSessions("infra");
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain("[infra]");
  });
});

describe("searchToolCalls", () => {
  it("matches on tool input/output", () => {
    const hits = searchToolCalls("kubectl");
    expect(hits).toHaveLength(1);
    expect(hits[0].tool_name).toBe("Bash");
  });

  it("returns a snippet from the tool field that matched", () => {
    const hits = searchToolCalls("configured");
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toContain("[configured]");
  });
});

describe("search", () => {
  it("combines messages, session metadata, and tool-call output", () => {
    saveParsedSession({
      session: { source: "codex", source_id: "example-domain", title: "Repo inventory", project_path: "/p/project-alpha", project_name: "project-alpha" },
      messages: [{ session_id: "", role: "user", content: "inventory repos", sequence_num: 0 }],
      toolCalls: [
        {
          session_id: "",
          tool_name: "exec_command",
          tool_input: "gh repo list example-org",
          tool_output: "project-alpha public 2026-05-25T12:14:28Z example.com",
        },
      ],
    });

    const domainHits = search("example.com");
    expect(domainHits).toHaveLength(1);
    expect(domainHits[0].project_name).toBe("project-alpha");
    expect(domainHits[0].snippet).toContain("exec_command");

    const dashedHits = search("project-alpha");
    expect(dashedHits.some((hit) => hit.project_name === "project-alpha")).toBe(true);
  });

  it("prioritizes exact identifier metadata over generic message hits at small limits", () => {
    for (let index = 0; index < 8; index++) {
      saveParsedSession({
        session: { source: "claude", source_id: `generic-alpha-${index}`, title: `Generic alpha ${index}` },
        messages: [{ session_id: "", role: "user", content: `generic project alpha discussion ${index}`, sequence_num: 0 }],
        toolCalls: [],
      });
    }
    saveParsedSession({
      session: {
        source: "codex",
        source_id: "exact-alpha",
        title: "Exact domain repo",
        project_path: "/repo/example.com/project-alpha",
        project_name: "project-alpha",
      },
      messages: [{ session_id: "", role: "user", content: "repo inventory", sequence_num: 0 }],
      toolCalls: [],
    });

    const hits = search("project-alpha", { limit: 5 });
    expect(hits[0].project_name).toBe("project-alpha");
  });

  it("prefers the exact project identity over a broad parent workspace match", () => {
    saveParsedSession({
      session: {
        source: "claude",
        source_id: "workspace-alpha",
        title: "Broad workspace project-alpha notes",
        project_path: "/repo",
        project_name: "repo",
      },
      messages: [{ session_id: "", role: "user", content: "project-alpha project-alpha project-alpha", sequence_num: 0 }],
      toolCalls: [],
    });
    saveParsedSession({
      session: {
        source: "codex",
        source_id: "specific-alpha",
        title: "Specific feature work",
        project_path: "/repo/project-alpha",
        project_name: "project-alpha",
      },
      messages: [{ session_id: "", role: "user", content: "project-alpha", sequence_num: 0 }],
      toolCalls: [],
    });

    const hits = search("project-alpha", { limit: 2 });
    expect(hits[0].project_name).toBe("project-alpha");
  });

  it("deprioritizes instruction preambles when ranking project searches", () => {
    saveParsedSession({
      session: {
        source: "codex",
        source_id: "instruction-preamble",
        title: "# AGENTS.md instructions for /Users/dev/Workspace/project-alpha <INSTRUCTIONS> project-alpha full plan",
        project_path: "/Users/dev/Workspace/project-alpha",
        project_name: "project-alpha",
        started_at: "2026-05-03T00:00:00.000Z",
      },
      messages: [
        {
          session_id: "",
          role: "user",
          content:
            "# AGENTS.md instructions for /Users/dev/Workspace/project-alpha\n\n<INSTRUCTIONS>\nproject-alpha full plan setup notes\n</INSTRUCTIONS>",
          sequence_num: 0,
        },
      ],
      toolCalls: [],
    });
    saveParsedSession({
      session: {
        source: "codex",
        source_id: "real-plan",
        title: "Project alpha full plan",
        project_path: "/Users/dev/Workspace/project-alpha",
        project_name: "project-alpha",
        started_at: "2026-05-02T00:00:00.000Z",
      },
      messages: [{ session_id: "", role: "user", content: "project-alpha full plan implementation priorities", sequence_num: 0 }],
      toolCalls: [],
    });

    const hits = search("project-alpha full plan", { project_path: "project-alpha", limit: 1 });
    expect(hits[0].title).toBe("Project alpha full plan");
  });
});
