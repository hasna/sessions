import { describe, expect, it } from "bun:test";
import {
  filterLivePanes,
  listLivePanes,
  listLivePanesFromTmuxOutput,
  normalizeProjectPath,
  parseLiveStatusFilter,
  type TmuxRunner,
} from "../src/lib/live.js";

const listOutput = [
  "open-router\t1\t1\t%101\tnode\t/home/hasna/Workspace/hasna/opensource/open-router\t0\t1\topen-router",
  "open-accounts\t1\t1\t%102\tnode\t/home/hasna/Workspace/hasna/opensource/open-accounts\t0\t1\topen-accounts",
  "open-signatures\t1\t1\t%103\tcodewith\t\t1\t1\thasna",
  "open-gateway\t1\t1\t%104\tnode\t/home/hasna/Workspace/hasna/opensource/open-gateway\t0\t1\topen-gateway",
  "open-sessions\t1\t1\t%105\tbash\t/home/hasna/Workspace/hasna/opensource/open-sessions\t0\t1\tspark02",
  "ops\t1\t1\t%106\tbash\t/home/hasna\t0\t1\tspark02",
  "open-notes\t1\t1\t%107\tnode\t/home/hasna/Workspace/hasna/opensource/open-notes\t0\t1\topen-notes",
  "open-aicopilot\t1\t1\t%108\tnode\t/home/hasna/Workspace/hasna/opensource/open-aicopilot\t0\t1\topen-aicopilot",
  "open-terminal\t1\t1\t%109\tnode\t/home/hasna/Workspace/hasna/opensource/open-terminal\t0\t1\topen-terminal",
  "worker-router\t1\t1\t%110\tnode\t/home/hasna/Workspace/hasna/opensource/open-router/packages/api\t0\t1\tapi",
].join("\n");

const captures: Record<string, string> = {
  "%101": [
    "Ran bun test",
    "",
    "Updated Plan",
    "  - Run final validation",
    "",
    "\u203a Run /review on my current changes",
    "  gpt-5.5 xhigh fast | Main [default]   Pursuing goal 3/4 (1m)",
    "",
    "Working (25m 20s | esc to interrupt)",
  ].join("\n"),
  "%102": [
    "Fixed on spark02.",
    "",
    "  Goal completed. Usage: 189,540 tokens, about 11m43s.",
    "",
    "\u203a Improve documentation in @filename",
    "  gpt-5.5 xhigh fast | Main [default]   Goal achieved (11m)",
  ].join("\n"),
  "%103": [
    "  Goal blocked (/goal resume)",
    "",
    "Pane is dead (signal 15, Sun Jun 21 15:54:21 2026)",
  ].join("\n"),
  "%104": [
    "Hasna Codewith",
    "",
    "Do you trust this folder? confirm?",
  ].join("\n"),
  "%105": "hasna@spark02:~/workspace/hasna/opensource/open-sessions$",
  "%106": "hasna@spark02:~$",
  "%107": "gpt-5.5 xhigh fast | account010 | Main [default]\nnew task? /clear to save 469k context",
  "%108": [
    "Blocked machines:",
    "- apple01: SSH times out",
    "",
    "\u203a Run /review on my current changes",
    "  gpt-5.5 xhigh fast | Main [default]   Goal achieved (30m)",
  ].join("\n"),
  "%109": [
    "Earlier transcript:",
    "  Goal blocked (/goal resume)",
    "",
    "User resumed the goal.",
    "",
    "\u203a Continue implementation",
    "  gpt-5.5 xhigh fast | Main [default]   Pursuing goal (8m)",
  ].join("\n"),
  "%110": "Running tests for open-router package\nWorking (2m | esc to interrupt)",
};

