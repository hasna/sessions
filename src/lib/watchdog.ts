import type { TmuxRunner } from "./live.js";

export type WatchdogStatus = "dead" | "crashed";

export interface WatchdogPaneRecord {
  sessionName: string;
  windowName: string;
  windowIndex: string;
  paneIndex: string;
  command: string;
  cwd: string | null;
  paneDead: boolean;
}

export interface WatchdogCandidate {
  session_name: string;
  window_target: string;
  status: WatchdogStatus;
  sibling_dir: string | null;
}

export interface WatchdogScanOptions {
  tmuxBin?: string;
  runner?: TmuxRunner;
}

const WATCHDOG_TMUX_FORMAT = [
  "#{session_name}",
  "#{window_name}",
  "#{window_index}",
  "#{pane_index}",
  "#{pane_current_command}",
  "#{pane_current_path}",
  "#{pane_dead}",
].join("\t");

const CRASHED_SHELL_COMMANDS = new Set(["bash", "sh"]);

export function parseWatchdogPaneLine(line: string): WatchdogPaneRecord | null {
  if (!line.trim()) return null;
  const parts = line.split("\t");
  if (parts.length < 7) return null;
  const [sessionName, windowName, windowIndex, paneIndex, command, cwd, paneDead] = parts;
  return {
    sessionName,
    windowName,
    windowIndex,
    paneIndex,
    command,
    cwd: cwd.trim() ? cwd : null,
    paneDead: paneDead === "1",
  };
}

export function scanWatchdogFromTmuxOutput(listOutput: string): WatchdogCandidate[] {
  const primaryPanes = listOutput
    .split("\n")
    .map(parseWatchdogPaneLine)
    .filter((pane): pane is WatchdogPaneRecord => pane !== null)
    .filter((pane) => pane.windowName === pane.sessionName);

  const healthySessions = new Set(
    primaryPanes
      .filter((pane) => !pane.paneDead && normalizeCommand(pane.command) === "claude")
      .map((pane) => pane.sessionName)
  );

  const candidates = new Map<string, WatchdogCandidate>();
  for (const pane of primaryPanes) {
    const status = watchdogStatus(pane);
    if (!status || !hasHealthySibling(pane.sessionName, healthySessions)) continue;

    const windowTarget = `${pane.sessionName}:${pane.windowIndex}`;
    const existing = candidates.get(windowTarget);
    if (!existing || (status === "dead" && existing.status !== "dead")) {
      candidates.set(windowTarget, {
        session_name: pane.sessionName,
        window_target: windowTarget,
        status,
        sibling_dir: pane.cwd,
      });
    }
  }

  return [...candidates.values()].sort((a, b) =>
    a.window_target.localeCompare(b.window_target)
  );
}

export function scanWatchdogSessions(options: WatchdogScanOptions = {}): WatchdogCandidate[] {
  const runner = options.runner ?? createWatchdogTmuxRunner(options.tmuxBin);
  const result = runner(["list-panes", "-a", "-F", WATCHDOG_TMUX_FORMAT]);
  if (result.exitCode !== 0) return [];
  return scanWatchdogFromTmuxOutput(result.stdout);
}

function watchdogStatus(pane: WatchdogPaneRecord): WatchdogStatus | null {
  if (pane.paneDead) return "dead";
  return CRASHED_SHELL_COMMANDS.has(normalizeCommand(pane.command)) ? "crashed" : null;
}

function hasHealthySibling(sessionName: string, healthySessions: Set<string>): boolean {
  const prefix = siblingPrefix(sessionName);
  if (!prefix) return false;
  return [...healthySessions].some(
    (healthySession) =>
      healthySession !== sessionName && siblingPrefix(healthySession) === prefix
  );
}

function siblingPrefix(sessionName: string): string | null {
  const separator = sessionName.lastIndexOf("-");
  if (separator <= 0 || separator === sessionName.length - 1) return null;
  return sessionName.slice(0, separator + 1);
}

function normalizeCommand(command: string): string {
  return command.trim().toLowerCase();
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
