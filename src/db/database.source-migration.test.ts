import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSchema } from "./database.js";
import { SqliteAdapter } from "./sqlite-adapter.js";

/**
 * The exact `sessions` DDL carried by stores created before 'codewith' was a
 * source — copied verbatim from the live station01 store (9.16 GB) on
 * 2026-08-03, whose CHECK reads `source IN ('claude', 'codex', 'gemini')`.
 *
 * Opening such a store used to rebuild the whole table on the open path, after
 * first taking a full `VACUUM INTO` copy of it. On a multi-GB store that never
 * finished inside any CLI timeout, so every invocation — including read-only
 * ones like `sessions list --limit 1` — restarted the rebuild from scratch and
 * left another multi-GB backup behind.
 */
const LEGACY_NARROW_SESSIONS_DDL = `CREATE TABLE sessions (
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
    machine TEXT,
    metadata TEXT DEFAULT '{}',
    UNIQUE(source, source_id)
  )`;

const MIGRATION_BACKUP_DIR = "migration-backups";
const OPT_IN_ENV = "HASNA_SESSIONS_MIGRATE_SOURCE_CONSTRAINT";

let dir: string;
let dbPath: string;
let db: SqliteAdapter | null = null;

/** Build a scratch store carrying the legacy narrow CHECK, with a row in it. */
function openLegacyStore(): SqliteAdapter {
  const adapter = new SqliteAdapter(dbPath);
  adapter.exec(LEGACY_NARROW_SESSIONS_DDL);
  adapter.exec(
    `INSERT INTO sessions (id, source, source_id, started_at)
     VALUES ('legacy-1', 'claude', 'src-1', '2026-07-01T00:00:00Z')`,
  );
  return adapter;
}

function sessionsDdl(adapter: SqliteAdapter): string {
  const row = adapter
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
    .get() as { sql?: string | null } | undefined;
  return row?.sql ?? "";
}

function backupFiles(): string[] {
  const backupDir = join(dir, MIGRATION_BACKUP_DIR);
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessions-source-migration-"));
  dbPath = join(dir, "sessions.db");
  delete process.env[OPT_IN_ENV];
});

afterEach(() => {
  db?.close();
  db = null;
  delete process.env[OPT_IN_ENV];
  rmSync(dir, { recursive: true, force: true });
});

describe("sessions.source constraint migration is off the open path", () => {
  test("opening a legacy narrow-constraint store writes NO migration backup", () => {
    db = openLegacyStore();

    // Control: the fixture really does carry the narrow constraint, so this
    // test is exercising the case the defect lives in.
    expect(sessionsDdl(db)).toContain("'claude', 'codex', 'gemini'");
    expect(sessionsDdl(db)).not.toContain("codewith");
    expect(backupFiles()).toEqual([]);

    initSchema(db);

    // The defect: initSchema ran a full VACUUM INTO copy of the store purely
    // because the CHECK was narrow. On the live 9 GB store that never finished.
    expect(backupFiles()).toEqual([]);
  });

  test("opening a legacy narrow-constraint store leaves the table in place", () => {
    db = openLegacyStore();
    initSchema(db);

    // Reads must still work, and the row must be untouched.
    const row = db.prepare("SELECT id, source FROM sessions WHERE id = 'legacy-1'").get() as
      | { id: string; source: string }
      | undefined;
    expect(row).toEqual({ id: "legacy-1", source: "claude" });

    // No half-built replacement table left behind, and the original survives.
    const tables = db
      .prepare(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'sessions_new')",
      )
      .get() as { c: number };
    expect(Number(tables.c)).toBe(1);
  });

  test("the migration still runs, and widens the constraint, when opted in", () => {
    db = openLegacyStore();
    process.env[OPT_IN_ENV] = "1";

    initSchema(db);

    // The feature is deferred, not deleted: opting in must actually migrate.
    expect(sessionsDdl(db)).toContain("codewith");
    const row = db.prepare("SELECT id, source FROM sessions WHERE id = 'legacy-1'").get() as
      | { id: string; source: string }
      | undefined;
    expect(row).toEqual({ id: "legacy-1", source: "claude" });

    // And a codewith row becomes insertable, which is the point of the migration.
    db.exec(
      `INSERT INTO sessions (id, source, source_id, started_at)
       VALUES ('cw-1', 'codewith', 'src-cw', '2026-08-01T00:00:00Z')`,
    );
    const cw = db.prepare("SELECT source FROM sessions WHERE id = 'cw-1'").get() as
      | { source: string }
      | undefined;
    expect(cw).toEqual({ source: "codewith" });
  });

  test("an already-migrated store is untouched whether or not the opt-in is set", () => {
    db = openLegacyStore();
    process.env[OPT_IN_ENV] = "1";
    initSchema(db);
    expect(sessionsDdl(db)).toContain("codewith");
    const backupsAfterMigration = backupFiles().length;

    // Re-opening must be a no-op — no second rebuild, no second backup.
    delete process.env[OPT_IN_ENV];
    initSchema(db);
    expect(sessionsDdl(db)).toContain("codewith");
    expect(backupFiles().length).toBe(backupsAfterMigration);
  });
});
