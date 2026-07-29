import {
  basename,
  join,
  resolve,
} from "node:path";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { encodePath, getClaudeProjectsDir, getCodexSessionsDir } from "./paths.js";
import type { TmuxCommandResult, TmuxRunner } from "./live.js";

export type ResumeAgent = "claude" | "codex" | "takumi";
export type SessionDiscoverySource = "pane-history" | "claude-project" | "codex-sessions";

export interface ProjectSession {
  agent: Extract<ResumeAgent, "claude" | "codex">;
  sessionId: string;
  projectPath: string;
  filePath: string;
  modifiedAt: string;
  mtimeMs: number;
}

export interface LastSessionMatch {
  target: string;
  agent: ResumeAgent;
  sessionId: string;
  projectPath: string;
  source: SessionDiscoverySource;
  filePath: string | null;
  resumeCommand: string[];
}

export interface FindLastSessionOptions {
  runner?: TmuxRunner;
  tmuxBin?: string;
  claudeProjectsDir?: string;
  codexSessionsDir?: string;
  captureLines?: number;
}

export type ResumeGroupEntryStatus = "planned" | "resumed" | "skipped" | "failed";

export interface ResumeGroupEntry {
  windowIndex: string;
  windowName: string;
  target: string;
  projectPath: string;
  agent: ResumeAgent | null;
  sessionId: string | null;
  source: SessionDiscoverySource | null;
  resumeCommand: string[] | null;
  status: ResumeGroupEntryStatus;
  error?: string;
}

export interface ResumeGroupResult {
  tmuxGroup: string;
  tmuxSession: string;
  dryRun: boolean;
  entries: ResumeGroupEntry[];
  summary: {
    windows: number;
    found: number;
    resumed: number;
    skipped: number;
    failed: number;
  };
}

export interface ResumeGroupOptions extends FindLastSessionOptions {
  dryRun?: boolean;
}

interface TmuxWindow {
  session: string;
  windowIndex: string;
  windowName: string;
  paneIndex: string;
  paneId: string;
  cwd: string;
  title: string;
}

interface PaneTarget extends TmuxWindow {
  active: boolean;
}

interface SessionRoots {
  claudeProjectsDir: string;
  codexSessionsDir: string;
}

const UUID_SOURCE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const WINDOW_FORMAT = [
  "#{window_index}",
  "#{window_name}",
  "#{pane_index}",
  "#{pane_id}",
  "#{pane_current_path}",
  "#{pane_title}",
].join("\t");
const PANE_FORMAT = [
  "#{session_name}",
  "#{window_index}",
  "#{window_name}",
  "#{pane_index}",
  "#{pane_id}",
  "#{pane_current_path}",
  "#{pane_title}",
  "#{pane_active}",
].join("\t");

/** Detect an explicit resume command using the documented provider priority. */
export function findExplicitResumeCommand(history: string): { agent: ResumeAgent; sessionId: string } | null {
  const cleaned = stripTerminalControl(history);
  const patterns: Array<[ResumeAgent, RegExp]> = [
    ["claude", new RegExp(`\\bclaude\\s+--resume(?:=|\\s+)["']?(${UUID_SOURCE})`, "gi")],
    ["takumi", new RegExp(`\\btakumi\\s+--resume(?:=|\\s+)["']?(${UUID_SOURCE})`, "gi")],
    ["codex", new RegExp(`\\bcodex\\s+resume\\s+["']?(${UUID_SOURCE})`, "gi")],
  ];

  for (const [agent, pattern] of patterns) {
    const matches = [...cleaned.matchAll(pattern)];
    const sessionId = matches.at(-1)?.[1];
    if (sessionId) return { agent, sessionId };
  }
  return null;
}

/** Detect the provider when no explicit resume command supplied one. */
export function detectResumeAgent(history: string): ResumeAgent {
  const explicit = findExplicitResumeCommand(history);
  if (explicit) return explicit.agent;
  return /\b(?:opus|sonnet)\b/i.test(stripTerminalControl(history)) ? "claude" : "claude";
}

/** List raw Claude and Codex session files for a project, newest first. */
export function listSessionsByProject(
  projectPath: string,
  options: Pick<FindLastSessionOptions, "claudeProjectsDir" | "codexSessionsDir"> = {}
): ProjectSession[] {
  const roots = sessionRoots(options);
  const normalizedProject = normalizePath(projectPath);
  const sessions = [
    ...listClaudeProjectSessions(normalizedProject, roots.claudeProjectsDir),
    ...listCodexProjectSessions(normalizedProject, roots.codexSessionsDir),
  ];
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath));
}

