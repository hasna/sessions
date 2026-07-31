import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { closeDatabase, resetDatabase } from "../src/db/database.js";
import { getLocalStore, resolveSessionStore } from "../src/db/session-store.js";

beforeEach(() => {
  process.env.SESSIONS_DB_PATH = ":memory:";
  process.env.HASNA_MACHINE = "store-test-machine";
  delete process.env.OPENAI_API_KEY;
  resetDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env.SESSIONS_DB_PATH;
  delete process.env.HASNA_MACHINE;
});

describe("local session store complete surface", () => {
  it("executes record, search, graph, maintenance, and local-only operations", async () => {
    const store = getLocalStore();
    expect(store.mode).toBe("local");
    expect(resolveSessionStore({}).mode).toBe("local");

    expect(await store.semanticSearch("nothing", {})).toEqual([]);
    expect(await store.embed({ limit: 0 })).toEqual({ messagesProcessed: 0, chunksEmbedded: 0 });

    const created = await store.create({
      id: "store-1",
      source: "claude",
      source_id: "native-store-1",
      title: "Store title",
      project_path: "/old/project",
      project_name: "project",
      model: "claude-test",
      model_provider: "anthropic",
      git_origin_url: "https://example.test/repo",
      machine: "store-test-machine",
    });
    expect(created.id).toBe("store-1");
    const imported = await store.importContent({
      session: {
        id: "store-1",
        source: "claude",
        source_id: "native-store-1",
        title: "Store title",
        project_path: "/old/project",
        project_name: "project",
        model: "claude-test",
        model_provider: "anthropic",
        git_origin_url: "https://example.test/repo",
        machine: "store-test-machine",
      },
      messages: [
        { id: "message-1", session_id: "store-1", role: "user", content: "hello searchable world", sequence_num: 0 },
        { id: "message-2", session_id: "store-1", role: "assistant", content: "answer", sequence_num: 1 },
      ],
      toolCalls: [
        { id: "tool-1", message_id: "message-2", session_id: "store-1", tool_name: "Read", tool_input: "file.ts", tool_output: "contents" },
      ],
      backup: { artifact: "backup.db" },
    });
    expect(imported.imported).toEqual({ messages: 2, toolCalls: 1 });
    expect(imported.backup).toEqual({ artifact: "backup.db" });

    expect(await store.list({ source: "claude", project_path: "/old", machine: "store-test-machine", limit: 10 })).toHaveLength(1);
    expect(await store.recent(10)).toHaveLength(1);
    expect((await store.get("native-store"))?.id).toBe("store-1");
    expect(await store.get("missing")).toBeNull();
    expect((await store.rename("store-1", "Renamed"))?.title).toBe("Renamed");
    expect(await store.messages("store-1")).toHaveLength(2);
    expect(await store.toolCalls("store-1")).toHaveLength(1);
    expect(await store.search("Renamed", {})).toHaveLength(1);
    expect(await store.searchContent("searchable", {})).toHaveLength(1);
    expect(await store.searchToolCalls("contents", {})).toHaveLength(1);
    expect(await store.hybridSearch("searchable", { limit: 3 })).toHaveLength(1);

    const recall = await store.recall("searchable world", { limit: 2 });
    expect(recall.results).toHaveLength(1);
    expect(await store.graphEntities()).not.toEqual([]);
    expect(await store.graphEntities("tool")).toContainEqual(expect.objectContaining({ name: "Read" }));
    expect(await store.graphRelated("tool", "Read", 5)).toHaveLength(1);
    expect((await store.graphSession("store-1"))?.tools).toEqual(["Read"]);
    expect(await store.graphSession("missing")).toBeNull();

    expect(await store.relocatePaths("/old", "/new")).toEqual({ rowsUpdated: 1 });
    expect((await store.get("store-1"))?.project_path).toBe("/new/project");
    expect(await store.stats()).toMatchObject({ session_count: 0, message_count: 0, tool_call_count: 0, by_source: [] });
    expect(await store.machines()).toEqual([]);
    await store.recomputeMachines();
    expect(await store.machines()).toContainEqual(expect.objectContaining({ name: "store-test-machine", session_count: 1 }));

    expect(await store.ingest({ sources: [] })).toEqual([]);
    await expect(store.ingest({ source: "unknown" })).rejects.toThrow("No parser registered");
    await expect(store.mergeFromDb(join(import.meta.dir, "missing-store.db"))).rejects.toThrow("No such database");

    expect(await store.remove("missing")).toBe(false);
    expect(await store.remove("store-1")).toBe(true);
    expect(await store.get("store-1")).toBeNull();
  });
});
