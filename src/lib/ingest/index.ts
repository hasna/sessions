import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerParser, getParser, listParsers } from "./registry.js";
import { ClaudeParser } from "./claude.js";
import { CodexParser } from "./codex.js";
import { CodewithParser } from "./codewith.js";
import { GeminiParser } from "./gemini.js";
import { saveParsedSession, saveStagedParsedSession } from "../../db/sessions.js";
import { getFileState, setFileState, updateIngestionStats } from "../../db/ingestion.js";
import { registerMachine, recomputeMachineCounts } from "../../db/machines.js";
import { getSessionsDir } from "../paths.js";

// Register the built-in parsers on import.
registerParser(new ClaudeParser());
registerParser(new CodexParser());
registerParser(new CodewithParser());
registerParser(new GeminiParser());

export { registerParser, getParser, listParsers };
export type { SessionParser } from "./types.js";
export { flattenContent } from "./types.js";
export { ClaudeParser, CodexParser, CodewithParser, GeminiParser };

export interface IngestResult {
  source: string;
  scanned: number;
  ingested: number;
  skipped: number;
  sessions: number;
  errors: number;
}

export interface IngestOptions {
  /** Re-ingest even if the file is unchanged since last ingest. */
  force?: boolean;
  /** Progress callback (one line per event). */
  onProgress?: (message: string) => void;
}

const INGEST_LOCK_DIR = "ingest.lock";
const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

interface IngestLockInfo {
  pid: number;
  started_at: string;
}

interface FileSnapshot {
  mtime: string;
  size: number;
}

function ingestLockPath(): string {
  return join(getSessionsDir(), INGEST_LOCK_DIR);
}

function pidIsRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockInfo(lockPath: string): IngestLockInfo | null {
  try {
    return JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf-8")) as IngestLockInfo;
  } catch {
    return null;
  }
}

function lockLooksStale(lockPath: string, info: IngestLockInfo | null): boolean {
  if (info?.pid && pidIsRunning(info.pid)) return false;
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    return age > STALE_LOCK_MS || !info?.pid || !pidIsRunning(info.pid);
  } catch {
    return true;
  }
}

function acquireIngestLock(): () => void {
  const lockPath = ingestLockPath();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockPath);
      writeFileSync(
        join(lockPath, "owner.json"),
        JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 2),
        "utf-8"
      );
      return () => rmSync(lockPath, { recursive: true, force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const info = readLockInfo(lockPath);
      if (lockLooksStale(lockPath, info)) {
        rmSync(lockPath, { recursive: true, force: true });
        continue;
      }
      const owner = info?.pid ? `pid ${info.pid}` : "another process";
      throw new Error(`another sessions ingest is already running (${owner}); wait for it to finish before starting another ingest`);
    }
  }
  throw new Error("could not acquire sessions ingest lock");
}

function withIngestLock<T>(fn: () => T): T {
  const release = acquireIngestLock();
  try {
    return fn();
  } finally {
    release();
  }
}

function snapshotFile(file: string): FileSnapshot | null {
  try {
    const st = statSync(file);
    return { mtime: st.mtime.toISOString(), size: st.size };
  } catch {
    return null;
  }
}

function sameSnapshot(a: FileSnapshot, b: FileSnapshot): boolean {
  return a.mtime === b.mtime && a.size === b.size;
}

function ingestSourceUnlocked(source: string, opts: IngestOptions = {}): IngestResult {
  const parser = getParser(source);
  if (!parser) throw new Error(`No parser registered for source: ${source}`);

  registerMachine();
  const result: IngestResult = { source, scanned: 0, ingested: 0, skipped: 0, sessions: 0, errors: 0 };
  const files = parser.listSessionFiles();

  for (const file of files) {
    result.scanned++;
    const before = snapshotFile(file);
    if (!before) {
      // File vanished between listing and stat — skip.
      continue;
    }

    if (!opts.force) {
      const state = getFileState(source, file);
      if (state && state.status === "ok" && state.file_mtime === before.mtime && state.file_size === before.size) {
        result.skipped++;
        continue;
      }
    }

    try {
      const parsed = parser.parseFileResult?.(file, { preferStaging: true }) ?? { sessions: parser.parseFile(file) };
      const after = snapshotFile(file);
      try {
        if (!after) {
          setFileState(source, file, before.mtime, before.size, "pending", "file vanished after parsing");
          opts.onProgress?.(`[${source}] deferred ${file}: file vanished after parsing`);
          continue;
        }
        if (parsed.incompleteTrailingRecord) {
          setFileState(source, file, after.mtime, after.size, "pending", "incomplete trailing JSONL record");
          opts.onProgress?.(`[${source}] deferred ${file}: incomplete trailing JSONL record`);
          continue;
        }
        if (!sameSnapshot(before, after)) {
          setFileState(source, file, after.mtime, after.size, "pending", "file changed during parsing");
          opts.onProgress?.(`[${source}] deferred ${file}: file changed during parsing`);
          continue;
        }

        let fileSessions = 0;
        for (const ps of parsed.sessions) {
          saveParsedSession(ps);
          result.sessions++;
          fileSessions++;
        }
        for (const staged of parsed.stagedSessions ?? []) {
          saveStagedParsedSession(staged);
          result.sessions++;
          fileSessions++;
        }
        setFileState(source, file, after.mtime, after.size, "ok");
        result.ingested++;
        opts.onProgress?.(`[${source}] ingested ${file} (${fileSessions} session${fileSessions === 1 ? "" : "s"})`);
      } finally {
        for (const staged of parsed.stagedSessions ?? []) {
          staged.cleanup();
        }
      }
    } catch (err) {
      result.errors++;
      setFileState(source, file, before.mtime, before.size, "error", (err as Error).message);
      opts.onProgress?.(`[${source}] ERROR ${file}: ${(err as Error).message}`);
    }
  }

  updateIngestionStats(source);
  recomputeMachineCounts();
  return result;
}

/** Ingest all session files for a single provider, skipping unchanged files. */
export function ingestSource(source: string, opts: IngestOptions = {}): IngestResult {
  return withIngestLock(() => ingestSourceUnlocked(source, opts));
}

/** Ingest every registered provider (or a subset). */
export function ingestAll(opts: IngestOptions & { sources?: string[] } = {}): IngestResult[] {
  const sources = opts.sources ?? listParsers().map((p) => p.source);
  return withIngestLock(() => sources.map((s) => ingestSourceUnlocked(s, opts)));
}
