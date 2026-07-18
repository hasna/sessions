import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getClaudeProjectsDir } from "../paths.js";
import type { ParseFileOptions, ParseFileResult, SessionParser } from "./types.js";
import { flattenContent } from "./types.js";
import { isInstructionPreamble, normalizeSessionTitle } from "../session-text.js";
import type {
  MessageInsert,
  ParsedSession,
  SessionInsert,
  ToolCallInsert,
  MessageRole,
} from "../../types/index.js";

const VALID_ROLES: MessageRole[] = ["user", "assistant", "system", "tool", "info", "thinking"];
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/i;
const HAS_COMMAND_TAG_RE = /<command-(?:message|name|args)>[\s\S]*?<\/command-(?:message|name|args)>/i;
const COMMAND_TAG_RE = /<command-(?:message|name|args)>[\s\S]*?<\/command-(?:message|name|args)>/gi;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function readBoundedJsonl(
  filePath: string,
  maxBufferedBytes: number | undefined,
): {
  digest: string;
  lines: string[];
  incompleteTrailingRecord: boolean;
  malformedRecordCount: number;
  maxBufferedLineBytes: number;
} {
  const stat = statSync(filePath);
  if (maxBufferedBytes !== undefined && stat.size > maxBufferedBytes) {
    throw new Error(`source file ${stat.size} exceeds max buffered bytes ${maxBufferedBytes}`);
  }

  const hash = createHash("sha256");
  const lines: string[] = [];
  const decoder = new StringDecoder("utf-8");
  const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, maxBufferedBytes ?? 64 * 1024)));
  let pending = "";
  let pendingBytes = 0;
  let malformedRecordCount = 0;
  let incompleteTrailingRecord = false;
  let maxBufferedLineBytes = 0;
  const fd = openSync(filePath, "r");
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      pending += decoder.write(chunk);
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) {
          pendingBytes = Buffer.byteLength(pending);
          if (maxBufferedBytes !== undefined && pendingBytes > maxBufferedBytes) {
            throw new Error(`JSONL pending line exceeds max buffered bytes ${maxBufferedBytes}`);
          }
          maxBufferedLineBytes = Math.max(maxBufferedLineBytes, pendingBytes);
          break;
        }
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        const lineBytes = Buffer.byteLength(line);
        maxBufferedLineBytes = Math.max(maxBufferedLineBytes, lineBytes);
        if (line.trim()) {
          try {
            JSON.parse(line);
            lines.push(line);
          } catch {
            malformedRecordCount++;
          }
        }
      }
    }
    pending += decoder.end();
    if (pending.trim()) {
      const lineBytes = Buffer.byteLength(pending);
      maxBufferedLineBytes = Math.max(maxBufferedLineBytes, lineBytes);
      if (maxBufferedBytes !== undefined && lineBytes > maxBufferedBytes) {
        throw new Error(`JSONL pending line exceeds max buffered bytes ${maxBufferedBytes}`);
      }
      try {
        JSON.parse(pending);
        lines.push(pending);
      } catch {
        incompleteTrailingRecord = true;
      }
    }
  } finally {
    closeSync(fd);
  }
  return {
    digest: `sha256:${hash.digest("hex")}`,
    lines,
    incompleteTrailingRecord,
    malformedRecordCount,
    maxBufferedLineBytes,
  };
}

function titleFromClaudeUserContent(content: string, isMeta: boolean): string | null {
  if (isMeta) return null;
  const normalized = normalizeSessionTitle(content);
  if (!normalized || isInstructionPreamble(normalized)) return null;

  const commandArgs = content.match(COMMAND_ARGS_RE)?.[1];
  if (commandArgs != null) {
    const fromArgs = normalizeSessionTitle(commandArgs);
    return fromArgs || null;
  }

  // Slash-command wrapper records are often automation scaffolding. Index the
  // message body, but do not let the wrapper become the session headline.
  const withoutCommandTags = normalizeSessionTitle(content.replace(COMMAND_TAG_RE, " "));
  if (!withoutCommandTags && HAS_COMMAND_TAG_RE.test(content)) return null;

  return normalized;
}

export class ClaudeParser implements SessionParser {
  readonly source = "claude" as const;

  sessionRoots(): string[] {
    return [getClaudeProjectsDir()];
  }

  listSessionFiles(): string[] {
    const root = getClaudeProjectsDir();
    if (!existsSync(root)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(root, { recursive: true }) as string[]) {
      if (entry.endsWith(".jsonl")) out.push(join(root, entry));
    }
    return out;
  }

  parseFile(filePath: string): ParsedSession[] {
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    return this.parseLines(filePath, lines);
  }

