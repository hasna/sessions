import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "../src/db/database.js";
import { getDataSource, resetDataSource } from "../src/server/data-source.js";

describe("server data source", () => {
  let tempDir: string;
  let originalStorageMode: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sessions-data-source-"));
    originalStorageMode = process.env.HASNA_SESSIONS_STORAGE_MODE;
    process.env.SESSIONS_DB_PATH = join(tempDir, "sessions.db");
    delete process.env.HASNA_SESSIONS_STORAGE_MODE;
    resetDatabase();
    resetDataSource();
    getDatabase();
  });

  afterEach(() => {
    closeDatabase();
    resetDataSource();
    delete process.env.SESSIONS_DB_PATH;
    if (originalStorageMode === undefined) {
      delete process.env.HASNA_SESSIONS_STORAGE_MODE;
    } else {
      process.env.HASNA_SESSIONS_STORAGE_MODE = originalStorageMode;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("selects and caches the configured mode until reset", () => {
    const local = getDataSource();
    expect(local.mode).toBe("local");
    expect(getDataSource()).toBe(local);

    process.env.HASNA_SESSIONS_STORAGE_MODE = "cloud";
    expect(getDataSource()).toBe(local);

    resetDataSource();
    expect(getDataSource().mode).toBe("cloud");
  });

  it("performs local CRUD and reports missing removals", async () => {
    const source = getDataSource();
    const created = await source.create({
      source: "codex",
      source_id: "native-1",
      title: "Data source coverage",
      project_name: "sessions",
    });

    expect(await source.get(created.id)).toMatchObject({ source_id: "native-1" });
    expect(await source.list({ source: "codex" })).toHaveLength(1);
    expect((await source.recent(1))[0]?.id).toBe(created.id);
    expect((await source.search("coverage", {}))[0]).toMatchObject({
      session: { id: created.id },
      match: "title",
    });
    expect(await source.stats()).toMatchObject({
      session_count: 1,
      message_count: 0,
      tool_call_count: 0,
      by_source: [{ source: "codex", sessions: 1 }],
    });

    expect(await source.remove("missing-id")).toBe(false);
    expect(await source.remove(created.id)).toBe(true);
    expect(await source.get(created.id)).toBeNull();
  });

  it("imports content and refuses an unconfirmed destructive shrink", async () => {
    const source = getDataSource();
    const input = {
      session: { source: "claude" as const, source_id: "import-1", title: "Imported" },
      messages: [{ session_id: "", role: "user" as const, content: "keep this" }],
      toolCalls: [],
      backup: { artifact: "backup.sqlite", note: "test backup" },
    };

    const imported = await source.importContent(input);
    expect(imported.imported).toEqual({ messages: 1, toolCalls: 0 });
    expect(imported.backup).toEqual(input.backup);
    expect(await source.messages(imported.session.id)).toHaveLength(1);

    await expect(
      source.importContent({ ...input, messages: [] }),
    ).rejects.toThrow("content import would shrink existing session content");

    const shrunk = await source.importContent({
      ...input,
      messages: [],
      destructive: { allowContentShrink: true, reason: "fixture cleanup" },
    });
    expect(shrunk.imported.messages).toBe(0);
    expect(await source.messages(shrunk.session.id)).toEqual([]);
  });
});
