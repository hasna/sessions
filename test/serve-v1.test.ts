import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintApiKey } from "@hasna/contracts/auth";
import { createSessionsServer } from "../src/server/app";
import { resetDataSource } from "../src/server/data-source";
import { resetAuth } from "../src/server/auth";
import { getDatabase, resetDatabase, closeDatabase } from "../src/db/database";

const SIGNING_KEY = "test-signing-secret-0123456789abcdef0123456789abcdef";

describe("/v1 authenticated API (local mode)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sessions-v1-"));
    process.env.SESSIONS_DB_PATH = join(dir, "sessions.db");
    process.env.HASNA_SESSIONS_API_SIGNING_KEY = SIGNING_KEY;
    delete process.env.HASNA_SESSIONS_STORAGE_MODE;
    resetDatabase();
    resetDataSource();
    resetAuth();
    getDatabase();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SESSIONS_DB_PATH;
    delete process.env.HASNA_SESSIONS_API_SIGNING_KEY;
    resetDataSource();
    resetAuth();
  });

  function keyFor(scopes: string[]): string {
    return mintApiKey({ app: "sessions", scopes, signingSecret: SIGNING_KEY, ttlSeconds: 3600 }).token;
  }

  it("rejects /v1 without a key (401) and with insufficient scope (403)", async () => {
    const server = createSessionsServer({ hostname: "127.0.0.1", port: 0 });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const noKey = await fetch(`${base}/v1/sessions`);
      expect(noKey.status).toBe(401);

      const readOnly = keyFor(["sessions:read"]);
      const writeAttempt = await fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: { "x-api-key": readOnly, "content-type": "application/json" },
        body: JSON.stringify({ source: "claude", source_id: "x1" }),
      });
      expect(writeAttempt.status).toBe(403);
    } finally {
      server.stop(true);
    }
  });

  it("performs an authenticated CRUD roundtrip", async () => {
    const server = createSessionsServer({ hostname: "127.0.0.1", port: 0 });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const rw = keyFor(["sessions:read", "sessions:write"]);
      const H = { "x-api-key": rw, "content-type": "application/json" };

      // CREATE
      const created = await fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          source: "claude",
          source_id: "roundtrip-1",
          title: "Roundtrip",
          project_name: "demo",
        }),
      });
      expect(created.status).toBe(201);
      const createdBody = await created.json();
      expect(createdBody.ok).toBe(true);
      const id = createdBody.session.id;
      expect(id).toBeTruthy();

      // READ
      const read = await fetch(`${base}/v1/sessions/${id}`, { headers: { "x-api-key": rw } });
      expect(read.status).toBe(200);
      expect((await read.json()).session.source_id).toBe("roundtrip-1");

      // LIST
      const list = await fetch(`${base}/v1/sessions`, { headers: { "x-api-key": rw } });
      expect(list.status).toBe(200);
      expect((await list.json()).count).toBeGreaterThanOrEqual(1);

      // SEARCH
      const search = await fetch(`${base}/v1/search?q=Roundtrip`, { headers: { "x-api-key": rw } });
      expect(search.status).toBe(200);
      expect((await search.json()).count).toBeGreaterThanOrEqual(1);

      // STATS
      const stats = await fetch(`${base}/v1/stats`, { headers: { "x-api-key": rw } });
      expect(stats.status).toBe(200);
      expect((await stats.json()).session_count).toBeGreaterThanOrEqual(1);

      // DELETE
      const del = await fetch(`${base}/v1/sessions/${id}`, { method: "DELETE", headers: { "x-api-key": rw } });
      expect(del.status).toBe(200);
      expect((await del.json()).deleted).toBe(true);

      const gone = await fetch(`${base}/v1/sessions/${id}`, { headers: { "x-api-key": rw } });
      expect(gone.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });

  it("serves rename (PATCH), content/tool search, and graph on /v1 (regression for stale-server 404/405)", async () => {
    const server = createSessionsServer({ hostname: "127.0.0.1", port: 0 });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const rw = keyFor(["sessions:read", "sessions:write"]);
      const H = { "x-api-key": rw, "content-type": "application/json" };

      const created = await fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          source: "claude",
          source_id: "endpoints-1",
          title: "Original title",
          project_name: "graph-demo",
          project_path: "/tmp/graph-demo",
        }),
      });
      expect(created.status).toBe(201);
      const id = (await created.json()).session.id as string;

      // RENAME — PATCH /v1/sessions/:id must exist (was 405 on the stale 0.11.x server).
      const renamed = await fetch(`${base}/v1/sessions/${id}`, {
        method: "PATCH",
        headers: H,
        body: JSON.stringify({ title: "Renamed via /v1" }),
      });
      expect(renamed.status).toBe(200);
      expect((await renamed.json()).session.title).toBe("Renamed via /v1");

      // PATCH with an empty title is a 400, not a 405/404.
      const badRename = await fetch(`${base}/v1/sessions/${id}`, {
        method: "PATCH",
        headers: H,
        body: JSON.stringify({ title: "   " }),
      });
      expect(badRename.status).toBe(400);

      // CONTENT SEARCH — GET /v1/search/content must exist (was 404 on the stale server).
      const content = await fetch(`${base}/v1/search/content?q=Renamed`, { headers: { "x-api-key": rw } });
      expect(content.status).toBe(200);
      expect((await content.json()).ok).toBe(true);

      // TOOL SEARCH — GET /v1/search/tools must exist (was 404 on the stale server).
      const tools = await fetch(`${base}/v1/search/tools?q=anything`, { headers: { "x-api-key": rw } });
      expect(tools.status).toBe(200);
      expect((await tools.json()).ok).toBe(true);

      // GRAPH — GET /v1/graph must exist (was 404 on the stale server) for all three shapes.
      const gEntities = await fetch(`${base}/v1/graph?type=project`, { headers: { "x-api-key": rw } });
      expect(gEntities.status).toBe(200);
      expect((await gEntities.json()).ok).toBe(true);

      const gSession = await fetch(`${base}/v1/graph?session=${id}`, { headers: { "x-api-key": rw } });
      expect(gSession.status).toBe(200);
      expect((await gSession.json()).ok).toBe(true);

      const gRelated = await fetch(`${base}/v1/graph?related=project:graph-demo`, { headers: { "x-api-key": rw } });
      expect(gRelated.status).toBe(200);
      expect((await gRelated.json()).ok).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("imports session content idempotently and serves messages/tool calls over /v1", async () => {
    const server = createSessionsServer({ hostname: "127.0.0.1", port: 0 });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const rw = keyFor(["sessions:read", "sessions:write"]);
      const H = { "x-api-key": rw, "content-type": "application/json" };

      const body = {
        session: {
          id: "content-sync-1",
          source: "claude",
          source_id: "content-sync-1",
          title: "Content Sync",
          project_name: "sync-demo",
          project_path: "/tmp/sync-demo",
          machine: "spark01",
        },
        messages: [
          {
            id: "msg-1",
            session_id: "content-sync-1",
            role: "user",
            content: "sync this transcript body",
            sequence_num: 0,
            input_tokens: 5,
          },
          {
            id: "msg-2",
            session_id: "content-sync-1",
            role: "assistant",
            content: "running cloud import",
            sequence_num: 1,
            output_tokens: 7,
          },
        ],
        toolCalls: [
          {
            id: "tool-1",
            message_id: "msg-2",
            session_id: "content-sync-1",
            tool_name: "Bash",
            tool_input: "sessions sync",
            tool_output: "ok",
            status: "success",
          },
        ],
        backup: {
          artifact: "/tmp/pre-cloud-sync.db",
          created_at: "2026-07-09T10:00:00.000Z",
          note: "test backup hook",
        },
      };

      const imported = await fetch(`${base}/v1/sessions/import`, {
        method: "POST",
        headers: H,
        body: JSON.stringify(body),
      });
      expect(imported.status).toBe(201);
      const importedBody = await imported.json();
      expect(importedBody.imported).toEqual({ messages: 2, toolCalls: 1 });
      expect(importedBody.backup.artifact).toBe("/tmp/pre-cloud-sync.db");
      expect(importedBody.session.message_count).toBe(2);
      expect(importedBody.session.total_input_tokens).toBe(5);
      expect(importedBody.session.total_output_tokens).toBe(7);

      const missingChildren = await fetch(`${base}/v1/sessions/import`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({ session: body.session }),
      });
      expect(missingChildren.status).toBe(400);
      expect((await missingChildren.json()).error).toContain("messages must be an array");

      const messages = await fetch(`${base}/v1/sessions/content-sync-1/messages`, { headers: { "x-api-key": rw } });
      expect(messages.status).toBe(200);
      expect((await messages.json()).messages.map((m: { id: string }) => m.id)).toEqual(["msg-1", "msg-2"]);

      const toolCalls = await fetch(`${base}/v1/sessions/content-sync-1/tool-calls`, { headers: { "x-api-key": rw } });
      expect(toolCalls.status).toBe(200);
      expect((await toolCalls.json()).toolCalls[0].tool_name).toBe("Bash");

      const contentSearch = await fetch(`${base}/v1/search/content?q=transcript`, { headers: { "x-api-key": rw } });
      expect(contentSearch.status).toBe(200);
      expect((await contentSearch.json()).count).toBe(1);

      const toolSearch = await fetch(`${base}/v1/search/tools?q=sessions`, { headers: { "x-api-key": rw } });
      expect(toolSearch.status).toBe(200);
      expect((await toolSearch.json()).count).toBe(1);

      const unsafeEmptyReplacement = await fetch(`${base}/v1/sessions/import`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          ...body,
          messages: [],
          toolCalls: [],
        }),
      });
      expect(unsafeEmptyReplacement.status).toBe(400);
      expect((await unsafeEmptyReplacement.json()).error).toContain("content import would shrink existing session content");

      const replacement = await fetch(`${base}/v1/sessions/import`, {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          ...body,
          messages: [{ id: "msg-3", session_id: "content-sync-1", role: "user", content: "replacement", sequence_num: 0 }],
          toolCalls: [],
          destructive: {
            allowContentShrink: true,
            reason: "test intentionally replaces imported child rows",
          },
        }),
      });
      expect(replacement.status).toBe(201);
      const replacedMessages = await fetch(`${base}/v1/sessions/content-sync-1/messages`, { headers: { "x-api-key": rw } });
      const replacedBody = await replacedMessages.json();
      expect(replacedBody.messages.map((m: { id: string }) => m.id)).toEqual(["msg-3"]);
    } finally {
      server.stop(true);
    }
  });

  it("accepts the key via Authorization: Bearer", async () => {
    const server = createSessionsServer({ hostname: "127.0.0.1", port: 0 });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const rw = keyFor(["sessions:read"]);
      const res = await fetch(`${base}/v1/machines`, { headers: { authorization: `Bearer ${rw}` } });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
