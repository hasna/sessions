import { getDatabase } from "../db/database.js";
import { getSession } from "../db/sessions.js";
import type { Message, Session, ToolCall } from "../types/index.js";
import type {
  CodingThreadEntities,
  RecallResume,
  RecallToolCall,
} from "./recall.js";

const MAX_VARIANT_TERMS = 8;
const MAX_TOOL_CALLS_PER_RESULT = 8;
const MAX_TOUCHED_FILES = 16;
const MAX_ENTITY_VALUES = 16;
const MAX_CONTEXT_MESSAGES_PER_RESULT = 24;
const MAX_CONTEXT_TOOL_CALLS_PER_RESULT = 64;
const MAX_RECENT_TOOL_CALLS_PER_RESULT = 12;
const MAX_ENTITY_SCAN_CHARS = 8_000;
const MAX_JSON_PARSE_CHARS = 24_000;

export function extractCodingEntities(
  session: Session,
  messages: Message[],
  toolCalls: ToolCall[]
): CodingThreadEntities {
  const textParts: string[] = [
    session.title ?? "",
    session.project_name ?? "",
    session.git_origin_url ?? "",
    session.git_branch ?? "",
    session.git_sha ?? "",
  ];
  for (const message of messages) textParts.push(message.content ?? "");
  for (const toolCall of toolCalls) {
    textParts.push(
      toolCall.tool_name,
      scanText(toolCall.tool_input),
      scanText(toolCall.tool_output)
    );
  }
  const text = textParts.join("\n");

  const files = new Set<string>();
  for (const value of extractJsonValues(toolCalls, ["file_path", "filepath", "path", "absolute_path", "relative_path"])) {
    addPath(files, value);
  }
  for (const path of extractFilePaths(text)) addPath(files, path);

  const commands = new Set<string>();
  for (const value of extractJsonValues(toolCalls, ["command", "cmd", "shell", "script"])) {
    addCommand(commands, value);
  }
  for (const toolCall of toolCalls) {
    if (isCommandTool(toolCall.tool_name)) {
      addCommand(commands, toolCall.tool_input ?? "");
    }
  }

  const repos = new Set<string>();
  if (session.git_origin_url) repos.add(session.git_origin_url);
  for (const repo of text.match(/(?:https?:\/\/|git@)[^\s"'<>]+/g) ?? []) {
    if (/github\.com|gitlab\.com|bitbucket\.org|\.git\b/.test(repo)) {
      repos.add(cleanTrailing(repo));
    }
  }

  const branches = new Set<string>();
  if (session.git_branch) branches.add(session.git_branch);
  for (const branch of extractBranches(text)) branches.add(branch);

  const commits = new Set<string>();
  if (session.git_sha) commits.add(session.git_sha);
  for (const commit of text.match(/\b[0-9a-f]{7,40}\b/gi) ?? []) commits.add(commit);

  return {
    file_paths: [...files].slice(0, MAX_TOUCHED_FILES),
    tool_names: unique(toolCalls.map((toolCall) => toolCall.tool_name)).slice(0, MAX_ENTITY_VALUES),
    commands: [...commands].slice(0, MAX_ENTITY_VALUES),
    repos: [...repos].slice(0, MAX_ENTITY_VALUES),
    branches: [...branches].slice(0, MAX_ENTITY_VALUES),
    commits: [...commits].slice(0, MAX_ENTITY_VALUES),
  };
}

export function loadRecallContext(
  sessionId: string,
  terms: string[]
): { messages: Message[]; toolCalls: ToolCall[] } {
  return {
    messages: loadRecallMessages(sessionId, terms),
    toolCalls: loadRecallToolCalls(sessionId, terms),
  };
}

function loadRecallMessages(sessionId: string, terms: string[]): Message[] {
  const db = getDatabase();
  const match = recallFtsOrQuery(terms);

  if (match) {
    try {
      const rows = db
        .prepare(
          `SELECT m.*
           FROM messages_fts
           JOIN messages m ON m.id = messages_fts.message_id
           WHERE messages_fts MATCH ? AND messages_fts.session_id = ?
           ORDER BY bm25(messages_fts) ASC
           LIMIT ?`
        )
        .all(match, sessionId, MAX_CONTEXT_MESSAGES_PER_RESULT) as Record<string, unknown>[];
      if (rows.length > 0) return rows.map(rowToMessage);
    } catch {
      // Fall through to a bounded chronological sample if FTS rejects a rare token.
    }
  }

  const rows = db
    .prepare(
      `SELECT *
       FROM messages
       WHERE session_id = ?
       ORDER BY sequence_num ASC, timestamp ASC
       LIMIT ?`
    )
    .all(sessionId, Math.min(12, MAX_CONTEXT_MESSAGES_PER_RESULT)) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

function loadRecallToolCalls(sessionId: string, terms: string[]): ToolCall[] {
  const db = getDatabase();
  const seen = new Set<string>();
  const toolCalls: ToolCall[] = [];
  const addRows = (rows: Record<string, unknown>[]) => {
    for (const row of rows) {
      const id = row.id as string;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      toolCalls.push(rowToToolCall(row));
      if (toolCalls.length >= MAX_CONTEXT_TOOL_CALLS_PER_RESULT) break;
    }
  };

  const match = recallFtsOrQuery(terms);
  if (match) {
    try {
      addRows(
        db
          .prepare(
            `SELECT tc.*
             FROM tool_calls_fts
             JOIN tool_calls tc ON tc.id = tool_calls_fts.tool_call_id
             WHERE tool_calls_fts MATCH ? AND tool_calls_fts.session_id = ?
             ORDER BY bm25(tool_calls_fts) ASC
             LIMIT ?`
          )
          .all(match, sessionId, MAX_CONTEXT_TOOL_CALLS_PER_RESULT) as Record<string, unknown>[]
      );
    } catch {
      // Fall through to a bounded recent sample if FTS rejects a rare token.
    }
  }

  if (toolCalls.length < MAX_RECENT_TOOL_CALLS_PER_RESULT) {
    addRows(
      db
        .prepare(
          `SELECT *
           FROM tool_calls
           WHERE session_id = ?
           ORDER BY COALESCE(timestamp, '') DESC
           LIMIT ?`
        )
        .all(sessionId, MAX_RECENT_TOOL_CALLS_PER_RESULT) as Record<string, unknown>[]
    );
  }

  return toolCalls;
}

function recallFtsOrQuery(terms: string[]): string | null {
  const tokens = unique(
    terms
      .map((term) => term.trim())
      .filter((term) => term.length >= 2)
      .slice(0, MAX_VARIANT_TERMS)
  );
  if (tokens.length === 0) return null;
  return tokens.map(quoteFtsTerm).join(" OR ");
}

function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

function parseMeta(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "string") return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    source_id: (row.source_id as string) ?? null,
    parent_message_id: (row.parent_message_id as string) ?? null,
    role: row.role as Message["role"],
    content: (row.content as string) ?? null,
    content_preview: (row.content_preview as string) ?? null,
    model: (row.model as string) ?? null,
    is_sidechain: Boolean(row.is_sidechain),
    sequence_num: row.sequence_num == null ? null : Number(row.sequence_num),
    input_tokens: Number(row.input_tokens ?? 0),
    output_tokens: Number(row.output_tokens ?? 0),
    cache_read_tokens: Number(row.cache_read_tokens ?? 0),
    cache_write_tokens: Number(row.cache_write_tokens ?? 0),
    thinking_tokens: Number(row.thinking_tokens ?? 0),
    timestamp: (row.timestamp as string) ?? null,
    metadata: parseMeta(row.metadata),
  };
}

function rowToToolCall(row: Record<string, unknown>): ToolCall {
  return {
    id: row.id as string,
    message_id: (row.message_id as string) ?? null,
    session_id: row.session_id as string,
    tool_name: row.tool_name as string,
    tool_input: (row.tool_input as string) ?? null,
    tool_output: (row.tool_output as string) ?? null,
    duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
    status: (row.status as ToolCall["status"]) ?? null,
    timestamp: (row.timestamp as string) ?? null,
    metadata: parseMeta(row.metadata),
  };
}


export function selectMatchingToolCalls(
  toolCalls: ToolCall[],
  terms: string[],
  query: string,
  toolHitSnippets: string[]
): RecallToolCall[] {
  const loweredQuery = query.toLowerCase();
  const loweredTerms = terms.map((term) => term.toLowerCase());
  const matches: RecallToolCall[] = [];
  for (const toolCall of toolCalls) {
    const haystack = [
      toolCall.tool_name,
      toolCall.tool_input ?? "",
      toolCall.tool_output ?? "",
    ]
      .join("\n")
      .toLowerCase();
    const exact = loweredQuery.length > 0 && haystack.includes(loweredQuery);
    const termMatch = loweredTerms.some((term) => haystack.includes(term));
    const snippetMatch = toolHitSnippets.some((snippet) =>
      haystack.includes(stripFtsMarkers(snippet).toLowerCase().slice(0, 30))
    );
    if (!exact && !termMatch && !snippetMatch) continue;
    matches.push({
      id: toolCall.id,
      tool_name: toolCall.tool_name,
      status: toolCall.status,
      timestamp: toolCall.timestamp,
      snippet: snippetForToolCall(toolCall, terms, query),
      input_preview: preview(toolCall.tool_input),
      output_preview: preview(toolCall.tool_output),
    });
    if (matches.length >= MAX_TOOL_CALLS_PER_RESULT) break;
  }
  return matches;
}

function snippetForToolCall(toolCall: ToolCall, terms: string[], query: string): string {
  const text = [toolCall.tool_name, toolCall.tool_input ?? "", toolCall.tool_output ?? ""].join("\n");
  return snippetAround(text, [query, ...terms]) || preview(text) || toolCall.tool_name;
}

function snippetAround(text: string, needles: string[]): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const lower = compact.toLowerCase();
  const needle = needles
    .map((item) => item.toLowerCase().trim())
    .filter(Boolean)
    .find((item) => lower.includes(item));
  if (!needle) return "";
  const index = lower.indexOf(needle);
  const start = Math.max(0, index - 70);
  const end = Math.min(compact.length, index + needle.length + 120);
  return compact.slice(start, end);
}

