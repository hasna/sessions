import { mkdirSync, statSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { SqliteAdapter } from "./sqlite-adapter.js";
import { getSessionsDbPath } from "../lib/paths.js";

export type Database = SqliteAdapter;

const SESSION_SOURCE_CHECK = "source IN ('claude', 'codex', 'codewith', 'gemini')";
const SQLITE_MIGRATION_MIN_FREE_BYTES = 64 * 1024 * 1024;
const SQLITE_MIGRATION_BACKUP_DIR = "migration-backups";

const SESSION_COLUMNS: { name: string; fallback: string }[] = [
  { name: "id", fallback: "lower(hex(randomblob(16)))" },
  { name: "source", fallback: "'claude'" },
  { name: "source_id", fallback: "id" },
  { name: "source_path", fallback: "NULL" },
  { name: "title", fallback: "NULL" },
  { name: "project_path", fallback: "NULL" },
  { name: "project_name", fallback: "NULL" },
  { name: "model", fallback: "NULL" },
  { name: "model_provider", fallback: "NULL" },
  { name: "git_branch", fallback: "NULL" },
  { name: "git_sha", fallback: "NULL" },
  { name: "git_origin_url", fallback: "NULL" },
  { name: "cli_version", fallback: "NULL" },
  { name: "is_subagent", fallback: "0" },
  { name: "parent_session_id", fallback: "NULL" },
  { name: "total_input_tokens", fallback: "0" },
  { name: "total_output_tokens", fallback: "0" },
  { name: "total_cache_read_tokens", fallback: "0" },
  { name: "total_cache_write_tokens", fallback: "0" },
  { name: "total_thinking_tokens", fallback: "0" },
  { name: "message_count", fallback: "0" },
  { name: "tool_call_count", fallback: "0" },
  { name: "started_at", fallback: "NULL" },
  { name: "ended_at", fallback: "NULL" },
  { name: "duration_seconds", fallback: "NULL" },
  { name: "ingested_at", fallback: "datetime('now')" },
  { name: "updated_at", fallback: "datetime('now')" },
  { name: "source_modified_at", fallback: "NULL" },
  { name: "machine", fallback: "NULL" },
  { name: "metadata", fallback: "'{}'" },
];

const SESSION_INDEX_SQL = [
  `CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_model ON sessions(model)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id ON sessions(parent_session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_machine ON sessions(machine)`,
];

/**
 * SQLite schema for the local session index (LocalStore). The self_hosted
 * cloud plane keeps its own Postgres schema under src/db/cloud/migrations.ts.
 * FTS5 virtual tables + triggers provide full-text search.
 */
const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL CHECK(${SESSION_SOURCE_CHECK}),
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
    machine TEXT,
    metadata TEXT DEFAULT '{}',
    UNIQUE(source, source_id)
  )`,

  `CREATE TABLE IF NOT EXISTS machines (
    name TEXT PRIMARY KEY,
    hostname TEXT,
    platform TEXT,
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    session_count INTEGER NOT NULL DEFAULT 0
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

  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    message TEXT NOT NULL,
    email TEXT,
    category TEXT DEFAULT 'general',
    version TEXT,
    machine_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,

  // Indexes
  `CREATE INDEX IF NOT EXISTS idx_sessions_source ON sessions(source)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path)`,
  // NOTE: idx_sessions_machine is created in runMigrations(), after the machine
  // column is guaranteed to exist (it must not run before the ALTER on old DBs).
  `CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_model ON sessions(model)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_parent_session_id ON sessions(parent_session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session_sequence ON messages(session_id, sequence_num)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_message_id ON tool_calls(message_id)`,
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
  `CREATE TABLE IF NOT EXISTS messages_fts_refs (
    rowid INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tool_calls_fts_refs (
    rowid INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_fts_refs_session ON messages_fts_refs(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_fts_refs_session ON tool_calls_fts_refs(session_id)`,

  // FTS tables are maintained explicitly in db/sessions.ts. Earlier versions
  // used per-row triggers, but replacing large sessions was very slow because
  // each trigger deleted from standalone FTS tables by unindexed text columns.
];

let _db: SqliteAdapter | null = null;

