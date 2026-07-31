import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");
const TEST_DIR = join(import.meta.dir, ".test-sessions-cli");
const HOME_DIR = join(TEST_DIR, "home");
const PROJECTS_DIR = join(TEST_DIR, "projects");

// A fixed "today" so the --today history filter is deterministic.
const TODAY = new Date().toISOString().slice(0, 10);

function runCli(args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.tsx", ...args],
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: HOME_DIR,
      CLAUDE_PATH: TEST_DIR,
      // Force local-store mode: never touch a real cloud endpoint from a test.
      HASNA_SESSIONS_API_URL: "",
      HASNA_SESSIONS_API_KEY: "",
      HASNA_SESSIONS_MODE: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function runCloudCli(args: string[], apiUrl: string) {
  const child = Bun.spawn({
    cmd: ["bun", "run", "src/cli/index.tsx", ...args],
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: HOME_DIR,
      HASNA_SESSIONS_API_URL: apiUrl,
      HASNA_SESSIONS_API_KEY: "test-key",
      HASNA_SESSIONS_MODE: "",
      HASNA_SESSIONS_STORAGE_MODE: "",
      SESSIONS_API_URL: "",
      SESSIONS_API_KEY: "",
      SESSIONS_MODE: "",
      SESSIONS_STORAGE_MODE: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function parseJsonOutput(result: ReturnType<typeof Bun.spawnSync>) {
  expect(result.exitCode).toBe(0);
  expect(Buffer.from(result.stderr).toString("utf-8")).toBe("");
  return JSON.parse(Buffer.from(result.stdout).toString("utf-8"));
}

/** Ingest the fixture transcripts into the local (per-test HOME) SQLite index. */
function ingest() {
  const result = runCli(["ingest", "--force", "--json"]);
  expect(result.exitCode).toBe(0);
  return result;
}

function setupFixtures() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(PROJECTS_DIR, { recursive: true });
  mkdirSync(HOME_DIR, { recursive: true });

  const projectDir = join(PROJECTS_DIR, "-Users-test-sample-project");
  mkdirSync(projectDir, { recursive: true });

  writeFileSync(
    join(projectDir, "session-001.jsonl"),
    [
      JSON.stringify({
        type: "user",
        timestamp: `${TODAY}T09:00:00.000Z`,
        cwd: "/Users/test/sample-project",
        sessionId: "session-001",
        message: { role: "user", content: "hello world" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: `${TODAY}T09:03:00.000Z`,
        cwd: "/Users/test/sample-project",
        sessionId: "session-001",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "done" }],
        },
      }),
    ].join("\n"),
    "utf-8"
  );
}

beforeEach(() => {
  setupFixtures();
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("sessions CLI store-backed flows", () => {
  it("lists indexed sessions from the store", () => {
    ingest();
    const payload = parseJsonOutput(runCli(["list", "--json"]));

    expect(payload).toHaveLength(1);
    expect(payload[0].source).toBe("claude");
    expect(payload[0].source_id).toBe("session-001");
    expect(payload[0].project_name).toBe("sample-project");
    expect(payload[0].model).toBe("claude-sonnet-4-6");
  });

  it("renames a session by setting its title through the store", () => {
    ingest();
    const renamed = parseJsonOutput(
      runCli(["rename", "session-001", "important session", "--json"])
    );
    expect(renamed.source_id).toBe("session-001");
    expect(renamed.title).toBe("important session");

    const listed = parseJsonOutput(runCli(["list", "--json"]));
    expect(listed[0].title).toBe("important session");
  });

  it("resolves resume targets by id prefix and by project", () => {
    ingest();
    const byName = parseJsonOutput(runCli(["resume", "session-001", "--json"]));
    expect(byName.session.source_id).toBe("session-001");
    expect(byName.command).toEqual(["claude", "--resume", "session-001"]);

    const byProject = parseJsonOutput(
      runCli(["resume", "--project", "sample-project", "--json"])
    );
    expect(byProject.session.source_id).toBe("session-001");
  });

  it("resolves duplicate native ids with source-qualified CLI identifiers", () => {
    ingest();
    const created = parseJsonOutput(
      runCli(["create", "--source", "codewith", "--source-id", "session-001", "--json"]),
    );
    expect(created.source).toBe("codewith");

    const ambiguous = runCli(["show", "session-001", "--json"]);
    expect(ambiguous.exitCode).not.toBe(0);
    expect(Buffer.from(ambiguous.stderr).toString("utf-8")).toContain(
      "Ambiguous session identifier",
    );

    const qualified = parseJsonOutput(runCli(["show", "codewith:session-001", "--json"]));
    expect(qualified.session.source).toBe("codewith");

    const explicit = parseJsonOutput(runCli(["show", "session-001", "--source", "claude", "--json"]));
    expect(explicit.session.source).toBe("claude");
  });

  it("shows local session metadata without message lines when the preview limit is zero", () => {
    ingest();

    const result = runCli(["show", "session-001", "--messages", "0"]);
    const stdout = Buffer.from(result.stdout).toString("utf-8");

    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stderr).toString("utf-8")).toBe("");
    expect(stdout).toContain("source:");
    expect(stdout).toContain("counts:");
    expect(stdout).toContain("id:");
    expect(stdout).not.toContain("[user]");
    expect(stdout).not.toContain("[assistant]");
  });

  it("rejects a negative local message preview limit", () => {
    ingest();

    const result = runCli(["show", "session-001", "--messages", "-1"]);

    expect(result.exitCode).not.toBe(0);
    expect(Buffer.from(result.stderr).toString("utf-8")).toContain(
      "--messages must be a non-negative integer",
    );
  });

  it("returns local session metadata and no messages in JSON when the preview limit is zero", () => {
    ingest();

    const payload = parseJsonOutput(
      runCli(["show", "session-001", "--messages", "0", "--json"]),
    );

    expect(payload.session).toMatchObject({ source: "claude", source_id: "session-001" });
    expect(payload.messages).toEqual([]);
  });

  it("skips the HTTP message endpoint when the preview limit is zero", async () => {
    let messageRequests = 0;
    const session = {
      id: "cloud-session",
      source: "claude",
      source_id: "cloud-session",
      title: "Cloud metadata",
      model: "claude-sonnet-4-6",
      project_name: "sample-project",
      project_path: "/Users/test/sample-project",
      git_branch: "main",
      started_at: `${TODAY}T09:00:00.000Z`,
      ended_at: `${TODAY}T09:03:00.000Z`,
      message_count: 2,
      tool_call_count: 0,
      total_input_tokens: 10,
      total_output_tokens: 5,
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/sessions/cloud-session") return Response.json({ session });
        if (path === "/v1/sessions/cloud-session/messages") {
          messageRequests += 1;
          return Response.json({ messages: [{ role: "user", content: "should not fetch" }] });
        }
        if (path === "/v1/sessions/cloud-session/tool-calls") {
          return Response.json({ toolCalls: [] });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    try {
      const result = await runCloudCli(
        ["show", "cloud-session", "--messages", "0", "--json"],
        `http://127.0.0.1:${server.port}`,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const payload = JSON.parse(result.stdout);
      expect(payload.session).toMatchObject({ id: "cloud-session", title: "Cloud metadata" });
      expect(payload.messages).toEqual([]);
      expect(messageRequests).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  it("rejects empty source-qualified CLI rename targets without renaming the sole session", () => {
    const created = parseJsonOutput(
      runCli([
        "create",
        "--source",
        "codewith",
        "--source-id",
        "sole-session",
        "--title",
        "Original title",
        "--json",
      ]),
    );
    expect(created.source).toBe("codewith");

    const rename = runCli(["rename", "codewith:", "Should not apply", "--json"]);
    expect(rename.exitCode).not.toBe(0);
    expect(Buffer.from(rename.stderr).toString("utf-8")).toContain(
      "source-qualified identifiers must include a non-empty source id",
    );

    const after = parseJsonOutput(runCli(["show", "sole-session", "--json"]));
    expect(after.session.title).toBe("Original title");
  });

  it("supports history filters and transcript search through the store", () => {
    ingest();
    const historyPayload = parseJsonOutput(runCli(["history", "--today", "--json"]));
    expect(historyPayload).toHaveLength(1);
    expect(historyPayload[0].source_id).toBe("session-001");

    const searchPayload = parseJsonOutput(runCli(["transcript-search", "hello", "--json"]));
    expect(searchPayload.length).toBeGreaterThanOrEqual(1);
    expect(searchPayload[0].session_id).toBeDefined();
  });
});
