import { SqliteAdapter } from "@hasna/cloud";
import { getSessionsDbPath } from "../lib/paths.js";

export type Database = SqliteAdapter;

/**
 * SQLite schema for the session index. Kept in lock-step with the PostgreSQL
 * mirror in pg-migrations.ts (column-for-column) so @hasna/cloud sync works.
 * FTS5 virtual tables + triggers provide full-text search.
 */
const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL CHECK(source IN ('claude', 'codex', 'gemini')),
    source_id TEXT NOT NULL,
    source_path TEXT,
    title TEXT,
    project_path TEXT,
    project_name TEXT,
    model TEXT,
    model_provider TEXT,
    git_branch TEXT,
    git_sha TEXT,
    git_origin_url TEXT,
    cli_version TEXT,
    is_subagent INTEGER NOT NULL DEFAULT 0,
    parent_session_id TEXT,
    total_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    total_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    total_thinking_tokens INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    ended_at TEXT,
    duration_seconds REAL,
    ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    source_modified_at TEXT,
    metadata TEXT DEFAULT '{}',
    UNIQUE(source, source_id)
  )`,

  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_id TEXT,
    parent_message_id TEXT,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool', 'info', 'thinking')),
    content TEXT,
    content_preview TEXT,
    model TEXT,
    is_sidechain INTEGER NOT NULL DEFAULT 0,
    sequence_num INTEGER,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    thinking_tokens INTEGER NOT NULL DEFAULT 0,
    timestamp TEXT,
    metadata TEXT DEFAULT '{}',
    UNIQUE(session_id, source_id)
  )`,

  `CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    tool_input TEXT,
    tool_output TEXT,
    duration_ms INTEGER,
    status TEXT CHECK(status IN ('success', 'error', 'timeout')),
    timestamp TEXT,
    metadata TEXT DEFAULT '{}'
  )`,

  `CREATE TABLE IF NOT EXISTS embeddings (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    embedding BLOB,
    embedding_model TEXT,
    dimensions INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    synced_to_s3 INTEGER NOT NULL DEFAULT 0,
    UNIQUE(message_id, chunk_index)
  )`,

  `CREATE TABLE IF NOT EXISTS ingestion_state (
    source TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_mtime TEXT,
    file_size INTEGER,
    ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
    status TEXT,
    error_message TEXT,
    PRIMARY KEY (source, file_path)
  )`,

  `CREATE TABLE IF NOT EXISTS ingestion_stats (
    source TEXT PRIMARY KEY,
    session_count INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    last_ingested_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // Indexes
  `CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_model ON sessions(model)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id ON sessions(parent_session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session_sequence ON messages(session_id, sequence_num)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_name ON tool_calls(tool_name)`,
  `CREATE INDEX IF NOT EXISTS idx_embeddings_session_id ON embeddings(session_id)`,

  // FTS5 virtual tables (standalone, with UNINDEXED reference columns)
  `CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
    session_id UNINDEXED, title, project_name, project_path,
    tokenize='porter unicode61'
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    message_id UNINDEXED, session_id UNINDEXED, content,
    tokenize='porter unicode61'
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS tool_calls_fts USING fts5(
    tool_call_id UNINDEXED, session_id UNINDEXED, tool_name, tool_input, tool_output,
    tokenize='porter unicode61'
  )`,

  // Triggers to keep FTS in sync with base tables
  `CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN
    INSERT INTO sessions_fts(session_id, title, project_name, project_path)
    VALUES (new.id, new.title, new.project_name, new.project_path);
  END`,
  `CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN
    DELETE FROM sessions_fts WHERE session_id = old.id;
  END`,
  `CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE ON sessions BEGIN
    DELETE FROM sessions_fts WHERE session_id = old.id;
    INSERT INTO sessions_fts(session_id, title, project_name, project_path)
    VALUES (new.id, new.title, new.project_name, new.project_path);
  END`,

  `CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(message_id, session_id, content)
    VALUES (new.id, new.session_id, new.content);
  END`,
  `CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    DELETE FROM messages_fts WHERE message_id = old.id;
  END`,
  `CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    DELETE FROM messages_fts WHERE message_id = old.id;
    INSERT INTO messages_fts(message_id, session_id, content)
    VALUES (new.id, new.session_id, new.content);
  END`,

  `CREATE TRIGGER IF NOT EXISTS tool_calls_ai AFTER INSERT ON tool_calls BEGIN
    INSERT INTO tool_calls_fts(tool_call_id, session_id, tool_name, tool_input, tool_output)
    VALUES (new.id, new.session_id, new.tool_name, new.tool_input, new.tool_output);
  END`,
  `CREATE TRIGGER IF NOT EXISTS tool_calls_ad AFTER DELETE ON tool_calls BEGIN
    DELETE FROM tool_calls_fts WHERE tool_call_id = old.id;
  END`,
  `CREATE TRIGGER IF NOT EXISTS tool_calls_au AFTER UPDATE ON tool_calls BEGIN
    DELETE FROM tool_calls_fts WHERE tool_call_id = old.id;
    INSERT INTO tool_calls_fts(tool_call_id, session_id, tool_name, tool_input, tool_output)
    VALUES (new.id, new.session_id, new.tool_name, new.tool_input, new.tool_output);
  END`,
];

let _db: SqliteAdapter | null = null;

/** Apply the schema (idempotent) to a database connection. */
export function initSchema(db: SqliteAdapter): void {
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  for (const stmt of SCHEMA) db.exec(stmt);
}

/** Get the process-wide database singleton, creating + migrating it on first use. */
export function getDatabase(): SqliteAdapter {
  if (_db) return _db;
  _db = new SqliteAdapter(getSessionsDbPath());
  initSchema(_db);
  return _db;
}

/** Close the singleton (next getDatabase() reopens). */
export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** Reset the singleton — closes the current connection so the next getDatabase() reopens fresh. Used by tests with an in-memory DB. */
export function resetDatabase(): void {
  closeDatabase();
}