  private parseLines(filePath: string, lines: string[]): ParsedSession[] {
    if (lines.length === 0) return [];

    // Claude message UUIDs are not globally unique across resumed sessions and
    // subagent files. Use the filename-backed session id as a namespace for the
    // internal DB primary key while preserving the raw UUID in source_id.
    const sourceId = basename(filePath).replace(/\.jsonl$/, "");
    const messages: MessageInsert[] = [];
    const toolCalls: ToolCallInsert[] = [];
    const seenMessageIds = new Map<string, number>();
    let sessionId: string | undefined;
    let cwd: string | undefined;
    let gitBranch: string | undefined;
    let version: string | undefined;
    let model: string | undefined;
    let firstTs: string | undefined;
    let lastTs: string | undefined;
    let title: string | undefined;
    let seq = 0;
    let inTok = 0,
      outTok = 0,
      cacheRead = 0,
      cacheWrite = 0;

    for (const line of lines) {
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!sessionId && typeof o.sessionId === "string") sessionId = o.sessionId;
      if (!cwd && typeof o.cwd === "string") cwd = o.cwd;
      if (!gitBranch && typeof o.gitBranch === "string") gitBranch = o.gitBranch;
      if (!version && typeof o.version === "string") version = o.version;

      const type = o.type;
      if (type !== "user" && type !== "assistant") continue;
      const message = o.message as Record<string, unknown> | undefined;
      if (!message || typeof message !== "object") continue;

      const role = (message.role as MessageRole) ?? (type as MessageRole);
      if (!VALID_ROLES.includes(role)) continue;

      const ts = typeof o.timestamp === "string" ? o.timestamp : null;
      if (ts) {
        if (!firstTs) firstTs = ts;
        lastTs = ts;
      }

      const msgModel = typeof message.model === "string" ? message.model : undefined;
      if (msgModel) model = msgModel;

      const usage = message.usage as Record<string, unknown> | undefined;
      if (usage) {
        inTok += num(usage.input_tokens);
        outTok += num(usage.output_tokens);
        cacheRead += num(usage.cache_read_input_tokens);
        cacheWrite += num(usage.cache_creation_input_tokens);
      }

      const content = flattenContent(message.content);
      if (!title && role === "user" && content) {
        title = titleFromClaudeUserContent(content, o.isMeta === true) ?? undefined;
      }

      const rawMessageId = typeof o.uuid === "string" ? o.uuid : null;
      const rawCount = rawMessageId ? seenMessageIds.get(rawMessageId) ?? 0 : 0;
      if (rawMessageId) seenMessageIds.set(rawMessageId, rawCount + 1);
      const sourceMessageId = rawMessageId && rawCount > 0 ? `${rawMessageId}:${rawCount}` : rawMessageId;
      const messageId = sourceMessageId
        ? `${sourceId}:${sourceMessageId}`
        : `${sourceId}:${seq}:${crypto.randomUUID()}`;
      messages.push({
        id: messageId,
        session_id: "",
        source_id: sourceMessageId,
        parent_message_id: typeof o.parentUuid === "string" ? `${sourceId}:${o.parentUuid}` : null,
        role,
        content,
        model: msgModel ?? null,
        is_sidechain: o.isSidechain === true,
        sequence_num: seq++,
        input_tokens: num(usage?.input_tokens),
        output_tokens: num(usage?.output_tokens),
        cache_read_tokens: num(usage?.cache_read_input_tokens),
        cache_write_tokens: num(usage?.cache_creation_input_tokens),
        timestamp: ts,
      });

      // Tool uses live in assistant content blocks
      if (Array.isArray(message.content)) {
        for (const block of message.content as unknown[]) {
          if (block && typeof block === "object") {
            const b = block as Record<string, unknown>;
            if (b.type === "tool_use" && typeof b.name === "string") {
              toolCalls.push({
                session_id: "",
                message_id: messageId,
                tool_name: b.name,
                tool_input: b.input != null ? JSON.stringify(b.input) : null,
                timestamp: ts,
              });
            }
          }
        }
      }
    }

    if (messages.length === 0) return [];

    // Use the filename uuid as the canonical session id. Claude is one-file-per
    // -session, and the in-file `sessionId` field is unreliable as a key — many
    // files (sidechains/resumes/summaries) reference a shared sessionId, which
    // would collapse distinct sessions on upsert. The filename is unique.
    const mtime = (() => {
      try {
        return statSync(filePath).mtime.toISOString();
      } catch {
        return null;
      }
    })();

    const session: SessionInsert = {
      source: "claude",
      source_id: sourceId,
      source_path: filePath,
      title: title ?? null,
      project_path: cwd ?? null,
      project_name: cwd ? basename(cwd) : null,
      model: model ?? null,
      model_provider: model ? "anthropic" : null,
      git_branch: gitBranch ?? null,
      cli_version: version ?? null,
      started_at: firstTs ?? null,
      ended_at: lastTs ?? null,
      total_input_tokens: inTok,
      total_output_tokens: outTok,
      total_cache_read_tokens: cacheRead,
      total_cache_write_tokens: cacheWrite,
      source_modified_at: mtime,
      metadata: sessionId && sessionId !== sourceId ? { claude_session_id: sessionId } : {},
    };

    return [{ session, messages, toolCalls }];
  }

  parseFileResult(filePath: string, opts: ParseFileOptions = {}): ParseFileResult {
    if (!existsSync(filePath)) return { sessions: [] };
    const result = readBoundedJsonl(filePath, opts.maxBufferedBytes);
    const sessions = this.parseLines(filePath, result.lines);
    return {
      sessions,
      incompleteTrailingRecord: result.incompleteTrailingRecord,
      malformedRecordCount: result.malformedRecordCount,
      maxBufferedLineBytes: result.maxBufferedLineBytes,
      maxNormalizedBatchRecords: sessions.reduce((max, session) => Math.max(max, session.messages.length, session.toolCalls.length), 0),
      sourceContentDigest: result.digest,
    };
  }
}
