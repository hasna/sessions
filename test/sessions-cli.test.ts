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
