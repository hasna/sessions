import { PgAdapterAsync } from "./remote-storage.js";
import { PG_MIGRATIONS } from "./pg-migrations.js";

export interface PgMigrationResult {
  applied: number[];
  alreadyApplied: number[];
  errors: string[];
  totalMigrations: number;
}

export async function applyPgMigrations(connectionString: string): Promise<PgMigrationResult> {
  const pg = new PgAdapterAsync(connectionString);
  const result: PgMigrationResult = {
    applied: [],
    alreadyApplied: [],
    errors: [],
    totalMigrations: PG_MIGRATIONS.length,
  };

  try {
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS migrations_log (
        id SERIAL PRIMARY KEY,
        version INTEGER NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied = await pg.all("SELECT version FROM migrations_log ORDER BY version") as Array<{ version: number }>;
    const appliedSet = new Set(applied.map((row) => row.version));

    for (let index = 0; index < PG_MIGRATIONS.length; index++) {
      const version = index + 1;
      if (appliedSet.has(version)) {
        result.alreadyApplied.push(version);
        continue;
      }

      try {
        await pg.exec(PG_MIGRATIONS[index]!);
        await pg.run("INSERT INTO migrations_log (version) VALUES ($1) ON CONFLICT DO NOTHING", version);
        result.applied.push(version);
      } catch (error) {
        result.errors.push(`Migration ${version}: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
  } finally {
    await pg.close();
  }

  return result;
}