function preview(value: string | null | undefined, max = 220): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}

export function buildResumeMetadata(session: Session): RecallResume {
  const metadataCommand = metadataResumeCommand(session.metadata);
  if (metadataCommand) return metadataCommand;

  if (session.source === "claude") {
    const command = ["claude", "--resume", session.source_id];
    return {
      available: true,
      command,
      shell_command: command.map(shellQuote).join(" "),
      reason: null,
    };
  }

  return {
    available: false,
    command: null,
    shell_command: null,
    reason: `No stable resume command is configured for ${session.source} indexed sessions yet; inspect source_path or use the provider's native history UI.`,
  };
}

function metadataResumeCommand(metadata: Record<string, unknown>): RecallResume | null {
  const raw = metadata.resume_command;
  if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
    const command = raw as string[];
    return {
      available: true,
      command,
      shell_command: command.map(shellQuote).join(" "),
      reason: null,
    };
  }
  if (typeof raw === "string" && raw.trim()) {
    return {
      available: true,
      command: null,
      shell_command: raw.trim(),
      reason: null,
    };
  }
  return null;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function compareSessionRecency(a: string, b: string): number {
  const sa = getSession(a);
  const sb = getSession(b);
  const at = new Date(sa.updated_at ?? sa.started_at ?? 0).getTime();
  const bt = new Date(sb.updated_at ?? sb.started_at ?? 0).getTime();
  return at - bt;
}

