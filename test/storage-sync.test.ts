import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDatabase, getDatabase, resetDatabase } from "../src/db/database.js";
import {
  SESSIONS_STORAGE_FALLBACK_ENV,
  getStorageConfig,
  getStorageConnectionString,
  getStorageDatabaseEnvName,
  hasStorageDatabaseConfig,
} from "../src/db/storage-config.js";
import { SESSIONS_STORAGE_TABLES, STORAGE_TABLES, getStorageStatus, pullStorageChangesFromRemote } from "../src/db/storage-sync.js";
import { saveParsedSession } from "../src/db/sessions.js";
import { search } from "../src/lib/search.js";

const envKeys = [
  "HASNA_SESSIONS_DATABASE_URL",
  "SESSIONS_DATABASE_URL",
  "HASNA_SESSIONS_STORAGE_MODE",
  "SESSIONS_STORAGE_MODE",
] as const;

const savedEnv = new Map<string, string | undefined>();
let savedSessionsDbPath: string | undefined;

type Row = Record<string, unknown>;

class MemoryRemote {
  constructor(private readonly tables: Record<string, Row[]>) {}

  async exec(): Promise<void> {}

  async get(): Promise<unknown> {
    return null;
  }

  async run(): Promise<{ changes: number }> {
    return { changes: 0 };
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

  it("canonical storage mode wins over the short fallback", () => {
    process.env.HASNA_SESSIONS_STORAGE_MODE = "remote";
    process.env.SESSIONS_STORAGE_MODE = "local";

    expect(getStorageConfig().mode).toBe("remote");
  });

  it("publishes stable storage tables and fallback env", () => {
    expect(SESSIONS_STORAGE_TABLES).toEqual(STORAGE_TABLES);
    expect(SESSIONS_STORAGE_FALLBACK_ENV.databaseUrl).toBe("SESSIONS_DATABASE_URL");
  });

  it("pulls duplicate provider sessions into the existing local id and rebuilds search", async () => {
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
