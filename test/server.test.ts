import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionsServer } from "../src/server/app";
import { getPackageInfo } from "../src/lib/package";
import { getDatabase, resetDatabase, closeDatabase } from "../src/db/database";
import { saveParsedSession } from "../src/db/sessions";

describe("createSessionsServer", () => {
  it("serves health and info endpoints", async () => {
    const pkg = getPackageInfo();
    const server = createSessionsServer({ hostname: "127.0.0.1", port: 0 });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;

      const healthResponse = await fetch(`${baseUrl}/health`);
      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.json()).toEqual({
        status: "ok",
        version: pkg.version,
        mode: "local",
      });

      const readyResponse = await fetch(`${baseUrl}/ready`);
      expect(readyResponse.status).toBe(200);
      expect((await readyResponse.json()).status).toBe("ready");

      const versionResponse = await fetch(`${baseUrl}/version`);
      expect(versionResponse.status).toBe(200);
      expect((await versionResponse.json()).version).toBe(pkg.version);

      const infoResponse = await fetch(`${baseUrl}/info`);
      expect(infoResponse.status).toBe(200);
      const info = await infoResponse.json();
      expect(info.ok).toBe(true);
      expect(info.name).toBe(pkg.name);
      expect(info.version).toBe(pkg.version);
      expect(info.endpoints).toContain("/health");

      const notFoundResponse = await fetch(`${baseUrl}/missing`);
      expect(notFoundResponse.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});

describe("query endpoints", () => {
  let dir: string;
  let sessionId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sessions-server-"));
    process.env.SESSIONS_DB_PATH = join(dir, "sessions.db");
    resetDatabase();
    getDatabase();
    const s = saveParsedSession({
      session: { source: "claude", source_id: "srv-1", title: "Deploy infra", project_path: "/p/infra", project_name: "infra" },
      messages: [{ session_id: "", role: "user", content: "deploy the kubernetes cluster", sequence_num: 0 }],
      toolCalls: [{ session_id: "", tool_name: "Bash", tool_input: "kubectl apply" }],
    });
    sessionId = s.id;
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SESSIONS_DB_PATH;
  });

  it("serves /search, /recall, /recent, /sessions/:id, /stats", async () => {
    const server = createSessionsServer({ hostname: "127.0.0.1", port: 0 });
    try {
      const base = `http://127.0.0.1:${server.port}`;

      const search = await (await fetch(`${base}/search?q=kubernetes`)).json();
      expect(search.ok).toBe(true);
      expect(search.count).toBe(1);
      expect(search.results[0].session_id).toBe(sessionId);

      const recall = await (await fetch(`${base}/recall?q=kubernetes`)).json();
      expect(recall.ok).toBe(true);
      expect(recall.count).toBe(1);
      expect(recall.results[0].session_id).toBe(sessionId);
      expect(recall.results[0].resume.shell_command).toBe("claude --resume srv-1");

      const toolCalls = await (await fetch(`${base}/tool-calls?q=kubectl&project=${encodeURIComponent("/p/infra")}`)).json();
      expect(toolCalls.ok).toBe(true);
      expect(toolCalls.count).toBe(1);
      const filteredToolCalls = await (await fetch(`${base}/tool-calls?q=kubectl&project=${encodeURIComponent("/definitely/nope")}`)).json();
      expect(filteredToolCalls.ok).toBe(true);
      expect(filteredToolCalls.count).toBe(0);

      const recent = await (await fetch(`${base}/recent`)).json();
      expect(recent.sessions).toHaveLength(1);

      const session = await (await fetch(`${base}/sessions/${sessionId}`)).json();
      expect(session.ok).toBe(true);
      expect(session.session.source_id).toBe("srv-1");
      expect(session.messages).toHaveLength(1);
      expect(session.tool_calls).toHaveLength(1);

      const missing = await fetch(`${base}/sessions/nope`);
      expect(missing.status).toBe(404);

      const search400 = await fetch(`${base}/search`);
      expect(search400.status).toBe(400);

      const stats = await (await fetch(`${base}/stats`)).json();
      expect(stats.ok).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
