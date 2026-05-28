/**
 * Adapter for Claude Code sessions.
 *
 * Storage: ~/.claude/projects/<encoded-path>/<session-id>.jsonl
 * Each line is a JSON record with type, message, cwd, timestamp, etc.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type {
  SessionAdapter,
  CanonicalSession,
  CanonicalEvent,
} from "./types.js";
import { encodePath, getClaudeProjectsDir } from "../paths.js";

export class ClaudeAdapter implements SessionAdapter {
  readonly id = "claude";
  readonly name = "Claude Code";

  isAvailable(): boolean {
    return existsSync(getClaudeProjectsDir());
  }

  getSessionsDir(): string {
    return getClaudeProjectsDir();
  }

  discoverSessions(): string[] {
    const projectsDir = getClaudeProjectsDir();
    if (!existsSync(projectsDir)) return [];

    const files: string[] = [];
    const dirs = readdirSync(projectsDir);
    for (const dir of dirs) {
      const dirPath = join(projectsDir, dir);
      try {
        if (!statSync(dirPath).isDirectory()) continue;
      } catch {
        continue;
      }
      const entries = readdirSync(dirPath);
      for (const entry of entries) {
        if (entry.endsWith(".jsonl")) {
          files.push(join(dirPath, entry));
        } else {
          // Check subdirectories for .jsonl files (subagents)
          const subPath = join(dirPath, entry);
          try {
            if (statSync(subPath).isDirectory()) {
              const subEntries = readdirSync(subPath);
              for (const subEntry of subEntries) {
                if (subEntry.endsWith(".jsonl")) {
                  files.push(join(subPath, subEntry));
                }
              }
            }
          } catch {
            // Not a directory
          }
        }
      }
    }
    return files;
  }

  parseSession(filePath: string): CanonicalSession | null {
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());

      let cwd = "";
      let sessionId = "";
      let model: string | null = null;
      let customTitle: string | null = null;
      let agentName: string | null = null;
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

        if (parsed.cwd) cwd = parsed.cwd;
        if (parsed.sessionId) sessionId = parsed.sessionId;
        if (parsed.message?.model) model = parsed.message.model;

        // Special types
        if (parsed.type === "custom-title" && parsed.customTitle) {
          customTitle = parsed.customTitle;
        }
        if (parsed.type === "agent-name" && parsed.agentName) {
          agentName = parsed.agentName;
        }

        // User messages
        if (parsed.type === "user" && parsed.message?.content) {
          const content =
            typeof parsed.message.content === "string"
              ? parsed.message.content
              : JSON.stringify(parsed.message.content);
          events.push({
            type: "user",
            timestamp: new Date(ts).toISOString(),
            content,
          });
        }

        // Assistant messages
        if (parsed.type === "assistant" && parsed.message?.content) {
          const msgModel = parsed.message.model;
          const parts = parsed.message.content as Array<Record<string, any>>;
          for (const part of parts) {
            if (part.type === "thinking" && part.thinking) {
              events.push({
                type: "thinking",
                timestamp: new Date(ts).toISOString(),
                model: msgModel,
                content: part.thinking,
              });
            } else if (part.type === "text" && part.text) {
              events.push({
                type: "assistant",
                timestamp: new Date(ts).toISOString(),
                model: msgModel,
                content: part.text,
              });
            } else if (part.type === "tool_use" && part.id && part.name) {
              events.push({
                type: "tool_call",
                timestamp: new Date(ts).toISOString(),
                model: msgModel,
                toolName: part.name,
                content: JSON.stringify(part.input ?? {}),
                toolArgs: part.input,
              });
            }
          }
        }
      }

      if (events.length === 0) return null;

      // Derive session ID from filename if not in content
      if (!sessionId) {
        sessionId = filePath.split("/").pop()!.replace(/\.jsonl$/, "");
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
        title: customTitle,
        agentName,
        source: "claude",
        events,
        sourcePath: filePath,
      };
    } catch {
      return null;
    }
  }
}
