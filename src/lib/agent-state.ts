import { Buffer } from "node:buffer";
import { getDatabase } from "../db/database.js";
import {
  countSessions,
  listSessionsByLastActivity,
  resolveSessionByPrefix,
} from "../db/sessions.js";
import { getMachineName } from "./machine.js";
import type { Session } from "../types/index.js";

export const ACTIVE_AGENTS_SCHEMA_VERSION = "sessions.active_agents.v1";
export const SESSION_HEALTH_SCHEMA_VERSION = "sessions.session_health.v1";

export type TargetKind = "agent" | "shell" | "unknown";
export type AgentKind = "codewith" | "codex" | "claude" | "gemini" | "opencode" | "aider" | "takumi" | "unknown";
export type ComposerState = "idle" | "active" | "unknown";
export type SessionActivity = "active" | "idle" | "stale";
export type HealthLevel = "healthy" | "warning" | "critical";
export type IssueSeverity = "info" | "warning" | "critical";

const DEFAULT_ACTIVE_AGENT_LIMIT = 20;
const DEFAULT_SESSION_HEALTH_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_CAPTURE_LINES = 80;
const MAX_CAPTURE_LINES = 200;
const MAX_CAPTURE_CHARS = 16_000;
const DEFAULT_ACTIVE_WINDOW_MINUTES = 15;
const DEFAULT_STALE_WINDOW_MINUTES = 60;
const DEFAULT_ISSUE_LIMIT = 8;
const MAX_TITLE_CHARS = 160;
const MAX_FIELD_CHARS = 512;
const MAX_REASON_CHARS = 280;
const MAX_ERROR_CHARS = 1_000;

const SHELL_COMMANDS = new Set(["bash", "csh", "dash", "fish", "ksh", "nu", "sh", "tcsh", "zsh"]);
const DIRECT_AGENT_COMMANDS: Record<string, AgentKind> = {
  aider: "aider",
  claude: "claude",
  "claude-code": "claude",
  codewith: "codewith",
  codex: "codex",
  gemini: "gemini",
  opencode: "opencode",
  takumi: "takumi",
};
const QUEUE_CAPABLE_AGENTS = new Set<AgentKind>(["claude", "codewith"]);
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-(?:ant|proj)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_SECRET]"],
  [new RegExp(`\\bn${"pm"}_[A-Za-z0-9_-]{8,}\\b`, "g"), "[REDACTED_SECRET]"],
  [/\bgh[opsu]_[A-Za-z0-9_]{8,}\b/g, "[REDACTED_SECRET]"],
  [new RegExp(`\\bctx7${"sk"}-[A-Za-z0-9_-]{8,}\\b`, "g"), "[REDACTED_SECRET]"],
  [new RegExp(`\\bx${"ai"}-[A-Za-z0-9_-]{8,}\\b`, "g"), "[REDACTED_SECRET]"],
  [new RegExp(`\\bAI${"za"}[A-Za-z0-9_-]{8,}\\b`, "g"), "[REDACTED_SECRET]"],
  [new RegExp(`\\bAK${"IA"}[A-Z0-9]{16}\\b`, "g"), "[REDACTED_SECRET]"],
  [new RegExp(`\\b(${"secret-token"}:\\s*)\\S+`, "gi"), "$1[REDACTED_SECRET]"],
  [/\b(api[_-]?key|token|password|secret)=\S+/gi, "$1=[REDACTED_SECRET]"],
];

export interface AgentClassification {
  target_kind: TargetKind;
  agent_kind: AgentKind;
  composer_state: ComposerState;
  can_receive_prompt: boolean;
  can_queue_prompt: boolean;
  submit_keys: Array<"Enter" | "Tab">;
  recommended_submit_key: "Enter" | "Tab" | null;
  confidence: "high" | "medium" | "low";
  reason: string;
}

export interface ActiveAgentSummary {
  target: string;
  pane_id: string | null;
  cwd: string | null;
  command: string;
  classification: AgentClassification;
  evidence_paths: string[];
  evidence: {
    pane_id: string | null;
    session_name: string;
    window_index: string;
    pane_index: string;
    capture_lines: number;
    capture_chars: number;
  };
}

