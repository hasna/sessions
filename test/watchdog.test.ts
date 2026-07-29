import { describe, expect, it } from "bun:test";
import {
  scanWatchdogFromTmuxOutput,
  scanWatchdogSessions,
} from "../src/lib/watchdog.js";
import type { TmuxRunner } from "../src/lib/live.js";

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
