import type { SqliteAdapter } from "./sqlite-adapter.js";
import { getDatabase, rebuildFtsTables } from "./database.js";
import { getSessionsDbPath } from "../lib/paths.js";
import { getStorageConfig, getStorageConnectionString } from "./storage-config.js";
import { PgAdapterAsync } from "./remote-storage.js";
import { PG_MIGRATIONS } from "./pg-migrations.js";

type Row = Record<string, unknown>;
type RemoteAdapter = Pick<PgAdapterAsync, "all" | "run" | "get" | "exec">;

export interface SyncResult {
  table: string;
  direction: "push" | "pull";
  rowsRead: number;
  rowsWritten: number;
  errors: string[];
}

export interface StorageStatus {
  mode: string;
  enabled: boolean;
  db_path: string;
  tables: Array<{ table: string; rows: number }>;
}

export const STORAGE_TABLES = [
  "sessions",
  "machines",
  "messages",
  "tool_calls",
  "embeddings",
  "ingestion_state",
  "ingestion_stats",
  "feedback",
] as const;

export const SESSIONS_STORAGE_TABLES = STORAGE_TABLES;

const TABLE_KEYS: Record<string, string[]> = {
  sessions: ["source", "source_id"],
  machines: ["name"],
  messages: ["id"],
  tool_calls: ["id"],
  embeddings: ["id"],
  ingestion_state: ["source", "file_path"],
  ingestion_stats: ["source"],
  feedback: ["id"],
};

const BOOLEAN_COLUMNS: Record<string, string[]> = {
  sessions: ["is_subagent"],
  messages: ["is_sidechain"],
  embeddings: ["synced_to_s3"],
};

const SYNC_BATCH_SIZE = 500;

