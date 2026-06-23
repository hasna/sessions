import { basename } from "node:path";
import { homedir } from "node:os";
import { getMachineName } from "./machine.js";

export type LivePaneStatus = "active" | "idle" | "needs_attention" | "dead";

export interface TmuxPaneRecord {
  session: string;
  windowIndex: string;
  paneIndex: string;
  paneId: string;
  command: string;
  cwd: string | null;
  paneDead: boolean;
  paneActive: boolean;
  title: string;
}

export interface LivePane {
  target: string;
  session: string;
  windowIndex: string;
  paneIndex: string;
  paneId: string;
  command: string;
  cwd: string | null;
  projectPath: string | null;
  projectSlug: string;
  machine: string;
  title: string;
  status: LivePaneStatus;
  statusReason: string;
  paneDead: boolean;
  paneActive: boolean;
  lastVisibleLine: string | null;
  isOpenSession: boolean;
}

export interface ListLivePanesOptions {
  openOnly?: boolean;
  project?: string;
  machine?: string;
  statuses?: LivePaneStatus[];
  captureLines?: number;
  tmuxBin?: string;
  runner?: TmuxRunner;
}

export interface TmuxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type TmuxRunner = (args: string[]) => TmuxCommandResult;

const TMUX_FORMAT = [
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

const LIVE_STATUSES: LivePaneStatus[] = [
  "active",
  "idle",
  "needs_attention",
  "dead",
];

const SHELL_COMMANDS = new Set([
  "",
  "bash",
  "zsh",
  "sh",
  "fish",
  "dash",
  "tmux",
  "login",
  "ssh",
  "sudo",
  "su",
  "cd",
]);

const NEEDS_ATTENTION_PATTERNS = [
  /\bgoal blocked\b/i,
  /\bstatus:\s*blocked\b/i,
  /\btask blocked\b/i,
  /\bblocked (by|on|waiting|until)\b/i,
  /\bblocked\s*\(\/goal resume\)/i,
  /\bwaiting for (user|approval|input|confirmation)\b/i,
  /\bneeds? (attention|approval|input|user)\b/i,
  /\bapproval (required|requested|needed)\b/i,
  /\btrust (this )?(folder|workspace|directory)\b/i,
  /\bdo you trust\b/i,
  /\bpermission\b.*\b(allow|approve|denied|required)\b/i,
  /\b(allow|approve|confirm|proceed)\?\s*$/i,
  /\bpress enter to continue\b/i,
];

const ACTIVE_PATTERNS = [
  /\bworking\s*\(/i,
  /\bpursuing goal\b/i,
  /\brunning (command|tool|tests?|build|typecheck)\b/i,
  /\b(tool|model) activity\b/i,
  /\bcalling tool\b/i,
  /\bexecuting\b/i,
];

const IDLE_PATTERNS = [
  /\bgoal achieved\b/i,
  /\bgoal completed\b/i,
  /\bgoal complete\b/i,
  /\bno active goal\b/i,
  /\bwhat do you want/i,
  /\bnew task\?\s+\/clear\b/i,
  /\btype (a )?message/i,
  /(^|\n)\s*>\s*$/m,
  /(^|\n)\s*\u203a\s*.*$/m,
  /(^|\n)[^\n@]+@[^:\n]+:[^\n]*[$#]\s*$/m,
];

export function parseLiveStatusFilter(raw: string | undefined): LivePaneStatus[] | undefined {
  if (!raw) return undefined;
  const statuses = raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const invalid = statuses.filter((status) => !LIVE_STATUSES.includes(status as LivePaneStatus));
  if (invalid.length > 0) {
    throw new Error(`Invalid --status value: ${invalid.join(", ")}. Use: ${LIVE_STATUSES.join(", ")}`);
  }
  return [...new Set(statuses as LivePaneStatus[])];
}

export function parseTmuxPaneLine(line: string): TmuxPaneRecord | null {
  if (!line.trim()) return null;
  const parts = line.split("\t");
  if (parts.length < 9) return null;
  const [
    session,
    windowIndex,
    paneIndex,
    paneId,
    command,
    cwd,
    paneDead,
    paneActive,
    ...titleParts
  ] = parts;
  return {
    session,
    windowIndex,
    paneIndex,
    paneId,
    command,
    cwd: cwd.trim() ? cwd : null,
    paneDead: paneDead === "1",
    paneActive: paneActive === "1",
    title: titleParts.join("\t"),
  };
}

export function normalizeProjectPath(path: string | null | undefined): string | null {
  if (!path) return null;
  let normalized = path.trim();
  if (!normalized) return null;
  if (normalized === "~") normalized = homedir();
  if (normalized.startsWith("~/")) normalized = `${homedir()}${normalized.slice(1)}`;

  normalized = normalized.replace(
    /^\/home\/([^/]+)\/Workspace(?=\/|$)/,
    "/home/$1/workspace"
  );
  normalized = normalized.replace(/\/{2,}/g, "/");
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/g, "");
  return normalized;
}

export function classifyLivePane(record: TmuxPaneRecord, captureText: string): { status: LivePaneStatus; reason: string } {
  if (record.paneDead) {
    return { status: "dead", reason: "tmux pane_dead=1" };
  }

  const visibleText = cleanCaptureText(captureText);
  const lines = tailLines(visibleText, 12);
  const currentLine = lines.at(-1) ?? "";
  const footerLines = lines.slice(Math.max(0, lines.length - 3));
  const bottomText = lines.join("\n");
  const command = record.command.toLowerCase();
  const currentStatus = classifyTextStatus(currentLine);
  if (currentStatus) {
    return currentStatus;
  }

  const footerStatus = classifyTextLinesStatus(footerLines);
  if (footerStatus) {
    return footerStatus;
  }

  if (matchesAny(NEEDS_ATTENTION_PATTERNS, bottomText)) {
    return { status: "needs_attention", reason: "attention indicator in pane text" };
  }

  if (matchesAny(ACTIVE_PATTERNS, bottomText)) {
    return { status: "active", reason: "working indicator in pane text" };
  }

  if (matchesAny(IDLE_PATTERNS, bottomText)) {
    return { status: "idle", reason: "idle prompt or completed goal in pane text" };
  }

  if (SHELL_COMMANDS.has(command)) {
    return { status: "idle", reason: "shell or composer prompt" };
  }

  return { status: "active", reason: "non-shell foreground command" };
}

function classifyTextStatus(text: string): { status: LivePaneStatus; reason: string } | null {
  if (matchesAny(NEEDS_ATTENTION_PATTERNS, text)) {
    return { status: "needs_attention", reason: "current attention indicator in pane text" };
  }

  if (matchesAny(ACTIVE_PATTERNS, text)) {
    return { status: "active", reason: "current working indicator in pane text" };
  }

  if (matchesAny(IDLE_PATTERNS, text)) {
    return { status: "idle", reason: "current idle prompt or completed goal in pane text" };
  }

  return null;
}

function classifyTextLinesStatus(lines: string[]): { status: LivePaneStatus; reason: string } | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const status = classifyTextStatus(lines[index]);
    if (status) return status;
  }
  return null;
}

