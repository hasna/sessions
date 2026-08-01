import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWatchStatus, startWatch, type Watcher } from "../src/lib/watch.js";
import { getDatabase, resetDatabase, closeDatabase } from "../src/db/database.js";
import { listSessions } from "../src/db/sessions.js";
import { getParser, registerParser } from "../src/lib/ingest/index.js";

let root: string;
let projectDir: string;
let watcher: Watcher | null = null;

const sessionLines = (id: string, text: string) =>
  [
    JSON.stringify({ type: "user", message: { role: "user", content: text }, uuid: `${id}-u`, timestamp: "2026-05-01T10:00:00Z", cwd: "/Users/h/Workspace/app", sessionId: id, gitBranch: "main" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-4", content: [{ type: "text", text: "ok" }] }, uuid: `${id}-a`, timestamp: "2026-05-01T10:00:02Z", sessionId: id }),
  ].join("\n");

const codewithRolloutLines = (id: string, text: string) =>
  [
    JSON.stringify({ timestamp: "2026-05-02T10:00:00Z", type: "session_meta", payload: { id, cwd: "/work/codewith" } }),
    JSON.stringify({ timestamp: "2026-05-02T10:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }),
  ].join("\n");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitFor = async (predicate: () => boolean, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error("timed out waiting for watcher state");
};

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
  process.env.HASNA_SESSIONS_DIR = join(root, "sessions-home");
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
  delete process.env.HASNA_SESSIONS_DIR;
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

  it("reports successful and failed ingest observability without leaking file contents", async () => {
    const file = join(projectDir, "watch-status.jsonl");
    const oldMtime = new Date(Date.now() - 10_000);
    writeFileSync(file, sessionLines("watch-status", "watched status"));
    utimesSync(file, oldMtime, oldMtime);

    const pending = getWatchStatus({ sources: ["claude"] }).roots[0];
    expect(pending?.lagSeconds).toBeGreaterThanOrEqual(9);

    watcher = startWatch({ sources: ["claude"], debounceMs: 25, pollMs: 100 });
    const claudeStatus = () => getWatchStatus({ sources: ["claude"] }).roots[0];
    await waitFor(() => claudeStatus()?.lastSuccessAt !== null);
    await waitFor(() => (claudeStatus()?.skippedFiles ?? 0) > 0);

    const successful = claudeStatus();
    expect(successful?.lastAttemptAt).not.toBeNull();
    expect(successful?.lastSuccessAt).not.toBeNull();
    expect(successful?.lagSeconds).toBe(0);
    expect(successful?.skippedFiles).toBeGreaterThan(0);
    expect(successful?.lastError).toBeNull();

    const originalParser = getParser("claude");
    if (!originalParser) throw new Error("claude parser not registered");
    const transcriptSecret = "SECRET_TRANSCRIPT_CONTENT";
    try {
      registerParser({
        source: "claude",
        sessionRoots: () => originalParser.sessionRoots(),
        listSessionFiles: () => originalParser.listSessionFiles(),
        parseFile: (path) => originalParser.parseFile(path),
        parseFileResult: () => {
          throw new Error("provoked parse error");
        },
      });
      writeFileSync(file, transcriptSecret);
      await waitFor(() => claudeStatus()?.lastError !== null);

      const failed = claudeStatus();
      expect(failed?.lastAttemptAt).not.toBeNull();
      expect(failed?.lastSuccessAt).toBe(successful?.lastSuccessAt);
      expect(failed?.lagSeconds).toBeGreaterThanOrEqual(0);
      expect(failed?.lastError).toBe("provoked parse error");
      expect(failed?.lastError).not.toContain(transcriptSecret);
    } finally {
      registerParser(originalParser);
    }
  }, 8000);

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

  it("recovers Codewith sessions across watcher restart without duplicates and preserves status", async () => {
    const rolloutDir = join(root, "codewith", "sessions", "2026", "05", "02");
    mkdirSync(rolloutDir, { recursive: true });
    process.env.CODEWITH_PATH = join(root, "codewith");

    watcher = startWatch({ sources: ["codewith"], debounceMs: 25, pollMs: 100 });
    writeFileSync(join(rolloutDir, "rollout-first.jsonl"), codewithRolloutLines("codewith-first", "first"));
    await waitFor(() => listSessions({ source: "codewith" }).length === 1);
    watcher.stop();
    watcher = null;

    const stoppedStatus = getWatchStatus({ sources: ["codewith"] }).roots[0];
    expect(stoppedStatus?.lastAttemptAt).not.toBeNull();
    expect(stoppedStatus?.lastSuccessAt).not.toBeNull();
    expect(stoppedStatus?.lastError).toBeNull();

    // Simulate a filesystem event missed while the supervised process is down.
    writeFileSync(join(rolloutDir, "rollout-second.jsonl"), codewithRolloutLines("codewith-second", "second"));
    await sleep(250);
    expect(listSessions({ source: "codewith" }).map((session) => session.source_id)).toEqual(["codewith-first"]);

    watcher = startWatch({ sources: ["codewith"], debounceMs: 25, pollMs: 100 });
    await waitFor(() => listSessions({ source: "codewith" }).length === 2);
    await waitFor(() => (getWatchStatus({ sources: ["codewith"] }).roots[0]?.skippedFiles ?? 0) === 2);

    expect(listSessions({ source: "codewith" }).map((session) => session.source_id).sort()).toEqual([
      "codewith-first",
      "codewith-second",
    ]);
    const restartedStatus = getWatchStatus({ sources: ["codewith"] }).roots[0];
    expect(restartedStatus).toMatchObject({
      exists: true,
      lagSeconds: 0,
      skippedFiles: 2,
      lastError: null,
    });
    expect(restartedStatus?.lastAttemptAt).not.toBeNull();
    expect(restartedStatus?.lastSuccessAt).not.toBeNull();
  }, 8000);
});
