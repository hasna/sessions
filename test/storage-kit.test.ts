import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KIT_VERSION,
  checkHealth,
  checkReady,
  checksumSql,
  createCloudPoolFromEnv,
  createMigrationLedger,
  createPgPool,
  createQueryClient,
  defineMigration,
  envToken,
  MigrationLedger,
  normalizeStorageMode,
  resolveDatabaseUrl,
  resolveStorageMode,
  resolveTlsConfig,
  sslModeFromConnectionString,
  storageEnvKeys,
  wrapExecutor,
} from "../src/generated/storage-kit/index.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("generated storage kit mode and TLS helpers", () => {
  it("exports its version and normalizes canonical, deprecated, and invalid modes", () => {
    expect(KIT_VERSION).toBe("0.5.2");
    expect(normalizeStorageMode(" LOCAL ")).toEqual({ mode: "local", deprecatedAlias: null });
    expect(normalizeStorageMode("CLOUD")).toEqual({ mode: "cloud", deprecatedAlias: null });
    expect(normalizeStorageMode("self-hosted")).toEqual({ mode: "cloud", deprecatedAlias: "self_hosted" });
    expect(normalizeStorageMode("remote")).toEqual({ mode: "cloud", deprecatedAlias: "remote" });
    expect(normalizeStorageMode("hybrid")).toEqual({ mode: "cloud", deprecatedAlias: "hybrid" });
    expect(() => normalizeStorageMode("disk")).toThrow("Unknown storage mode");
  });

  it("builds env keys and resolves default, canonical, alias, warning, and URL precedence", () => {
    expect(envToken("open-sessions")).toBe("OPEN_SESSIONS");
    expect(storageEnvKeys("open-sessions")).toEqual({
      modeKeys: ["HASNA_OPEN_SESSIONS_STORAGE_MODE", "OPEN_SESSIONS_STORAGE_MODE"],
      databaseUrlKeys: ["HASNA_OPEN_SESSIONS_DATABASE_URL", "OPEN_SESSIONS_DATABASE_URL"],
    });
    expect(resolveStorageMode("sessions", {})).toEqual({
      mode: "local",
      source: "default",
      deprecatedAlias: null,
      databaseUrlPresent: false,
      databaseUrlSource: null,
      warning: null,
    });

    const alias = resolveStorageMode("sessions", {
      SESSIONS_STORAGE_MODE: " self-hosted ",
      SESSIONS_DATABASE_URL: " postgres://alias ",
    });
    expect(alias.mode).toBe("cloud");
    expect(alias.source).toBe("SESSIONS_STORAGE_MODE");
    expect(alias.databaseUrlSource).toBe("SESSIONS_DATABASE_URL");
    expect(alias.warning).toContain("Deprecated storage mode");
    expect(alias.warning).toContain("Using alias env");

    const missingUrl = resolveStorageMode("sessions", { HASNA_SESSIONS_STORAGE_MODE: "cloud" });
    expect(missingUrl.warning).toContain("cloud mode needs HASNA_SESSIONS_DATABASE_URL");

    const canonical = {
      HASNA_SESSIONS_STORAGE_MODE: "cloud",
      SESSIONS_STORAGE_MODE: "local",
      HASNA_SESSIONS_DATABASE_URL: " postgres://canonical ",
      SESSIONS_DATABASE_URL: "postgres://alias",
    };
    expect(resolveStorageMode("sessions", canonical).warning).toBeNull();
    expect(resolveDatabaseUrl("sessions", canonical)).toBe("postgres://canonical");
    expect(resolveDatabaseUrl("sessions", { SESSIONS_DATABASE_URL: " postgres://alias " })).toBe("postgres://alias");
    expect(resolveDatabaseUrl("sessions", {})).toBeNull();
  });

  it("parses every supported ssl mode and rejects unknown modes", () => {
    expect(sslModeFromConnectionString("postgres://db/local")).toBe("disable");
    expect(sslModeFromConnectionString("postgres://db/x?sslmode=disable")).toBe("disable");
    expect(sslModeFromConnectionString("postgres://db/x?sslmode=prefer")).toBe("prefer");
    expect(sslModeFromConnectionString("postgres://db/x?sslmode=allow")).toBe("prefer");
    expect(sslModeFromConnectionString("postgres://db/x?sslmode=require")).toBe("require");
    expect(sslModeFromConnectionString("postgres://db/x?sslmode=verify-ca")).toBe("verify-ca");
    expect(sslModeFromConnectionString("postgres://db/x?sslmode=VERIFY-FULL")).toBe("verify-full");
    for (const value of ["1", "true", "yes", "on", "require"]) {
      expect(sslModeFromConnectionString(`postgres://db/x?ssl=${value}`)).toBe("require");
    }
    expect(sslModeFromConnectionString("postgres://db/x?ssl=false")).toBe("disable");
    expect(() => sslModeFromConnectionString("postgres://db/x?sslmode=bogus")).toThrow("Unknown sslmode");
  });

  it("resolves disabled, relaxed, and verified TLS using every CA source", () => {
    expect(resolveTlsConfig("postgres://db/x")).toBeUndefined();
    expect(resolveTlsConfig("postgres://db/x?sslmode=prefer")).toBeUndefined();
    expect(resolveTlsConfig("postgres://db/x?sslmode=require", { env: {} })).toEqual({ rejectUnauthorized: false });
    expect(resolveTlsConfig("postgres://db/x?sslmode=require", { ca: " INLINE " })).toEqual({
      rejectUnauthorized: false,
      ca: " INLINE ",
    });

    const root = mkdtempSync(join(tmpdir(), "sessions-storage-kit-"));
    tempRoots.push(root);
    const caPath = join(root, "ca.pem");
    writeFileSync(caPath, "FILE-CA");
    expect(resolveTlsConfig("postgres://db/x?sslmode=verify-ca", { caCertPath: caPath, env: {} })).toEqual({
      rejectUnauthorized: true,
      ca: "FILE-CA",
    });
    expect(resolveTlsConfig("postgres://db/x?sslmode=verify-full", { env: { PGSSLROOTCERT: caPath } })).toEqual({
      rejectUnauthorized: true,
      ca: "FILE-CA",
    });
    expect(resolveTlsConfig("postgres://db/x?sslmode=verify-full", { env: { NODE_EXTRA_CA_CERTS: caPath } })).toEqual({
      rejectUnauthorized: true,
      ca: "FILE-CA",
    });
    expect(() => resolveTlsConfig("postgres://db/x?sslmode=verify-full", { env: {} })).toThrow("requires a CA bundle");
  });
});

