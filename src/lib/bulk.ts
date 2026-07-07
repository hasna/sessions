import { cpus, loadavg } from "node:os";
import { basename } from "node:path";
import {
  buildLivePane,
  filterLivePanes,
  normalizeProjectPath,
  parseTmuxPaneLine,
  type LivePane,
  type LivePaneStatus,
  type TmuxPaneRecord,
  type TmuxRunner,
} from "./live.js";

export type BulkSessionAction =
  | "status"
  | "capture"
  | "ensure"
  | "start"
  | "stop"
  | "restart"
  | "doctor";

export type BulkEntryDecision = "planned" | "queued" | "skipped" | "refused";

export interface BulkSessionOptions {
  action: BulkSessionAction;
  panes: LivePane[];
  openOnly?: boolean;
  statuses?: LivePaneStatus[];
  statusFilterExplicit?: boolean;
  project?: string;
  machine?: string;
  localMachine?: string;
  dryRun?: boolean;
  yes?: boolean;
  queue?: boolean;
  executionEnabled?: boolean;
  concurrency?: number;
  jitterMs?: number;
  maxActiveAgents?: number;
  maxLoad1?: number;
  maxLoadPerCore?: number;
  load1?: number;
  cpuCount?: number;
  now?: Date;
}

export interface BulkLiveDiscoveryOptions {
  openOnly?: boolean;
  project?: string;
  captureLines?: number;
  tmuxBin?: string;
  runner?: TmuxRunner;
}

export interface BulkGuardHints {
  captureScope: "prefiltered";
  activeAgentCount: number;
  selectedCount: number;
  selectedMachineCount: number;
  selectedMachines: string[];
  load1: number;
  cpuCount: number;
  loadPerCore: number;
  maxActiveAgents: number;
  maxLoad1: number | null;
  maxLoadPerCore: number;
}

export interface BulkGuardDecision {
  ok: boolean;
  reasons: string[];
  hints: BulkGuardHints;
}

export interface BulkPlanEntry {
  target: string;
  machine: string;
  projectSlug: string;
  projectPath: string | null;
  isOpenSession: boolean;
  status: LivePaneStatus;
  action: BulkSessionAction;
  decision: BulkEntryDecision;
  reason: string;
  scheduledDelayMs: number;
  queue: "none" | "local";
  argv: string[] | null;
  commandPreview: string | null;
  lastVisibleLine: string | null;
}

export interface BulkSessionPlan {
  schemaVersion: "sessions.bulk.v1";
  observedAt: string;
  action: BulkSessionAction;
  dryRun: boolean;
  yes: boolean;
  queue: boolean;
  executionEnabled: boolean;
  concurrency: number;
  jitterMs: number;
  filters: {
    openOnly: boolean;
    statuses: LivePaneStatus[] | null;
    project: string | null;
    machine: string | null;
  };
  guard: BulkGuardDecision;
  summary: {
    totalPanes: number;
    selected: number;
    planned: number;
    queued: number;
    skipped: number;
    refused: number;
  };
  entries: BulkPlanEntry[];
}

const READ_ONLY_ACTIONS = new Set<BulkSessionAction>([
  "status",
  "capture",
  "doctor",
]);

const MUTATING_ACTIONS = new Set<BulkSessionAction>([
  "ensure",
  "start",
  "stop",
  "restart",
]);

const BULK_TMUX_FORMAT = [
  "#{session_name}",
  "#{window_index}",
  "#{pane_index}",
  "#{pane_id}",
  "#{pane_current_command}",
  "#{pane_current_path}",
  "#{pane_dead}",
  "#{pane_active}",
  "#{pane_title}",
].join("\t");

export const BULK_SESSION_ACTIONS: BulkSessionAction[] = [
  "status",
  "capture",
  "ensure",
  "start",
  "stop",
  "restart",
  "doctor",
];

export function isBulkSessionAction(value: string): value is BulkSessionAction {
  return BULK_SESSION_ACTIONS.includes(value as BulkSessionAction);
}