export interface ActiveAgentsResponse {
  schema_version: typeof ACTIVE_AGENTS_SCHEMA_VERSION;
  generated_at: string;
  machine: string;
  redacted: true;
  limit: number;
  total: number;
  returned: number;
  truncated: boolean;
  source: {
    backend: "tmux";
    available: boolean;
    command: string;
    errors: string[];
  };
  agents: ActiveAgentSummary[];
}

export interface SessionResumeCommand {
  available: boolean;
  argv: string[] | null;
  shell: string | null;
  reason: string | null;
}

export interface SessionHealthIssue {
  type: "stale" | "empty_transcript" | "missing_cwd" | "missing_source_path" | "token_bloat" | "tool_bloat" | "tool_errors" | "no_resume_command";
  severity: IssueSeverity;
  description: string;
  evidence_paths: string[];
}

export interface SessionHealthSummary {
  id: string;
  source: Session["source"];
  source_id: string;
  title: string | null;
  cwd: string | null;
  machine: string | null;
  updated_at: string | null;
  last_activity_at: string | null;
  age_minutes: number | null;
  command: SessionResumeCommand;
  classification: {
    agent_kind: AgentKind;
    activity: SessionActivity;
    health: HealthLevel;
    composer_state: "unknown";
    reason: string;
  };
  counts: {
    messages: number;
    tool_calls: number;
    tokens: number;
  };
  evidence_paths: string[];
  evidence_refs: {
    session: string;
    source_path: string | null;
  };
  issues: SessionHealthIssue[];
  truncated: {
    issues: boolean;
  };
}

export interface SessionHealthResponse {
  schema_version: typeof SESSION_HEALTH_SCHEMA_VERSION;
  generated_at: string;
  machine: string;
  redacted: true;
  limit: number;
  total: number;
  returned: number;
  truncated: boolean;
  lookup?: {
    id: string;
    status: "found" | "not_found" | "ambiguous" | "filtered_out";
    matches: number;
  };
  sessions: SessionHealthSummary[];
}

export interface ActiveAgentsOptions {
  limit?: number;
  includeUnknown?: boolean;
  capture?: boolean;
  captureLines?: number;
  tmuxCommand?: string;
  now?: Date;
}

export interface SessionHealthOptions {
  id?: string;
  source?: string;
  project_path?: string;
  machine?: string;
  limit?: number;
  activeMinutes?: number;
  staleMinutes?: number;
  issueLimit?: number;
  now?: Date;
}

interface TmuxPane {
  sessionName: string;
  windowIndex: string;
  paneIndex: string;
  paneId: string | null;
  command: string;
  cwd: string | null;
  dead: boolean;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function boundedPositiveInt(value: number | undefined, fallback: number, max = MAX_LIMIT): number {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

function boundedNonNegativeInt(value: number | undefined, fallback: number, max: number): number {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < 0) return fallback;
  return Math.min(value, max);
}

export function redactSensitive(value: string): string {
  return SECRET_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value
  );
}

function boundString(value: string, max = MAX_FIELD_CHARS): string {
  if (value.length <= max) return value;
  if (max <= 20) return value.slice(0, max);
  const marker = "...[truncated]...";
  const remaining = max - marker.length;
  const head = Math.ceil(remaining / 2);
  const tail = Math.floor(remaining / 2);
  return `${value.slice(0, head)}${marker}${value.slice(-tail)}`;
}

export function redactAndBoundString(value: string, max = MAX_FIELD_CHARS): string {
  return boundString(redactSensitive(value).replace(/\0/g, ""), max);
}

function redactNullable(value: string | null | undefined, max = MAX_FIELD_CHARS): string | null {
  return value == null ? null : redactAndBoundString(value, max);
}

function basename(command: string): string {
  const trimmed = command.trim();
  const part = trimmed.split(/[\\/]/).at(-1) ?? trimmed;
  return part.trim().toLowerCase();
}

function agentKindFromCommand(command: string): AgentKind {
  return DIRECT_AGENT_COMMANDS[basename(command)] ?? "unknown";
}

