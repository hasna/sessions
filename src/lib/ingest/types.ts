import type { ParsedSession, SessionSource } from "../../types/index.js";

export interface SessionParser {
  /** Provider identifier (claude, codex, codewith, gemini, …). */
  readonly source: SessionSource;
  /** Root directories where this provider stores session files. */
  sessionRoots(): string[];
  /** Enumerate absolute paths of session files under the roots. */
  listSessionFiles(): string[];
  /** Parse a session file into normalized sessions. Most providers yield one per file; some (gemini logs.json) yield many. Returns [] if none. */
  parseFile(filePath: string): ParsedSession[];
}

/** Flatten a Claude/Codex content value (string or array of blocks) into plain text. */
export function flattenContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (typeof b.text === "string") parts.push(b.text);
      else if (typeof b.thinking === "string") parts.push(b.thinking);
      else if (b.type === "tool_result" && b.content != null) parts.push(flattenContent(b.content));
      else if (b.type === "input_text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type === "output_text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("\n").trim();
}
