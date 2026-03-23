/**
 * PostgreSQL migrations for open-sessions cloud sync.
 *
 * Equivalent to the SQLite schema in database.ts, translated for PostgreSQL.
 */

export const PG_MIGRATIONS: string[] = [
  // Migration 1: sessions table
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
    is_subagent BOOLEAN NOT NULL DEFAULT FALSE,
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
    ingested_at TEXT NOT NULL DEFAULT NOW()::text,
    updated_at TEXT NOT NULL DEFAULT NOW()::text,
    source_modified_at TEXT,
    metadata TEXT DEFAULT '{}',
    UNIQUE(source, source_id)
  )`,

  // Migration 2: messages table
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    source_id TEXT,
    parent_message_id TEXT,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool', 'info', 'thinking')),
    content TEXT,
    content_preview TEXT,
    model TEXT,
    is_sidechain BOOLEAN NOT NULL DEFAULT FALSE,
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

  // Migration 3: tool_calls table
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

  // Migration 4: embeddings table
  `CREATE TABLE IF NOT EXISTS embeddings (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    chunk_text TEXT NOT NULL,
    embedding BYTEA,
    embedding_model TEXT,
    dimensions INTEGER,
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    synced_to_s3 BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE(message_id, chunk_index)
  )`,

  // Migration 5: ingestion_state table
  `CREATE TABLE IF NOT EXISTS ingestion_state (
    source TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_mtime TEXT,
    file_size INTEGER,
    ingested_at TEXT NOT NULL DEFAULT NOW()::text,
    status TEXT,
    error_message TEXT,
    PRIMARY KEY (source, file_path)
  )`,

  // Migration 6: ingestion_stats table
  `CREATE TABLE IF NOT EXISTS ingestion_stats (
    source TEXT PRIMARY KEY,
    session_count INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    last_ingested_at TEXT,
    updated_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  // Migration 7: indexes on sessions
  `CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_source_source_id ON sessions(source, source_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_model ON sessions(model)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id ON sessions(parent_session_id)`,

  // Migration 8: indexes on messages
  `CREATE INDEX IF NOT EXISTS idx_messages_session_sequence ON messages(session_id, sequence_num)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_parent_message_id ON messages(parent_message_id)`,

  // Migration 9: indexes on tool_calls
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_message_id ON tool_calls(message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_name ON tool_calls(tool_name)`,

  // Migration 10: indexes on embeddings
  `CREATE INDEX IF NOT EXISTS idx_embeddings_session_id ON embeddings(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_embeddings_message_id ON embeddings(message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_embeddings_synced_to_s3 ON embeddings(synced_to_s3)`,

  // Migration 11: migrations tracking
  `CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  // Migration 12: feedback table
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    message TEXT NOT NULL,
    email TEXT,
    category TEXT DEFAULT 'general',
    version TEXT,
    machine_id TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,
];
