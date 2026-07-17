import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWatchStatus, startWatch, type Watcher } from "../src/lib/watch.js";
import { getDatabase, resetDatabase, closeDatabase } from "../src/db/database.js";
import { listSessions } from "../src/db/sessions.js";

let root: string;
let projectDir: string;
let watcher: Watcher | null = null;

const sessionLines = (id: string, text: string) =>
  [
    JSON.stringify({ type: "user", message: { role: "user", content: text }, uuid: `${id}-u`, timestamp: "2026-05-01T10:00:00Z", cwd: "/Users/h/Workspace/app", sessionId: id, gitBranch: "main" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-4", content: [{ type: "text", text: "ok" }] }, uuid: `${id}-a`, timestamp: "2026-05-01T10:00:02Z", sessionId: id }),
  ].join("\n");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sessions-watch-"));
  projectDir = join(root, "claude", "projects", "-Users-h-Workspace-app");
  mkdirSync(projectDir, { recursive: true });
  process.env.CLAUDE_PATH = join(root, "claude");
  process.env.CODEX_PATH = join(root, "codex-missing");
  process.env.CODEWITH_PATH = join(root, "codewith-missing");
  process.env.GEMINI_PATH = join(root, "gemini-missing");
  // Use a temp FILE db (not :memory:) so the watcher's ingest and this test's
  // reads share state even if they resolve to separate db module singletons.
  process.env.SESSIONS_DB_PATH = join(root, "sessions.db");
  resetDatabase();
  getDatabase();
});

afterEach(() => {
  watcher?.stop();
  watcher = null;
  closeDatabase();
  rmSync(root, { recursive: true, force: true });
  delete process.env.CLAUDE_PATH;
  delete process.env.CODEX_PATH;
  delete process.env.CODEWITH_PATH;
  delete process.env.GEMINI_PATH;
  delete process.env.SESSIONS_DB_PATH;
});

describe("startWatch", () => {
  it("reports watch status without starting the watcher", () => {
    const status = getWatchStatus({ debounceMs: 25, pollMs: 0 });
    expect(status.debounceMs).toBe(25);
    expect(status.pollMs).toBe(0);
    expect(status.roots.map((root) => root.source).sort()).toEqual(["claude", "codewith", "codex", "gemini"]);
    expect(status.sources).toContain("claude");
    expect(status.roots.some((root) => root.source === "claude" && root.exists)).toBe(true);
    expect(status.roots.some((root) => root.source === "codex" && !root.exists)).toBe(true);
    expect(status.roots.some((root) => root.source === "codewith" && !root.exists)).toBe(true);
    expect(status.roots.some((root) => root.source === "gemini" && !root.exists)).toBe(true);
  });

  it("watches only providers whose dirs exist", () => {
    watcher = startWatch({ debounceMs: 50, pollMs: 200 });
    expect(watcher.sources).toContain("claude");
    expect(watcher.sources).not.toContain("codex"); // dir missing
    expect(watcher.sources).not.toContain("codewith"); // dir missing
    expect(watcher.sources).not.toContain("gemini"); // dir missing
    expect(watcher.roots.every((root) => root.exists)).toBe(true);
  });

  it("can restrict watched providers", () => {
    const codexRoot = join(root, "codex");
    mkdirSync(join(codexRoot, "sessions"), { recursive: true });
    process.env.CODEX_PATH = codexRoot;
    watcher = startWatch({ sources: ["codex"], debounceMs: 50, pollMs: 0 });
    expect(watcher.sources).toEqual(["codex"]);
  });

  it("ingests a newly written session file via the poll safety net", async () => {
    const ingests: string[] = [];
    watcher = startWatch({ debounceMs: 50, pollMs: 200, onIngest: (r) => ingests.push(r.source) });
    writeFileSync(join(projectDir, "watch-1.jsonl"), sessionLines("watch-1", "watched deploy"));

    // A single long wait lets the 200ms poll fire several times without the
    // tight-loop scheduling that can starve timers under the test runner.
    await sleep(2000);

    expect(ingests.length).toBeGreaterThan(0);
    expect(listSessions({ source: "claude" }).some((s) => s.source_id === "watch-1")).toBe(true);
  }, 8000);
});
