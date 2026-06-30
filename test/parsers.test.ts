import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeParser } from "../src/lib/ingest/claude.js";
import { CodexParser } from "../src/lib/ingest/codex.js";
import { GeminiParser } from "../src/lib/ingest/gemini.js";
import { flattenContent } from "../src/lib/ingest/types.js";
import { getParser, listParsers } from "../src/lib/ingest/index.js";
import { getDatabase, resetDatabase, closeDatabase } from "../src/db/database.js";
import { saveParsedSession, getMessages, getToolCalls } from "../src/db/sessions.js";

let root: string;

const CLAUDE_LINES = [
  JSON.stringify({ type: "permission-mode", sessionId: "sess-claude-1" }),
  JSON.stringify({
    type: "user",
    message: { role: "user", content: "deploy the app to staging" },
    uuid: "u1",
    parentUuid: null,
    timestamp: "2026-05-01T10:00:00Z",
    cwd: "/Users/h/Workspace/myapp",
    sessionId: "sess-claude-1",
    version: "2.1.0",
    gitBranch: "main",
  }),
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-opus-4",
      content: [
        { type: "text", text: "Deploying now." },
        { type: "tool_use", name: "Bash", input: { command: "kubectl apply" } },
      ],
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
    },
    uuid: "a1",
    parentUuid: "u1",
    timestamp: "2026-05-01T10:00:05Z",
    sessionId: "sess-claude-1",
  }),
].join("\n");

const CODEX_LINES = [
  JSON.stringify({
    timestamp: "2026-05-02T09:00:00Z",
    type: "session_meta",
    payload: {
      id: "sess-codex-1",
      cwd: "/Users/h/Workspace/api",
      cli_version: "0.91.0",
      model_provider: "openai",
      git: { branch: "dev", commit_hash: "abc123", repository_url: "https://github.com/h/api" },
    },
  }),
  JSON.stringify({
    timestamp: "2026-05-02T09:00:01Z",
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the failing test" }] },
  }),
  JSON.stringify({
    timestamp: "2026-05-02T09:00:02Z",
    type: "response_item",
    payload: { type: "function_call", name: "shell", arguments: '{"cmd":"pytest"}', call_id: "c1" },
  }),
  JSON.stringify({
    timestamp: "2026-05-02T09:00:03Z",
    type: "response_item",
    payload: { type: "function_call_output", call_id: "c1", output: "1 passed" },
  }),
  JSON.stringify({
    timestamp: "2026-05-02T09:00:04Z",
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fixed it." }] },
  }),
].join("\n");

const GEMINI_LOGS = JSON.stringify([
  { sessionId: "g1", messageId: 0, type: "user", message: "hello gemini", timestamp: "2026-05-03T08:00:00Z" },
  { sessionId: "g1", messageId: 1, type: "user", message: "second prompt", timestamp: "2026-05-03T08:01:00Z" },
  { sessionId: "g2", messageId: 0, type: "user", message: "other session", timestamp: "2026-05-03T09:00:00Z" },
]);

let claudeFile: string;
let codexFile: string;
let geminiFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sessions-parse-"));
  // Claude layout: <CLAUDE_PATH>/projects/<enc>/<uuid>.jsonl
  const cdir = join(root, "claude", "projects", "-Users-h-Workspace-myapp");
  mkdirSync(cdir, { recursive: true });
  claudeFile = join(cdir, "sess-claude-1.jsonl");
  writeFileSync(claudeFile, CLAUDE_LINES);
  process.env.CLAUDE_PATH = join(root, "claude");

  // Codex layout: <CODEX_PATH>/sessions/2026/05/02/rollout-...jsonl
  const xdir = join(root, "codex", "sessions", "2026", "05", "02");
  mkdirSync(xdir, { recursive: true });
  codexFile = join(xdir, "rollout-2026-05-02T09-00-00-sess-codex-1.jsonl");
  writeFileSync(codexFile, CODEX_LINES);
  process.env.CODEX_PATH = join(root, "codex");

  // Gemini layout: <GEMINI_PATH>/tmp/<hash>/logs.json
  const gdir = join(root, "gemini", "tmp", "abc123hash");
  mkdirSync(gdir, { recursive: true });
  geminiFile = join(gdir, "logs.json");
  writeFileSync(geminiFile, GEMINI_LOGS);
  process.env.GEMINI_PATH = join(root, "gemini");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.CLAUDE_PATH;
  delete process.env.CODEX_PATH;
  delete process.env.GEMINI_PATH;
});

