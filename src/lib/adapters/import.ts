/**
 * Import sessions from external adapters into Claude Code storage format.
 *
 * This takes a CanonicalSession (from any adapter) and writes it as
 * a .jsonl file in ~/.claude/projects/<encoded-path>/ so that it
 * becomes natively readable by Claude Code, Takumi, and all other tools.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { CanonicalSession, ImportOptions, ImportResult } from "./types.js";
import { encodePath, getClaudeProjectsDir } from "../paths.js";
import { loadSessionRegistry, saveSessionRegistry } from "../sessions.js";

/**
 * Convert a CanonicalSession into Claude Code .jsonl line format.
 * Each event becomes a line that Claude Code can parse for --resume.
 */
function toClaudeJsonl(session: CanonicalSession): string {
  const lines: string[] = [];
  const sessionId = session.id;
  const cwd = session.cwd || "/tmp";

  // Header — Claude Code uses this for session metadata
  lines.push(
    JSON.stringify({
      type: "header",
      sessionId,
      cwd,
      version: "1.0.0",
    })
  );

  for (const event of session.events) {
    const base = {
      type: event.type === "user" ? "user" : "assistant",
      timestamp: event.timestamp,
      cwd,
      sessionId,
      message: {} as Record<string, any>,
    };

    if (event.type === "user") {
      base.message = {
        role: "user",
        content: event.content,
      };
      lines.push(JSON.stringify(base));
    } else if (event.type === "assistant") {
      base.message = {
        role: "assistant",
        content: [
          {
            type: "text",
            text: event.content,
          },
        ],
        model: event.model || session.model || "claude-sonnet-4-6",
        stop_reason: "end_turn",
      };
      lines.push(JSON.stringify(base));
    } else if (event.type === "thinking") {
      // Thinking events become assistant messages with thinking content
      const thinkingBase = {
        ...base,
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: event.content,
            },
          ],
          model: event.model || session.model || "claude-sonnet-4-6",
        },
      };
      lines.push(JSON.stringify(thinkingBase));
    } else if (event.type === "tool_call") {
      base.message = {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: event.toolName || "unknown",
            input: event.toolArgs || {},
          },
        ],
        model: event.model || session.model || "claude-sonnet-4-6",
      };
      lines.push(JSON.stringify(base));
    } else if (event.type === "tool_result") {
      // Tool results become assistant follow-up messages
      base.message = {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `[Tool: ${event.toolName || "unknown"}]\n${event.content}`,
          },
        ],
        model: event.model || session.model || "claude-sonnet-4-6",
      };
      lines.push(JSON.stringify(base));
    } else if (event.type === "system") {
      // System messages become user-assistant context
      base.type = "assistant";
      base.message = {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `[System context]\n${event.content}`,
          },
        ],
        model: event.model || session.model || "claude-sonnet-4-6",
      };
      lines.push(JSON.stringify(base));
    }
  }

  // Custom title and agent name events
  if (session.title) {
    lines.push(
      JSON.stringify({
        type: "custom-title",
        customTitle: session.title,
        timestamp: session.lastActivityAt,
        cwd,
        sessionId,
      })
    );
  }

  if (session.agentName) {
    lines.push(
      JSON.stringify({
        type: "agent-name",
        agentName: session.agentName,
        timestamp: session.lastActivityAt,
        cwd,
        sessionId,
      })
    );
  }

  return lines.join("\n");
}

/**
 * Import canonical sessions into Claude Code storage.
 *
 * Sessions are placed in ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 * so they become natively readable by all tools in the ecosystem.
 */
export function importCanonicalSessions(
  sessions: CanonicalSession[],
  options: ImportOptions = {}
): ImportResult {
  const { overwrite = false, dryRun = false, verbose = false, projectPath, updateRegistry = true } = options;
  const projectsDir = getClaudeProjectsDir();

  const result: ImportResult = {
    imported: 0,
    skipped: 0,
    errors: [],
  };

  // Filter by project if specified
  const targetSessions = projectPath
    ? sessions.filter((s) => s.cwd.includes(projectPath))
    : sessions;

  if (!existsSync(projectsDir) && !dryRun) {
    mkdirSync(projectsDir, { recursive: true });
  }

  for (const session of targetSessions) {
    const encodedDir = encodePath(session.cwd);
    const destDir = join(projectsDir, encodedDir);
    const destFile = join(destDir, `${session.id}.jsonl`);

    // Skip if already exists and not overwriting
    if (existsSync(destFile) && !overwrite) {
      result.skipped++;
      if (verbose) console.log(`  Skipping (exists): ${destFile}`);
      continue;
    }

    const jsonlContent = toClaudeJsonl(session);

    if (verbose) {
      console.log(`  Importing: ${session.id} → ${encodedDir}/${session.id}.jsonl`);
      console.log(`    Source: ${session.source}, Events: ${session.events.length}, CWD: ${session.cwd}`);
    }

    if (!dryRun) {
      mkdirSync(destDir, { recursive: true });
      writeFileSync(destFile, jsonlContent, "utf-8");
    }

    result.imported++;
  }

  // Update session registry if requested
  if (updateRegistry && !dryRun && result.imported > 0) {
    try {
      const registry = loadSessionRegistry();
      for (const session of targetSessions) {
        const encodedDir = encodePath(session.cwd);
        const transcriptPath = join(projectsDir, encodedDir, `${session.id}.jsonl`);

        if (existsSync(transcriptPath)) {
          registry.sessions[session.id] = {
            sessionId: session.id,
            friendlyName: `${session.source}-${session.id.slice(0, 8)}`,
            friendlyNameSource: "auto",
            projectPath: session.cwd,
            projectSlug: session.cwd.split("/").pop() || "unknown",
            encodedDir,
            transcriptPath,
            provider: "claude",
            startedAt: session.startedAt,
            lastActivityAt: session.lastActivityAt,
            lastModel: session.model,
            customTitle: session.title,
            agentName: session.agentName,
            status: "idle",
          };
        }
      }
      saveSessionRegistry(registry);
    } catch (err: any) {
      result.errors.push({
        file: "registry",
        error: `Failed to update registry: ${err.message}`,
      });
    }
  }

  return result;
}

