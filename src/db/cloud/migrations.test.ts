import { describe, expect, test } from "bun:test";
import type { QueryResultRow } from "pg";
import { MigrationLedger, type AppliedMigration, type TypedQueryClient } from "../../generated/storage-kit/index.js";
import { loadMigrations } from "./migrations.js";

const APPROVED_BASE_0001_CHECKSUM = "sha256:05b4985082a384ac34d50ea7c3ca7f02063f57a8f8754539747517dc55a5ae24";

function applied(row: { id: string; checksum: string }): AppliedMigration {
  return {
    id: row.id,
    checksum: row.checksum,
    appliedAt: "2026-07-17T00:00:00.000Z",
  };
}

describe("cloud migration ledger", () => {
  test("accepts an existing base 0001 checksum and plans 0004 without rewriting applied migrations", async () => {
    const migrations = loadMigrations();
    const initial = migrations.find((migration) => migration.id === "0001_init");
    const codewith = migrations.find((migration) => migration.id === "0004_codewith_session_source");
    const sourceIdIndex = migrations.find((migration) => migration.id === "0005_session_source_id_lookup_index");
    expect(initial).toBeDefined();
    expect(codewith).toBeDefined();
    expect(sourceIdIndex).toBeDefined();
    expect(initial?.sql).toMatch(/CHECK\s*\(source IN \('claude', 'codex', 'gemini'\)\)/);
    expect(initial?.sql).not.toContain("codewith");
    expect(initial?.checksum).toBe(APPROVED_BASE_0001_CHECKSUM);
    expect(codewith?.sql).toContain("codewith");
    expect(sourceIdIndex?.sql).toContain("idx_sessions_source_id");

    const alreadyApplied = migrations
      .filter(
        (migration) =>
          migration.id !== "0004_codewith_session_source" &&
          migration.id !== "0005_session_source_id_lookup_index",
      )
      .map((migration) =>
        applied({
          ...migration,
          checksum: migration.id === "0001_init" ? APPROVED_BASE_0001_CHECKSUM : migration.checksum,
        }),
      );
    let migrationWrites = 0;
    const client: TypedQueryClient = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async many<T extends QueryResultRow>(sql: string): Promise<T[]> {
        if (sql.includes("SELECT id, checksum, applied_at FROM schema_migrations")) {
          return alreadyApplied.map((row) => ({
            id: row.id,
            checksum: row.checksum,
            applied_at: row.appliedAt,
          })) as T[];
        }
        throw new Error(`unexpected many SQL: ${sql}`);
      },
      async get() {
        throw new Error("get() not used in this test");
      },
      async one() {
        throw new Error("one() not used in this test");
      },
      async execute(sql: string): Promise<void> {
        if (sql.includes("CREATE TABLE IF NOT EXISTS schema_migrations")) return;
        migrationWrites++;
      },
    };

    const result = await new MigrationLedger(client, migrations).migrate({ dryRun: true });

    expect(migrationWrites).toBe(0);
    expect(result.plan.map((item) => [item.migration.id, item.state])).toEqual([
      ["0001_init", "already_applied"],
      ["0002_api_keys", "already_applied"],
      ["0003_session_token_bigints", "already_applied"],
      ["0004_codewith_session_source", "pending"],
      ["0005_session_source_id_lookup_index", "pending"],
    ]);
  });
});
