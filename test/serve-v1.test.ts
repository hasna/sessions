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
