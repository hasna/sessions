import { watch, existsSync, readFileSync, renameSync, statSync, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { listFileStates } from "../db/ingestion.js";
import { getSessionsDbPath } from "./paths.js";
import { listParsers, ingestSource, type IngestResult } from "./ingest/index.js";
import { ingestionStateMtime } from "./ingest/types.js";

export interface WatchOptions {
  /** Restrict watching to these provider sources. Defaults to every parser. */
  sources?: string[];
  /** How long to wait after the last change before ingesting (per source). Default 2000ms. */
  debounceMs?: number;
  /**
   * Safety-net re-scan interval. fs.watch can miss events (notably recursive
   * subdirectory writes on some runtimes), so we also re-ingest on this cadence.
   * Re-ingest is mtime-gated and cheap when nothing changed. Default 10000ms;
   * set 0 to disable.
   */
  pollMs?: number;
  /** Called after each debounced ingest. */
  onIngest?: (result: IngestResult) => void;
  /** Called when an ingest throws. */
  onError?: (error: Error) => void;
}

export interface Watcher {
  /** Stop watching and clear pending timers. */
  stop(): void;
  /** Source providers currently being watched. */
  readonly sources: string[];
  /** Existing provider roots being watched. */
  readonly roots: WatchRootStatus[];
  readonly debounceMs: number;
  readonly pollMs: number;
}

export interface WatchRootStatus {
  source: string;
  root: string;
  exists: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lagSeconds: number | null;
  skippedFiles: number;
  lastError: string | null;
}

export interface WatchStatus {
  sources: string[];
  roots: WatchRootStatus[];
  debounceMs: number;
  pollMs: number;
}

interface WatchSourceState {
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  skippedFiles: number;
  lastError: string | null;
}

const sourceStates = new Map<string, WatchSourceState>();
const WATCH_STATUS_FILE = "watch-status.json";

function watchStatusPath(): string {
  return join(dirname(getSessionsDbPath()), WATCH_STATUS_FILE);
}

function loadSourceStates(): void {
  sourceStates.clear();
  try {
    const saved = JSON.parse(readFileSync(watchStatusPath(), "utf-8")) as Record<string, WatchSourceState>;
    for (const [source, state] of Object.entries(saved)) {
      if (!state || typeof state !== "object") continue;
      sourceStates.set(source, {
        lastAttemptAt: typeof state.lastAttemptAt === "string" ? state.lastAttemptAt : null,
        lastSuccessAt: typeof state.lastSuccessAt === "string" ? state.lastSuccessAt : null,
        skippedFiles: typeof state.skippedFiles === "number" ? state.skippedFiles : 0,
        lastError: typeof state.lastError === "string" ? state.lastError : null,
      });
    }
  } catch {
    return;
  }
}

function saveSourceStates(): void {
  const path = watchStatusPath();
  const temporaryPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(Object.fromEntries(sourceStates)), "utf-8");
    renameSync(temporaryPath, path);
  } catch {
    return;
  }
}

function emptySourceState(): WatchSourceState {
  return { lastAttemptAt: null, lastSuccessAt: null, skippedFiles: 0, lastError: null };
}

function sourceLagSeconds(source: string): number | null {
  const parser = listParsers().find((candidate) => candidate.source === source);
  if (!parser) return null;

  let files: string[];
  try {
    files = parser.listSessionFiles();
  } catch {
    return null;
  }

  let newestPendingMtime = 0;
  const fileStates = new Map(listFileStates(source).map((state) => [state.file_path, state]));
  for (const file of files) {
    try {
      const stat = statSync(file);
      const state = fileStates.get(file);
      const mtime = stat.mtime.toISOString();
      const auxiliarySignature = parser.auxiliaryIngestionSignature?.(file) ?? null;
      if (
        state?.status === "ok" &&
        state.file_mtime === ingestionStateMtime(mtime, auxiliarySignature) &&
        state.file_size === stat.size
      ) continue;
      newestPendingMtime = Math.max(newestPendingMtime, stat.mtimeMs);
    } catch {
      continue;
    }
  }
  return newestPendingMtime === 0 ? 0 : Math.max(0, Math.floor((Date.now() - newestPendingMtime) / 1000));
}

