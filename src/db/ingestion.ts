import { getDatabase } from "./database.js";

export interface FileState {
  source: string;
  file_path: string;
  file_mtime: string | null;
  file_size: number | null;
  status: string | null;
}

export function getFileState(source: string, filePath: string): FileState | null {
  const db = getDatabase();
  const row = db
    .prepare("SELECT * FROM ingestion_state WHERE source = ? AND file_path = ?")
    .get(source, filePath) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    source: row.source as string,
    file_path: row.file_path as string,
    file_mtime: (row.file_mtime as string) ?? null,
    file_size: row.file_size == null ? null : Number(row.file_size),
    status: (row.status as string) ?? null,
  };
}

export function setFileState(
  source: string,
  filePath: string,
  mtime: string | null,
  size: number | null,
  status: string,
  errorMessage?: string
): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO ingestion_state (source, file_path, file_mtime, file_size, ingested_at, status, error_message)
     VALUES (?, ?, ?, ?, datetime('now'), ?, ?)
     ON CONFLICT(source, file_path) DO UPDATE SET
       file_mtime = excluded.file_mtime,
       file_size = excluded.file_size,
       ingested_at = excluded.ingested_at,
       status = excluded.status,
       error_message = excluded.error_message`
  ).run(source, filePath, mtime, size, status, errorMessage ?? null);
}

/** Recompute the ingestion_stats rollup for a source from the live tables. */
export function updateIngestionStats(source: string): void {
  const db = getDatabase();
  const agg = db
    .prepare(
      `SELECT
         COUNT(*) AS session_count,
         COALESCE(SUM(message_count), 0) AS message_count,
         COALESCE(SUM(tool_call_count), 0) AS tool_call_count,
         COALESCE(SUM(total_input_tokens + total_output_tokens), 0) AS total_tokens
       FROM sessions WHERE source = ?`
    )
    .get(source) as Record<string, unknown>;

  db.prepare(
    `INSERT INTO ingestion_stats (source, session_count, message_count, tool_call_count, total_tokens, last_ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(source) DO UPDATE SET
       session_count = excluded.session_count,
       message_count = excluded.message_count,
       tool_call_count = excluded.tool_call_count,
       total_tokens = excluded.total_tokens,
       last_ingested_at = excluded.last_ingested_at,
       updated_at = excluded.updated_at`
  ).run(
    source,
    Number(agg.session_count ?? 0),
    Number(agg.message_count ?? 0),
    Number(agg.tool_call_count ?? 0),
    Number(agg.total_tokens ?? 0)
  );
}

export interface IngestionStats {
  source: string;
  session_count: number;
  message_count: number;
  tool_call_count: number;
  total_tokens: number;
  last_ingested_at: string | null;
}

export function getIngestionStats(): IngestionStats[] {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM ingestion_stats ORDER BY source").all() as Record<string, unknown>[];
  return rows.map((r) => ({
    source: r.source as string,
    session_count: Number(r.session_count ?? 0),
    message_count: Number(r.message_count ?? 0),
    tool_call_count: Number(r.tool_call_count ?? 0),
    total_tokens: Number(r.total_tokens ?? 0),
    last_ingested_at: (r.last_ingested_at as string) ?? null,
  }));
}
