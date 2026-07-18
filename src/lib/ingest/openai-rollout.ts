import { closeSync, existsSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { Database as BunDatabase } from "bun:sqlite";
import type { ParseFileOptions, ParseFileResult, SessionParser } from "./types.js";
import { flattenContent } from "./types.js";
import { titleFromUserContent } from "../session-text.js";
import type {
  MessageInsert,
  MessageRole,
  ParsedSession,
  SessionInsert,
  SessionSource,
  StagedParsedSession,
  ToolCallInsert,
} from "../../types/index.js";

const READ_BUFFER_BYTES = 64 * 1024;

function mapRole(role: unknown): MessageRole {
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role === "developer" || role === "system") return "system";
  if (role === "tool") return "tool";
  return "info";
}

export class OpenAiRolloutParser implements SessionParser {
  constructor(
    readonly source: Extract<SessionSource, "codex" | "codewith">,
    private readonly sessionsRoot: () => string
  ) {}

  sessionRoots(): string[] {
    return [this.sessionsRoot()];
  }

  listSessionFiles(): string[] {
    const root = this.sessionsRoot();
    if (!existsSync(root)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(root, { recursive: true }) as string[]) {
      if (entry.endsWith(".jsonl") && basename(entry).startsWith("rollout-")) {
        out.push(join(root, entry));
      }
    }
    return out;
  }

  parseFile(filePath: string): ParsedSession[] {
    return this.parseFileResult(filePath).sessions;
  }

  parseFileResult(filePath: string, opts: ParseFileOptions = {}): ParseFileResult {
    if (!existsSync(filePath)) return { sessions: [] };

    const sink: RolloutSink = opts.preferStaging ? new StagedRolloutSink() : new MemoryRolloutSink();
    let sourceId: string | undefined;
    let cwd: string | undefined;
    let cliVersion: string | undefined;
    let modelProvider: string | undefined;
    let gitBranch: string | undefined;
    let gitSha: string | undefined;
    let gitUrl: string | undefined;
    let firstTs: string | undefined;
    let lastTs: string | undefined;
    let title: string | undefined;
    let seq = 0;

    const parseRecord = (o: Record<string, unknown>) => {
      const ts = typeof o.timestamp === "string" ? o.timestamp : null;
      const payload = (o.payload as Record<string, unknown>) ?? {};

      if (o.type === "session_meta") {
        if (typeof payload.id === "string") sourceId = payload.id;
        if (typeof payload.cwd === "string") cwd = payload.cwd;
        if (typeof payload.cli_version === "string") cliVersion = payload.cli_version;
        if (typeof payload.model_provider === "string") modelProvider = payload.model_provider;
        const git = payload.git as Record<string, unknown> | undefined;
        if (git) {
          if (typeof git.branch === "string") gitBranch = git.branch;
          if (typeof git.commit_hash === "string") gitSha = git.commit_hash;
          if (typeof git.repository_url === "string") gitUrl = git.repository_url;
        }
        return;
      }

      if (o.type !== "response_item") return;
      if (ts) {
        if (!firstTs) firstTs = ts;
        lastTs = ts;
      }

      const ptype = payload.type;

      if (ptype === "function_call" && typeof payload.name === "string") {
        const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
        sink.addToolCall(callId, {
          session_id: "",
          tool_name: payload.name,
          tool_input: payload.arguments != null ? String(payload.arguments) : null,
          timestamp: ts,
        });
        return;
      }

      if (ptype === "function_call_output") {
        const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
        if (callId) sink.updateToolOutput(callId, flattenContent(payload.output));
        return;
      }

      const role = ptype === "reasoning" ? "thinking" : mapRole(payload.role);
      const content =
        ptype === "reasoning"
          ? flattenContent(payload.summary ?? payload.content)
          : flattenContent(payload.content);
      if (!content) return;

      if (!title && role === "user") {
        title = titleFromUserContent(content) ?? undefined;
      }

      sink.addMessage({
        session_id: "",
        role,
        content,
        sequence_num: seq++,
        timestamp: ts,
      });
    };

    let readResult: { incompleteTrailingRecord: boolean; malformedRecordCount: number; maxBufferedLineBytes: number };
    try {
      readResult = readJsonlRecords(filePath, parseRecord);
    } catch (error) {
      sink.cleanup();
      throw error;
    }
    const { incompleteTrailingRecord, malformedRecordCount, maxBufferedLineBytes } = readResult;

    if (sink.messageCount === 0 && sink.toolCallCount === 0) {
      sink.cleanup();
      return {
        sessions: [],
        incompleteTrailingRecord,
        malformedRecordCount,
        maxBufferedLineBytes,
        maxNormalizedBatchRecords: sink.maxNormalizedBatchRecords,
      };
    }

    const fileBase = basename(filePath).replace(/\.jsonl$/, "");
    sourceId = sourceId ?? fileBase;
    const mtime = (() => {
      try {
        return statSync(filePath).mtime.toISOString();
      } catch {
        return null;
      }
    })();

    const session: SessionInsert = {
      source: this.source,
      source_id: sourceId,
      source_path: filePath,
      title: title ?? null,
      project_path: cwd ?? null,
      project_name: cwd ? basename(cwd) : null,
      model_provider: modelProvider ?? null,
      git_branch: gitBranch ?? null,
      git_sha: gitSha ?? null,
      git_origin_url: gitUrl ?? null,
      cli_version: cliVersion ?? null,
      started_at: firstTs ?? null,
      ended_at: lastTs ?? null,
      source_modified_at: mtime,
    };

    const parsed = sink.toParseFileResult(session);
    return {
      ...parsed,
      incompleteTrailingRecord,
      malformedRecordCount,
      maxBufferedLineBytes,
      maxNormalizedBatchRecords: sink.maxNormalizedBatchRecords,
    };
  }
}

