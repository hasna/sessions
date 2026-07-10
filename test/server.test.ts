import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionsServer,
  MAX_REQUEST_BODY_SIZE_ENV,
  resolveMaxRequestBodySize,
  SELF_HOSTED_DEFAULT_MAX_REQUEST_BODY_SIZE,
} from "../src/server/app";
import { getPackageInfo } from "../src/lib/package";
import { getDatabase, resetDatabase, closeDatabase } from "../src/db/database";
import { saveParsedSession } from "../src/db/sessions";

describe("createSessionsServer", () => {
  it("preserves Bun's default body limit in local mode unless configured", () => {
    expect(resolveMaxRequestBodySize({ HASNA_SESSIONS_STORAGE_MODE: "local" })).toBeUndefined();
  });

  it("uses a self-hosted/cloud default request body limit for large imports", () => {
    expect(resolveMaxRequestBodySize({ HASNA_SESSIONS_STORAGE_MODE: "cloud" })).toBe(
      SELF_HOSTED_DEFAULT_MAX_REQUEST_BODY_SIZE,
    );
  });

  it("accepts byte and unit overrides for the request body limit", () => {
    expect(resolveMaxRequestBodySize({ [MAX_REQUEST_BODY_SIZE_ENV]: "1048576" })).toBe(1024 * 1024);
    expect(resolveMaxRequestBodySize({ [MAX_REQUEST_BODY_SIZE_ENV]: "2MiB" })).toBe(2 * 1024 * 1024);
  });

  it("rejects invalid request body limit configuration at startup", () => {
    expect(() => resolveMaxRequestBodySize({ [MAX_REQUEST_BODY_SIZE_ENV]: "not-a-size" })).toThrow(
      MAX_REQUEST_BODY_SIZE_ENV,
    );
  });

  it("applies the configured Bun request body limit before route handling", async () => {
    const server = createSessionsServer({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: 64,
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${baseUrl}/v1/sessions/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: ["x".repeat(128)], toolCalls: [] }),
      });
      expect(response.status).toBe(413);
    } finally {
      server.stop(true);
    }
  });

  it("allows larger bodies to reach existing validation when the limit is raised", async () => {
    const server = createSessionsServer({
      hostname: "127.0.0.1",
      port: 0,
      maxRequestBodySize: 16 * 1024,
    });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${baseUrl}/v1/sessions/import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: ["x".repeat(128)], toolCalls: [] }),
      });
      expect(response.status).toBe(503);
      expect((await response.json()).error).toContain("API auth not configured");
    } finally {
      server.stop(true);
    }
  });

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
      expect(info.endpoints).toContain("/v1/sessions");

      const notFoundResponse = await fetch(`${baseUrl}/missing`);
      expect(notFoundResponse.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});

describe("legacy pre-/v1 content endpoints are gone (no unauthenticated surface)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sessions-server-"));
    process.env.SESSIONS_DB_PATH = join(dir, "sessions.db");
    resetDatabase();
    getDatabase();
    // Seed a session so a lingering legacy route would leak real content if present.
    saveParsedSession({
      session: { source: "claude", source_id: "srv-1", title: "Deploy infra", project_path: "/p/infra", project_name: "infra" },
      messages: [{ session_id: "", role: "user", content: "deploy the kubernetes cluster", sequence_num: 0 }],
      toolCalls: [{ session_id: "", tool_name: "Bash", tool_input: "kubectl apply" }],
    });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SESSIONS_DB_PATH;
  });

  it("returns 404 for every deleted unauthenticated content route", async () => {
    const server = createSessionsServer({ hostname: "127.0.0.1", port: 0 });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const gone = [
        "/search?q=kubernetes",
        "/recall?q=kubernetes",
        "/tool-calls?q=kubectl",
        "/recent",
        "/list",
        "/machines",
        "/stats",
        "/sessions/srv-1",
      ];
      for (const path of gone) {
        const res = await fetch(`${base}${path}`);
        expect(res.status, `${path} should be gone`).toBe(404);
      }
    } finally {
      server.stop(true);
    }
  });
});