export function trimToken(token: string): string {
  return token
    .replace(/^[^\w/.:@%+=-]+|[^\w/.:@%+=-]+$/g, "")
    .replace(/^['"]+|['"]+$/g, "");
}

function extractFilePaths(text: string): string[] {
  const matches = [
    ...(text.match(/(?:^|[\s"'`(])((?:\/[A-Za-z0-9._@%+=:,~-]+)+)(?=$|[\s"'`),\]}])/g) ?? []),
    ...(text.match(/(?:^|[\s"'`(])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,10})(?=$|[\s"'`),\]}])/g) ?? []),
    ...(text.match(/(?:^|[\s"'`(])((?:README|CHANGELOG|LICENSE|Dockerfile|Makefile|package|tsconfig|bun\.lock|Cargo|Gemfile|go\.mod)(?:\.[A-Za-z0-9]+)?)(?=$|[\s"'`),\]}])/gi) ?? []),
  ];
  return matches
    .map((match) => match.trim().replace(/^["'`()]+|["'`(),\]}]+$/g, ""))
    .map(cleanPath)
    .filter(Boolean);
}

function addPath(paths: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  for (const path of extractFilePaths(value).length ? extractFilePaths(value) : [cleanPath(value)]) {
    if (!path) continue;
    if (path.includes("://")) continue;
    if (path === "/" || path.length < 3) continue;
    paths.add(path);
  }
}

function cleanPath(value: string): string {
  return cleanTrailing(value)
    .replace(/^["'`()]+|["'`]+$/g, "")
    .replace(/:\d+(?::\d+)?$/g, "");
}

function cleanTrailing(value: string): string {
  return value.replace(/[),.;\]}>"'`]+$/g, "");
}

function extractJsonValues(toolCalls: ToolCall[], keys: string[]): unknown[] {
  const wanted = new Set(keys);
  const values: unknown[] = [];
  for (const toolCall of toolCalls) {
    for (const raw of [toolCall.tool_input, toolCall.tool_output]) {
      if (!raw) continue;
      if (raw.length > MAX_JSON_PARSE_CHARS) continue;
      try {
        collectJsonValues(JSON.parse(raw), wanted, values);
      } catch {
        // Tool inputs are often plain command strings.
      }
    }
  }
  return values;
}

function scanText(value: string | null | undefined): string {
  if (!value) return "";
  return value.length > MAX_ENTITY_SCAN_CHARS ? value.slice(0, MAX_ENTITY_SCAN_CHARS) : value;
}

function collectJsonValues(value: unknown, keys: Set<string>, out: unknown[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonValues(item, keys, out);
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (keys.has(key.toLowerCase())) out.push(nested);
    collectJsonValues(nested, keys, out);
  }
}

function addCommand(commands: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const command = value
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("{"));
  if (!command) return;
  commands.add(command.slice(0, 300));
}

function isCommandTool(toolName: string): boolean {
  return /^(bash|shell|terminal|run_command|exec|command)$/i.test(toolName);
}

function extractBranches(text: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /\bgit\s+(?:checkout|switch)\s+(?:-b\s+)?([A-Za-z0-9._/-]+)/g,
    /\bbranch[:=]\s*([A-Za-z0-9._/-]+)/gi,
    /\bon branch\s+([A-Za-z0-9._/-]+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) out.add(cleanTrailing(match[1]));
    }
  }
  return [...out];
}

export function unique(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function stripFtsMarkers(value: string): string {
  return value.replace(/\[|\]/g, "");
}
