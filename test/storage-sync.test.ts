import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "../src/db/database.js";
import {
  SESSIONS_STORAGE_FALLBACK_ENV,
  getStorageConfig,
  getStorageConnectionString,
  getStorageDatabaseEnvName,
  hasStorageDatabaseConfig,
} from "../src/db/storage-config.js";
import { REMOTE_SESSION_INDEX_TABLE } from "../src/db/index-adapters.js";
import { getRemotePayloadTokens, getRemoteTableGate } from "../src/db/storage-policy.js";
import { SESSIONS_STORAGE_TABLES, STORAGE_TABLES, getStorageStatus, pullStorageChangesFromRemote, pushStorageChangesToRemote } from "../src/db/storage-sync.js";
import { saveParsedSession } from "../src/db/sessions.js";
import { search } from "../src/lib/search.js";

const envKeys = [
  "HASNA_SESSIONS_DATABASE_URL",
  "SESSIONS_DATABASE_URL",
  "HASNA_SESSIONS_STORAGE_MODE",
  "SESSIONS_STORAGE_MODE",
  "HASNA_SESSIONS_STORAGE_CONFIG_PATH",
  "HASNA_SESSIONS_REMOTE_PAYLOADS",
  "SESSIONS_REMOTE_PAYLOADS",
] as const;

const savedEnv = new Map<string, string | undefined>();
let savedSessionsDbPath: string | undefined;
let tempRoot: string | null = null;

type Row = Record<string, unknown>;

class MemoryRemote {
  readonly runs: Array<{ sql: string; params: unknown[] }> = [];

  constructor(
    private readonly tables: Record<string, Row[]>,
    private readonly existingSessions: Record<string, string> = {}
  ) {}

  async exec(): Promise<void> {}

  async get(_sql = "", source?: unknown, sourceId?: unknown): Promise<unknown> {
    const id = this.existingSessions[`${String(source)}:${String(sourceId)}`];
    return id ? { id } : null;
  }

  async run(sql = "", ...params: unknown[]): Promise<{ changes: number }> {
    this.runs.push({ sql, params });
    return { changes: 1 };
  }

  async all(sql: string, limit?: unknown, offset?: unknown): Promise<unknown[]> {
    const match = sql.match(/FROM "([^"]+)"/);
    if (!match) return [];
    const rows = this.tables[match[1]] ?? [];
    if (!sql.includes("LIMIT")) return rows;
    return rows.slice(Number(offset ?? 0), Number(offset ?? 0) + Number(limit ?? rows.length));
  }
}