interface RolloutSink {
  readonly messageCount: number;
  readonly toolCallCount: number;
  readonly maxNormalizedBatchRecords: number;
  addMessage(message: MessageInsert): void;
  addToolCall(callId: string | undefined, toolCall: ToolCallInsert): void;
  updateToolOutput(callId: string, output: string): void;
  toParseFileResult(session: SessionInsert): Pick<ParseFileResult, "sessions" | "stagedSessions">;
  cleanup(): void;
}

class MemoryRolloutSink implements RolloutSink {
  private readonly messages: MessageInsert[] = [];
  private readonly toolCalls: ToolCallInsert[] = [];
  private readonly toolByCallId = new Map<string, ToolCallInsert>();

  get messageCount(): number {
    return this.messages.length;
  }

  get toolCallCount(): number {
    return this.toolCalls.length;
  }

  get maxNormalizedBatchRecords(): number {
    return Math.max(this.messages.length, this.toolCalls.length);
  }

  addMessage(message: MessageInsert): void {
    this.messages.push(message);
  }

  addToolCall(callId: string | undefined, toolCall: ToolCallInsert): void {
    this.toolCalls.push(toolCall);
    if (callId) this.toolByCallId.set(callId, toolCall);
  }

  updateToolOutput(callId: string, output: string): void {
    const toolCall = this.toolByCallId.get(callId);
    if (toolCall) toolCall.tool_output = output;
  }

  toParseFileResult(session: SessionInsert): Pick<ParseFileResult, "sessions" | "stagedSessions"> {
    return { sessions: [{ session, messages: this.messages, toolCalls: this.toolCalls }] };
  }

  cleanup(): void {}
}

class StagedRolloutSink implements RolloutSink {
  private readonly dir = mkdtempSync(join(tmpdir(), "sessions-rollout-stage-"));
  private readonly db = new BunDatabase(join(this.dir, "stage.sqlite"));
  private nextMessageIndex = 0;
  private nextToolCallIndex = 0;
  private maxBatch = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  totalCacheReadTokens = 0;
  totalCacheWriteTokens = 0;
  totalThinkingTokens = 0;

  constructor() {
    this.db.exec(`
      CREATE TABLE messages (idx INTEGER PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE tool_calls (idx INTEGER PRIMARY KEY, call_id TEXT, json TEXT NOT NULL);
      CREATE INDEX tool_calls_call_id ON tool_calls(call_id);
    `);
  }

  get messageCount(): number {
    return this.nextMessageIndex;
  }

  get toolCallCount(): number {
    return this.nextToolCallIndex;
  }

  get maxNormalizedBatchRecords(): number {
    return this.maxBatch;
  }

  addMessage(message: MessageInsert): void {
    this.totalInputTokens += message.input_tokens ?? 0;
    this.totalOutputTokens += message.output_tokens ?? 0;
    this.totalCacheReadTokens += message.cache_read_tokens ?? 0;
    this.totalCacheWriteTokens += message.cache_write_tokens ?? 0;
    this.totalThinkingTokens += message.thinking_tokens ?? 0;
    this.db.prepare("INSERT INTO messages (idx, json) VALUES (?, ?)").run(
      this.nextMessageIndex++,
      JSON.stringify(message)
    );
    this.maxBatch = Math.max(this.maxBatch, 1);
  }

