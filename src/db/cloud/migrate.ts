// Migration runner for the open-sessions cloud schema.
//
// Applies pending `migrations/*.sql` against the shared RDS using the vendored
// kit's MigrationLedger (per-migration sha256 drift/downgrade guards). Intended
// to run as the one-shot ECS migration task and from `sessions migrate`.

import { MigrationLedger, type PoolQueryClient } from "../../generated/storage-kit/index.js";
import { getCloudClient } from "./client.js";
import { loadMigrations } from "./migrations.js";

export interface MigrateOptions {
  dryRun?: boolean;
  client?: PoolQueryClient;
}

export interface MigrateReport {
  dryRun: boolean;
  applied: string[];
  pending: string[];
  alreadyApplied: string[];
}

/** Apply (or, with dryRun, report) pending cloud migrations. */
export async function runCloudMigrations(options: MigrateOptions = {}): Promise<MigrateReport> {
  const client = options.client ?? getCloudClient();
  const migrations = loadMigrations();
  const ledger = new MigrationLedger(client, migrations);
  const before = await ledger.migrate({ dryRun: true });
  const pendingBefore = before.plan
    .filter((p) => p.state === "pending")
    .map((p) => p.migration.id);
  const alreadyApplied = before.plan
    .filter((p) => p.state === "already_applied")
    .map((p) => p.migration.id);

  if (options.dryRun) {
    return { dryRun: true, applied: [], pending: pendingBefore, alreadyApplied };
  }

  await ledger.migrate({ dryRun: false });
  return { dryRun: false, applied: pendingBefore, pending: [], alreadyApplied };
}

export interface ReadyReport {
  ok: boolean;
  pendingMigrations: string[];
  error?: string;
}

/**
 * Read-only readiness check for the request-path (DML-only) app role: proves the
 * DB is reachable and every known migration id is present in schema_migrations,
 * WITHOUT any DDL (the app role cannot create the ledger). Never creates tables.
 */
export async function checkCloudReady(
  client: PoolQueryClient = getCloudClient(),
): Promise<ReadyReport> {
  try {
    await client.get<{ ok: number }>("SELECT 1 AS ok");
  } catch (error) {
    return {
      ok: false,
      pendingMigrations: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const known = loadMigrations().map((m) => m.id);
  let applied: string[] = [];
  try {
    const rows = await client.many<{ id: string }>("SELECT id FROM schema_migrations");
    applied = rows.map((r) => r.id);
  } catch (error) {
    return {
      ok: false,
      pendingMigrations: known,
      error: `schema_migrations unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const appliedSet = new Set(applied);
  const pending = known.filter((id) => !appliedSet.has(id));
  return { ok: pending.length === 0, pendingMigrations: pending };
}