export function buildLivePane(
  record: TmuxPaneRecord,
  captureText: string,
  machine = getMachineName()
): LivePane {
  const cwd = normalizeProjectPath(record.cwd);
  const project = deriveProject(cwd, record.session);
  const status = classifyLivePane(record, captureText);
  return {
    target: `${record.session}:${record.windowIndex}.${record.paneIndex}`,
    session: record.session,
    windowIndex: record.windowIndex,
    paneIndex: record.paneIndex,
    paneId: record.paneId,
    command: record.command,
    cwd: record.cwd,
    projectPath: project.path,
    projectSlug: project.slug,
    machine,
    title: record.title,
    status: status.status,
    statusReason: status.reason,
    paneDead: record.paneDead,
    paneActive: record.paneActive,
    lastVisibleLine: lastVisibleLine(captureText),
    isOpenSession: isOpenNamed(record.session, project.slug),
  };
}

export function listLivePanesFromTmuxOutput(
  listOutput: string,
  captureByPaneId: Map<string, string> | Record<string, string>,
  machine = getMachineName()
): LivePane[] {
  const lookup = captureByPaneId instanceof Map
    ? (paneId: string) => captureByPaneId.get(paneId) ?? ""
    : (paneId: string) => captureByPaneId[paneId] ?? "";

  return listOutput
    .split("\n")
    .map(parseTmuxPaneLine)
    .filter((record): record is TmuxPaneRecord => record !== null)
    .map((record) => buildLivePane(record, lookup(record.paneId), machine))
    .sort(sortLivePanes);
}

