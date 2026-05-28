import { existsSync } from "node:fs";
import { getDatabase } from "./database.js";
import { recomputeMachineCounts } from "./machines.js";
import { updateIngestionStats } from "./ingestion.js";
import { SESSION_SOURCES } from "../types/index.js";

// Explicit column lists so the merge is independent of physical column order
// (a migrated DB appends `machine` last; a fresh DB has it mid-table).
const SESSION_COLS =
  "id, source, source_id, source_path, title, project_path, project_name, model, model_provider, git_branch, git_sha, git_origin_url, cli_version, is_subagent, parent_session_id, total_input_tokens, total_output_tokens, total_cache_read_tokens, total_cache_write_tokens, total_thinking_tokens, message_count, tool_call_count, started_at, ended_at, duration_seconds, ingested_at, updated_at, source_modified_at, machine, metadata";
const MESSAGE_COLS =
  "id, session_id, source_id, parent_message_id, role, content, content_preview, model, is_sidechain, sequence_num, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, thinking_tokens, timestamp, metadata";
const TOOL_COLS =
  "id, message_id, session_id, tool_name, tool_input, tool_output, duration_ms, status, timestamp, metadata";
const EMBEDDING_COLS =
  "id, message_id, session_id, chunk_index, chunk_text, embedding, embedding_model, dimensions, created_at, synced_to_s3";

export interface MergeResult {
  sessions: number;
  messages: number;
  tool_calls: number;
  embeddings: number;
}

function countRows(db: ReturnType<typeof getDatabase>, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
}

/**
 * Merge another sessions database (e.g. copied from another machine) into the
 * local one. New rows are added (INSERT OR IGNORE on id / natural keys) and the
 * `machine` tag from the source is preserved, so the merged index stays
 * attributable per machine. FTS is repopulated for new rows via the triggers.
 */
export function mergeFromDb(path: string): MergeResult {
  if (!existsSync(path)) throw new Error(`No such database: ${path}`);
  const db = getDatabase();
  const quoted = "'" + path.replace(/'/g, "''") + "'";
  db.exec(`ATTACH DATABASE ${quoted} AS src`);
  try {
    const before = {
      s: countRows(db, "sessions"),
      m: countRows(db, "messages"),
      t: countRows(db, "tool_calls"),
      e: countRows(db, "embeddings"),
    };
    db.exec(`INSERT OR IGNORE INTO sessions (${SESSION_COLS}) SELECT ${SESSION_COLS} FROM src.sessions`);
    db.exec(`INSERT OR IGNORE INTO messages (${MESSAGE_COLS}) SELECT ${MESSAGE_COLS} FROM src.messages`);
    db.exec(`INSERT OR IGNORE INTO tool_calls (${TOOL_COLS}) SELECT ${TOOL_COLS} FROM src.tool_calls`);
    try {
      db.exec(`INSERT OR IGNORE INTO embeddings (${EMBEDDING_COLS}) SELECT ${EMBEDDING_COLS} FROM src.embeddings`);
    } catch {
      // Source DB may predate the embeddings table — ignore.
    }
    const after = {
      s: countRows(db, "sessions"),
      m: countRows(db, "messages"),
      t: countRows(db, "tool_calls"),
      e: countRows(db, "embeddings"),
    };
    recomputeMachineCounts();
    for (const source of SESSION_SOURCES) updateIngestionStats(source);
    return {
      sessions: after.s - before.s,
      messages: after.m - before.m,
      tool_calls: after.t - before.t,
      embeddings: after.e - before.e,
    };
  } finally {
    db.exec("DETACH DATABASE src");
  }
}
