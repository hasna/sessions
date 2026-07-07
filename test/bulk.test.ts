import { describe, expect, it } from "bun:test";
import {
  buildBulkSessionPlan,
  listBulkLivePanes,
  parseConcurrency,
  parseJitterMs,
} from "../src/lib/bulk.js";
import type { LivePane, TmuxRunner } from "../src/lib/live.js";

function pane(target: string, status: LivePane["status"], overrides: Partial<LivePane> = {}): LivePane {
  const [session, paneTarget] = target.split(":");
  const [windowIndex, paneIndex] = paneTarget.split(".");
  return {
    target,
    session,
    windowIndex,
    paneIndex,
    paneId: `%${target.replace(/[^a-z0-9]/gi, "")}`,
    command: "node",
    cwd: `/home/hasna/Workspace/hasna/opensource/${session}`,
    projectPath: `/home/hasna/workspace/hasna/opensource/${session}`,
    projectSlug: session,
    machine: "spark02",
    title: session,
    status,
    statusReason: "fixture",
    paneDead: status === "dead",
    paneActive: true,
    lastVisibleLine: `${session} ${status}`,
    isOpenSession: session.startsWith("open-"),
    ...overrides,
  };
}

describe("bulk session planner", () => {
  it("plans read-only status checks with filters and load hints", () => {
    const plan = buildBulkSessionPlan({
      action: "status",
      panes: [
        pane("open-router:1.1", "active"),
        pane("open-accounts:1.1", "idle"),
        pane("ops:1.1", "idle", { isOpenSession: false }),
      ],
      openOnly: true,
      statuses: ["active", "idle"],
      now: new Date("2026-06-23T07:00:00.000Z"),
      load1: 1,
      cpuCount: 4,
    });

    expect(plan.schemaVersion).toBe("sessions.bulk.v1");
    expect(plan.observedAt).toBe("2026-06-23T07:00:00.000Z");
    expect(plan.summary).toMatchObject({ totalPanes: 3, selected: 2, planned: 2, refused: 0 });
    expect(plan.guard.hints.activeAgentCount).toBe(1);
    expect(plan.guard.hints.captureScope).toBe("prefiltered");
    expect(plan.guard.hints.loadPerCore).toBe(0.25);
    expect(plan.entries.map((entry) => entry.target)).toEqual(["open-router:1.1", "open-accounts:1.1"]);
    expect(plan.entries[0].isOpenSession).toBe(true);
  });

  it("refuses mutating work without --yes", () => {
    const plan = buildBulkSessionPlan({
      action: "stop",
      panes: [pane("open-accounts:1.1", "idle")],
      statuses: ["idle"],
      statusFilterExplicit: true,
      dryRun: false,
      yes: false,
      load1: 0,
      cpuCount: 4,
    });

    expect(plan.summary.refused).toBe(1);
    expect(plan.entries[0].reason).toContain("requires --yes");
  });

  it("refuses non-dry-run mutation when execution is disabled", () => {
    const plan = buildBulkSessionPlan({
      action: "stop",
      panes: [pane("open-accounts:1.1", "idle")],
      statuses: ["idle"],
      statusFilterExplicit: true,
      dryRun: false,
      yes: true,
      executionEnabled: false,
      load1: 0,
      cpuCount: 4,
    });

    expect(plan.summary.refused).toBe(1);
    expect(plan.entries[0].reason).toContain("execution backend is not enabled");
    expect(plan.entries[0].argv).toEqual(["tmux", "kill-pane", "-t", "%openaccounts11"]);
    expect(plan.entries[0].commandPreview).toContain("\"tmux\"");
  });

  it("queues mutating work behind concurrency and deterministic jitter when confirmed", () => {
    const plan = buildBulkSessionPlan({
      action: "restart",
      panes: [
        pane("open-a:1.1", "idle"),
        pane("open-b:1.1", "idle"),
        pane("open-c:1.1", "idle"),
      ],
      statuses: ["idle"],
      statusFilterExplicit: true,
      yes: true,
      concurrency: 2,
      jitterMs: 100,
      load1: 0,
      cpuCount: 4,
    });

    expect(plan.summary.queued).toBe(3);
    expect(plan.entries.every((entry) => entry.queue === "local")).toBe(true);
    expect(plan.entries[0].scheduledDelayMs).toBeGreaterThanOrEqual(0);
    expect(plan.entries[0].scheduledDelayMs).toBeLessThanOrEqual(100);
    expect(plan.entries[2].scheduledDelayMs).toBeGreaterThanOrEqual(100);
  });

  it("refuses active panes unless the active status was explicit", () => {
    const implicit = buildBulkSessionPlan({
      action: "restart",
      panes: [pane("open-router:1.1", "active")],
      yes: true,
      load1: 0,
      cpuCount: 4,
    });

    const explicit = buildBulkSessionPlan({
      action: "restart",
      panes: [pane("open-router:1.1", "active")],
      statuses: ["active"],
      statusFilterExplicit: true,
      yes: true,
      load1: 0,
      cpuCount: 4,
    });

    expect(implicit.entries[0].decision).toBe("refused");
    expect(implicit.entries[0].reason).toContain("--status active");
    expect(explicit.entries[0].decision).toBe("queued");
  });

  it("reports overload warnings without refusing read-only status entries", () => {
    const plan = buildBulkSessionPlan({
      action: "status",
      panes: [
        pane("open-a:1.1", "active"),
        pane("open-b:1.1", "active"),
      ],
      maxActiveAgents: 1,
      load1: 0,
      cpuCount: 4,
    });

    expect(plan.guard.ok).toBe(false);
    expect(plan.guard.reasons[0]).toContain("active agent count");
    expect(plan.summary.planned).toBe(2);
    expect(plan.summary.refused).toBe(0);
    expect(plan.entries[0].reason).toContain("guard warnings");
  });

  it("refuses mutating plans across multiple machines", () => {
    const plan = buildBulkSessionPlan({
      action: "stop",
      panes: [
        pane("open-a:1.1", "idle", { machine: "spark02" }),
        pane("open-b:1.1", "idle", { machine: "apple03" }),
      ],
      statuses: ["idle"],
      statusFilterExplicit: true,
      dryRun: true,
      load1: 0,
      cpuCount: 4,
    });

    expect(plan.guard.ok).toBe(false);
    expect(plan.guard.reasons).toContain("mutating bulk operations are limited to one machine per run");
    expect(plan.summary.refused).toBe(2);
  });

  it("validates concurrency and jitter options", () => {
    expect(parseConcurrency("3")).toBe(3);
    expect(parseJitterMs("250")).toBe(250);
    expect(() => parseConcurrency("0")).toThrow("--concurrency");
    expect(() => parseJitterMs("-1")).toThrow("--jitter");
  });

  it("prefilters tmux captures for open-only bulk discovery", () => {
    const listOutput = [
      "open-router\t1\t1\t%101\tnode\t/home/hasna/Workspace/hasna/opensource/open-router\t0\t1\topen-router",
      "ops\t1\t1\t%102\tbash\t/home/hasna\t0\t1\tspark02",
      "agent-maximus\t1\t1\t%103\tnode\t/home/hasna/Workspace/hasna/opensource/open-aicopilot\t0\t1\tagent",
    ].join("\n");
    const captured: string[] = [];
    const runner: TmuxRunner = (args) => {
      if (args[0] === "list-panes") {
        return { exitCode: 0, stdout: listOutput, stderr: "" };
      }
      if (args[0] === "capture-pane") {
        const paneId = args[args.indexOf("-t") + 1];
        captured.push(paneId);
        return { exitCode: 0, stdout: "Goal achieved", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    };

    const panes = listBulkLivePanes({ openOnly: true, runner });

    expect(captured.sort()).toEqual(["%101", "%103"]);
    expect(panes.map((livePane) => livePane.target).sort()).toEqual([
      "agent-maximus:1.1",
      "open-router:1.1",
    ]);
  });
});