describe("flattenContent", () => {
  it("handles strings, text/thinking blocks, tool_result, input/output_text", () => {
    expect(flattenContent("hi")).toBe("hi");
    expect(flattenContent([{ type: "text", text: "a" }, { type: "thinking", thinking: "b" }])).toBe("a\nb");
    expect(flattenContent([{ type: "input_text", text: "x" }])).toBe("x");
    expect(flattenContent([{ type: "tool_result", content: "out" }])).toBe("out");
    expect(flattenContent(null)).toBe("");
  });
});

describe("ClaudeParser", () => {
  it("parses a real-shaped session, messages, and tool_use", () => {
    const [ps] = new ClaudeParser().parseFile(claudeFile);
    expect(ps).toBeTruthy();
    expect(ps.session.source).toBe("claude");
    expect(ps.session.source_id).toBe("sess-claude-1");
    expect(ps.session.project_path).toBe("/Users/h/Workspace/myapp");
    expect(ps.session.project_name).toBe("myapp");
    expect(ps.session.model).toBe("claude-opus-4");
    expect(ps.session.model_provider).toBe("anthropic");
    expect(ps.session.git_branch).toBe("main");
    expect(ps.session.cli_version).toBe("2.1.0");
    expect(ps.session.title).toBe("deploy the app to staging");
    expect(ps.session.total_input_tokens).toBe(10);
    expect(ps.session.total_output_tokens).toBe(20);
    expect(ps.messages).toHaveLength(2);
    expect(ps.toolCalls).toHaveLength(1);
    expect(ps.toolCalls[0].tool_name).toBe("Bash");
    expect(ps.toolCalls[0].message_id).toBe("sess-claude-1:a1");
  });

  it("listSessionFiles finds the fixture under CLAUDE_PATH", () => {
    const files = new ClaudeParser().listSessionFiles();
    expect(files.some((f) => f.endsWith("sess-claude-1.jsonl"))).toBe(true);
  });

  it("uses the filename (not the in-file sessionId) as source_id, so files sharing a sessionId don't collapse", () => {
    const dir = join(root, "claude", "projects", "-Users-h-Workspace-shared");
    mkdirSync(dir, { recursive: true });
    // Two distinct files that both reference the SAME in-file sessionId.
    const line = (uuid: string) =>
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, uuid, timestamp: "2026-05-01T10:00:00Z", cwd: "/Users/h/Workspace/shared", sessionId: "SHARED-PARENT" });
    writeFileSync(join(dir, "file-A.jsonl"), line("a"));
    writeFileSync(join(dir, "file-B.jsonl"), line("b"));

    const p = new ClaudeParser();
    const a = p.parseFile(join(dir, "file-A.jsonl"))[0];
    const b = p.parseFile(join(dir, "file-B.jsonl"))[0];
    expect(a.session.source_id).toBe("file-A");
    expect(b.session.source_id).toBe("file-B");
    expect(a.session.source_id).not.toBe(b.session.source_id);
    // the in-file sessionId is preserved in metadata
    expect(a.session.metadata?.claude_session_id).toBe("SHARED-PARENT");
  });

  it("does not use slash-command wrapper records as session titles", () => {
    const dir = join(root, "claude", "projects", "-Users-h-Workspace-client-dashboard");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "command-wrapper.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content:
              "<command-message>skill-project-maintenance</command-message> <command-name>/skill-project-maintenance</command-name> <command-args></command-args>",
          },
          uuid: "cmd",
          timestamp: "2026-05-01T10:00:00Z",
          cwd: "/Users/h/Workspace/client-dashboard",
          sessionId: "command-wrapper",
        }),
        JSON.stringify({
          type: "assistant",
          message: { role: "assistant", content: "done" },
          uuid: "a",
          timestamp: "2026-05-01T10:00:02Z",
          sessionId: "command-wrapper",
        }),
      ].join("\n")
    );

    const [ps] = new ClaudeParser().parseFile(file);
    expect(ps.session.title).toBeNull();
  });

  it("uses slash-command args as the title when they contain the user request", () => {
    const dir = join(root, "claude", "projects", "-Users-h-Workspace-client-dashboard");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "goal-command.jsonl");
    writeFileSync(
      file,
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content:
            "<command-name>/goal</command-name> <command-message>goal</command-message> <command-args>check and fix every border radius in the dashboard</command-args>",
        },
        uuid: "goal",
        timestamp: "2026-05-01T10:00:00Z",
        cwd: "/Users/h/Workspace/client-dashboard",
        sessionId: "goal-command",
      })
    );

    const [ps] = new ClaudeParser().parseFile(file);
    expect(ps.session.title).toBe("check and fix every border radius in the dashboard");
  });
});