describe("generated typed query client", () => {
  it("implements query, many, get, one, and execute semantics", async () => {
    const calls: Array<[string, readonly unknown[] | undefined]> = [];
    const executor = {
      async query(sql: string, params?: readonly unknown[]) {
        calls.push([sql, params]);
        if (sql === "empty") return { rows: [], rowCount: null };
        if (sql === "many") return { rows: [{ id: 1 }, { id: 2 }], rowCount: 2 };
        return { rows: [{ id: 1 }], rowCount: null };
      },
    };
    const client = wrapExecutor(executor);
    expect(await client.query<{ id: number }>("row", [1])).toEqual({ rows: [{ id: 1 }], rowCount: 1 });
    expect(await client.many<{ id: number }>("many")).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await client.get<{ id: number }>("row")).toEqual({ id: 1 });
    expect(await client.get("empty")).toBeNull();
    expect(await client.one<{ id: number }>("row")).toEqual({ id: 1 });
    await expect(client.one("empty")).rejects.toThrow("got 0");
    await expect(client.one("many")).rejects.toThrow("got 2");
    await client.execute("write", [2]);
    expect(calls).toContainEqual(["write", [2]]);
  });

  it("commits successful transactions, rolls back failures, releases clients, and closes pools", async () => {
    const statements: string[] = [];
    let released = 0;
    let ended = 0;
    const transactionClient = {
      async query(sql: string) {
        statements.push(sql);
        return { rows: [{ value: 7 }], rowCount: 1 };
      },
      release() {
        released++;
      },
    };
    const pool = {
      async query() { return { rows: [], rowCount: 0 }; },
      async connect() { return transactionClient; },
      async end() { ended++; },
    };
    const client = createQueryClient(pool as any);
    expect(client.pool).toBe(pool as any);
    expect(await client.transaction(async (tx) => (await tx.one<{ value: number }>("SELECT" )).value)).toBe(7);
    expect(statements).toEqual(["BEGIN", "SELECT", "COMMIT"]);
    expect(released).toBe(1);

    statements.length = 0;
    await expect(client.transaction(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(statements).toEqual(["BEGIN", "ROLLBACK"]);
    expect(released).toBe(2);

    transactionClient.query = async (sql: string) => {
      statements.push(sql);
      if (sql === "ROLLBACK") throw new Error("rollback failed");
      return { rows: [], rowCount: 0 };
    };
    await expect(client.transaction(async () => { throw new Error("original"); })).rejects.toThrow("original");
    expect(released).toBe(3);
    await client.close();
    expect(ended).toBe(1);
  });
});

function migrationClient(initial: Array<{ id: string; checksum: string; applied_at: string | Date }> = []) {
  const rows = [...initial];
  const executed: Array<{ sql: string; params?: readonly unknown[] }> = [];
  return {
    rows,
    executed,
    async query() { return { rows: [], rowCount: 0 }; },
    async many() { return rows; },
    async get() { return null; },
    async one() { throw new Error("unused"); },
    async execute(sql: string, params?: readonly unknown[]) {
      executed.push({ sql, params });
      if (sql.includes("INSERT INTO")) {
        rows.push({ id: String(params?.[0]), checksum: String(params?.[1]), applied_at: "2026-01-01T00:00:00Z" });
      }
    },
  };
}

describe("generated migration ledger and health probes", () => {
  it("normalizes checksums, freezes migrations, and rejects duplicate ids", () => {
    expect(checksumSql(" SELECT 1\r\n ")).toBe(checksumSql("SELECT 1\n"));
    const migration = defineMigration("0001", "  SELECT 1;  ");
    expect(migration.sql).toBe("SELECT 1;");
    expect(Object.isFrozen(migration)).toBe(true);
    expect(() => new MigrationLedger(migrationClient() as any, [migration, migration])).toThrow("Duplicate migration id");
  });

  it("lists, plans, dry-runs, applies, and skips already-applied migrations", async () => {
    const one = defineMigration("0001", "SELECT 1");
    const two = defineMigration("0002", "SELECT 2");
    const client = migrationClient([{ id: one.id, checksum: one.checksum, applied_at: new Date("2025-01-01T00:00:00Z") }]);
    const ledger = createMigrationLedger(client as any, [one, two], { ledgerTable: "custom_ledger" });
    expect(await ledger.listApplied()).toEqual([{ id: "0001", checksum: one.checksum, appliedAt: "2025-01-01T00:00:00.000Z" }]);
    const dry = await ledger.migrate({ dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.plan.map((item) => item.state)).toEqual(["already_applied", "pending"]);
    expect(client.executed.some((entry) => entry.sql.includes("custom_ledger"))).toBe(true);

    client.executed.length = 0;
    const result = await ledger.migrate();
    expect(result.dryRun).toBe(false);
    expect(result.applied.map((row) => row.id)).toEqual(["0001", "0002"]);
    expect(client.executed.some((entry) => entry.sql === "SELECT 2")).toBe(true);
    expect(client.executed.some((entry) => entry.sql === "SELECT 1")).toBe(false);
  });

  it("guards against unknown applied migrations and checksum drift", async () => {
    const migration = defineMigration("0001", "SELECT 1");
    await expect(new MigrationLedger(migrationClient([{ id: "9999", checksum: "x", applied_at: "now" }]) as any, [migration]).migrate({ dryRun: true }))
      .rejects.toThrow("not recognized");
    await expect(new MigrationLedger(migrationClient([{ id: "0001", checksum: "wrong", applied_at: "now" }]) as any, [migration]).migrate({ dryRun: true }))
      .rejects.toThrow("checksum mismatch");
  });

  it("reports health success and Error/non-Error failures", async () => {
    expect((await checkHealth({ get: async () => ({ ok: 1 }) } as any)).ok).toBe(true);
    expect(await checkHealth({ get: async () => { throw new Error("offline"); } } as any)).toMatchObject({ ok: false, error: "offline" });
    expect(await checkHealth({ get: async () => { throw "down"; } } as any)).toMatchObject({ ok: false, error: "down" });
  });

  it("reports readiness for current, pending, and failed ledgers", async () => {
    const migration = defineMigration("0001", "SELECT 1");
    expect(await checkReady(migrationClient([{ id: migration.id, checksum: migration.checksum, applied_at: "now" }]) as any, [migration]))
      .toMatchObject({ ok: true, pendingMigrations: [] });
    expect(await checkReady(migrationClient() as any, [migration]))
      .toMatchObject({ ok: false, pendingMigrations: ["0001"] });
    expect(await checkReady({ execute: async () => { throw "no database"; } } as any, [migration]))
      .toMatchObject({ ok: false, pendingMigrations: [], error: "no database" });
    expect(await checkReady({ execute: async () => { throw new Error("bad database"); } } as any, [migration]))
      .toMatchObject({ ok: false, pendingMigrations: [], error: "bad database" });
  });
});

describe("generated pool factory", () => {
  it("builds pg pools with optional configuration", async () => {
    const pool = createPgPool({
      connectionString: "postgres://user:pass@localhost/db?sslmode=require",
      ca: "CA",
      env: {},
      max: 3,
      idleTimeoutMillis: 40,
      connectionTimeoutMillis: 50,
      applicationName: "sessions-test",
    });
    expect((pool as any).options).toMatchObject({
      max: 3,
      idleTimeoutMillis: 40,
      connectionTimeoutMillis: 50,
      application_name: "sessions-test",
      ssl: { rejectUnauthorized: false, ca: "CA" },
    });
    await pool.end();

    const minimal = createPgPool({ connectionString: "postgres://localhost/db", env: {} });
    expect((minimal as any).options.ssl).toBeUndefined();
    await minimal.end();
  });

  it("validates cloud env configuration and returns a closable query client", async () => {
    expect(() => createCloudPoolFromEnv("open-sessions", { env: {} })).toThrow("requires open-sessions storage mode 'cloud'");
    expect(() => createCloudPoolFromEnv("open-sessions", {
      env: { HASNA_OPEN_SESSIONS_STORAGE_MODE: "cloud" },
    })).toThrow("needs a database URL");

    const result = createCloudPoolFromEnv("open-sessions", {
      env: {
        OPEN_SESSIONS_STORAGE_MODE: "cloud",
        OPEN_SESSIONS_DATABASE_URL: "postgres://localhost/db",
      },
      max: 2,
      idleTimeoutMillis: 10,
      connectionTimeoutMillis: 20,
      applicationName: "kit-test",
    });
    expect(result.connectionSource).toBe("OPEN_SESSIONS_DATABASE_URL");
    expect((result.client.pool as any).options).toMatchObject({ max: 2, application_name: "kit-test" });
    await result.client.close();
  });
});
