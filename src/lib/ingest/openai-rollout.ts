import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { SessionParser } from "./types.js";
import { flattenContent } from "./types.js";
import { titleFromUserContent } from "../session-text.js";
import type {
  MessageInsert,
  MessageRole,
  ParsedSession,
  SessionInsert,
  SessionSource,
  ToolCallInsert,
} from "../../types/index.js";

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
    if (!existsSync(filePath)) return [];
    const lines = readFileSync(filePath, "utf-8").split("\n").filter((l) => l.trim());
    if (lines.length === 0) return [];

    const messages: MessageInsert[] = [];
    const toolCalls: ToolCallInsert[] = [];
    const toolByCallId = new Map<string, ToolCallInsert>();
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

    for (const line of lines) {
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
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
        continue;
      }

      if (o.type !== "response_item") continue;
      if (ts) {
        if (!firstTs) firstTs = ts;
        lastTs = ts;
      }

      const ptype = payload.type;

      if (ptype === "function_call" && typeof payload.name === "string") {
        const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
        const tc: ToolCallInsert = {
          session_id: "",
          tool_name: payload.name,
          tool_input: payload.arguments != null ? String(payload.arguments) : null,
          timestamp: ts,
        };
        toolCalls.push(tc);
        if (callId) toolByCallId.set(callId, tc);
        continue;
      }

      if (ptype === "function_call_output") {
        const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
        const tc = callId ? toolByCallId.get(callId) : undefined;
        if (tc) tc.tool_output = flattenContent(payload.output);
        continue;
      }

      const role = ptype === "reasoning" ? "thinking" : mapRole(payload.role);
      const content =
        ptype === "reasoning"
          ? flattenContent(payload.summary ?? payload.content)
          : flattenContent(payload.content);
      if (!content) continue;

      if (!title && role === "user") {
        title = titleFromUserContent(content) ?? undefined;
      }

      messages.push({
        session_id: "",
        role,
        content,
        sequence_num: seq++,
        timestamp: ts,
      });
    }

    if (messages.length === 0 && toolCalls.length === 0) return [];

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

    return [{ session, messages, toolCalls }];
  }
}
