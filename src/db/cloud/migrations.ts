// Migration loader for open-sessions cloud schema.
//
// Reads the ordered `migrations/*.sql` files from the repo's migrations
// directory and turns them into checksummed `Migration` objects for the
// vendored kit's MigrationLedger. The directory is resolved robustly so it
// works from source (bun run), the bundled dist, and the Docker image.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineMigration, type Migration } from "../../generated/storage-kit/index.js";

function moduleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

/** Resolve the on-disk `migrations/` directory across all runtime layouts. */
export function resolveMigrationsDir(): string {
  const candidates = [
    process.env.SESSIONS_MIGRATIONS_DIR,
    join(process.cwd(), "migrations"),
    // src/db/cloud -> repo root
    resolve(moduleDir(), "../../../migrations"),
    // dist/... -> repo root
    resolve(moduleDir(), "../../migrations"),
    resolve(moduleDir(), "../migrations"),
    "/app/migrations",
  ].filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "0001_init.sql"))) return candidate;
  }
  throw new Error(
    `Could not locate the migrations directory. Looked in: ${candidates.join(", ")}`,
  );
}

/** Load all migrations in id order, checksummed for the ledger. */
export function loadMigrations(): Migration[] {
  const dir = resolveMigrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (files.length === 0) throw new Error(`No .sql migrations found in ${dir}`);
  return files.map((file) => {
    const id = file.replace(/\.sql$/, "");
    const sql = readFileSync(join(dir, file), "utf8");
    return defineMigration(id, sql);
  });
}