beforeEach(() => {
  savedSessionsDbPath = process.env.SESSIONS_DB_PATH;
  process.env.SESSIONS_DB_PATH = ":memory:";
  resetDatabase();
  savedEnv.clear();
  for (const key of envKeys) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  closeDatabase();
  resetDatabase();
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
  if (savedSessionsDbPath === undefined) delete process.env.SESSIONS_DB_PATH;
  else process.env.SESSIONS_DB_PATH = savedSessionsDbPath;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("sessions storage sync", () => {
  it("reports repo-local session tables", () => {
    const status = getStorageStatus();

    expect(status.db_path).toBe(":memory:");
    expect(status.tables.map((table) => table.table)).toContain("sessions");
    expect(status.tables.find((table) => table.table === "feedback")?.rows).toBe(0);
    expect(status.privacy.default_remote_push).toBe("metadata_only");
    expect(status.privacy.gated_tables.map((table) => table.table)).toContain("messages");
    expect(status.adapters.map((adapter) => adapter.id)).toContain("local-sqlite-fts");
    expect(status.adapters.map((adapter) => adapter.id)).toContain("remote-postgres-index");
  });

  it("canonical storage database env wins over the short fallback", () => {
    process.env.HASNA_SESSIONS_DATABASE_URL = "postgres://new.example/sessions";
    process.env.SESSIONS_DATABASE_URL = "postgres://fallback.example/sessions";

    expect(getStorageConnectionString()).toBe("postgres://new.example/sessions");
    expect(getStorageDatabaseEnvName()).toBe("HASNA_SESSIONS_DATABASE_URL");
    expect(getStorageConfig().mode).toBe("hybrid");
  });

  it("short storage database env remains a non-deprecated fallback", () => {
    process.env.SESSIONS_DATABASE_URL = "postgres://fallback.example/sessions";

    expect(getStorageConnectionString()).toBe("postgres://fallback.example/sessions");
    expect(getStorageDatabaseEnvName()).toBe("SESSIONS_DATABASE_URL");
    expect(getStorageConfig().mode).toBe("hybrid");
  });

  it("detects when no storage database is configured", () => {
    expect(hasStorageDatabaseConfig()).toBe(false);

    process.env.HASNA_SESSIONS_DATABASE_URL = "postgres://new.example/sessions";
    expect(hasStorageDatabaseConfig()).toBe(true);
  });

  it("fails loudly when the storage config file is malformed", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "sessions-storage-config-"));
    const configPath = join(tempRoot, "config.json");
    mkdirSync(tempRoot, { recursive: true });
    writeFileSync(configPath, "{ not json", "utf-8");
    process.env.HASNA_SESSIONS_STORAGE_CONFIG_PATH = configPath;

    expect(() => getStorageConfig()).toThrow(/Malformed sessions storage config/);
    expect(() => hasStorageDatabaseConfig()).toThrow(/Malformed sessions storage config/);
  });

  it("canonical storage mode wins over the short fallback", () => {
    process.env.HASNA_SESSIONS_STORAGE_MODE = "remote";
    process.env.SESSIONS_STORAGE_MODE = "local";

    expect(getStorageConfig().mode).toBe("remote");
  });

  it("publishes stable storage tables and fallback env", () => {
    expect(SESSIONS_STORAGE_TABLES).toEqual(STORAGE_TABLES);
    expect(SESSIONS_STORAGE_FALLBACK_ENV.databaseUrl).toBe("SESSIONS_DATABASE_URL");
  });

  it("keeps remote payload tables gated until explicit opt-in", () => {
    expect(getRemotePayloadTokens()).toEqual([]);
    expect(getRemoteTableGate("sessions").allowed).toBe(true);
    expect(getRemoteTableGate("messages").allowed).toBe(false);
    expect(getRemoteTableGate("tool_calls").allowed).toBe(false);
    expect(getRemoteTableGate("embeddings").allowed).toBe(false);
    expect(getRemoteTableGate("future_payload_table").allowed).toBe(false);
    expect(getRemoteTableGate("future_payload_table").payloadClass).toBe("unknown");

    process.env.HASNA_SESSIONS_REMOTE_PAYLOADS = "transcripts,tool_payloads";
    expect(getRemotePayloadTokens()).toEqual(["tool_payloads", "transcripts"]);
    expect(getRemoteTableGate("messages").allowed).toBe(true);
    expect(getRemoteTableGate("tool_calls").allowed).toBe(true);
    expect(getRemoteTableGate("embeddings").allowed).toBe(false);
  });

  it("pushes a redacted remote session index while skipping transcript payloads by default", async () => {
    saveParsedSession({
      session: {
        id: "local-session",
        source: "claude",
        source_id: "same-source",
        title: "remote metadata title",
        project_path: "/workspace/app",
        project_name: "app",
      },
      messages: [{ id: "local-message", session_id: "", role: "user", content: "private transcript token", sequence_num: 0 }],
      toolCalls: [],
    });

    const remote = new MemoryRemote({});
    const results = await pushStorageChangesToRemote(remote, ["sessions", "messages"], getDatabase());
    const messages = results.find((result) => result.table === "messages");
    const index = results.find((result) => result.table === REMOTE_SESSION_INDEX_TABLE);

    expect(messages?.skipped).toBe(true);
    expect(messages?.warnings?.join("\n")).toContain("full message transcript content");
    expect(index?.rowsRead).toBe(1);
    expect(index?.rowsWritten).toBe(1);
    expect(remote.runs.some((run) => run.sql.includes(REMOTE_SESSION_INDEX_TABLE))).toBe(true);
    expect(remote.runs.some((run) => run.params.includes("private transcript token"))).toBe(false);
  });

  it("uses the remote session id when writing redacted index rows for existing provider sessions", async () => {
    saveParsedSession({
      session: {
        id: "local-session",
        source: "claude",
        source_id: "same-source",
        title: "remote metadata title",
      },
      messages: [],
      toolCalls: [],
    });

    const remote = new MemoryRemote({}, { "claude:same-source": "remote-existing-session" });
    await pushStorageChangesToRemote(remote, ["sessions"], getDatabase());

    const indexRun = remote.runs.find((run) => run.sql.includes(REMOTE_SESSION_INDEX_TABLE));
    expect(indexRun?.params[0]).toBe("remote-existing-session");
  });

  it("reports remote storage as enabled when RDS config is writable without an explicit mode", () => {
    tempRoot = mkdtempSync(join(tmpdir(), "sessions-storage-rds-config-"));
    const configPath = join(tempRoot, "config.json");
    mkdirSync(tempRoot, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      rds: {
        host: "db.example.invalid",
        username: "sessions_user",
        password_env: "SESSIONS_DATABASE_PASSWORD",
      },
    }), "utf-8");
    process.env.HASNA_SESSIONS_STORAGE_CONFIG_PATH = configPath;

    const status = getStorageStatus();
    const pg = status.adapters.find((adapter) => adapter.id === "remote-postgres-index");
    expect(status.enabled).toBe(true);
    expect(pg?.enabled).toBe(true);
    expect(pg?.writable).toBe(true);
  });

  it("pulls duplicate provider sessions into the existing local id and rebuilds search", async () => {
    process.env.HASNA_SESSIONS_REMOTE_PAYLOADS = "transcripts";

    const local = saveParsedSession({
      session: { id: "local-session", source: "claude", source_id: "same-source", title: "old title" },
      messages: [{ id: "local-message", session_id: "", role: "user", content: "oldtoken", sequence_num: 0 }],
      toolCalls: [],
    });

    const remote = new MemoryRemote({
      sessions: [{ id: "remote-session", source: "claude", source_id: "same-source", title: "remote title" }],
      messages: [{ id: "remote-message", session_id: "remote-session", role: "user", content: "newtoken", sequence_num: 1 }],
    });

    const results = await pullStorageChangesFromRemote(remote, ["sessions", "messages"], getDatabase());
    expect(results.flatMap((result) => result.errors)).toEqual([]);

    const sessionRows = getDatabase().prepare("SELECT id, title FROM sessions WHERE source = ? AND source_id = ?").all("claude", "same-source") as Array<{ id: string; title: string }>;
    expect(sessionRows).toEqual([{ id: local.id, title: "remote title" }]);

    const remoteMessage = getDatabase().prepare("SELECT session_id FROM messages WHERE id = ?").get("remote-message") as { session_id: string };
    expect(remoteMessage.session_id).toBe(local.id);
    expect(search("newtoken")).toHaveLength(1);
  });
});
