import { describe, expect, it } from "bun:test";
import {
  scanWatchdogFromTmuxOutput,
  scanWatchdogSessions,
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


const listOutput = [
  "platform-alumia-dev-1\tplatform-alumia-dev-1\t0\t0\tclaude\t/work/platform-alumia-dev-1\t0",
  "platform-alumia-dev-2\tplatform-alumia-dev-2\t0\t0\tbash\t/work/platform-alumia-dev-2\t0",
  "platform-alumia-dev-3\tplatform-alumia-dev-3\t0\t0\tsh\t/work/platform-alumia-dev-3\t1",
  "platform-alumia-dev-4\tlogs\t1\t0\tbash\t/work/platform-alumia-dev-4\t0",
  "platform-alumia-dev\tplatform-alumia-dev\t0\t0\tbash\t/work/platform-alumia-dev\t0",
  "standalone-shell\tstandalone-shell\t0\t0\tbash\t/work/standalone-shell\t0",
  "other-family-1\tother-family-1\t0\t0\tbash\t/work/other-family-1\t0",
].join("\n");

describe("tmux watchdog scanner", () => {
  it("reports dead and crashed primary panes only when a Claude sibling is healthy", () => {
    expect(scanWatchdogFromTmuxOutput(listOutput)).toEqual([
      {
        session_name: "platform-alumia-dev-2",
        window_target: "platform-alumia-dev-2:0",
        status: "crashed",
        sibling_dir: "/work/platform-alumia-dev-2",
      },
      {
        session_name: "platform-alumia-dev-3",
        window_target: "platform-alumia-dev-3:0",
        status: "dead",
        sibling_dir: "/work/platform-alumia-dev-3",
      },
    ]);
  });

  it("does not treat non-primary windows or unrelated shell sessions as agents", () => {
    const candidates = scanWatchdogFromTmuxOutput(listOutput);

    expect(
      candidates.some((candidate) => candidate.session_name === "platform-alumia-dev-4")
    ).toBe(false);
    expect(
      candidates.some((candidate) => candidate.session_name === "platform-alumia-dev")
    ).toBe(false);
    expect(
      candidates.some((candidate) => candidate.session_name === "standalone-shell")
    ).toBe(false);
    expect(
      candidates.some((candidate) => candidate.session_name === "other-family-1")
    ).toBe(false);
  });

  it("supports non-hyphen numbered sibling session names", () => {
    const accountOutput = [
      "account010\taccount010\t0\t0\tclaude\t/work/account010\t0",
      "account011\taccount011\t0\t0\tbash\t/work/account011\t0",
    ].join("\n");

    expect(scanWatchdogFromTmuxOutput(accountOutput)).toEqual([
      {
        session_name: "account011",
        window_target: "account011:0",
        status: "crashed",
        sibling_dir: "/work/account011",
      },
    ]);
  });

  it("lists tmux panes with the watchdog format through the injected runner", () => {
    const calls: string[][] = [];
    const runner: TmuxRunner = (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: listOutput, stderr: "" };
    };

    expect(scanWatchdogSessions({ runner })).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 3)).toEqual(["list-panes", "-a", "-F"]);
    expect(calls[0][3]).toContain("#{window_name}");
    expect(calls[0][3]).toContain("#{pane_dead}");
  });

  it("returns no candidates when tmux listing fails", () => {
    const runner: TmuxRunner = () => ({ exitCode: 1, stdout: "", stderr: "no server running" });
    expect(scanWatchdogSessions({ runner })).toEqual([]);
  });
});