describe("live tmux panes", () => {
  it("classifies captured Codewith, dead, attention, and shell pane fixtures", () => {
    const panes = listLivePanesFromTmuxOutput(listOutput, captures, "spark02");
    const byTarget = Object.fromEntries(panes.map((pane) => [pane.target, pane]));

    expect(byTarget["open-router:1.1"].status).toBe("active");
    expect(byTarget["open-router:1.1"].lastVisibleLine).toContain("Working");
    expect(byTarget["open-accounts:1.1"].status).toBe("idle");
    expect(byTarget["open-gateway:1.1"].status).toBe("needs_attention");
    expect(byTarget["open-signatures:1.1"].status).toBe("dead");
    expect(byTarget["open-sessions:1.1"].status).toBe("idle");
    expect(byTarget["open-notes:1.1"].status).toBe("idle");
    expect(byTarget["open-aicopilot:1.1"].status).toBe("idle");
    expect(byTarget["open-terminal:1.1"].status).toBe("active");
    expect(byTarget["worker-router:1.1"].status).toBe("active");
    expect(byTarget["worker-router:1.1"].projectPath).toBe("/home/hasna/workspace/hasna/opensource/open-router");
    expect(byTarget["worker-router:1.1"].projectSlug).toBe("open-router");
    expect(byTarget["worker-router:1.1"].isOpenSession).toBe(true);
    expect(byTarget["ops:1.1"].status).toBe("idle");
  });

  it("normalizes uppercase Workspace paths when deriving project paths", () => {
    const panes = listLivePanesFromTmuxOutput(listOutput, captures, "spark02");
    const router = panes.find((pane) => pane.target === "open-router:1.1");

    expect(router?.projectPath).toBe("/home/hasna/workspace/hasna/opensource/open-router");
    expect(router?.projectSlug).toBe("open-router");
    expect(normalizeProjectPath("/home/hasna/Workspace/hasna/opensource/open-router/")).toBe(
      "/home/hasna/workspace/hasna/opensource/open-router"
    );
  });

  it("filters open-name panes and requested statuses", () => {
    const panes = listLivePanesFromTmuxOutput(listOutput, captures, "spark02");
    const inactiveOpen = filterLivePanes(panes, {
      openOnly: true,
      statuses: ["idle", "dead", "needs_attention"],
    });

    expect(inactiveOpen.map((pane) => pane.target).sort()).toEqual([
      "open-accounts:1.1",
      "open-aicopilot:1.1",
      "open-gateway:1.1",
      "open-notes:1.1",
      "open-sessions:1.1",
      "open-signatures:1.1",
    ]);
    expect(inactiveOpen.some((pane) => pane.session === "ops")).toBe(false);
  });

  it("filters by normalized project selector and machine", () => {
    const panes = listLivePanesFromTmuxOutput(listOutput, captures, "spark02");
    const filtered = filterLivePanes(panes, {
      project: "/home/hasna/Workspace/hasna/opensource/open-router",
      machine: "spark02",
    });

    expect(filtered.map((pane) => pane.target).sort()).toEqual([
      "open-router:1.1",
      "worker-router:1.1",
    ]);
    expect(filterLivePanes(panes, { machine: "apple03" })).toHaveLength(0);
  });

  it("discovers panes through a tmux runner and captures by pane id", () => {
    const seenCaptureTargets: string[] = [];
    const runner: TmuxRunner = (args) => {
      if (args[0] === "list-panes") {
        return { exitCode: 0, stdout: listOutput, stderr: "" };
      }
      if (args[0] === "capture-pane") {
        const paneId = args[args.indexOf("-t") + 1];
        seenCaptureTargets.push(paneId);
        return { exitCode: 0, stdout: captures[paneId] ?? "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected tmux command" };
    };

    const panes = listLivePanes({
      runner,
      openOnly: true,
      statuses: parseLiveStatusFilter("active"),
    });

    expect(seenCaptureTargets).toContain("%101");
    expect(panes.map((pane) => pane.target)).toEqual([
      "open-router:1.1",
      "open-terminal:1.1",
      "worker-router:1.1",
    ]);
  });

  it("rejects invalid status filters", () => {
    expect(() => parseLiveStatusFilter("active,stuck")).toThrow("Invalid --status value");
  });
});