/** Resolve a pane/window target to the last resumable provider session. */
export function findLastSession(
  tmuxWindowTarget: string,
  options: FindLastSessionOptions = {}
): LastSessionMatch | null {
  const runner = options.runner ?? createTmuxRunner(options.tmuxBin);
  const panesResult = runner(["list-panes", "-t", tmuxWindowTarget, "-F", PANE_FORMAT]);
  if (panesResult.exitCode !== 0) {
    throw new Error(tmuxError(`tmux target not found: ${tmuxWindowTarget}`, panesResult));
  }
  const panes = panesResult.stdout
    .split("\n")
    .map(parsePaneTarget)
    .filter((pane): pane is PaneTarget => pane !== null);
  const pane = panes.find((candidate) => candidate.active) ?? panes[0];
  if (!pane) throw new Error(`tmux target has no panes: ${tmuxWindowTarget}`);

  const capture = capturePane(runner, pane.paneId, options.captureLines);
  const ordinal = windowOrdinal(runner, pane.session, pane.windowIndex);
  return matchLastSession(pane, capture, ordinal, sessionRoots(options));
}

/** Detect and (unless dry-run) rebuild every resumable window in a tmux group. */
export function resumeGroup(tmuxGroup: string, options: ResumeGroupOptions = {}): ResumeGroupResult {
  const runner = options.runner ?? createTmuxRunner(options.tmuxBin);
  const tmuxSession = resolveTmuxGroupSession(runner, tmuxGroup);
  const windows = listTmuxWindows(runner, tmuxSession);
  const roots = sessionRoots(options);

  const entries = windows.map((window, ordinal): ResumeGroupEntry => {
    const history = capturePane(runner, window.paneId, options.captureLines);
    const match = matchLastSession(window, history, ordinal, roots);
    if (!match) {
      return {
        windowIndex: window.windowIndex,
        windowName: window.windowName,
        target: `${tmuxSession}:${window.windowIndex}`,
        projectPath: window.cwd,
        agent: null,
        sessionId: null,
        source: null,
        resumeCommand: null,
        status: "skipped",
        error: "no resumable session found",
      };
    }
    return {
      windowIndex: window.windowIndex,
      windowName: window.windowName,
      target: `${tmuxSession}:${window.windowIndex}`,
      projectPath: window.cwd,
      agent: match.agent,
      sessionId: match.sessionId,
      source: match.source,
      resumeCommand: match.resumeCommand,
      status: options.dryRun ? "planned" : "resumed",
    };
  });

  if (!options.dryRun) rebuildWindows(runner, tmuxSession, windows, entries);

  return groupResult(tmuxGroup, tmuxSession, Boolean(options.dryRun), entries);
}

export function formatResumeGroupTable(result: ResumeGroupResult): string {
  const headers = ["WINDOW", "AGENT", "SESSION", "STATUS"];
  const rows = result.entries.map((entry) => [
    `${entry.windowIndex}:${entry.windowName}`,
    entry.agent ?? "-",
    entry.sessionId ?? "-",
    entry.error ? `${entry.status}: ${entry.error}` : entry.status,
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length))
  );
  const render = (columns: string[]) =>
    columns.map((value, index) => value.padEnd(widths[index])).join("  ").trimEnd();
  const lines = [`tmux group ${result.tmuxGroup} (${result.dryRun ? "dry run" : "resume"})`, render(headers)];
  for (const row of rows) lines.push(render(row));
  lines.push(
    `summary: windows=${result.summary.windows} found=${result.summary.found} resumed=${result.summary.resumed} skipped=${result.summary.skipped} failed=${result.summary.failed}`
  );
  return lines.join("\n");
}

function matchLastSession(
  pane: TmuxWindow,
  history: string,
  fallbackIndex: number,
  roots: SessionRoots
): LastSessionMatch | null {
  const explicit = findExplicitResumeCommand(history);
  if (explicit) {
    return buildMatch(pane, explicit.agent, explicit.sessionId, "pane-history", null);
  }

  // Claude project transcripts are the first filesystem fallback. The window's
  // ordinal (0 = first tmux window) selects the Nth-most-recent transcript.
  const claude = listClaudeProjectSessions(normalizePath(pane.cwd), roots.claudeProjectsDir)[fallbackIndex];
  if (claude) {
    return buildMatch(pane, "claude", claude.sessionId, "claude-project", claude.filePath);
  }

  const codex = listCodexProjectSessions(normalizePath(pane.cwd), roots.codexSessionsDir)[fallbackIndex];
  if (codex) {
    return buildMatch(pane, "codex", codex.sessionId, "codex-sessions", codex.filePath);
  }

  return null;
}