function quoteId(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function orderByClause(table: string): string {
  const keyColumns = TABLE_KEYS[table] ?? ["id"];
  return `ORDER BY ${keyColumns.map(quoteId).join(", ")}`;
}

function toPgRow(table: string, row: Row): Row {
  const copy = { ...row };
  for (const column of BOOLEAN_COLUMNS[table] ?? []) {
    if (column in copy) copy[column] = Boolean(copy[column]);
  }
  return copy;
}

function toSqliteRow(table: string, row: Row): Row {
  const copy = { ...row };
  for (const column of BOOLEAN_COLUMNS[table] ?? []) {
    if (column in copy) copy[column] = copy[column] ? 1 : 0;
  }
  return copy;
}

function getRowString(row: Row, column: string): string | null {
  const value = row[column];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function destinationSessionIdForSqlite(db: SqliteAdapter, row: Row): string | null {
  const source = getRowString(row, "source");
  const sourceId = getRowString(row, "source_id");
  const rowId = getRowString(row, "id");
  if (!source || !sourceId) return rowId;
  const existing = db
    .prepare("SELECT id FROM sessions WHERE source = ? AND source_id = ?")
    .get(source, sourceId) as { id: string } | undefined;
  return existing?.id ?? rowId;
}

async function destinationSessionIdForPg(remote: RemoteAdapter, row: Row): Promise<string | null> {
  const source = getRowString(row, "source");
  const sourceId = getRowString(row, "source_id");
  const rowId = getRowString(row, "id");
  if (!source || !sourceId) return rowId;
  const existing = await remote.get(
    "SELECT id FROM sessions WHERE source = $1 AND source_id = $2",
    source,
    sourceId
  ) as { id: string } | null;
  return existing?.id ?? rowId;
}

function rewriteSessionReferences(table: string, rows: Row[], sessionIdMap: Map<string, string>): Row[] {
  if (table !== "messages" && table !== "tool_calls" && table !== "embeddings") return rows;
  return rows.map((row) => {
    const sessionId = getRowString(row, "session_id");
    const mappedSessionId = sessionId ? sessionIdMap.get(sessionId) : null;
    return mappedSessionId ? { ...row, session_id: mappedSessionId } : row;
  });
}

function prepareSessionRowsForSqlite(db: SqliteAdapter, rows: Row[], sessionIdMap: Map<string, string>): Row[] {
  for (const row of rows) {
    const sourceId = getRowString(row, "id");
    const destinationId = destinationSessionIdForSqlite(db, row);
    if (sourceId && destinationId) sessionIdMap.set(sourceId, destinationId);
  }

  return rows.map((row) => {
    const sourceId = getRowString(row, "id");
    const destinationId = sourceId ? sessionIdMap.get(sourceId) : null;
    const parentSessionId = getRowString(row, "parent_session_id");
    return {
      ...row,
      ...(destinationId ? { id: destinationId } : {}),
      ...(parentSessionId && sessionIdMap.has(parentSessionId)
        ? { parent_session_id: sessionIdMap.get(parentSessionId) }
        : {}),
    };
  });
}

async function prepareSessionRowsForPg(remote: RemoteAdapter, rows: Row[], sessionIdMap: Map<string, string>): Promise<Row[]> {
  for (const row of rows) {
    const sourceId = getRowString(row, "id");
    const destinationId = await destinationSessionIdForPg(remote, row);
    if (sourceId && destinationId) sessionIdMap.set(sourceId, destinationId);
  }

  return rows.map((row) => {
    const sourceId = getRowString(row, "id");
    const destinationId = sourceId ? sessionIdMap.get(sourceId) : null;
    const parentSessionId = getRowString(row, "parent_session_id");
    return {
      ...row,
      ...(destinationId ? { id: destinationId } : {}),
      ...(parentSessionId && sessionIdMap.has(parentSessionId)
        ? { parent_session_id: sessionIdMap.get(parentSessionId) }
        : {}),
    };
  });
}

async function getRemoteColumns(remote: RemoteAdapter, table: string): Promise<Set<string>> {
  const rows = await remote.all(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    table
  ) as Array<{ column_name: string }>;
  return new Set(rows.map((row) => row.column_name));
}

function getSqliteColumns(db: SqliteAdapter, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${quoteId(table)})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

async function upsertPg(remote: RemoteAdapter, table: string, rows: Row[]): Promise<number> {
  if (rows.length === 0) return 0;

  const remoteColumns = await getRemoteColumns(remote, table);
  const keyColumns = TABLE_KEYS[table] ?? ["id"];
  let written = 0;

  for (const rawRow of rows) {
    const row = toPgRow(table, rawRow);
    const columns = Object.keys(row).filter((column) => remoteColumns.has(column));
    if (keyColumns.some((column) => !columns.includes(column))) continue;

    const values = columns.map((column) => row[column]);
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
    const updateColumns = columns.filter((column) => !keyColumns.includes(column) && !(table === "sessions" && column === "id"));
    const updateClause = updateColumns.length > 0
      ? `DO UPDATE SET ${updateColumns.map((column) => `${quoteId(column)} = EXCLUDED.${quoteId(column)}`).join(", ")}`
      : "DO NOTHING";

    await remote.run(
      `INSERT INTO ${quoteId(table)} (${columns.map(quoteId).join(", ")})
       VALUES (${placeholders})
       ON CONFLICT (${keyColumns.map(quoteId).join(", ")}) ${updateClause}`,
      ...values
    );
    written++;
  }

  return written;
}

function upsertSqlite(db: SqliteAdapter, table: string, rows: Row[]): number {
  const sqliteColumns = getSqliteColumns(db, table);
  const keyColumns = TABLE_KEYS[table] ?? ["id"];
  let written = 0;

  for (const rawRow of rows) {
    const row = toSqliteRow(table, rawRow);
    const columns = Object.keys(row).filter((column) => sqliteColumns.has(column));
    if (keyColumns.some((column) => !columns.includes(column))) continue;

    const updateColumns = columns.filter((column) => !keyColumns.includes(column) && !(table === "sessions" && column === "id"));
    const updateClause = updateColumns.length > 0
      ? `DO UPDATE SET ${updateColumns.map((column) => `${quoteId(column)} = excluded.${quoteId(column)}`).join(", ")}`
      : "DO NOTHING";

    db.prepare(
      `INSERT INTO ${quoteId(table)} (${columns.map(quoteId).join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})
       ON CONFLICT(${keyColumns.map(quoteId).join(", ")}) ${updateClause}`
    ).run(...(columns.map((column) => row[column]) as any[]));
    written++;
  }

  return written;
}

export async function getStoragePg(): Promise<PgAdapterAsync> {
  return new PgAdapterAsync(getStorageConnectionString("sessions"));
}

export async function runStorageMigrations(remote: RemoteAdapter): Promise<void> {
  for (const migration of PG_MIGRATIONS) {
    await remote.exec(migration);
  }
}

export function getStorageStatus(db: SqliteAdapter = getDatabase()): StorageStatus {
  const config = getStorageConfig();
  return {
    mode: config.mode,
    enabled: config.mode === "hybrid" || config.mode === "remote",
    db_path: getSessionsDbPath(),
    tables: STORAGE_TABLES.map((table) => {
      try {
        const row = db.prepare(`SELECT COUNT(*) as count FROM ${quoteId(table)}`).get() as { count: number };
        return { table, rows: row.count };
      } catch {
        return { table, rows: 0 };
      }
    }),
  };
}

export async function pushStorageChangesToRemote(
  remote: RemoteAdapter,
  tables: string[] = [...STORAGE_TABLES],
  db: SqliteAdapter = getDatabase()
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  const sessionIdMap = new Map<string, string>();

  await runStorageMigrations(remote);
  for (const table of tables) {
    const result: SyncResult = { table, direction: "push", rowsRead: 0, rowsWritten: 0, errors: [] };
    try {
      const stmt = db.prepare(`SELECT * FROM ${quoteId(table)} ${orderByClause(table)} LIMIT ? OFFSET ?`);
      for (let offset = 0; ; offset += SYNC_BATCH_SIZE) {
        const rows = stmt.all(SYNC_BATCH_SIZE, offset) as Row[];
        if (rows.length === 0) break;
        const preparedRows = table === "sessions"
          ? await prepareSessionRowsForPg(remote, rows, sessionIdMap)
          : rewriteSessionReferences(table, rows, sessionIdMap);
        result.rowsRead += rows.length;
        result.rowsWritten += await upsertPg(remote, table, preparedRows);
        if (rows.length < SYNC_BATCH_SIZE) break;
      }
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
    results.push(result);
  }

  return results;
}

export async function pushStorageChanges(tables: string[] = [...STORAGE_TABLES]): Promise<SyncResult[]> {
  const remote = await getStoragePg();
  try {
    return await pushStorageChangesToRemote(remote, tables);
  } finally {
    await remote.close();
  }
}

export async function pullStorageChangesFromRemote(
  remote: RemoteAdapter,
  tables: string[] = [...STORAGE_TABLES],
  db: SqliteAdapter = getDatabase()
): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  const sessionIdMap = new Map<string, string>();
  let ftsDirty = false;

  await runStorageMigrations(remote);
  for (const table of tables) {
    const result: SyncResult = { table, direction: "pull", rowsRead: 0, rowsWritten: 0, errors: [] };
    try {
      for (let offset = 0; ; offset += SYNC_BATCH_SIZE) {
        const rows = await remote.all(
          `SELECT * FROM ${quoteId(table)} ${orderByClause(table)} LIMIT ? OFFSET ?`,
          SYNC_BATCH_SIZE,
          offset
        ) as Row[];
        if (rows.length === 0) break;
        const preparedRows = table === "sessions"
          ? prepareSessionRowsForSqlite(db, rows, sessionIdMap)
          : rewriteSessionReferences(table, rows, sessionIdMap);
        result.rowsRead += rows.length;
        result.rowsWritten += upsertSqlite(db, table, preparedRows);
        if (result.rowsWritten > 0 && (table === "sessions" || table === "messages" || table === "tool_calls")) {
          ftsDirty = true;
        }
        if (rows.length < SYNC_BATCH_SIZE) break;
      }
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }
    results.push(result);
  }

  if (ftsDirty) rebuildFtsTables(db);
  return results;
}

export async function pullStorageChanges(tables: string[] = [...STORAGE_TABLES]): Promise<SyncResult[]> {
  const remote = await getStoragePg();
  try {
    return await pullStorageChangesFromRemote(remote, tables);
  } finally {
    await remote.close();
  }
}

export async function syncStorageChanges(tables: string[] = [...STORAGE_TABLES]): Promise<{ push: SyncResult[]; pull: SyncResult[] }> {
  return {
    push: await pushStorageChanges(tables),
    pull: await pullStorageChanges(tables),
  };
}

export function parseStorageTables(raw?: string): string[] {
  if (!raw) return [...STORAGE_TABLES];
  const requested = raw.split(",").map((table) => table.trim()).filter(Boolean);
  return requested.length > 0 ? requested : [...STORAGE_TABLES];
}