describe("CodexParser", () => {
  it("parses session_meta, messages, and function_call + output", () => {
    const [ps] = new CodexParser().parseFile(codexFile);
    expect(ps.session.source).toBe("codex");
    expect(ps.session.source_id).toBe("sess-codex-1");
    expect(ps.session.project_name).toBe("api");
    expect(ps.session.model_provider).toBe("openai");
    expect(ps.session.git_branch).toBe("dev");
    expect(ps.session.git_sha).toBe("abc123");
    expect(ps.session.title).toBe("fix the failing test");
    expect(ps.messages).toHaveLength(2);
    expect(ps.toolCalls).toHaveLength(1);
    expect(ps.toolCalls[0].tool_name).toBe("shell");
    expect(ps.toolCalls[0].tool_input).toBe('{"cmd":"pytest"}');
    expect(ps.toolCalls[0].tool_output).toBe("1 passed");
  });

  it("listSessionFiles finds rollout files under CODEX_PATH", () => {
    expect(new CodexParser().listSessionFiles().some((f) => f.includes("rollout-"))).toBe(true);
  });
});

describe("GeminiParser", () => {
  it("splits a logs.json into one ParsedSession per sessionId", () => {
    const sessions = new GeminiParser().parseFile(geminiFile);
    expect(sessions).toHaveLength(2);
    const g1 = sessions.find((s) => s.session.source_id === "g1");
    expect(g1?.messages).toHaveLength(2);
    expect(g1?.session.title).toBe("hello gemini");
    expect(g1?.session.model_provider).toBe("google");
  });
});

describe("registry", () => {
  it("registers all three built-in parsers", () => {
    const names = listParsers().map((p) => p.source).sort();
    expect(names).toEqual(["claude", "codex", "gemini"]);
    expect(getParser("claude")?.source).toBe("claude");
  });
});

describe("parsers -> store (end to end)", () => {
  beforeEach(() => {
    process.env.SESSIONS_DB_PATH = ":memory:";
    resetDatabase();
    getDatabase();
  });
  afterEach(() => {
    closeDatabase();
    delete process.env.SESSIONS_DB_PATH;
  });

  it("saves a parsed claude session and links the tool call to its message", () => {
    const [ps] = new ClaudeParser().parseFile(claudeFile);
    const s = saveParsedSession(ps);
    expect(s.message_count).toBe(2);
    expect(s.tool_call_count).toBe(1);
    const msgs = getMessages(s.id);
    const tcs = getToolCalls(s.id);
    expect(tcs[0].message_id).toBe(msgs.find((m) => m.role === "assistant")?.id);
  });
});
