// ── Constants ──────────────────────────────────────────────────────────

export const SESSION_SOURCES = ["claude", "codex", "codewith", "gemini"] as const;
export type SessionSource = (typeof SESSION_SOURCES)[number];

export function isSessionSource(value: string): value is SessionSource {
  return (SESSION_SOURCES as readonly string[]).includes(value);
}

export const MESSAGE_ROLES = [
  "user",
  "assistant",
  "system",
  "tool",
  "info",
  "thinking",
] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const TOOL_CALL_STATUSES = ["success", "error", "timeout"] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

// ── Session ────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  source: SessionSource;
  source_id: string;
  source_path: string | null;
  title: string | null;
  project_path: string | null;
  project_name: string | null;
  model: string | null;
  model_provider: string | null;
  git_branch: string | null;
  git_sha: string | null;
  git_origin_url: string | null;
  cli_version: string | null;
  is_subagent: boolean;
  parent_session_id: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_cache_write_tokens: number;
  total_thinking_tokens: number;
  message_count: number;
  tool_call_count: number;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  ingested_at: string;
  updated_at: string;
  source_modified_at: string | null;
  machine: string | null;
  metadata: Record<string, unknown>;
}

export interface SessionLookupOptions {
  /**
   * Resolve the identifier as a provider-native source id or source-id prefix
   * within this source. Source-qualified identifiers such as `codewith:<id>`
   * are normalized to this shape by lookup implementations.
   */
  source?: SessionSource | string;
}

export interface SessionInsert {
  id?: string;
  source: SessionSource;
  source_id: string;
  source_path?: string | null;
  title?: string | null;
  project_path?: string | null;
  project_name?: string | null;
  model?: string | null;
  model_provider?: string | null;
  git_branch?: string | null;
  git_sha?: string | null;
  git_origin_url?: string | null;
  cli_version?: string | null;
  is_subagent?: boolean;
  parent_session_id?: string | null;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cache_read_tokens?: number;
  total_cache_write_tokens?: number;
  total_thinking_tokens?: number;
  message_count?: number;
  tool_call_count?: number;
  started_at?: string | null;
  ended_at?: string | null;
  duration_seconds?: number | null;
  source_modified_at?: string | null;
  machine?: string | null;
  metadata?: Record<string, unknown>;
}

export interface Machine {
  name: string;
  hostname: string | null;
  platform: string | null;
  first_seen_at: string;
  last_seen_at: string;
  session_count: number;
}

// ── Message ────────────────────────────────────────────────────────────

export interface Message {
  id: string;
  session_id: string;
  source_id: string | null;
  parent_message_id: string | null;
  role: MessageRole;
  content: string | null;
  content_preview: string | null;
  model: string | null;
  is_sidechain: boolean;
  sequence_num: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  thinking_tokens: number;
  timestamp: string | null;
  metadata: Record<string, unknown>;
}

export interface MessageInsert {
  id?: string;
  session_id: string;
  source_id?: string | null;
  parent_message_id?: string | null;
  role: MessageRole;
  content?: string | null;
  content_preview?: string | null;
  model?: string | null;
  is_sidechain?: boolean;
  sequence_num?: number | null;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  thinking_tokens?: number;
  timestamp?: string | null;
  metadata?: Record<string, unknown>;
}

// ── Tool call ──────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  message_id: string | null;
  session_id: string;
  tool_name: string;
  tool_input: string | null;
  tool_output: string | null;
  duration_ms: number | null;
  status: ToolCallStatus | null;
  timestamp: string | null;
  metadata: Record<string, unknown>;
}

export interface ToolCallInsert {
  id?: string;
  message_id?: string | null;
  session_id: string;
  tool_name: string;
  tool_input?: string | null;
  tool_output?: string | null;
  duration_ms?: number | null;
  status?: ToolCallStatus | null;
  timestamp?: string | null;
  metadata?: Record<string, unknown>;
}

// ── Parsed (parser output, pre-DB) ─────────────────────────────────────

export interface ParsedSession {
  session: SessionInsert;
  messages: MessageInsert[];
  toolCalls: ToolCallInsert[];
}

export interface StagedParsedSession {
  session: SessionInsert;
  messageCount: number;
  toolCallCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalThinkingTokens: number;
  /** Largest normalized record batch held by the parser while staging. */
  maxNormalizedBatchRecords: number;
  forEachMessageBatch(batchSize: number, callback: (batch: MessageInsert[]) => void): void;
  forEachToolCallBatch(batchSize: number, callback: (batch: ToolCallInsert[]) => void): void;
  cleanup(): void;
}

export interface SessionContentBackup {
  /** Caller-created backup artifact path or URI, if available. */
  artifact?: string | null;
  /** ISO timestamp when the caller created or verified the backup. */
  created_at?: string | null;
  /** Human-readable backup note; do not include secrets. */
  note?: string | null;
}

export interface SessionContentDestructiveIntent {
  /**
   * Allows an import payload to replace an existing session with fewer messages
   * or tool calls. Requires a non-empty reason.
   */
  allowContentShrink: boolean;
  /** Human-readable reason for intentionally shrinking synced content. */
  reason: string;
}

export interface SessionContentImport extends ParsedSession {
  /**
   * Caller-provided backup/export metadata. The server records only this
   * metadata in the response; callers own the actual SQLite-safe backup
   * artifact lifecycle.
   */
  backup?: SessionContentBackup;
  /**
   * Explicit destructive intent for intentional content pruning. By default,
   * import refuses to replace existing cloud content with fewer child rows.
   */
  destructive?: SessionContentDestructiveIntent;
}

// ── Errors ─────────────────────────────────────────────────────────────

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Session not found: ${id}`);
    this.name = "SessionNotFoundError";
  }
}

export interface SessionLookupCandidate {
  id: string;
  source: string;
  source_id: string;
}

export class SessionAmbiguousError extends Error {
  readonly identifier: string;
  readonly candidates: SessionLookupCandidate[];

  constructor(identifier: string, candidates: SessionLookupCandidate[]) {
    const suffix = candidates
      .slice(0, 5)
      .map((candidate) => `${candidate.source}:${candidate.source_id}`)
      .join(", ");
    super(
      `Ambiguous session identifier '${identifier}' matched ${candidates.length} sessions` +
        (suffix ? ` (${suffix})` : "") +
        "; qualify it as <source>:<source_id> or pass an explicit source.",
    );
    this.name = "SessionAmbiguousError";
    this.identifier = identifier;
    this.candidates = candidates;
  }
}