function makeRootStatus(source: string, root: string): WatchRootStatus {
  const exists = existsSync(root);
  const state = sourceStates.get(source) ?? emptySourceState();
  return {
    source,
    root,
    exists,
    ...state,
    lagSeconds: exists ? sourceLagSeconds(source) : null,
  };
}

export function getWatchStatus(opts: WatchOptions = {}): WatchStatus {
  loadSourceStates();
  const debounceMs = opts.debounceMs ?? 2000;
  const pollMs = opts.pollMs ?? 10000;
  const allowedSources = opts.sources ? new Set(opts.sources) : null;
  const roots: WatchRootStatus[] = [];
  const sources = new Set<string>();

  for (const parser of listParsers()) {
    if (allowedSources && !allowedSources.has(parser.source)) continue;
    for (const root of parser.sessionRoots()) {
      const status = makeRootStatus(parser.source, root);
      roots.push(status);
      if (status.exists) sources.add(parser.source);
    }
  }

  return { sources: [...sources], roots, debounceMs, pollMs };
}

/**
 * Watch every registered provider's session directories and re-ingest the
 * affected provider (debounced) whenever files change — keeping the index
 * continuously fresh for real-time queries.
 */
export function startWatch(opts: WatchOptions = {}): Watcher {
  const status = getWatchStatus(opts);
  const { debounceMs, pollMs } = status;
  const watchers: FSWatcher[] = [];
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const sources: string[] = [];
  const watchedRoots = status.roots.filter((root) => root.exists);

  const updateSourceState = (source: string, state: WatchSourceState) => {
    sourceStates.set(source, state);
    saveSourceStates();
    for (const root of watchedRoots) {
      if (root.source !== source) continue;
      Object.assign(root, state, { lagSeconds: sourceLagSeconds(source) });
    }
  };

  const runIngest = (source: string) => {
    const previous = sourceStates.get(source) ?? emptySourceState();
    const lastAttemptAt = new Date().toISOString();
    updateSourceState(source, { ...previous, lastAttemptAt });
    try {
      let lastError: string | null = null;
      const result = ingestSource(source, { onError: (error) => (lastError = error.message) });
      const completedAt = new Date().toISOString();
      updateSourceState(source, {
        lastAttemptAt,
        lastSuccessAt: result.errors === 0 ? completedAt : previous.lastSuccessAt,
        skippedFiles: result.skipped,
        lastError: result.errors > 0 ? lastError ?? `${result.errors} file${result.errors === 1 ? "" : "s"} failed to ingest` : null,
      });
      opts.onIngest?.(result);
    } catch (err) {
      updateSourceState(source, {
        ...previous,
        lastAttemptAt,
        lastError: (err as Error).message,
      });
      opts.onError?.(err as Error);
    }
  };

  const scheduleIngest = (source: string) => {
    const existingTimer = pending.get(source);
    if (existingTimer) clearTimeout(existingTimer);
    pending.set(
      source,
      setTimeout(() => {
        pending.delete(source);
        runIngest(source);
      }, debounceMs)
    );
  };

  for (const parser of listParsers()) {
    let watching = false;
    for (const { source, root, exists } of status.roots) {
      if (source !== parser.source || !exists) continue;
      try {
        watchers.push(watch(root, { recursive: true }, () => scheduleIngest(parser.source)));
        watching = true;
      } catch (err) {
        const previous = sourceStates.get(parser.source) ?? emptySourceState();
        updateSourceState(parser.source, { ...previous, lastError: (err as Error).message });
        opts.onError?.(err as Error);
      }
    }
    if (watching) sources.push(parser.source);
  }

  // Safety-net poll: re-ingest watched sources on a cadence (mtime-gated, cheap).
  const interval =
    pollMs > 0 && sources.length > 0
      ? setInterval(() => {
          for (const source of sources) runIngest(source);
        }, pollMs)
      : null;

  return {
    sources,
    roots: watchedRoots,
    debounceMs,
    pollMs,
    stop() {
      for (const w of watchers) w.close();
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
      if (interval) clearInterval(interval);
    },
  };
}