export function listLivePanes(options: ListLivePanesOptions = {}): LivePane[] {
  const runner = options.runner ?? createTmuxRunner(options.tmuxBin);
  const listResult = runner(["list-panes", "-a", "-F", TMUX_FORMAT]);
  if (listResult.exitCode !== 0) {
    return [];
  }

  const captures = new Map<string, string>();
  const records = listResult.stdout
    .split("\n")
    .map(parseTmuxPaneLine)
    .filter((record): record is TmuxPaneRecord => record !== null);

  for (const record of records) {
    const capture = runner([
      "capture-pane",
      "-p",
      "-t",
      record.paneId,
      "-S",
      `-${options.captureLines ?? 80}`,
    ]);
    captures.set(record.paneId, capture.exitCode === 0 ? capture.stdout : "");
  }

  return filterLivePanes(
    records
      .map((record) => buildLivePane(record, captures.get(record.paneId) ?? ""))
      .sort(sortLivePanes),
    options
  );
}

export function filterLivePanes(
  panes: LivePane[],
  options: Pick<ListLivePanesOptions, "openOnly" | "project" | "machine" | "statuses"> = {}
): LivePane[] {
  const statusSet = options.statuses?.length ? new Set(options.statuses) : null;
  const projectSelector = normalizeProjectPath(options.project);
  const machineSelector = options.machine?.toLowerCase();

  return panes.filter((pane) => {
    if (options.openOnly && !pane.isOpenSession) return false;
    if (statusSet && !statusSet.has(pane.status)) return false;
    if (machineSelector && pane.machine.toLowerCase() !== machineSelector) return false;
    if (projectSelector && !matchesProject(pane, projectSelector)) return false;
    return true;
  });
}

export function formatLivePaneTable(panes: LivePane[]): string {
  if (panes.length === 0) {
    return "No live tmux panes found.";
  }

  const headers = ["STATUS", "MACHINE", "TARGET", "PROJECT", "CMD", "LAST"];
  const rows = panes.map((pane) => [
    pane.status,
    pane.machine,
    pane.target,
    pane.projectSlug,
    pane.command || "-",
    truncate(pane.lastVisibleLine ?? pane.title ?? "-", 96),
  ]);
  const widths = headers.map((header, index) =>
    Math.min(32, Math.max(header.length, ...rows.map((row) => row[index].length)))
  );

  const render = (cols: string[]) =>
    cols
      .map((value, index) => truncate(value, widths[index]).padEnd(widths[index]))
      .join("  ")
      .trimEnd();

  return [render(headers), ...rows.map(render)].join("\n");
}

function createTmuxRunner(tmuxBin = "tmux"): TmuxRunner {
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

function cleanCaptureText(text: string): string {
  return text
    .replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/\r/g, "");
}

function tailLines(text: string, count: number): string[] {
  const lines = cleanCaptureText(text)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return lines.slice(Math.max(0, lines.length - count));
}

function lastVisibleLine(text: string): string | null {
  const line = tailLines(text, 1)[0];
  return line ? line.trim().replace(/\s+/g, " ") : null;
}

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function deriveProject(projectPath: string | null, session: string): { path: string | null; slug: string } {
  const openAncestor = findOpenProjectAncestor(projectPath);
  if (openAncestor) return openAncestor;

  return {
    path: projectPath,
    slug: deriveSlug(projectPath ?? session, session),
  };
}

function findOpenProjectAncestor(projectPath: string | null): { path: string; slug: string } | null {
  if (!projectPath?.startsWith("/")) return null;
  const parts = projectPath.split("/");
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (!part.toLowerCase().startsWith("open-")) continue;
    return {
      path: parts.slice(0, index + 1).join("/") || "/",
      slug: deriveSlug(part, part),
    };
  }
  return null;
}

function deriveSlug(value: string, fallback: string): string {
  const base = basename(value || fallback) || fallback || "unknown";
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

function isOpenNamed(session: string, projectSlug: string): boolean {
  return session.startsWith("open-") || projectSlug.startsWith("open-");
}

function matchesProject(pane: LivePane, selector: string): boolean {
  const value = selector.toLowerCase();
  const cwd = normalizeProjectPath(pane.cwd)?.toLowerCase();
  return (
    pane.session.toLowerCase().includes(value) ||
    pane.projectSlug.toLowerCase().includes(value) ||
    (pane.projectPath?.toLowerCase().includes(value) ?? false) ||
    (cwd?.includes(value) ?? false)
  );
}

function sortLivePanes(a: LivePane, b: LivePane): number {
  const statusOrder: Record<LivePaneStatus, number> = {
    active: 0,
    needs_attention: 1,
    idle: 2,
    dead: 3,
  };
  const byStatus = statusOrder[a.status] - statusOrder[b.status];
  if (byStatus !== 0) return byStatus;
  return a.target.localeCompare(b.target);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return `${value.slice(0, max - 3)}...`;
}
