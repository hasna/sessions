import type { StorageConfig } from "./storage-config.js";
import { getStorageDatabaseUrl } from "./storage-config.js";
import type { SqliteAdapter } from "./sqlite-adapter.js";

type RemoteIndexAdapter = {
  run(sql: string, ...params: unknown[]): Promise<{ changes: number }>;
};

type SessionIndexRow = {
  session_id: string;
  source: string;
  source_id: string;
  title: string | null;
  project_path: string | null;
  project_name: string | null;
  started_at: string | null;
  ended_at: string | null;
  machine: string | null;
  updated_at: string | null;
  searchable_text: string;
};

export const REMOTE_SESSION_INDEX_TABLE = "session_index_documents";

export interface IndexAdapterStatus {
  id: string;
  kind: "local-sqlite" | "remote-postgres" | "remote-object-storage";
  enabled: boolean;
  writable: boolean;
  role: string;
  stores: string[];
  privacy_boundary: string;
}

export interface RemoteSessionIndexResult {
  table: typeof REMOTE_SESSION_INDEX_TABLE;
  rowsRead: number;
  rowsWritten: number;
}

function hasRemoteDatabaseConfig(config: StorageConfig): boolean {
  return Boolean(getStorageDatabaseUrl() || (config.rds.host && config.rds.username));
}

export function getIndexAdapterStatus(config: StorageConfig): IndexAdapterStatus[] {
  const pgConfigured = hasRemoteDatabaseConfig(config);
  const objectStorage = config.object_storage;
  const objectConfigured = objectStorage.provider === "s3" && Boolean(objectStorage.bucket);

  return [
    {
      id: "local-sqlite-fts",
      kind: "local-sqlite",
      enabled: true,
      writable: true,
      role: "Primary capture and search index",
      stores: ["local SQLite tables", "local FTS5 virtual tables", "local agent transcript files"],
      privacy_boundary: "Transcript content stays on this machine unless an explicit remote payload opt-in is configured.",
    },
    {
      id: "remote-postgres-index",
      kind: "remote-postgres",
      enabled: config.mode === "hybrid" || config.mode === "remote" || pgConfigured,
      writable: pgConfigured,
      role: "Optional searchable metadata index and table mirror",
      stores: ["session_index_documents", "metadata sync tables", "opt-in payload sync tables"],
      privacy_boundary: "Metadata index rows are written by default; transcript, tool, embedding, and feedback payload tables are gated.",
    },
    {
      id: "remote-s3-object-index",
      kind: "remote-object-storage",
      enabled: objectConfigured,
      writable: false,
      role: "Reserved descriptor for future approved S3/AWS index object storage",
      stores: objectConfigured
        ? [`s3://${objectStorage.bucket}/${objectStorage.prefix}`]
        : ["not configured"],
      privacy_boundary: "This package does not upload objects to S3/AWS; future object writes require a separate approved implementation.",
    },
  ];
}

function searchableText(row: SessionIndexRow): string {
  return [
    row.title,
    row.project_name,
    row.project_path,
    row.source,
    row.machine,
  ].filter(Boolean).join("\n");
}

export async function pushRemoteSessionIndexFromSqlite(
  remote: RemoteIndexAdapter,
  db: SqliteAdapter,
  sessionIdMap: Map<string, string> = new Map()
): Promise<RemoteSessionIndexResult> {
  const rows = db.prepare(
    `SELECT id AS session_id, source, source_id, title, project_path, project_name,
            started_at, ended_at, machine, updated_at
     FROM sessions
     ORDER BY source, source_id`
  ).all() as SessionIndexRow[];

  let rowsWritten = 0;
  for (const row of rows) {
    const remoteSessionId = sessionIdMap.get(row.session_id) ?? row.session_id;
    const result = await remote.run(
      `INSERT INTO ${REMOTE_SESSION_INDEX_TABLE}
       (session_id, source, source_id, title, project_path, project_name, started_at, ended_at,
        machine, updated_at, searchable_text, content_redacted, privacy_policy, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, 'metadata_only', NOW()::text)
       ON CONFLICT (source, source_id) DO UPDATE SET
         session_id = EXCLUDED.session_id,
         source = EXCLUDED.source,
         source_id = EXCLUDED.source_id,
         title = EXCLUDED.title,
         project_path = EXCLUDED.project_path,
         project_name = EXCLUDED.project_name,
         started_at = EXCLUDED.started_at,
         ended_at = EXCLUDED.ended_at,
         machine = EXCLUDED.machine,
         updated_at = EXCLUDED.updated_at,
         searchable_text = EXCLUDED.searchable_text,
         content_redacted = TRUE,
         privacy_policy = 'metadata_only',
         indexed_at = NOW()::text`,
      remoteSessionId,
      row.source,
      row.source_id,
      row.title,
      row.project_path,
      row.project_name,
      row.started_at,
      row.ended_at,
      row.machine,
      row.updated_at,
      searchableText(row)
    );
    rowsWritten += result.changes;
  }

  return {
    table: REMOTE_SESSION_INDEX_TABLE,
    rowsRead: rows.length,
    rowsWritten,
  };
}
