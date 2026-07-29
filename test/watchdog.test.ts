import { describe, expect, it } from "bun:test";
import {
  sessionsWatchdogRestart,
  sessionsWatchdogRestartAll,
  watchdogSessionPrefix,
} from "../src/lib/watchdog.js";
import type { TmuxRunner } from "../src/lib/live.js";

const healthySibling =
  "worker-02\t1\t0\t%102\tclaude\t/work/project\t0\t1\tworker-02";
const crashedWorker =
  "worker-01\t3\t0\t%101\tbash\t\t1\t1\tworker-01";
const crashedOther =
  "other-01\t1\t0\t%201\tbash\t\t1\t1\tother-01";

describe("tmux watchdog restart", () => {
  it("respawns a crashed pane from a healthy sibling and resumes Claude", async () => {
    const calls: string[][] = [];
    const sleeps: number[] = [];
    let polls = 0;
    const runner: TmuxRunner = (args) => {
      calls.push(args);
      if (args[0] === "list-panes") {
        return { exitCode: 0, stdout: [crashedWorker, healthySibling].join("\n"), stderr: "" };
      }
      if (args[0] === "display-message") {
        polls += 1;
        return { exitCode: 0, stdout: polls === 1 ? "bash\n" : "claude\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await sessionsWatchdogRestart("worker-01", {
      runner,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    expect(result).toMatchObject({
      requestedSession: "worker-01",
      crashedFound: 1,
      restarted: 1,
      skipped: 0,
    });
    expect(result.entries[0]).toMatchObject({
      sessionName: "worker-01",
      target: "worker-01:3.0",
      siblingDir: "/work/project",
      outcome: "restarted",
      claudeStarted: true,
    });
    expect(calls).toContainEqual([
      "respawn-pane",
      "-k",
      "-t",
      "worker-01:3.0",
      "-c",
      "/work/project",
    ]);
    expect(calls).toContainEqual([
      "send-keys",
      "-t",
      "worker-01:3.0",
      'claude --resume "worker-01"',
      "Enter",
    ]);
    expect(calls.filter((args) => args[0] === "display-message")).toHaveLength(2);
    expect(sleeps).toEqual([1_000, 1_000, 1_000]);
  });

  it("warns after 15 seconds when Claude does not start", async () => {
    const calls: string[][] = [];
    const warnings: string[] = [];
    const runner: TmuxRunner = (args) => {
      calls.push(args);
      if (args[0] === "list-panes") {
        return { exitCode: 0, stdout: [crashedWorker, healthySibling].join("\n"), stderr: "" };
      }
      if (args[0] === "display-message") {
        return { exitCode: 0, stdout: "bash\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await sessionsWatchdogRestart("worker-01", {
      runner,
      sleep: async () => {},
      warn: (message) => warnings.push(message),
    });

    expect(result.entries[0].outcome).toBe("claude_timeout");
    expect(result.entries[0].claudeStarted).toBe(false);
    expect(calls.filter((args) => args[0] === "display-message")).toHaveLength(15);
    expect(calls.filter((args) => args[0] === "send-keys")).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("within 15s; skipping message step");
  });

  it("skips crashed sessions that have no healthy sibling directory", async () => {
    const calls: string[][] = [];
    const warnings: string[] = [];
    const runner: TmuxRunner = (args) => {
      calls.push(args);
      if (args[0] === "list-panes") {
        return { exitCode: 0, stdout: crashedOther, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await sessionsWatchdogRestartAll({
      runner,
      sleep: async () => {},
      warn: (message) => warnings.push(message),
    });

    expect(result).toMatchObject({ crashedFound: 1, restarted: 0, skipped: 1 });
    expect(result.entries[0].outcome).toBe("skipped_no_sibling");
    expect(calls.some((args) => args[0] === "respawn-pane")).toBe(false);
    expect(warnings[0]).toContain("no healthy sibling directory");
  });

  it("derives only numbered sibling prefixes", () => {
    expect(watchdogSessionPrefix("worker-01")).toBe("worker");
    expect(watchdogSessionPrefix("account010")).toBe("account");
    expect(watchdogSessionPrefix("open-router")).toBe("open-router");
  });
});
