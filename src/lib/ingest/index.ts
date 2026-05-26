import { statSync } from "node:fs";
import { registerParser, getParser, listParsers } from "./registry.js";
import { ClaudeParser } from "./claude.js";
import { CodexParser } from "./codex.js";
import { GeminiParser } from "./gemini.js";
import { saveParsedSession } from "../../db/sessions.js";
import { getFileState, setFileState, updateIngestionStats } from "../../db/ingestion.js";

// Register the built-in parsers on import.
registerParser(new ClaudeParser());
registerParser(new CodexParser());
registerParser(new GeminiParser());

export { registerParser, getParser, listParsers };
export type { SessionParser } from "./types.js";
export { flattenContent } from "./types.js";
export { ClaudeParser, CodexParser, GeminiParser };

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

/** Ingest all session files for a single provider, skipping unchanged files. */
export function ingestSource(source: string, opts: IngestOptions = {}): IngestResult {
  const parser = getParser(source);
  if (!parser) throw new Error(`No parser registered for source: ${source}`);

  const result: IngestResult = { source, scanned: 0, ingested: 0, skipped: 0, sessions: 0, errors: 0 };
  const files = parser.listSessionFiles();

  for (const file of files) {
    result.scanned++;
    let mtime: string | null = null;
    let size: number | null = null;
    try {
      const st = statSync(file);
      mtime = st.mtime.toISOString();
      size = st.size;
    } catch {
      // File vanished between listing and stat — skip.
      continue;
    }

    if (!opts.force) {
      const state = getFileState(source, file);
      if (state && state.status === "ok" && state.file_mtime === mtime) {
        result.skipped++;
        continue;
      }
    }

    try {
      const parsed = parser.parseFile(file);
      for (const ps of parsed) {
        saveParsedSession(ps);
        result.sessions++;
      }
      setFileState(source, file, mtime, size, "ok");
      result.ingested++;
      opts.onProgress?.(`[${source}] ingested ${file} (${parsed.length} session${parsed.length === 1 ? "" : "s"})`);
    } catch (err) {
      result.errors++;
      setFileState(source, file, mtime, size, "error", (err as Error).message);
      opts.onProgress?.(`[${source}] ERROR ${file}: ${(err as Error).message}`);
    }
  }

  updateIngestionStats(source);
  return result;
}

/** Ingest every registered provider (or a subset). */
export function ingestAll(opts: IngestOptions & { sources?: string[] } = {}): IngestResult[] {
  const sources = opts.sources ?? listParsers().map((p) => p.source);
  return sources.map((s) => ingestSource(s, opts));
}
