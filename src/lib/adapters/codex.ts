/**
 * Adapter for OpenAI Codex sessions.
 *
 * Storage: ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
 * Each line has: { timestamp, type, payload }
 * Types: session_meta, event_msg, response_item, turn_context
 * Payload roles: developer, user, assistant, function_call, function_call_output
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type {
  SessionAdapter,
  CanonicalSession,
  CanonicalEvent,
} from "./types.js";

function getCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function getCodexSessionsDir(): string {
  return join(getCodexHome(), "sessions");
}

export class CodexAdapter implements SessionAdapter {
  readonly id = "codex";
  readonly name = "OpenAI Codex";

  isAvailable(): boolean {
    return existsSync(getCodexSessionsDir());
  }

  getSessionsDir(): string {
    return getCodexSessionsDir();
  }

  discoverSessions(): string[] {
    const sessionsDir = getCodexSessionsDir();
    if (!existsSync(sessionsDir)) return [];

    const files: string[] = [];
    // Structure: sessions/YYYY/MM/DD/*.jsonl
    try {
      const years = readdirSync(sessionsDir);
      for (const year of years) {
        const yearPath = join(sessionsDir, year);
        try {
          if (!statSync(yearPath).isDirectory()) continue;
        } catch {
          continue;
        }
        const months = readdirSync(yearPath);
        for (const month of months) {
          const monthPath = join(yearPath, month);
          try {
            if (!statSync(monthPath).isDirectory()) continue;
          } catch {
            continue;
          }
          const days = readdirSync(monthPath);
          for (const day of days) {
            const dayPath = join(monthPath, day);
            try {
              if (!statSync(dayPath).isDirectory()) continue;
            } catch {
              continue;
            }
            const entries = readdirSync(dayPath);
            for (const entry of entries) {
              if (entry.endsWith(".jsonl")) {
                files.push(join(dayPath, entry));
              }
            }
          }
        }
      }
    } catch {
      // Base dir doesn't exist or unreadable
    }
    return files;
  }

  parseSession(filePath: string): CanonicalSession | null {
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      let sessionId = "";
      let cwd = "";
      let model: string | null = null;
      let agentName: string | null = null;
      let agentRole: string | null = null;
      let earliestTs: number = Infinity;
      let latestTs: number = 0;
      const events: CanonicalEvent[] = [];

      for (const line of lines) {
        let parsed: Record<string, any>;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }

        const ts = parsed.timestamp
          ? new Date(parsed.timestamp).getTime()
          : 0;
        if (ts > 0) {
          if (ts < earliestTs) earliestTs = ts;
          if (ts > latestTs) latestTs = ts;
        }

        // session_meta — contains id, cwd, agent info
        if (parsed.type === "session_meta" && parsed.payload) {
          const p = parsed.payload;
          if (p.id) sessionId = p.id;
          if (p.cwd) cwd = p.cwd;
          if (p.agent_nickname) agentName = p.agent_nickname;
          if (p.agent_role) agentRole = p.agent_role;
          if (p.model_provider) model = p.model_provider;
        }

        // response_item — the actual conversation turns
        if (parsed.type === "response_item" && parsed.payload) {
          const payload = parsed.payload;

          if (payload.type === "message") {
            const role = payload.role;
            const contentParts = payload.content as Array<{
              type?: string;
              text?: string;
              name?: string;
              arguments?: string;
              output?: string;
              parsed?: any;
            }>;

            for (const part of contentParts) {
              if (role === "user") {
                if (part.type === "input_text" && part.text) {
                  events.push({
                    type: "user",
                    timestamp: new Date(ts).toISOString(),
                    content: part.text,
                  });
                }
              } else if (role === "assistant") {
                if (part.type === "output_text" && part.text) {
                  events.push({
                    type: "assistant",
                    timestamp: new Date(ts).toISOString(),
                    model: model || undefined,
                    content: part.text,
                  });
                }
              } else if (role === "developer") {
                if (part.type === "input_text" && part.text) {
                  events.push({
                    type: "system",
                    timestamp: new Date(ts).toISOString(),
                    content: part.text,
                  });
                }
              }
            }
          }

          // Function/tool calls
          if (payload.type === "function_call" || (payload.name && payload.arguments !== undefined)) {
            events.push({
              type: "tool_call",
              timestamp: new Date(ts).toISOString(),
              model: model || undefined,
              toolName: payload.name,
              content: typeof payload.arguments === "string"
                ? payload.arguments
                : JSON.stringify(payload.arguments ?? {}),
              toolArgs: typeof payload.arguments === "string"
                ? undefined
                : payload.arguments,
            });
          }

          // Function call outputs
          if (payload.type === "function_call_output" || payload.output !== undefined) {
            events.push({
              type: "tool_result",
              timestamp: new Date(ts).toISOString(),
              content: payload.output || JSON.stringify(payload),
              toolName: payload.name,
              toolResult: payload.output,
            });
          }

          // Reasoning/thinking
          if (payload.type === "reasoning" || (payload.type === "message" && payload.parsed?.reasoning)) {
            const reasoning = payload.content?.[0]?.text || JSON.stringify(payload);
            events.push({
              type: "thinking",
              timestamp: new Date(ts).toISOString(),
              model: model || undefined,
              content: reasoning,
            });
          }
        }
      }

      if (events.length === 0) return null;

      // Derive session ID from filename if not in content
      if (!sessionId) {
        const filename = filePath.split("/").pop()!.replace(/\.jsonl$/, "");
        // Filename format: rollout-<timestamp>-<uuid>
        const uuidMatch = filename.match(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
        sessionId = uuidMatch ? uuidMatch[1] : filename;
      }

      return {
        id: sessionId,
        cwd: cwd || "",
        startedAt: earliestTs !== Infinity
          ? new Date(earliestTs).toISOString()
          : new Date().toISOString(),
        lastActivityAt: latestTs !== 0
          ? new Date(latestTs).toISOString()
          : new Date().toISOString(),
        model,
        title: agentName ? `${agentName} (${agentRole})` : null,
        agentName,
        source: "codex",
        events,
        sourcePath: filePath,
      };
    } catch {
      return null;
    }
  }
}
