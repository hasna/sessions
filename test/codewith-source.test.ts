// Cross-surface guard tests: `codewith` must remain a first-class session
// source everywhere the wire/DB/ingest surfaces enumerate providers. Runtime
// support already exists; these assertions fail loudly if a future change adds
// a new surface (or narrows an existing list) that silently drops codewith,
// keeping the API / CLI / SDK / sync path in lock-step.

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SESSION_SOURCES, isSessionSource } from "../src/types/index.js";
import { buildOpenApiDocument } from "../src/server/openapi.js";
import { getParser, listParsers } from "../src/lib/ingest/index.js";
import { getWatchStatus } from "../src/lib/watch.js";
import { closeDatabase, getDatabase, resetDatabase } from "../src/db/database.js";
import { getSessionBySource, listSessions, upsertSession } from "../src/db/sessions.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("codewith is a first-class session source", () => {
  it("is enumerated in the SESSION_SOURCES source of truth", () => {
    expect(SESSION_SOURCES).toContain("codewith");
    expect(isSessionSource("codewith")).toBe(true);
  });

  it("appears in the OpenAPI source enum for Session and SessionCreate", () => {
    const doc = buildOpenApiDocument() as {
      components: { schemas: Record<string, { properties: { source: { enum: string[] } } }> };
    };
    const schemas = doc.components.schemas;
    for (const name of ["Session", "SessionCreate"]) {
      const sourceEnum = schemas[name]?.properties?.source?.enum;
      expect(sourceEnum, `${name}.source.enum missing`).toBeDefined();
      expect(sourceEnum).toContain("codewith");
      // Wire enum must stay in lock-step with the code source of truth.
      expect([...sourceEnum].sort()).toEqual([...SESSION_SOURCES].sort());
    }
  });

  it("is part of the generated SDK Session/SessionCreate source union", () => {
    const sdk = readFileSync(join(repoRoot, "src/sdk/client.ts"), "utf-8");
    // The generator emits `"source": "claude" | "codex" | "codewith" | "gemini"`.
    const unions = sdk.match(/"source":\s*("[a-z]+"(?:\s*\|\s*"[a-z]+")+)/g) ?? [];
    expect(unions.length).toBeGreaterThan(0);
    for (const union of unions) {
      expect(union).toContain('"codewith"');
    }
  });

  it("has a registered ingest parser rooted at the codewith sessions dir", () => {
    const parser = getParser("codewith");
    expect(parser).toBeDefined();
    expect(parser?.source).toBe("codewith");
    expect(listParsers().map((p) => p.source)).toContain("codewith");
  });

  it("is watched by the ingest-watch/daemon roots when its dir exists", () => {
    const prev = process.env.CODEWITH_PATH;
    const dir = mkdtempSync(join(tmpdir(), "codewith-watch-"));
    try {
      mkdirSync(join(dir, "sessions"), { recursive: true });
      process.env.CODEWITH_PATH = dir;
      const status = getWatchStatus();
      expect(status.roots.some((r) => r.source === "codewith" && r.exists)).toBe(true);
      expect(status.sources).toContain("codewith");
    } finally {
      if (prev === undefined) delete process.env.CODEWITH_PATH;
      else process.env.CODEWITH_PATH = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is validated by the shared Postgres source CHECK migration", () => {
    const sql = readFileSync(join(repoRoot, "migrations/0004_codewith_session_source.sql"), "utf-8");
    expect(sql).toMatch(/source IN \([^)]*'codewith'[^)]*\)/);
    for (const source of SESSION_SOURCES) {
      expect(sql).toContain(`'${source}'`);
    }
  });

  it("round-trips through the local SQLite index (ingest → label → query)", () => {
    process.env.SESSIONS_DB_PATH = ":memory:";
    resetDatabase();
    getDatabase();
    try {
      upsertSession({ source: "codewith", source_id: "guard-1", title: "codewith session" });
      upsertSession({ source: "claude", source_id: "guard-2", title: "claude session" });

      const fetched = getSessionBySource("codewith", "guard-1");
      expect(fetched?.source).toBe("codewith");
      expect(fetched?.title).toBe("codewith session");

      const filtered = listSessions({ source: "codewith" });
      expect(filtered.map((s) => s.source_id)).toEqual(["guard-1"]);
    } finally {
      closeDatabase();
      delete process.env.SESSIONS_DB_PATH;
    }
  });
});
