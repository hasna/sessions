import type { Message, Session, ToolCall } from "../../types/index.js";

export interface SessionRow {
  id: string;
  source: string;
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
  metadata: string | null;
  [key: string]: unknown;
}

export interface MessageRow {
  id: string;
  session_id: string;
  source_id: string | null;
  parent_message_id: string | null;
  role: string;
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
  metadata: string | null;
  [key: string]: unknown;
}

export interface ToolCallRow {
  id: string;
  message_id: string | null;
  session_id: string;
  tool_name: string;
  tool_input: string | null;
  tool_output: string | null;
  duration_ms: number | null;
  status: string | null;
  timestamp: string | null;
  metadata: string | null;
  [key: string]: unknown;
}

export function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function rowToSession(row: SessionRow): Session {
  let metadata: Record<string, unknown> = {};
  if (row.metadata) {
    try {
      const parsed = JSON.parse(row.metadata);
      if (parsed && typeof parsed === "object") metadata = parsed as Record<string, unknown>;
    } catch {
      metadata = {};
    }
  }
  return {
    id: row.id,
    source: row.source as Session["source"],
    source_id: row.source_id,
    source_path: row.source_path,
    title: row.title,
    project_path: row.project_path,
    project_name: row.project_name,
    model: row.model,
    model_provider: row.model_provider,
    git_branch: row.git_branch,
    git_sha: row.git_sha,
    git_origin_url: row.git_origin_url,
    cli_version: row.cli_version,
    is_subagent: Boolean(row.is_subagent),
    parent_session_id: row.parent_session_id,
    total_input_tokens: num(row.total_input_tokens),
    total_output_tokens: num(row.total_output_tokens),
    total_cache_read_tokens: num(row.total_cache_read_tokens),
    total_cache_write_tokens: num(row.total_cache_write_tokens),
    total_thinking_tokens: num(row.total_thinking_tokens),
    message_count: num(row.message_count),
    tool_call_count: num(row.tool_call_count),
    started_at: row.started_at,
    ended_at: row.ended_at,
    duration_seconds: row.duration_seconds === null ? null : num(row.duration_seconds),
    ingested_at: row.ingested_at,
    updated_at: row.updated_at,
    source_modified_at: row.source_modified_at,
    machine: row.machine,
    metadata,
  };
}

export function parseMetadata(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    session_id: row.session_id,
    source_id: row.source_id,
    parent_message_id: row.parent_message_id,
    role: row.role as Message["role"],
    content: row.content,
    content_preview: row.content_preview,
    model: row.model,
    is_sidechain: Boolean(row.is_sidechain),
    sequence_num: row.sequence_num === null ? null : num(row.sequence_num),
    input_tokens: num(row.input_tokens),
    output_tokens: num(row.output_tokens),
    cache_read_tokens: num(row.cache_read_tokens),
    cache_write_tokens: num(row.cache_write_tokens),
    thinking_tokens: num(row.thinking_tokens),
    timestamp: row.timestamp,
    metadata: parseMetadata(row.metadata),
  };
}

export function rowToToolCall(row: ToolCallRow): ToolCall {
  return {
    id: row.id,
    message_id: row.message_id,
    session_id: row.session_id,
    tool_name: row.tool_name,
    tool_input: row.tool_input,
    tool_output: row.tool_output,
    duration_ms: row.duration_ms === null ? null : num(row.duration_ms),
    status: (row.status as ToolCall["status"]) ?? null,
    timestamp: row.timestamp,
    metadata: parseMetadata(row.metadata),
  };
}