function agentKindFromText(text: string): AgentKind {
  if (/\b(?:Hasna\s+)?Codewith(?:\s+CLI)?\b/i.test(text) || /\bPursuing goal\b|\bGoal active Objective:\b/i.test(text)) {
    return "codewith";
  }
  if (/\b(?:OpenAI\s+)?Codex(?:\s+CLI)?\b/i.test(text)) return "codex";
  if (/\b(?:Anthropic\s+)?Claude(?:\s+Code)?(?:\s+CLI)?\b/i.test(text)) return "claude";
  if (/\bGemini(?:\s+CLI)?\b/i.test(text)) return "gemini";
  if (/\bOpenCode(?:\s+CLI)?\b/i.test(text)) return "opencode";
  if (/\bTakumi(?:\s+CLI)?\b/i.test(text)) return "takumi";
  return "unknown";
}

function composerStateFromText(text: string): ComposerState {
  const normalized = text.replace(/\s+/g, " ");
  if (/\b(?:Pursuing goal|Working \(|esc to interrupt|background terminal running|Messages to be submitted after next tool call|Goal active Objective:)\b/i.test(normalized)) {
    return "active";
  }
  if (/\bGoal achieved(?:\s*\([^)]+\))?\b/i.test(normalized) && /^[›❯>](?:\s|$).*/m.test(text)) {
    return "idle";
  }
  if (/^[›❯>](?:\s|$).*/m.test(text) || /\b(?:awaiting prompt|idle composer)\b/i.test(normalized)) {
    return "idle";
  }
  return "unknown";
}

function classifyPane(command: string, visible: string): AgentClassification {
  const commandKind = agentKindFromCommand(command);
  const textKind = agentKindFromText(visible);
  const shell = SHELL_COMMANDS.has(basename(command));
  const agentKind = commandKind !== "unknown" ? commandKind : textKind;
  const targetKind: TargetKind = shell ? "shell" : agentKind !== "unknown" ? "agent" : "unknown";
  const composerState = targetKind === "agent" ? composerStateFromText(visible) : "unknown";
  const canReceivePrompt = targetKind === "agent" && composerState === "idle";
  const canQueuePrompt = targetKind === "agent" && composerState === "active" && QUEUE_CAPABLE_AGENTS.has(agentKind);
  const submitKeys: Array<"Enter" | "Tab"> = targetKind === "agent" ? ["Enter"] : [];
  if (targetKind === "agent" && QUEUE_CAPABLE_AGENTS.has(agentKind)) submitKeys.push("Tab");
  const confidence = commandKind !== "unknown" ? "high" : textKind !== "unknown" ? "medium" : "low";
  const recommendedSubmitKey = canReceivePrompt ? "Enter" : canQueuePrompt ? "Tab" : null;
  const reason =
    targetKind === "shell"
      ? `pane command ${basename(command) || "unknown"} is a shell`
      : targetKind === "agent"
        ? `recognized ${agentKind} from ${commandKind !== "unknown" ? "pane command" : "visible composer"}; composer is ${composerState}`
        : `pane command ${basename(command) || "unknown"} is not a recognized agent composer`;

  return {
    target_kind: targetKind,
    agent_kind: agentKind,
    composer_state: composerState,
    can_receive_prompt: canReceivePrompt,
    can_queue_prompt: canQueuePrompt,
    submit_keys: submitKeys,
    recommended_submit_key: recommendedSubmitKey,
    confidence,
    reason: redactAndBoundString(reason, MAX_REASON_CHARS),
  };
}

function runCommand(cmd: string[]): CommandResult {
  try {
    const proc = Bun.spawnSync({
      cmd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = Buffer.from(proc.stdout).toString("utf-8");
    const stderr = Buffer.from(proc.stderr).toString("utf-8");
    const exitCode = proc.exitCode;
    return { ok: exitCode === 0, stdout, stderr, exitCode };
  } catch (error) {
    return { ok: false, stdout: "", stderr: (error as Error).message, exitCode: null };
  }
}

function tmuxCommand(options: ActiveAgentsOptions): string {
  return options.tmuxCommand ?? process.env.SESSIONS_TMUX ?? "tmux";
}

function parseTmuxPanes(stdout: string): TmuxPane[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const parts = line.split("\t");
      const [sessionName = "", windowIndex = "", paneIndex = "", paneId = "", command = "", cwd = "", _panePid = "", dead = "0"] = parts;
      return {
        sessionName,
        windowIndex,
        paneIndex,
        paneId: paneId || null,
        command,
        cwd: cwd || null,
        dead: dead === "1",
      };
    })
    .filter((pane) => !pane.dead && pane.sessionName && pane.windowIndex && pane.paneIndex);
}

