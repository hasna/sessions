/**
 * Canonical session format that all adapters normalize to.
 *
 * This is the lowest common denominator across all AI CLI session formats.
 * It captures: metadata, user messages, assistant responses, and tool calls.
 */

export interface CanonicalSession {
  /** Unique session identifier */
  id: string;
  /** Project working directory */
  cwd: string;
  /** When the session started */
  startedAt: string;
  /** Last activity timestamp */
  lastActivityAt: string;
  /** Model/provider used */
  model: string | null;
  /** Custom title if set */
  title: string | null;
  /** Agent name if set */
  agentName: string | null;
  /** Source tool name (claude, codex, etc.) */
  source: string;
  /** Ordered transcript events */
  events: CanonicalEvent[];
  /** Raw source path for the session file */
  sourcePath: string;
}

export type CanonicalEventType =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "system"
  | "thinking";

export interface CanonicalEvent {
  /** Event type */
  type: CanonicalEventType;
  /** ISO timestamp */
  timestamp: string;
  /** Model name (for assistant/tool events) */
  model?: string;
  /** Text content */
  content: string;
  /** For tool_call: the tool name */
  toolName?: string;
  /** For tool_call/tool_result: structured arguments */
  toolArgs?: Record<string, any>;
  /** For tool_result: the result */
  toolResult?: string;
}

/**
 * A session adapter knows how to discover and parse sessions
 * from a specific AI CLI's native storage format.
 */
export interface SessionAdapter {
  /** Unique identifier (e.g., "claude", "codex") */
  readonly id: string;

  /** Human-readable name (e.g., "Claude Code", "OpenAI Codex") */
  readonly name: string;

  /** Whether this tool's session storage exists on this machine */
  isAvailable(): boolean;

  /**
   * Return paths to all session files for this adapter.
   * Each entry is the raw path to a session file.
   */
  discoverSessions(): string[];

  /**
   * Parse a single session file into the canonical format.
   */
  parseSession(filePath: string): CanonicalSession | null;

  /**
   * Return the base directory where this tool stores sessions.
   */
  getSessionsDir(): string;
}

/**
 * Result of importing sessions into the Claude Code storage format.
 */
export interface ImportResult {
  /** Number of sessions imported */
  imported: number;
  /** Number of sessions skipped (already exist) */
  skipped: number;
  /** Errors encountered */
  errors: Array<{ file: string; error: string }>;
}

/**
 * Options for importing sessions.
 */
export interface ImportOptions {
  /** Only import sessions for this project path */
  projectPath?: string;
  /** Overwrite existing session files */
  overwrite?: boolean;
  /** Dry run — show what would be imported */
  dryRun?: boolean;
  /** Print detailed progress */
  verbose?: boolean;
  /** Also write to the sessions registry */
  updateRegistry?: boolean;
}