/** Apply the schema (idempotent) to a database connection. */
export function initSchema(db: SqliteAdapter): void {
  // Set the lock wait before any other PRAGMA. A database can be in WAL
  // recovery when another `sessions ingest` was interrupted; without this,
  // the first write-ish PRAGMA can fail immediately with SQLITE_BUSY_RECOVERY.
  db.exec("PRAGMA busy_timeout=30000");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA synchronous=NORMAL");
  db.exec("PRAGMA foreign_keys=ON");
  // Wait for locks instead of failing immediately — `sessions watch`
  // ingests while queries/relocate run against the same DB.
  for (const stmt of SCHEMA) db.exec(stmt);
  runMigrations(db);
}

/**
 * Idempotent column migrations for databases created before a column existed.
 * We attempt the ALTER and ignore the "duplicate column" error — this avoids
 * relying on `PRAGMA table_info` through the adapter (which can't run via a
 * prepared statement) and works whether or not the column is already present.
 */
function runMigrations(db: SqliteAdapter): void {
  try {
    db.exec("ALTER TABLE sessions ADD COLUMN machine TEXT");
  } catch {
    // Column already exists — nothing to do.
  }
  migrateSessionSourceConstraint(db);
  ensureSessionIndexes(db);
  for (const trigger of [
    "sessions_ai",
    "sessions_ad",
    "sessions_au",
    "messages_ai",
    "messages_ad",
    "messages_au",
    "tool_calls_ai",
    "tool_calls_ad",
    "tool_calls_au",
  ]) {
    db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  }
  ensureFtsRowidRefs(db);
}

function ensureSessionIndexes(db: SqliteAdapter): void {
  for (const sql of SESSION_INDEX_SQL) db.exec(sql);
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function sourceCheckAllowsCodewith(sql: string | null): boolean {
  return Boolean(sql?.includes("codewith"));
}

function tableSql(db: SqliteAdapter, table: string): string | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql?: string | null } | undefined;
  return row?.sql ?? null;
}

function existingColumns(db: SqliteAdapter, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as { name: string }[];
  return new Set(rows.map((row) => row.name));
}

function databasePath(db: SqliteAdapter): string | null {
  const rows = db.prepare("PRAGMA database_list").all() as { name: string; file: string }[];
  const main = rows.find((row) => row.name === "main");
  return main?.file ? main.file : null;
}

function databasePageBytes(db: SqliteAdapter): number {
  const pageSize = db.prepare("PRAGMA page_size").get() as { page_size?: number } | undefined;
  const pageCount = db.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined;
  return Number(pageSize?.page_size ?? 0) * Number(pageCount?.page_count ?? 0);
}

