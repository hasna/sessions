import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");
const TEST_DIR = join(import.meta.dir, ".test-sessions-cli");
const HOME_DIR = join(TEST_DIR, "home");
const PROJECTS_DIR = join(TEST_DIR, "projects");

function runCli(args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.tsx", ...args],
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: HOME_DIR,
      CLAUDE_PATH: TEST_DIR,
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
        timestamp: "2026-04-10T09:00:00.000Z",
        cwd: "/Users/test/sample-project",
        sessionId: "session-001",
        message: { role: "user", content: "hello" },
      }),
      JSON.stringify({
        type: "custom-title",
        timestamp: "2026-04-10T09:01:00.000Z",
        sessionId: "session-001",
        customTitle: "legacy-title",
      }),
      JSON.stringify({
        type: "agent-name",
        timestamp: "2026-04-10T09:02:00.000Z",
        sessionId: "session-001",
        agentName: "legacy-agent",
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-10T09:03:00.000Z",
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

describe("sessions CLI registry flows", () => {
  it("lists sessions with auto-generated friendly names", () => {
    const result = runCli(["list", "--json"]);
    const payload = parseJsonOutput(result);

    expect(payload).toHaveLength(1);
    expect(payload[0].sessionId).toBe("session-001");
    expect(payload[0].friendlyName).toBe("sample-project-00001");
    expect(payload[0].projectSlug).toBe("sample-project");
    expect(payload[0].customTitle).toBe("legacy-title");
    expect(payload[0].agentName).toBe("legacy-agent");
    expect(payload[0].lastModel).toBe("claude-sonnet-4-6");
  });

  it("renames sessions and preserves the manual name", () => {
    const renameResult = runCli([
      "rename",
      "session-001",
      "important-session",
      "--json",
    ]);
    const renamed = parseJsonOutput(renameResult);
    expect(renamed.friendlyName).toBe("important-session");
    expect(renamed.friendlyNameSource).toBe("manual");

    const listResult = runCli(["list", "--json"]);
    const listed = parseJsonOutput(listResult);
    expect(listed[0].friendlyName).toBe("important-session");
  });

  it("resolves resume targets by friendly name and by project", () => {
    const byName = runCli(["resume", "sample-project-00001", "--json"]);
    const namePayload = parseJsonOutput(byName);
    expect(namePayload.session.sessionId).toBe("session-001");
    expect(namePayload.command).toEqual(["claude", "--resume", "session-001"]);

    const byProject = runCli(["resume", "--project", "sample-project", "--json"]);
    const projectPayload = parseJsonOutput(byProject);
    expect(projectPayload.session.friendlyName).toBe("sample-project-00001");
  });

  it("supports history filters and transcript search", () => {
    const historyResult = runCli(["history", "--today", "--json"]);
    const historyPayload = parseJsonOutput(historyResult);
    expect(historyPayload).toHaveLength(1);
    expect(historyPayload[0].friendlyName).toBe("sample-project-00001");

    const searchResult = runCli(["transcript-search", "hello", "--json"]);
    const searchPayload = parseJsonOutput(searchResult);
    expect(searchPayload).toHaveLength(1);
    expect(searchPayload[0].session.sessionId).toBe("session-001");
    expect(searchPayload[0].snippet.toLowerCase()).toContain("hello");
  });
});
