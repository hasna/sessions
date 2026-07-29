import {
  parseTmuxPaneLine,
  type TmuxCommandResult,
  type TmuxPaneRecord,
  type TmuxRunner,
} from "./live.js";

const WATCHDOG_TMUX_FORMAT = [
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

const DEFAULT_SHELL_READY_DELAY_MS = 1_000;
const DEFAULT_CLAUDE_START_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export type WatchdogRestartOutcome =
  | "restarted"
  | "skipped_no_sibling"
  | "respawn_failed"
  | "resume_failed"
  | "claude_timeout";

export interface WatchdogRestartEntry {
  sessionName: string;
  target: string;
  siblingDir: string | null;
  outcome: WatchdogRestartOutcome;
  claudeStarted: boolean;
  warning: string | null;
}

export interface WatchdogRestartResult {
  requestedSession: string | null;
  crashedFound: number;
  restarted: number;
  skipped: number;
  entries: WatchdogRestartEntry[];
}

export interface WatchdogRestartOptions {
  tmuxBin?: string;
  runner?: TmuxRunner;
  sleep?: (milliseconds: number) => Promise<void>;
  warn?: (message: string) => void;
  shellReadyDelayMs?: number;
  claudeStartTimeoutMs?: number;
  pollIntervalMs?: number;
}

/** Restart every crashed pane belonging to one exact tmux session name. */
export async function sessionsWatchdogRestart(
  sessionName: string,
  options: WatchdogRestartOptions = {}
): Promise<WatchdogRestartResult> {
  const requestedSession = sessionName.trim();
  if (!requestedSession) throw new Error("session_name cannot be empty");
  return restartCrashedSessions(requestedSession, options);
}

/** Restart every crashed pane visible to the local tmux server. */
export async function sessionsWatchdogRestartAll(
  options: WatchdogRestartOptions = {}
): Promise<WatchdogRestartResult> {
  return restartCrashedSessions(null, options);
}

/**
 * Session launchers commonly number siblings (worker-01/worker-02 or
 * account010/account011). Removing only that run suffix avoids treating every
 * broadly named open-* session as a sibling.
 */
export function watchdogSessionPrefix(sessionName: string): string {
  const prefix = sessionName.replace(/[-_.]?\d+$/, "").replace(/[-_.]+$/, "");
  return prefix || sessionName;
}

async function restartCrashedSessions(
  requestedSession: string | null,
  options: WatchdogRestartOptions
): Promise<WatchdogRestartResult> {
  const runner = options.runner ?? createWatchdogTmuxRunner(options.tmuxBin);
  const listResult = runner(["list-panes", "-a", "-F", WATCHDOG_TMUX_FORMAT]);
  if (listResult.exitCode !== 0) {
    throw new Error(`Unable to list tmux panes: ${commandError(listResult)}`);
  }

  const records = listResult.stdout
    .split("\n")
    .map(parseTmuxPaneLine)
    .filter((record): record is TmuxPaneRecord => record !== null);
  const crashed = records.filter(
    (record) => record.paneDead && (requestedSession === null || record.session === requestedSession)
  );

  const entries: WatchdogRestartEntry[] = [];
  for (const record of crashed) {
    entries.push(await restartCrashedPane(record, records, runner, options));
  }

  const restarted = entries.filter((entry) => entry.outcome === "restarted").length;
  return {
    requestedSession,
    crashedFound: crashed.length,
    restarted,
    skipped: entries.length - restarted,
    entries,
  };
}

async function restartCrashedPane(
  crashed: TmuxPaneRecord,
  records: TmuxPaneRecord[],
  runner: TmuxRunner,
  options: WatchdogRestartOptions
): Promise<WatchdogRestartEntry> {
  const target = `${crashed.session}:${crashed.windowIndex}.${crashed.paneIndex}`;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const siblingDir = findHealthySiblingDir(crashed, records);

  if (!siblingDir) {
    const warning = `Watchdog cannot restart ${target}: no healthy sibling directory for prefix '${watchdogSessionPrefix(crashed.session)}'`;
    warn(warning);
    return restartEntry(crashed.session, target, null, "skipped_no_sibling", warning);
  }

  const respawn = runner(["respawn-pane", "-k", "-t", target, "-c", siblingDir]);
  if (respawn.exitCode !== 0) {
    const warning = `Watchdog failed to respawn ${target}: ${commandError(respawn)}`;
    warn(warning);
    return restartEntry(crashed.session, target, siblingDir, "respawn_failed", warning);
  }

  const sleep = options.sleep ?? defaultSleep;
  await sleep(nonNegativeDelay(options.shellReadyDelayMs, DEFAULT_SHELL_READY_DELAY_MS));

  const resumeCommand = `claude --resume "${escapeDoubleQuotedShellValue(crashed.session)}"`;
  const resume = runner(["send-keys", "-t", target, resumeCommand, "Enter"]);
  if (resume.exitCode !== 0) {
    const warning = `Watchdog failed to send the Claude resume command to ${target}: ${commandError(resume)}`;
    warn(warning);
    return restartEntry(crashed.session, target, siblingDir, "resume_failed", warning);
  }

  const claudeStarted = await pollForClaude(target, runner, sleep, options);
  if (!claudeStarted) {
    const timeoutMs = positiveDelay(
      options.claudeStartTimeoutMs,
      DEFAULT_CLAUDE_START_TIMEOUT_MS
    );
    const warning = `Watchdog warning: Claude did not start in ${target} within ${formatSeconds(timeoutMs)}; skipping message step`;
    warn(warning);
    return restartEntry(crashed.session, target, siblingDir, "claude_timeout", warning);
  }

  return restartEntry(crashed.session, target, siblingDir, "restarted", null, true);
}

function findHealthySiblingDir(
  crashed: TmuxPaneRecord,
  records: TmuxPaneRecord[]
): string | null {
  const prefix = watchdogSessionPrefix(crashed.session);
  const siblings = records
    .filter(
      (record) =>
        record.paneId !== crashed.paneId &&
        !record.paneDead &&
        Boolean(record.cwd?.trim()) &&
        watchdogSessionPrefix(record.session) === prefix
    )
    .sort((left, right) => {
      const sameSession = Number(right.session === crashed.session) - Number(left.session === crashed.session);
      if (sameSession !== 0) return sameSession;
      const claudeFirst = Number(right.command.toLowerCase() === "claude") - Number(left.command.toLowerCase() === "claude");
      if (claudeFirst !== 0) return claudeFirst;
      return paneTarget(left).localeCompare(paneTarget(right));
    });
  return siblings[0]?.cwd?.trim() || null;
}

async function pollForClaude(
  target: string,
  runner: TmuxRunner,
  sleep: (milliseconds: number) => Promise<void>,
  options: WatchdogRestartOptions
): Promise<boolean> {
  const timeoutMs = positiveDelay(
    options.claudeStartTimeoutMs,
    DEFAULT_CLAUDE_START_TIMEOUT_MS
  );
  const pollIntervalMs = positiveDelay(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const attempts = Math.ceil(timeoutMs / pollIntervalMs);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleep(Math.min(pollIntervalMs, timeoutMs - attempt * pollIntervalMs));
    const command = runner([
      "display-message",
      "-p",
      "-t",
      target,
      "#{pane_current_command}",
    ]);
    if (command.exitCode === 0 && command.stdout.trim().toLowerCase() === "claude") {
      return true;
    }
  }
  return false;
}

function restartEntry(
  sessionName: string,
  target: string,
  siblingDir: string | null,
  outcome: WatchdogRestartOutcome,
  warning: string | null,
  claudeStarted = false
): WatchdogRestartEntry {
  return { sessionName, target, siblingDir, outcome, claudeStarted, warning };
}

function paneTarget(record: TmuxPaneRecord): string {
  return `${record.session}:${record.windowIndex}.${record.paneIndex}`;
}

function escapeDoubleQuotedShellValue(value: string): string {
  return value.replace(/[\\"$`]/g, "\\$&");
}

function commandError(result: TmuxCommandResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
}

function nonNegativeDelay(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveDelay(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function formatSeconds(milliseconds: number): string {
  return `${milliseconds / 1_000}s`;
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await Bun.sleep(milliseconds);
}

function createWatchdogTmuxRunner(tmuxBin = "tmux"): TmuxRunner {
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