function paneTarget(pane: TmuxPane): string {
  return `${pane.sessionName}:${pane.windowIndex}.${pane.paneIndex}`;
}

function capturePane(command: string, target: string, lines: number): string {
  if (lines <= 0) return "";
  const result = runCommand([command, "capture-pane", "-pt", target, "-S", `-${lines}`]);
  if (!result.ok) return "";
  return redactSensitive(result.stdout).slice(-MAX_CAPTURE_CHARS);
}

export function buildActiveAgentsResponse(options: ActiveAgentsOptions = {}): ActiveAgentsResponse {
  const limit = boundedPositiveInt(options.limit, DEFAULT_ACTIVE_AGENT_LIMIT);
  const captureLines = boundedNonNegativeInt(options.captureLines, DEFAULT_CAPTURE_LINES, MAX_CAPTURE_LINES);
  const command = tmuxCommand(options);
  const list = runCommand([
    command,
    "list-panes",
    "-a",
    "-F",
    "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_pid}\t#{pane_dead}",
  ]);

  if (!list.ok) {
    const error = redactAndBoundString(
      list.stderr.trim() || `tmux list-panes failed${list.exitCode == null ? "" : ` (exit ${list.exitCode})`}`,
      MAX_ERROR_CHARS
    );
    return {
      schema_version: ACTIVE_AGENTS_SCHEMA_VERSION,
      generated_at: (options.now ?? new Date()).toISOString(),
      machine: getMachineName(),
      redacted: true,
      limit,
      total: 0,
      returned: 0,
      truncated: false,
      source: { backend: "tmux", available: false, command: redactAndBoundString(command), errors: [error] },
      agents: [],
    };
  }

  const summaries = parseTmuxPanes(list.stdout)
    .map((pane): ActiveAgentSummary => {
      const target = paneTarget(pane);
      const visible = options.capture === false ? "" : capturePane(command, target, captureLines);
      const classification = classifyPane(pane.command, visible);
      const evidencePath = redactAndBoundString(`tmux://${target}`);
      return {
        target: redactAndBoundString(target),
        pane_id: redactNullable(pane.paneId),
        cwd: redactNullable(pane.cwd),
        command: redactAndBoundString(pane.command),
        classification,
        evidence_paths: [evidencePath],
        evidence: {
          pane_id: redactNullable(pane.paneId),
          session_name: redactAndBoundString(pane.sessionName),
          window_index: redactAndBoundString(pane.windowIndex),
          pane_index: redactAndBoundString(pane.paneIndex),
          capture_lines: options.capture === false ? 0 : captureLines,
          capture_chars: visible.length,
        },
      };
    })
    .filter((summary) => options.includeUnknown || summary.classification.target_kind === "agent")
    .sort((a, b) => a.target.localeCompare(b.target));

  const agents = summaries.slice(0, limit);
  return {
    schema_version: ACTIVE_AGENTS_SCHEMA_VERSION,
    generated_at: (options.now ?? new Date()).toISOString(),
    machine: getMachineName(),
    redacted: true,
    limit,
    total: summaries.length,
    returned: agents.length,
    truncated: summaries.length > agents.length,
    source: { backend: "tmux", available: true, command: redactAndBoundString(command), errors: [] },
    agents,
  };
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function resumeCommandForSession(session: Session): SessionResumeCommand {
  const raw = session.metadata.resume_command;
  if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
    const argv = raw.map((item) => redactAndBoundString(item, MAX_FIELD_CHARS));
    return { available: true, argv, shell: redactAndBoundString(argv.map(shellQuote).join(" "), MAX_FIELD_CHARS), reason: null };
  }
  if (typeof raw === "string" && raw.trim()) {
    return { available: true, argv: null, shell: redactAndBoundString(raw.trim(), MAX_FIELD_CHARS), reason: null };
  }
  if (session.source === "claude") {
    const argv = ["claude", "--resume", session.source_id].map((item) => redactAndBoundString(item, MAX_FIELD_CHARS));
    return { available: true, argv, shell: argv.map(shellQuote).join(" "), reason: null };
  }
  const reason = `No stable resume command is configured for ${session.source} indexed sessions yet; inspect source_path or use the provider's native history UI.`;
  return {
    available: false,
    argv: null,
    shell: null,
    reason: redactAndBoundString(reason, MAX_REASON_CHARS),
  };
}