  addToolCall(callId: string | undefined, toolCall: ToolCallInsert): void {
    this.db.prepare("INSERT INTO tool_calls (idx, call_id, json) VALUES (?, ?, ?)").run(
      this.nextToolCallIndex++,
      callId ?? null,
      JSON.stringify(toolCall)
    );
    this.maxBatch = Math.max(this.maxBatch, 1);
  }

  updateToolOutput(callId: string, output: string): void {
    const row = this.db
      .prepare("SELECT idx, json FROM tool_calls WHERE call_id = ? ORDER BY idx DESC LIMIT 1")
      .get(callId) as { idx: number; json: string } | undefined;
    if (!row) return;
    const toolCall = JSON.parse(row.json) as ToolCallInsert;
    toolCall.tool_output = output;
    this.db.prepare("UPDATE tool_calls SET json = ? WHERE idx = ?").run(JSON.stringify(toolCall), row.idx);
  }

  toParseFileResult(session: SessionInsert): Pick<ParseFileResult, "sessions" | "stagedSessions"> {
    const staged: StagedParsedSession = {
      session,
      messageCount: this.messageCount,
      toolCallCount: this.toolCallCount,
      totalInputTokens: this.totalInputTokens,
      totalOutputTokens: this.totalOutputTokens,
      totalCacheReadTokens: this.totalCacheReadTokens,
      totalCacheWriteTokens: this.totalCacheWriteTokens,
      totalThinkingTokens: this.totalThinkingTokens,
      maxNormalizedBatchRecords: this.maxNormalizedBatchRecords,
      forEachMessageBatch: (batchSize, callback) => this.forEachBatch<MessageInsert>("messages", batchSize, callback),
      forEachToolCallBatch: (batchSize, callback) => this.forEachBatch<ToolCallInsert>("tool_calls", batchSize, callback),
      cleanup: () => this.cleanup(),
    };
    return { sessions: [], stagedSessions: [staged] };
  }

  cleanup(): void {
    this.db.close();
    rmSync(this.dir, { recursive: true, force: true });
  }

  private forEachBatch<T>(table: "messages" | "tool_calls", batchSize: number, callback: (batch: T[]) => void): void {
    let lastIndex = -1;
    for (;;) {
      const rows = this.db
        .prepare(`SELECT idx, json FROM ${table} WHERE idx > ? ORDER BY idx LIMIT ?`)
        .all(lastIndex, batchSize) as Array<{ idx: number; json: string }>;
      if (rows.length === 0) return;
      this.maxBatch = Math.max(this.maxBatch, rows.length);
      callback(rows.map((row) => JSON.parse(row.json) as T));
      lastIndex = rows[rows.length - 1].idx;
    }
  }
}

function readJsonlRecords(
  filePath: string,
  onRecord: (record: Record<string, unknown>) => void
): { incompleteTrailingRecord: boolean; malformedRecordCount: number; maxBufferedLineBytes: number } {
  const fd = openSync(filePath, "r");
  const decoder = new StringDecoder("utf8");
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  let pending = "";
  let incompleteTrailingRecord = false;
  let malformedRecordCount = 0;
  let maxBufferedLineBytes = 0;

  const parseLine = (line: string, trailing: boolean) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    maxBufferedLineBytes = Math.max(maxBufferedLineBytes, Buffer.byteLength(line));
    try {
      onRecord(JSON.parse(trimmed) as Record<string, unknown>);
    } catch {
      if (trailing) incompleteTrailingRecord = true;
      else malformedRecordCount++;
    }
  };

  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;

      pending += decoder.write(buffer.subarray(0, bytesRead));
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = pending.slice(0, newlineIndex).replace(/\r$/, "");
        parseLine(line, false);
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf("\n");
      }
      if (pending) {
        maxBufferedLineBytes = Math.max(maxBufferedLineBytes, Buffer.byteLength(pending));
      }
    }

    pending += decoder.end();
    parseLine(pending.replace(/\r$/, ""), true);
  } finally {
    closeSync(fd);
  }

  return { incompleteTrailingRecord, malformedRecordCount, maxBufferedLineBytes };
}
