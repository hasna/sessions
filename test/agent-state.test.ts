import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildActiveAgentsResponse, buildSessionHealthResponse } from "../src/lib/agent-state.js";
import { closeDatabase, getDatabase, resetDatabase } from "../src/db/database.js";
import { saveParsedSession } from "../src/db/sessions.js";

const repoRoot = join(import.meta.dir, "..");
const TEST_DIR = join(import.meta.dir, ".test-agent-state");
const DB_PATH = join(TEST_DIR, "sessions.db");

function writeFakeTmux(): string {
  const path = join(TEST_DIR, "fake-tmux.sh");
  const fakeGitHubToken = `gh${"p"}_1234567890abcdef`;
  writeFileSync(
    path,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "list-panes" ]]; then
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' work 0 0 %1 codewith '/tmp/project-token=${fakeGitHubToken}' 111 0
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' work 0 1 %2 bash /tmp/project 112 0
  exit 0
fi
if [[ "$1" == "capture-pane" ]]; then
  if [[ "$3" == "work:0.0" ]]; then
    printf 'Hasna Codewith CLI\\nmodel: gpt-5\\n› ready\\n'
  else
    printf '$ shell\\n'
  fi
  exit 0
fi
echo "unexpected fake tmux args: $*" >&2
exit 2
`,
    "utf-8"
  );
  chmodSync(path, 0o755);
  return path;
}

function runCli(args: string[], env: Record<string, string> = {}) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.tsx", ...args],
    cwd: repoRoot,
    env: {
      ...process.env,
      SESSIONS_DB_PATH: DB_PATH,
      HASNA_SESSIONS_DB_PATH: DB_PATH,
      HASNA_SESSIONS_DIR: join(TEST_DIR, "sessions-home"),
      ...env,
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

function seedSession() {
  const fakeGitHubToken = `gh${"p"}_1234567890abcdef`;
  const longSecretTitle = `Health fixture ${fakeGitHubToken} ${"x".repeat(300)}`;
  process.env.SESSIONS_DB_PATH = DB_PATH;
  process.env.HASNA_SESSIONS_DB_PATH = DB_PATH;
  resetDatabase();
  getDatabase();
  saveParsedSession({
    session: {
      source: "claude",
      source_id: "health-session-001",
      source_path: `/tmp/${"nested/".repeat(80)}health-session-001.jsonl`,
      title: longSecretTitle,
      project_path: "/tmp/health-project",
      project_name: "health-project",
      ended_at: "2026-01-01T00:00:00.000Z",
    },
    messages: [
      { session_id: "", role: "user", content: "please run a check", sequence_num: 0, timestamp: "2026-01-01T00:00:00.000Z" },
      { session_id: "", role: "assistant", content: "running it", sequence_num: 1, timestamp: "2026-01-01T00:01:00.000Z" },
    ],
    toolCalls: [
      { session_id: "", tool_name: "Bash", tool_input: "bun test", status: "error", timestamp: "2026-01-01T00:01:00.000Z" },
    ],
  });
  closeDatabase();
  delete process.env.SESSIONS_DB_PATH;
  delete process.env.HASNA_SESSIONS_DB_PATH;
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  seedSession();
});

afterEach(() => {
  closeDatabase();
  delete process.env.SESSIONS_DB_PATH;
  delete process.env.HASNA_SESSIONS_DB_PATH;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("agent abstraction state", () => {
  it("returns bounded redacted active-agent state from tmux", () => {
    const fakeTmux = writeFakeTmux();
    const response = buildActiveAgentsResponse({
      tmuxCommand: fakeTmux,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(response.schema_version).toBe("sessions.active_agents.v1");
    expect(response.source.available).toBe(true);
    expect(response.total).toBe(1);
    expect(response.agents).toHaveLength(1);
    expect(response.agents[0].target).toBe("work:0.0");
    expect(response.agents[0].cwd).toContain("[REDACTED_SECRET]");
    expect(response.agents[0].classification).toMatchObject({
      target_kind: "agent",
      agent_kind: "codewith",
      composer_state: "idle",
      can_receive_prompt: true,
      recommended_submit_key: "Enter",
    });

    const withUnknown = buildActiveAgentsResponse({
      tmuxCommand: fakeTmux,
      includeUnknown: true,
      now: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(withUnknown.total).toBe(2);
    expect(withUnknown.agents[1].classification.target_kind).toBe("shell");
  });

  it("returns compact session health with resume command and evidence paths", () => {
    process.env.SESSIONS_DB_PATH = DB_PATH;
    process.env.HASNA_SESSIONS_DB_PATH = DB_PATH;
    resetDatabase();
    const response = buildSessionHealthResponse({
      id: "health-session-001",
      now: new Date("2026-01-01T02:00:00.000Z"),
      staleMinutes: 60,
    });

    expect(response.schema_version).toBe("sessions.session_health.v1");
    expect(response.sessions).toHaveLength(1);
    expect(response.sessions[0].cwd).toBe("/tmp/health-project");
    expect(response.sessions[0].title).toContain("[REDACTED_SECRET]");
    expect(response.sessions[0].title!.length).toBeLessThanOrEqual(160);
    expect(response.sessions[0].command.shell).toBe("claude --resume health-session-001");
    expect(response.sessions[0].classification.activity).toBe("stale");
    expect(response.sessions[0].classification.health).toBe("warning");
    expect(response.sessions[0].evidence_paths[0].length).toBeLessThanOrEqual(512);
    expect(response.lookup).toEqual({ id: "health-session-001", status: "found", matches: 1 });
    expect(response.sessions[0].issues.map((issue) => issue.type)).toEqual(["stale", "tool_errors"]);

    const listResponse = buildSessionHealthResponse({
      now: new Date("2026-01-01T02:00:00.000Z"),
      limit: 1,
    });
    expect(listResponse.total).toBe(1);
    expect(listResponse.truncated).toBe(false);
  });

  it("exposes active-agents and session-health through CLI JSON by default", () => {
    const fakeTmux = writeFakeTmux();

    const activeResult = runCli(["active-agents"], { SESSIONS_TMUX: fakeTmux });
    expect(Buffer.from(activeResult.stdout).toString("utf-8")).not.toContain("\n  ");
    const active = parseJsonOutput(activeResult);
    expect(active.schema_version).toBe("sessions.active_agents.v1");
    expect(active.agents[0].classification.agent_kind).toBe("codewith");

    const healthResult = runCli(["session-health", "health-session-001"]);
    expect(Buffer.from(healthResult.stdout).toString("utf-8")).not.toContain("\n  ");
    const health = parseJsonOutput(healthResult);
    expect(health.schema_version).toBe("sessions.session_health.v1");
    expect(health.sessions[0].command.shell).toBe("claude --resume health-session-001");
    expect(health.sessions[0].title).toContain("[REDACTED_SECRET]");
  });
});