function agentKindForSource(source: Session["source"]): AgentKind {
  if (source === "claude") return "claude";
  if (source === "codex") return "codex";
  if (source === "gemini") return "gemini";
  return "unknown";
}

function sessionLastActivity(session: Session): string | null {
  return session.ended_at ?? session.updated_at ?? session.started_at ?? session.ingested_at ?? null;
}

function ageMinutes(now: Date, timestamp: string | null): number | null {
  if (!timestamp) return null;
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((now.getTime() - parsed) / 60_000));
}

function activityForAge(age: number | null, activeMinutes: number, staleMinutes: number): SessionActivity {
  if (age == null) return "stale";
  if (age <= activeMinutes) return "active";
  if (age <= staleMinutes) return "idle";
  return "stale";
}

function severityScore(severity: IssueSeverity): number {
  if (severity === "critical") return 50;
  if (severity === "warning") return 20;
  return 5;
}

function buildSessionIssues(
  session: Session,
  options: { age: number | null; staleMinutes: number; command: SessionResumeCommand }
): SessionHealthIssue[] {
  const evidencePaths = session.source_path ? [redactAndBoundString(session.source_path)] : [];
  const issues: SessionHealthIssue[] = [];
  const tokenTotal =
    session.total_input_tokens +
    session.total_output_tokens +
    session.total_cache_read_tokens +
    session.total_cache_write_tokens +
    session.total_thinking_tokens;

  if (session.message_count === 0) {
    issues.push({
      type: "empty_transcript",
      severity: "critical",
      description: redactAndBoundString("Session has no indexed messages.", MAX_REASON_CHARS),
      evidence_paths: evidencePaths,
    });
  }
  if (!session.project_path) {
    issues.push({
      type: "missing_cwd",
      severity: "warning",
      description: redactAndBoundString("Session does not have a cwd/project_path.", MAX_REASON_CHARS),
      evidence_paths: evidencePaths,
    });
  }
  if (!session.source_path) {
    issues.push({
      type: "missing_source_path",
      severity: "info",
      description: redactAndBoundString("Session does not have a raw source transcript path.", MAX_REASON_CHARS),
      evidence_paths: [],
    });
  }
  if (options.age != null && options.age > options.staleMinutes) {
    issues.push({
      type: "stale",
      severity: "warning",
      description: redactAndBoundString(`No indexed activity for ${options.age} minutes.`, MAX_REASON_CHARS),
      evidence_paths: evidencePaths,
    });
  }
  if (session.message_count > 0 && tokenTotal / session.message_count > 4_000) {
    issues.push({
      type: "token_bloat",
      severity: "warning",
      description: redactAndBoundString(`Average indexed token count is ${Math.round(tokenTotal / session.message_count)} per message.`, MAX_REASON_CHARS),
      evidence_paths: evidencePaths,
    });
  }
  if (session.tool_call_count > 200) {
    issues.push({
      type: "tool_bloat",
      severity: "info",
      description: redactAndBoundString(`Session has ${session.tool_call_count} indexed tool calls.`, MAX_REASON_CHARS),
      evidence_paths: evidencePaths,
    });
  }
  if (!options.command.available) {
    issues.push({
      type: "no_resume_command",
      severity: "info",
      description: redactAndBoundString(options.command.reason ?? "No stable resume command is configured.", MAX_REASON_CHARS),
      evidence_paths: evidencePaths,
    });
  }

  return issues;
}

