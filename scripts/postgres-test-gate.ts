#!/usr/bin/env bun

import { randomUUID } from "crypto";
import { createPgPool } from "../src/generated/storage-kit/pool.js";
import { createQueryClient } from "../src/generated/storage-kit/query.js";
import { runCloudMigrations, checkCloudReady } from "../src/db/cloud/migrate.js";
import { deleteSession, getSession, upsertSession } from "../src/db/cloud/store.js";

const databaseUrl =
  process.env.HASNA_SESSIONS_PG_TEST_URL ??
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "A live PostgreSQL URL is required in HASNA_SESSIONS_PG_TEST_URL, TEST_DATABASE_URL, or DATABASE_URL.",
  );
}

const schema = `sessions_contract_${randomUUID().replaceAll("-", "")}`;
const sourceId = `postgres-gate-${randomUUID()}`;
const admin = createQueryClient(createPgPool({
  connectionString: databaseUrl,
  max: 1,
  applicationName: "sessions-contract-admin",
}));

function withSearchPath(connectionString: string, searchPath: string): string {
  const url = new URL(connectionString);
  const existing = url.searchParams.get("options");
  const option = `-c search_path=${searchPath}`;
  url.searchParams.set("options", existing ? `${existing} ${option}` : option);
  return url.toString();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PostgreSQL conformance gate failed: ${message}`);
}

let client: ReturnType<typeof createQueryClient> | null = null;
try {
  await admin.execute(`CREATE SCHEMA ${schema}`);
  client = createQueryClient(createPgPool({
    connectionString: withSearchPath(databaseUrl, schema),
    max: 2,
    applicationName: "sessions-contract-gate",
  }));

  const migration = await runCloudMigrations({ client });
  assert(migration.pending.length === 0, "migrations remain pending");
  assert(migration.applied.length > 0, "fresh schema did not apply migrations");

  const ready = await checkCloudReady(client);
  assert(ready.ok, ready.error ?? `pending migrations: ${ready.pendingMigrations.join(", ")}`);

  const created = await upsertSession({
    source: "codewith",
    source_id: sourceId,
    title: "PostgreSQL conformance gate",
    project_name: "contracts",
    metadata: { gate: "postgres" },
  }, client);
  const fetched = await getSession(created.id, client);
  assert(fetched?.source_id === sourceId, "created session was not read back");
  assert(fetched.metadata.gate === "postgres", "JSON metadata did not round-trip");
  assert(await deleteSession(created.id, client), "created session was not deleted");
  assert(await getSession(created.id, client) === null, "deleted session remained readable");

  console.log(JSON.stringify({
    ok: true,
    engine: "postgres",
    migrations: migration.applied.length,
    crud: "create/read/delete",
  }));
} finally {
  try {
    await client?.close();
  } finally {
    try {
      await admin.execute(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await admin.close();
    }
  }
}
