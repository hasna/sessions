import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_NAME, closeCloudClient, getCloudClient, isCloudMode } from "../src/db/cloud/client.js";
import { checkCloudReady, runCloudMigrations } from "../src/db/cloud/migrate.js";
import { loadMigrations, resolveMigrationsDir } from "../src/db/cloud/migrations.js";

const originalEnv = {
  mode: process.env.HASNA_SESSIONS_STORAGE_MODE,
  url: process.env.HASNA_SESSIONS_DATABASE_URL,
  migrations: process.env.SESSIONS_MIGRATIONS_DIR,
};
const roots: string[] = [];

afterEach(async () => {
  await closeCloudClient();
  if (originalEnv.mode === undefined) delete process.env.HASNA_SESSIONS_STORAGE_MODE;
  else process.env.HASNA_SESSIONS_STORAGE_MODE = originalEnv.mode;
  if (originalEnv.url === undefined) delete process.env.HASNA_SESSIONS_DATABASE_URL;
  else process.env.HASNA_SESSIONS_DATABASE_URL = originalEnv.url;
  if (originalEnv.migrations === undefined) delete process.env.SESSIONS_MIGRATIONS_DIR;
  else process.env.SESSIONS_MIGRATIONS_DIR = originalEnv.migrations;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("cloud client lifecycle", () => {
  it("detects mode and lazily caches and closes the configured pool", async () => {
    expect(APP_NAME).toBe("sessions");
    expect(isCloudMode({})).toBe(false);
    expect(isCloudMode({ HASNA_SESSIONS_STORAGE_MODE: "self_hosted" })).toBe(true);

    process.env.HASNA_SESSIONS_STORAGE_MODE = "cloud";
    process.env.HASNA_SESSIONS_DATABASE_URL = "postgres://localhost/sessions";
    const first = getCloudClient();
    expect(getCloudClient()).toBe(first);
    expect((first.pool as any).options).toMatchObject({ max: 5, application_name: "sessions-serve" });
    await closeCloudClient();
    await closeCloudClient();
    const second = getCloudClient();
    expect(second).not.toBe(first);
  });

  it("fails closed when cloud client configuration is absent", () => {
    delete process.env.HASNA_SESSIONS_STORAGE_MODE;
    delete process.env.HASNA_SESSIONS_DATABASE_URL;
    expect(() => getCloudClient()).toThrow("requires sessions storage mode 'cloud'");
  });
});

function ledgerClient(appliedIds: string[] = []) {
  const migrations = loadMigrations();
  const checksumById = new Map(migrations.map((migration) => [migration.id, migration.checksum]));
  const rows = appliedIds.map((id) => ({ id, checksum: checksumById.get(id)!, applied_at: "2026-01-01T00:00:00Z" }));
  const statements: string[] = [];
  const client = {
    pool: {} as any,
    statements,
    async query() { return { rows: [], rowCount: 0 }; },
    async get() { return { ok: 1 }; },
    async many() { return rows; },
    async one() { throw new Error("unused"); },
    async execute(sql: string, params?: readonly unknown[]) {
      statements.push(sql);
      if (sql.includes("INSERT INTO schema_migrations")) {
        rows.push({ id: String(params?.[0]), checksum: String(params?.[1]), applied_at: "2026-01-01T00:00:00Z" });
      }
    },
    async transaction<T>(fn: (client: any) => Promise<T>) { return fn(client); },
    async close() {},
  };
  return client;
}

describe("cloud migration runtime", () => {
  it("loads ordered checksummed migrations from an explicit directory", () => {
    const root = mkdtempSync(join(tmpdir(), "sessions-migrations-"));
    roots.push(root);
    writeFileSync(join(root, "0001_init.sql"), "SELECT 1;");
    writeFileSync(join(root, "0002_more.sql"), "SELECT 2;");
    writeFileSync(join(root, "README.md"), "ignored");
    process.env.SESSIONS_MIGRATIONS_DIR = root;
    expect(resolveMigrationsDir()).toBe(root);
    expect(loadMigrations().map((migration) => [migration.id, migration.sql])).toEqual([
      ["0001_init", "SELECT 1;"],
      ["0002_more", "SELECT 2;"],
    ]);
  });

  it("rejects an explicitly selected migration directory with no SQL after resolving its sentinel", () => {
    const root = mkdtempSync(join(tmpdir(), "sessions-migrations-empty-"));
    roots.push(root);
    mkdirSync(join(root, "0001_init.sql"));
    process.env.SESSIONS_MIGRATIONS_DIR = root;
    expect(() => loadMigrations()).toThrow();
  });

  it("reports dry-run plans and applies pending migrations", async () => {
    delete process.env.SESSIONS_MIGRATIONS_DIR;
    const migrations = loadMigrations();
    const client = ledgerClient([migrations[0].id]);
    const dry = await runCloudMigrations({ client: client as any, dryRun: true });
    expect(dry).toEqual({
      dryRun: true,
      applied: [],
      pending: migrations.slice(1).map((migration) => migration.id),
      alreadyApplied: [migrations[0].id],
    });
    const applied = await runCloudMigrations({ client: client as any });
    expect(applied.dryRun).toBe(false);
    expect(applied.applied).toEqual(migrations.slice(1).map((migration) => migration.id));
    expect(applied.pending).toEqual([]);
  });

  it("checks reachability, ledger availability, and pending migration ids", async () => {
    const known = loadMigrations().map((migration) => migration.id);
    const readyClient = ledgerClient(known);
    expect(await checkCloudReady(readyClient as any)).toEqual({ ok: true, pendingMigrations: [] });

    const partial = ledgerClient([known[0]]);
    expect(await checkCloudReady(partial as any)).toEqual({ ok: false, pendingMigrations: known.slice(1) });

    const unreachable = ledgerClient();
    unreachable.get = async () => { throw "offline"; };
    expect(await checkCloudReady(unreachable as any)).toEqual({ ok: false, pendingMigrations: [], error: "offline" });
    unreachable.get = async () => { throw new Error("network down"); };
    expect(await checkCloudReady(unreachable as any)).toEqual({ ok: false, pendingMigrations: [], error: "network down" });

    const missingLedger = ledgerClient();
    missingLedger.many = async () => { throw "missing"; };
    expect(await checkCloudReady(missingLedger as any)).toEqual({
      ok: false,
      pendingMigrations: known,
      error: "schema_migrations unavailable: missing",
    });
    missingLedger.many = async () => { throw new Error("permission denied"); };
    expect((await checkCloudReady(missingLedger as any)).error).toContain("permission denied");
  });
});