function buildMatch(
  pane: TmuxWindow,
  agent: ResumeAgent,
  sessionId: string,
  source: SessionDiscoverySource,
  filePath: string | null
): LastSessionMatch {
  return {
    target: `${pane.session}:${pane.windowIndex}.${pane.paneIndex}`,
    agent,
    sessionId,
    projectPath: pane.cwd,
    source,
    filePath,
    resumeCommand: buildResumeCommand(agent, sessionId),
  };
}

function buildResumeCommand(agent: ResumeAgent, sessionId: string): string[] {
  if (agent === "codex") return ["codex", "resume", sessionId];
  return [agent, "--resume", sessionId];
}

function listClaudeProjectSessions(projectPath: string, projectsDir: string): ProjectSession[] {
  const projectDir = join(projectsDir, encodePath(projectPath));
  if (!existsSync(projectDir)) return [];
  const sessions: ProjectSession[] = [];
  for (const entry of safeReadDir(projectDir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const filePath = join(projectDir, entry);
    const stat = safeStat(filePath);
    if (!stat?.isFile()) continue;
    sessions.push({
      agent: "claude",
      sessionId: entry.slice(0, -".jsonl".length),
      projectPath,
      filePath,
      modifiedAt: stat.mtime.toISOString(),
      mtimeMs: stat.mtimeMs,
    });
  }
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath));
}

function listCodexProjectSessions(projectPath: string, sessionsDir: string): ProjectSession[] {
  if (!existsSync(sessionsDir)) return [];
  const sessions: ProjectSession[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(sessionsDir, { recursive: true }) as string[];
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const filePath = join(sessionsDir, entry);
    const stat = safeStat(filePath);
    if (!stat?.isFile()) continue;
    const metadata = readCodexMetadata(filePath);
    if (!metadata || normalizePath(metadata.cwd) !== projectPath) continue;
    sessions.push({
      agent: "codex",
      sessionId: metadata.sessionId,
      projectPath,
      filePath,
      modifiedAt: stat.mtime.toISOString(),
      mtimeMs: stat.mtimeMs,
    });
  }
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filePath.localeCompare(b.filePath));
}

function readCodexMetadata(filePath: string): { sessionId: string; cwd: string } | null {
  let content = "";
  try {
    const descriptor = openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(512 * 1024);
      const length = readSync(descriptor, buffer, 0, buffer.length, 0);
      content = buffer.subarray(0, length).toString("utf-8");
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return null;
  }

  let cwd = "";
  let sessionId = "";
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (record.type !== "session_meta" || typeof record.payload !== "object" || !record.payload) continue;
      const payload = record.payload as Record<string, unknown>;
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      if (typeof payload.id === "string") sessionId = payload.id;
      if (cwd && sessionId) break;
    } catch {
      // Ignore incomplete or malformed records while looking for session_meta.
    }
  }
  if (!sessionId) {
    sessionId = basename(filePath).match(new RegExp(`(${UUID_SOURCE})\\.jsonl$`, "i"))?.[1] ?? "";
  }
  return cwd && sessionId ? { cwd, sessionId } : null;
}

function resolveTmuxGroupSession(runner: TmuxRunner, tmuxGroup: string): string {
  const result = runner(["list-sessions", "-F", "#{session_name}\t#{session_group}"]);
  if (result.exitCode !== 0) throw new Error(tmuxError("unable to list tmux sessions", result));
  const records = result.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts) => parts[0]);
  const exact = records.find(([session]) => session === tmuxGroup);
  if (exact) return exact[0];
  const grouped = records.filter(([, group]) => group === tmuxGroup).map(([session]) => session).sort();
  if (grouped[0]) return grouped[0];
  throw new Error(`tmux group or session not found: ${tmuxGroup}`);
}

function listTmuxWindows(runner: TmuxRunner, session: string): TmuxWindow[] {
  const result = runner(["list-windows", "-t", session, "-F", WINDOW_FORMAT]);
  if (result.exitCode !== 0) throw new Error(tmuxError(`unable to list windows for ${session}`, result));
  return result.stdout
    .split("\n")
    .map((line) => parseWindow(line, session))
    .filter((window): window is TmuxWindow => window !== null)
    .sort(compareWindowIndex);
}

function parseWindow(line: string, session: string): TmuxWindow | null {
  if (!line.trim()) return null;
  const [windowIndex, windowName, paneIndex, paneId, cwd, ...title] = line.split("\t");
  if (!windowIndex || !paneId) return null;
  return { session, windowIndex, windowName, paneIndex, paneId, cwd, title: title.join("\t") };
}

function parsePaneTarget(line: string): PaneTarget | null {
  if (!line.trim()) return null;
  const [session, windowIndex, windowName, paneIndex, paneId, cwd, title, active] = line.split("\t");
  if (!session || !windowIndex || !paneId) return null;
  return { session, windowIndex, windowName, paneIndex, paneId, cwd, title, active: active === "1" };
}

