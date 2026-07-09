import type { SessionContentImport } from "../types/index.js";

export interface ExistingContentCounts {
  messages: number;
  toolCalls: number;
}

function hasExplicitShrinkIntent(input: SessionContentImport): boolean {
  const destructive = input.destructive;
  return destructive?.allowContentShrink === true && typeof destructive.reason === "string" && destructive.reason.trim().length > 0;
}

export function contentShrinkError(
  input: SessionContentImport,
  existing: ExistingContentCounts | null,
): string | null {
  if (!existing) return null;
  const incomingMessages = input.messages.length;
  const incomingToolCalls = input.toolCalls.length;
  if (incomingMessages >= existing.messages && incomingToolCalls >= existing.toolCalls) return null;
  if (hasExplicitShrinkIntent(input)) return null;

  const parts: string[] = [];
  if (incomingMessages < existing.messages) {
    parts.push(`messages ${existing.messages} -> ${incomingMessages}`);
  }
  if (incomingToolCalls < existing.toolCalls) {
    parts.push(`toolCalls ${existing.toolCalls} -> ${incomingToolCalls}`);
  }
  return `content import would shrink existing session content (${parts.join(", ")}); pass destructive.allowContentShrink with a non-empty reason to confirm intentional replacement`;
}
