import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { ParseFileOptions, ParseFileResult, SessionParser } from "./types.js";
import type {
  MessageInsert,
  MessageRole,
  ParsedSession,
  SessionInsert,
} from "../../types/index.js";

function geminiTmpRoot(): string {
  return process.env.GEMINI_PATH
    ? join(process.env.GEMINI_PATH, "tmp")
    : join(homedir(), ".gemini", "tmp");
}

interface GeminiLogEntry {
  sessionId?: string;
  messageId?: number;
  type?: string;
  message?: string;
  timestamp?: string;
  role?: string;
}

function readBoundedFile(
  filePath: string,
  maxBufferedBytes: number | undefined,
): { raw: Buffer; digest: string } {
  const stat = statSync(filePath);
  if (maxBufferedBytes !== undefined && stat.size > maxBufferedBytes) {
    throw new Error(`source file ${stat.size} exceeds max buffered bytes ${maxBufferedBytes}`);
  }
  const raw = Buffer.alloc(stat.size);
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(Math.min(64 * 1024, Math.max(1, maxBufferedBytes ?? 64 * 1024)));
  const fd = openSync(filePath, "r");
  let offset = 0;
  try {
    for (;;) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      const slice = chunk.subarray(0, bytesRead);
      hash.update(slice);
      slice.copy(raw, offset);
      offset += bytesRead;
    }
  } finally {
    closeSync(fd);
  }
  return { raw, digest: `sha256:${hash.digest("hex")}` };
}

/**
 * Best-effort parser for the Gemini CLI. Gemini records prompts in
 * ~/.gemini/tmp/<projectHash>/logs.json as an array of entries; a single file
 * can contain many sessions (grouped by sessionId). No local Gemini data was
 * available when this was written, so it is conservative and defensive.
 */
export class GeminiParser implements SessionParser {
  readonly source = "gemini" as const;

  sessionRoots(): string[] {
    return [geminiTmpRoot()];
  }

  listSessionFiles(): string[] {
    const root = geminiTmpRoot();
    if (!existsSync(root)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(root, { recursive: true }) as string[]) {
      if (basename(entry) === "logs.json") out.push(join(root, entry));
    }
    return out;
  }

  parseFile(filePath: string): ParsedSession[] {
    if (!existsSync(filePath)) return [];
    let entries: GeminiLogEntry[];
    try {
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      entries = Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
    return this.parseEntries(filePath, entries);
  }

  private parseEntries(filePath: string, entries: GeminiLogEntry[]): ParsedSession[] {
    if (entries.length === 0) return [];

    const mtime = (() => {
      try {
        return statSync(filePath).mtime.toISOString();
      } catch {
        return null;
      }
    })();

    // Group entries by sessionId
    const bySession = new Map<string, GeminiLogEntry[]>();
    for (const e of entries) {
      const sid = e.sessionId ?? basename(filePath);
      const list = bySession.get(sid) ?? [];
      list.push(e);
      bySession.set(sid, list);
    }

    const sessions: ParsedSession[] = [];
    for (const [sid, list] of bySession) {
      list.sort((a, b) => (a.messageId ?? 0) - (b.messageId ?? 0));
      const messages: MessageInsert[] = [];
      let seq = 0;
      let title: string | undefined;
      let firstTs: string | undefined;
      let lastTs: string | undefined;

      for (const e of list) {
        const content = typeof e.message === "string" ? e.message : "";
        if (!content) continue;
        const role: MessageRole = e.role === "model" || e.role === "assistant" ? "assistant" : "user";
        if (!title && role === "user") title = content.replace(/\s+/g, " ").slice(0, 120);
        if (e.timestamp) {
          if (!firstTs) firstTs = e.timestamp;
          lastTs = e.timestamp;
        }
        messages.push({
          session_id: "",
          role,
          content,
          sequence_num: seq++,
          timestamp: e.timestamp ?? null,
        });
      }

      if (messages.length === 0) continue;

      const session: SessionInsert = {
        source: "gemini",
        source_id: sid,
        source_path: filePath,
        title: title ?? null,
        model_provider: "google",
        started_at: firstTs ?? null,
        ended_at: lastTs ?? null,
        source_modified_at: mtime,
      };
      sessions.push({ session, messages, toolCalls: [] });
    }

    return sessions;
  }

  parseFileResult(filePath: string, opts: ParseFileOptions = {}): ParseFileResult {
    if (!existsSync(filePath)) return { sessions: [] };
    const { raw, digest } = readBoundedFile(filePath, opts.maxBufferedBytes);
    let entries: GeminiLogEntry[];
    try {
      const data = JSON.parse(raw.toString("utf-8"));
      entries = Array.isArray(data) ? data : [];
    } catch {
      return {
        sessions: [],
        incompleteTrailingRecord: false,
        malformedRecordCount: 1,
        maxBufferedLineBytes: raw.byteLength,
        maxNormalizedBatchRecords: 0,
        sourceContentDigest: digest,
      };
    }
    const sessions = this.parseEntries(filePath, entries);
    return {
      sessions,
      incompleteTrailingRecord: false,
      malformedRecordCount: 0,
      maxBufferedLineBytes: raw.byteLength,
      maxNormalizedBatchRecords: sessions.reduce((max, session) => Math.max(max, session.messages.length, session.toolCalls.length), 0),
      sourceContentDigest: digest,
    };
  }
}
