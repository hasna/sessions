// ── Constants ──────────────────────────────────────────────────────────

export const SESSION_SOURCES = ["claude", "codex", "gemini"] as const;
export type SessionSource = (typeof SESSION_SOURCES)[number];

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
  metadata: Record<string, unknown>;
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
  metadata?: Record<string, unknown>;
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

// ── Errors ─────────────────────────────────────────────────────────────

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Session not found: ${id}`);
    this.name = "SessionNotFoundError";
  }
}