function availableBytes(path: string): number | null {
  try {
    const stat = statfsSync(path);
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

function preflightSourceConstraintMigration(db: SqliteAdapter): void {
  const invalidSources = db
    .prepare(
      `SELECT source, COUNT(*) AS count FROM sessions
       WHERE source NOT IN ('claude', 'codex', 'codewith', 'gemini')
       GROUP BY source ORDER BY source`,
    )
    .all() as { source: string; count: number }[];
  if (invalidSources.length > 0) {
    const summary = invalidSources
      .map((row) => `${row.source || "(empty)"}:${Number(row.count)}`)
      .join(", ");
    throw new Error(`cannot migrate sessions.source constraint with unknown sources present: ${summary}`);
  }

  const dbPath = databasePath(db);
  if (!dbPath) return;

  const dbBytes = Math.max(databasePageBytes(db), statSync(dbPath).size);
  const requiredBytes = dbBytes * 2 + SQLITE_MIGRATION_MIN_FREE_BYTES;
  const freeBytes = availableBytes(dirname(dbPath));
  if (freeBytes !== null && freeBytes < requiredBytes) {
    throw new Error(
      `not enough free disk for sessions.source migration backup/rebuild: need ${requiredBytes} bytes, available ${freeBytes} bytes`,
    );
  }

  const backupDir = join(dirname(dbPath), SQLITE_MIGRATION_BACKUP_DIR);
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `sessions-pre-codewith-source-${stamp}.db`);
  db.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`);
  const backupSize = statSync(backupPath).size;
  if (backupSize <= 0) {
    throw new Error(`sessions.source migration backup was empty: ${backupPath}`);
  }
}

function countTables(db: SqliteAdapter): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of [
    "sessions",
    "messages",
    "tool_calls",
    "sessions_fts",
    "messages_fts",
    "tool_calls_fts",
    "messages_fts_refs",
    "tool_calls_fts_refs",
  ]) {
    counts[table] = tableCount(db, table);
  }
  return counts;
}

function assertCountsUnchanged(before: Record<string, number>, after: Record<string, number>): void {
  for (const [table, count] of Object.entries(before)) {
    if (after[table] !== count) {
      throw new Error(`sessions.source migration changed ${table} row count: before ${count}, after ${after[table]}`);
    }
  }
}

function assertForeignKeysValid(db: SqliteAdapter): void {
  const rows = db.prepare("PRAGMA foreign_key_check").all();
  if (rows.length > 0) {
    throw new Error(`sessions.source migration left foreign-key violations: ${JSON.stringify(rows)}`);
  }
}

function createSessionsReplacementTable(db: SqliteAdapter): void {
  db.exec(
    `CREATE TABLE sessions_new (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL CHECK(${SESSION_SOURCE_CHECK}),
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
      machine TEXT,
      metadata TEXT DEFAULT '{}',
      UNIQUE(source, source_id)
    )`,
  );
}

function migrateSessionSourceConstraint(db: SqliteAdapter): void {
  if (sourceCheckAllowsCodewith(tableSql(db, "sessions"))) return;

  preflightSourceConstraintMigration(db);
  const before = countTables(db);
  const columns = existingColumns(db, "sessions");
  const targetColumns = SESSION_COLUMNS.map((column) => quoteIdent(column.name)).join(", ");
  const sourceColumns = SESSION_COLUMNS.map((column) =>
    columns.has(column.name) && column.fallback !== "NULL"
      ? `COALESCE(${quoteIdent(column.name)}, ${column.fallback})`
      : columns.has(column.name)
        ? quoteIdent(column.name)
        : column.fallback,
  ).join(", ");

  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS sessions_new");
      createSessionsReplacementTable(db);
      db.exec(`INSERT INTO sessions_new (${targetColumns}) SELECT ${sourceColumns} FROM sessions`);
      if (process.env.HASNA_SESSIONS_FAIL_CODEWITH_SOURCE_MIGRATION === "1") {
        throw new Error("forced sessions.source migration failure");
      }
      db.exec("DROP TABLE sessions");
      db.exec("ALTER TABLE sessions_new RENAME TO sessions");
      ensureSessionIndexes(db);
    });
  } finally {
    try {
      db.exec("DROP TABLE IF EXISTS sessions_new");
    } catch {
      // Best-effort cleanup after rollback.
    }
    db.exec("PRAGMA foreign_keys=ON");
  }

  const after = countTables(db);
  assertCountsUnchanged(before, after);
  assertForeignKeysValid(db);
}

function tableCount(db: SqliteAdapter, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

function insertFtsMessage(db: SqliteAdapter, messageId: string, sessionId: string, content: string | null): void {
  const result = db
    .prepare("INSERT INTO messages_fts_refs(session_id, message_id) VALUES (?, ?)")
    .run(sessionId, messageId) as { lastInsertRowid?: number | bigint };
  if (result.lastInsertRowid == null) throw new Error("failed to allocate messages_fts rowid");
  db.prepare("INSERT INTO messages_fts(rowid, message_id, session_id, content) VALUES (?, ?, ?, ?)")
    .run(result.lastInsertRowid, messageId, sessionId, content);
}

function insertFtsToolCall(
  db: SqliteAdapter,
  toolCallId: string,
  sessionId: string,
  toolName: string,
  toolInput: string | null,
  toolOutput: string | null
): void {
  const result = db
    .prepare("INSERT INTO tool_calls_fts_refs(session_id, tool_call_id) VALUES (?, ?)")
    .run(sessionId, toolCallId) as { lastInsertRowid?: number | bigint };
  if (result.lastInsertRowid == null) throw new Error("failed to allocate tool_calls_fts rowid");
  db.prepare(
    "INSERT INTO tool_calls_fts(rowid, tool_call_id, session_id, tool_name, tool_input, tool_output) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(result.lastInsertRowid, toolCallId, sessionId, toolName, toolInput, toolOutput);
}

export function rebuildFtsTables(db: SqliteAdapter): void {
  db.exec("DROP TABLE IF EXISTS sessions_fts");
  db.exec("DROP TABLE IF EXISTS messages_fts");
  db.exec("DROP TABLE IF EXISTS tool_calls_fts");
  db.exec(`CREATE VIRTUAL TABLE sessions_fts USING fts5(
    session_id UNINDEXED, title, project_name, project_path,
    tokenize='porter unicode61'
  )`);
  db.exec(`CREATE VIRTUAL TABLE messages_fts USING fts5(
    message_id UNINDEXED, session_id UNINDEXED, content,
    tokenize='porter unicode61'
  )`);
  db.exec(`CREATE VIRTUAL TABLE tool_calls_fts USING fts5(
    tool_call_id UNINDEXED, session_id UNINDEXED, tool_name, tool_input, tool_output,
    tokenize='porter unicode61'
  )`);
  db.exec("DELETE FROM messages_fts_refs");
  db.exec("DELETE FROM tool_calls_fts_refs");

  const insertSession = db.prepare(
    "INSERT INTO sessions_fts(session_id, title, project_name, project_path) VALUES (?, ?, ?, ?)"
  );
  const sessions = db
    .prepare("SELECT id, title, project_name, project_path FROM sessions")
    .all() as Record<string, unknown>[];
  for (const session of sessions) {
    insertSession.run(
      session.id as string,
      (session.title as string) ?? null,
      (session.project_name as string) ?? null,
      (session.project_path as string) ?? null
    );
  }

  const messages = db
    .prepare("SELECT id, session_id, content FROM messages ORDER BY session_id, sequence_num")
    .all() as Record<string, unknown>[];
  for (const message of messages) {
    insertFtsMessage(
      db,
      message.id as string,
      message.session_id as string,
      (message.content as string) ?? null
    );
  }

  const toolCalls = db
    .prepare("SELECT id, session_id, tool_name, tool_input, tool_output FROM tool_calls ORDER BY session_id, timestamp")
    .all() as Record<string, unknown>[];
  for (const toolCall of toolCalls) {
    insertFtsToolCall(
      db,
      toolCall.id as string,
      toolCall.session_id as string,
      toolCall.tool_name as string,
      (toolCall.tool_input as string) ?? null,
      (toolCall.tool_output as string) ?? null
    );
  }
}

function ensureFtsRowidRefs(db: SqliteAdapter): void {
  const messageCount = tableCount(db, "messages");
  const toolCallCount = tableCount(db, "tool_calls");
  const messageRefCount = tableCount(db, "messages_fts_refs");
  const toolCallRefCount = tableCount(db, "tool_calls_fts_refs");

  if (messageRefCount !== messageCount) {
    const messageFtsCount = tableCount(db, "messages_fts");
    if (messageFtsCount === messageCount) {
      db.exec("DELETE FROM messages_fts_refs");
      db.exec(
        `INSERT INTO messages_fts_refs(rowid, session_id, message_id)
         SELECT rowid, session_id, message_id FROM messages_fts
         WHERE session_id IS NOT NULL AND message_id IS NOT NULL`
      );
    }
  }

  if (toolCallRefCount !== toolCallCount) {
    const toolCallFtsCount = tableCount(db, "tool_calls_fts");
    if (toolCallFtsCount === toolCallCount) {
      db.exec("DELETE FROM tool_calls_fts_refs");
      db.exec(
        `INSERT INTO tool_calls_fts_refs(rowid, session_id, tool_call_id)
         SELECT rowid, session_id, tool_call_id FROM tool_calls_fts
         WHERE session_id IS NOT NULL AND tool_call_id IS NOT NULL`
      );
    }
  }

  const repairedMessageRefCount = tableCount(db, "messages_fts_refs");
  const repairedToolCallRefCount = tableCount(db, "tool_calls_fts_refs");
  if (
    process.env.HASNA_SESSIONS_REBUILD_FTS_ON_OPEN === "1" &&
    (repairedMessageRefCount !== messageCount || repairedToolCallRefCount !== toolCallCount)
  ) {
    rebuildFtsTables(db);
  }
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