export function parseConcurrency(value: number | string | undefined, fallback = 2): number {
  if (value == null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  return parsed;
}

export function parseJitterMs(value: number | string | undefined, fallback = 0): number {
  if (value == null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("--jitter must be a non-negative integer number of milliseconds");
  }
  return parsed;
}

export function listBulkLivePanes(options: BulkLiveDiscoveryOptions = {}): LivePane[] {
  const runner = options.runner ?? createBulkTmuxRunner(options.tmuxBin);
  const listResult = runner(["list-panes", "-a", "-F", BULK_TMUX_FORMAT]);
  if (listResult.exitCode !== 0) {
    return [];
  }

  const records = listResult.stdout
    .split("\n")
    .map(parseTmuxPaneLine)
    .filter((record): record is TmuxPaneRecord => record !== null)
    .filter((record) => prefilterTmuxRecord(record, options));

  return records
    .map((record) => {
      const capture = runner([
        "capture-pane",
        "-p",
        "-t",
        record.paneId,
        "-S",
        `-${options.captureLines ?? 80}`,
      ]);
      return buildLivePane(record, capture.exitCode === 0 ? capture.stdout : "");
    })
    .sort((a, b) => a.target.localeCompare(b.target));
}

export function buildBulkSessionPlan(options: BulkSessionOptions): BulkSessionPlan {
  const dryRun = Boolean(options.dryRun);
  const yes = Boolean(options.yes);
  const queue = options.queue !== false;
  const executionEnabled = options.executionEnabled !== false;
  const concurrency = parseConcurrency(options.concurrency);
  const jitterMs = parseJitterMs(options.jitterMs);
  const observedAt = (options.now ?? new Date()).toISOString();
  const selected = filterLivePanes(options.panes, {
    openOnly: options.openOnly,
    statuses: options.statuses,
    project: options.project,
    machine: options.machine,
  });
  const guard = buildBulkGuardDecision(selected, options);

  const entries = selected.map((pane, index) =>
    buildBulkPlanEntry(pane, index, {
      ...options,
      dryRun,
      yes,
      queue,
      executionEnabled,
      concurrency,
      jitterMs,
      guard,
    })
  );

  const count = (decision: BulkEntryDecision) =>
    entries.filter((entry) => entry.decision === decision).length;

  return {
    schemaVersion: "sessions.bulk.v1",
    observedAt,
    action: options.action,
    dryRun,
    yes,
    queue,
    executionEnabled,
    concurrency,
    jitterMs,
    filters: {
      openOnly: Boolean(options.openOnly),
      statuses: options.statuses?.length ? [...options.statuses] : null,
      project: options.project ?? null,
      machine: options.machine ?? null,
    },
    guard,
    summary: {
      totalPanes: options.panes.length,
      selected: selected.length,
      planned: count("planned"),
      queued: count("queued"),
      skipped: count("skipped"),
      refused: count("refused"),
    },
    entries,
  };
}

export function buildBulkGuardDecision(
  selectedPanes: LivePane[],
  options: Pick<
    BulkSessionOptions,
    | "panes"
    | "action"
    | "localMachine"
    | "dryRun"
    | "maxActiveAgents"
    | "maxLoad1"
    | "maxLoadPerCore"
    | "load1"
    | "cpuCount"
  >
): BulkGuardDecision {
  const cpuCount = Math.max(1, options.cpuCount ?? cpus().length);
  const load1 = options.load1 ?? loadavg()[0] ?? 0;
  const maxActiveAgents = options.maxActiveAgents ?? 12;
  const maxLoad1 = options.maxLoad1 ?? null;
  const maxLoadPerCore = options.maxLoadPerCore ?? 1.5;
  const selectedMachines = [...new Set(selectedPanes.map((pane) => pane.machine))].sort();
  const activeAgentCount = options.panes.filter((pane) => pane.status === "active").length;
  const loadPerCore = load1 / cpuCount;
  const reasons: string[] = [];
  const mutating = MUTATING_ACTIONS.has(options.action);

  if (mutating && selectedMachines.length > 1) {
    reasons.push("mutating bulk operations are limited to one machine per run");
  }

  if (mutating && options.localMachine && selectedMachines.some((machine) => machine !== options.localMachine)) {
    reasons.push(`mutating bulk operations are local-only for this runner (${options.localMachine})`);
  }

  if (activeAgentCount > maxActiveAgents) {
    reasons.push(`active agent count ${activeAgentCount} exceeds max ${maxActiveAgents}`);
  }

  if (maxLoad1 != null && load1 > maxLoad1) {
    reasons.push(`1m load ${round(load1)} exceeds max ${round(maxLoad1)}`);
  }

  if (loadPerCore > maxLoadPerCore) {
    reasons.push(`1m load per core ${round(loadPerCore)} exceeds max ${round(maxLoadPerCore)}`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    hints: {
      captureScope: "prefiltered",
      activeAgentCount,
      selectedCount: selectedPanes.length,
      selectedMachineCount: selectedMachines.length,
      selectedMachines,
      load1,
      cpuCount,
      loadPerCore,
      maxActiveAgents,
      maxLoad1,
      maxLoadPerCore,
    },
  };
}

function buildBulkPlanEntry(
  pane: LivePane,
  index: number,
  options: BulkSessionOptions & {
    dryRun: boolean;
    yes: boolean;
    queue: boolean;
    executionEnabled: boolean;
    concurrency: number;
    jitterMs: number;
    guard: BulkGuardDecision;
  }
): BulkPlanEntry {
  const mutating = MUTATING_ACTIONS.has(options.action);
  const readOnly = READ_ONLY_ACTIONS.has(options.action);
  const scheduledDelayMs = scheduledDelayFor(pane.target, index, options.concurrency, options.jitterMs);
  const argv = describeBulkArgv(options.action, pane);

  if (readOnly) {
    const warning = options.guard.ok ? "" : `; guard warnings: ${options.guard.reasons.join("; ")}`;
    return entry(pane, options.action, "planned", `read-only bulk check${warning}`, scheduledDelayMs, "none", argv);
  }

  if (!options.guard.ok) {
    return entry(pane, options.action, "refused", options.guard.reasons.join("; "), scheduledDelayMs, "none", argv);
  }

  if (options.action === "ensure" && pane.status !== "dead") {
    return entry(pane, options.action, "skipped", "pane already exists", scheduledDelayMs, "none", argv);
  }

  if (options.action === "start" && pane.status !== "dead") {
    return entry(pane, options.action, "skipped", "pane is already started", scheduledDelayMs, "none", argv);
  }

  if (mutating && (pane.status === "active" || pane.status === "needs_attention") && !statusWasExplicit(pane.status, options)) {
    return entry(
      pane,
      options.action,
      "refused",
      `refusing ${options.action} for ${pane.status} pane without explicit --status ${pane.status}`,
      scheduledDelayMs,
      "none",
      argv
    );
  }

  if (options.dryRun) {
    return entry(pane, options.action, "planned", "dry run", scheduledDelayMs, "none", argv);
  }

  if (!options.executionEnabled) {
    return entry(pane, options.action, "refused", "mutating execution backend is not enabled; use --dry-run for planning", scheduledDelayMs, "none", argv);
  }

  if (!options.yes) {
    return entry(pane, options.action, "refused", "mutating bulk operation requires --yes", scheduledDelayMs, "none", argv);
  }

  return entry(
    pane,
    options.action,
    options.queue ? "queued" : "planned",
    options.queue ? "queued behind local concurrency guard" : "ready to run",
    scheduledDelayMs,
    options.queue ? "local" : "none",
    argv
  );
}

function entry(
  pane: LivePane,
  action: BulkSessionAction,
  decision: BulkEntryDecision,
  reason: string,
  scheduledDelayMs: number,
  queue: "none" | "local",
  argv: string[] | null
): BulkPlanEntry {
  return {
    target: pane.target,
    machine: pane.machine,
    projectSlug: pane.projectSlug,
    projectPath: pane.projectPath,
    isOpenSession: pane.isOpenSession,
    status: pane.status,
    action,
    decision,
    reason,
    scheduledDelayMs,
    queue,
    argv,
    commandPreview: argv ? argv.map((part) => JSON.stringify(part)).join(" ") : null,
    lastVisibleLine: pane.lastVisibleLine,
  };
}

function describeBulkArgv(action: BulkSessionAction, pane: LivePane): string[] | null {
  switch (action) {
    case "status":
      return null;
    case "capture":
      return ["tmux", "capture-pane", "-p", "-t", pane.paneId];
    case "doctor":
      return null;
    case "ensure":
    case "start":
      return pane.projectPath ? ["tmux", "new-session", "-d", "-s", pane.session, "-c", pane.projectPath] : null;
    case "stop":
      return ["tmux", "kill-pane", "-t", pane.paneId];
    case "restart":
      return pane.projectPath
        ? ["tmux", "respawn-pane", "-k", "-t", pane.paneId, "-c", pane.projectPath]
        : ["tmux", "respawn-pane", "-k", "-t", pane.paneId];
  }
}

function statusWasExplicit(status: LivePaneStatus, options: Pick<BulkSessionOptions, "statuses" | "statusFilterExplicit">): boolean {
  return Boolean(options.statusFilterExplicit && options.statuses?.includes(status));
}

function scheduledDelayFor(target: string, index: number, concurrency: number, jitterMs: number): number {
  const batchDelay = Math.floor(index / concurrency) * jitterMs;
  if (jitterMs === 0) return batchDelay;
  return batchDelay + stableJitter(target, jitterMs);
}

function stableJitter(value: string, maxMs: number): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % (maxMs + 1);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function formatBulkSessionPlan(plan: BulkSessionPlan): string {
  const lines = [
    `sessions bulk ${plan.action} (${plan.observedAt})`,
    `guard: ${plan.guard.ok ? "ok" : "refused"}  active=${plan.guard.hints.activeAgentCount}  load1=${round(plan.guard.hints.load1)}  load/core=${round(plan.guard.hints.loadPerCore)}  selected=${plan.summary.selected}`,
  ];

  if (plan.guard.reasons.length > 0) {
    for (const reason of plan.guard.reasons) {
      lines.push(`refusal: ${reason}`);
    }
  }

  lines.push(
    `summary: planned=${plan.summary.planned} queued=${plan.summary.queued} skipped=${plan.summary.skipped} refused=${plan.summary.refused}`
  );

  if (plan.entries.length === 0) {
    lines.push("No matching live panes.");
    return lines.join("\n");
  }

  const headers = ["DECISION", "STATUS", "MACHINE", "TARGET", "PROJECT", "DELAY", "REASON"];
  const rows = plan.entries.map((entry) => [
    entry.decision,
    entry.status,
    entry.machine,
    entry.target,
    entry.projectSlug,
    `${entry.scheduledDelayMs}ms`,
    entry.reason,
  ]);
  const widths = headers.map((header, index) =>
    Math.min(40, Math.max(header.length, ...rows.map((row) => row[index].length)))
  );
  const render = (cols: string[]) =>
    cols
      .map((value, index) => truncate(value, widths[index]).padEnd(widths[index]))
      .join("  ")
      .trimEnd();

  lines.push(render(headers));
  for (const row of rows) lines.push(render(row));
  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return `${value.slice(0, max - 3)}...`;
}

function createBulkTmuxRunner(tmuxBin = "tmux"): TmuxRunner {
  return (args: string[]) => {
    try {
      const result = Bun.spawnSync({
        cmd: [tmuxBin, ...args],
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        exitCode: result.exitCode,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
      };
    } catch (error) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: (error as Error).message,
      };
    }
  };
}

function prefilterTmuxRecord(record: TmuxPaneRecord, options: Pick<BulkLiveDiscoveryOptions, "openOnly" | "project">): boolean {
  const projectPath = normalizeProjectPath(record.cwd);
  const projectSlug = deriveProjectSlug(projectPath, record.session);

  if (options.openOnly && !record.session.startsWith("open-") && !projectSlug.startsWith("open-")) {
    return false;
  }

  if (options.project) {
    const selector = normalizeProjectPath(options.project)?.toLowerCase() ?? options.project.toLowerCase();
    const haystack = [
      record.session,
      projectSlug,
      projectPath ?? "",
      record.cwd ?? "",
    ].join("\n").toLowerCase();
    if (!haystack.includes(selector)) return false;
  }

  return true;
}

function deriveProjectSlug(projectPath: string | null, session: string): string {
  const base = basename(projectPath ?? session) || session || "unknown";
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown";
}
