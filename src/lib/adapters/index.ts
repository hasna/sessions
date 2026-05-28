/**
 * Session adapter registry.
 *
 * Each external tool (Claude Code, Codex, future CLIs) implements a `SessionAdapter`
 * that knows how to:
 * 1. Discover sessions in its native storage
 * 2. Parse individual sessions into the canonical `CanonicalSession` format
 * 3. Import sessions into `~/.claude/projects/` for cross-tool compatibility
 *
 * Adapters are registered here — adding a new one is just importing it.
 */

import type { SessionAdapter, CanonicalSession } from "./types.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter } from "./codex.js";

// Register adapters here — order matters for discovery precedence
const _adapters: Map<string, SessionAdapter> = new Map();

export function registerAdapter(id: string, adapter: SessionAdapter): void {
  _adapters.set(id, adapter);
}

export function getAdapter(id: string): SessionAdapter | undefined {
  return _adapters.get(id);
}

export function listAdapters(): Array<{ id: string; available: boolean }> {
  return [..._adapters.entries()].map(([id, adapter]) => ({
    id,
    available: adapter.isAvailable(),
  }));
}

export function autoDetectAdapters(): SessionAdapter[] {
  return [..._adapters.values()].filter((a) => a.isAvailable());
}

// Built-in adapters
registerAdapter("claude", new ClaudeAdapter());
registerAdapter("codex", new CodexAdapter());

export type { SessionAdapter, CanonicalSession };
export { ClaudeAdapter } from "./claude.js";
export { CodexAdapter } from "./codex.js";
