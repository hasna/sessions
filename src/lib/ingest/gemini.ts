import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { SessionParser } from "./types.js";
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
}
