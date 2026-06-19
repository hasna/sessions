import { watch, existsSync, type FSWatcher } from "node:fs";
import { listParsers, ingestSource, type IngestResult } from "./ingest/index.js";

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
}

export interface WatchStatus {
  sources: string[];
  roots: WatchRootStatus[];
  debounceMs: number;
  pollMs: number;
}

export function getWatchStatus(opts: WatchOptions = {}): WatchStatus {
  const debounceMs = opts.debounceMs ?? 2000;
  const pollMs = opts.pollMs ?? 10000;
  const allowedSources = opts.sources ? new Set(opts.sources) : null;
  const roots: WatchRootStatus[] = [];
  const sources = new Set<string>();

  for (const parser of listParsers()) {
    if (allowedSources && !allowedSources.has(parser.source)) continue;
    for (const root of parser.sessionRoots()) {
      const rootStatus = { source: parser.source, root, exists: existsSync(root) };
      roots.push(rootStatus);
      if (rootStatus.exists) sources.add(parser.source);
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

  const runIngest = (source: string) => {
    try {
      opts.onIngest?.(ingestSource(source));
    } catch (err) {
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
    roots: status.roots.filter((root) => root.exists),
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