function capturePane(runner: TmuxRunner, paneId: string, captureLines?: number): string {
  const start = captureLines == null ? "-" : `-${captureLines}`;
  const result = runner(["capture-pane", "-p", "-t", paneId, "-S", start]);
  return result.exitCode === 0 ? result.stdout : "";
}

function windowOrdinal(runner: TmuxRunner, session: string, windowIndex: string): number {
  const result = runner(["list-windows", "-t", session, "-F", "#{window_index}"]);
  if (result.exitCode !== 0) return 0;
  const indexes = result.stdout.split("\n").filter(Boolean).sort(compareIndexStrings);
  const ordinal = indexes.indexOf(windowIndex);
  return ordinal >= 0 ? ordinal : 0;
}

function rebuildWindows(
  runner: TmuxRunner,
  tmuxSession: string,
  windows: TmuxWindow[],
  entries: ResumeGroupEntry[]
): void {
  const resumable = entries.filter((entry) => entry.resumeCommand !== null);
  if (resumable.length === 0) return;

  let keeperId: string | null = null;
  if (windows.length === 1) {
    const keeper = runner([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{window_id}",
      "-t",
      `${tmuxSession}:`,
      "-n",
      `__sessions_resume_keeper_${process.pid}`,
    ]);
    if (keeper.exitCode !== 0) {
      const error = tmuxError("unable to create temporary tmux window", keeper);
      for (const entry of resumable) {
        entry.status = "failed";
        entry.error = error;
      }
      return;
    }
    keeperId = keeper.stdout.trim() || null;
  }

  for (const entry of [...resumable].sort((a, b) => compareIndexStrings(b.windowIndex, a.windowIndex))) {
    const killed = runner(["kill-window", "-t", `${tmuxSession}:${entry.windowIndex}`]);
    if (killed.exitCode !== 0) {
      entry.status = "failed";
      entry.error = tmuxError(`unable to kill ${entry.target}`, killed);
      continue;
    }

    const created = runner(newWindowArgs(tmuxSession, entry));
    if (created.exitCode !== 0) {
      // Put back an interactive shell window so a failed launch does not leave
      // the group with a silently missing window.
      runner(newWindowArgs(tmuxSession, entry, null));
      entry.status = "failed";
      entry.error = tmuxError(`unable to recreate ${entry.target}`, created);
    } else {
      entry.status = "resumed";
    }
  }

  if (keeperId) runner(["kill-window", "-t", keeperId]);
}

function newWindowArgs(tmuxSession: string, entry: ResumeGroupEntry, command = entry.resumeCommand): string[] {
  const args = [
    "new-window",
    "-d",
    "-t",
    `${tmuxSession}:${entry.windowIndex}`,
    "-n",
    entry.windowName,
  ];
  if (entry.projectPath) args.push("-c", entry.projectPath);
  if (command) args.push(`exec ${command.map(shellQuote).join(" ")}`);
  return args;
}

function groupResult(
  tmuxGroup: string,
  tmuxSession: string,
  dryRun: boolean,
  entries: ResumeGroupEntry[]
): ResumeGroupResult {
  return {
    tmuxGroup,
    tmuxSession,
    dryRun,
    entries,
    summary: {
      windows: entries.length,
      found: entries.filter((entry) => entry.sessionId !== null).length,
      resumed: entries.filter((entry) => entry.status === "resumed").length,
      skipped: entries.filter((entry) => entry.status === "skipped").length,
      failed: entries.filter((entry) => entry.status === "failed").length,
    },
  };
}

function sessionRoots(options: Pick<FindLastSessionOptions, "claudeProjectsDir" | "codexSessionsDir">): SessionRoots {
  return {
    claudeProjectsDir: options.claudeProjectsDir ?? getClaudeProjectsDir(),
    codexSessionsDir: options.codexSessionsDir ?? getCodexSessionsDir(),
  };
}

function normalizePath(path: string): string {
  const normalized = resolve(path || ".");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function safeStat(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function compareWindowIndex(a: TmuxWindow, b: TmuxWindow): number {
  return compareIndexStrings(a.windowIndex, b.windowIndex);
}

function compareIndexStrings(a: string, b: string): number {
  const numeric = Number(a) - Number(b);
  return Number.isFinite(numeric) && numeric !== 0 ? numeric : a.localeCompare(b);
}

function stripTerminalControl(value: string): string {
  return value
    .replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
    .replace(/\r/g, "");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function tmuxError(prefix: string, result: TmuxCommandResult): string {
  const detail = result.stderr.trim();
  return detail ? `${prefix}: ${detail}` : prefix;
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
      return { exitCode: 1, stdout: "", stderr: (error as Error).message };
    }
  };
}