function countErroredToolCalls(sessionId: string): number {
  const row = getDatabase()
    .prepare("SELECT COUNT(*) AS c FROM tool_calls WHERE session_id = ? AND status IN ('error', 'timeout')")
    .get(sessionId) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

function summarizeSessionHealth(
  session: Session,
  options: Required<Pick<SessionHealthOptions, "activeMinutes" | "staleMinutes" | "issueLimit" | "now">>
): SessionHealthSummary {
  const command = resumeCommandForSession(session);
  const lastActivityAt = sessionLastActivity(session);
  const age = ageMinutes(options.now, lastActivityAt);
  const evidencePaths = session.source_path ? [redactAndBoundString(session.source_path)] : [];
  const issues = buildSessionIssues(session, { age, staleMinutes: options.staleMinutes, command });
  const erroredTools = countErroredToolCalls(session.id);
  if (erroredTools > 0) {
    issues.push({
      type: "tool_errors",
      severity: "warning",
      description: redactAndBoundString(`${erroredTools} indexed tool calls ended with error or timeout.`, MAX_REASON_CHARS),
      evidence_paths: evidencePaths,
    });
  }

  const score = Math.max(0, 100 - issues.reduce((sum, issue) => sum + severityScore(issue.severity), 0));
  const health: HealthLevel = score < 50 || issues.some((issue) => issue.severity === "critical")
    ? "critical"
    : issues.some((issue) => issue.severity === "warning")
      ? "warning"
      : "healthy";
  const activity = activityForAge(age, options.activeMinutes, options.staleMinutes);
  const visibleIssues = issues.slice(0, options.issueLimit);

  return {
    id: session.id,
    source: session.source,
    source_id: redactAndBoundString(session.source_id),
    title: redactNullable(session.title, MAX_TITLE_CHARS),
    cwd: redactNullable(session.project_path),
    machine: redactNullable(session.machine),
    updated_at: redactNullable(session.updated_at),
    last_activity_at: redactNullable(lastActivityAt),
    age_minutes: age,
    command,
    classification: {
      agent_kind: agentKindForSource(session.source),
      activity,
      health,
      composer_state: "unknown",
      reason: redactAndBoundString(`${activity} indexed session; ${health} health (${issues.length} issue${issues.length === 1 ? "" : "s"})`, MAX_REASON_CHARS),
    },
    counts: {
      messages: session.message_count,
      tool_calls: session.tool_call_count,
      tokens:
        session.total_input_tokens +
        session.total_output_tokens +
        session.total_cache_read_tokens +
        session.total_cache_write_tokens +
        session.total_thinking_tokens,
    },
    evidence_paths: evidencePaths,
    evidence_refs: {
      session: redactAndBoundString(`sessions://session/${session.id}`),
      source_path: evidencePaths[0] ?? null,
    },
    issues: visibleIssues,
    truncated: {
      issues: issues.length > visibleIssues.length,
    },
  };
}

export function buildSessionHealthResponse(options: SessionHealthOptions = {}): SessionHealthResponse {
  const now = options.now ?? new Date();
  const limit = boundedPositiveInt(options.limit, DEFAULT_SESSION_HEALTH_LIMIT);
  const activeMinutes = boundedPositiveInt(options.activeMinutes, DEFAULT_ACTIVE_WINDOW_MINUTES, 24 * 60);
  const staleMinutes = Math.max(
    activeMinutes,
    boundedPositiveInt(options.staleMinutes, DEFAULT_STALE_WINDOW_MINUTES, 30 * 24 * 60)
  );
  const issueLimit = boundedPositiveInt(options.issueLimit, DEFAULT_ISSUE_LIMIT, 50);

  const filters = {
    source: options.source,
    project_path: options.project_path,
    machine: options.machine,
  };
  let total = 0;
  let lookup: SessionHealthResponse["lookup"] | undefined;
  const sessions = options.id
    ? (() => {
        const result = resolveSessionByPrefix(options.id!);
        lookup = {
          id: redactAndBoundString(options.id!, MAX_FIELD_CHARS),
          status: result.status,
          matches: result.matches,
        };
        if (!result.session) return [];
        const filteredOut =
          (filters.source != null && result.session.source !== filters.source) ||
          (filters.project_path != null && result.session.project_path !== filters.project_path) ||
          (filters.machine != null && result.session.machine !== filters.machine);
        if (filteredOut) {
          lookup = { ...lookup!, status: "filtered_out" };
          return [];
        }
        total = 1;
        return [result.session];
      })()
    : listSessionsByLastActivity({
        source: options.source,
        project_path: options.project_path,
        machine: options.machine,
        limit,
      });
  if (!options.id) {
    total = countSessions(filters);
  }

  const summaries = sessions
    .slice(0, limit)
    .map((session) => summarizeSessionHealth(session, { activeMinutes, staleMinutes, issueLimit, now }));

  return {
    schema_version: SESSION_HEALTH_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    machine: getMachineName(),
    redacted: true,
    limit,
    total,
    returned: summaries.length,
    truncated: total > summaries.length,
    lookup,
    sessions: summaries,
  };
}
