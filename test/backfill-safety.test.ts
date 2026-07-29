import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSessionBackfill } from "../src/lib/backfill.js";
import {
  FakeParser,
  LegacyParser,
  RaceParser,
  StagedRaceParser,
  fakeStore,
  localFakeStore,
  message,
  parsedSession,
  repoRoot,
  root,
  setupBackfillTest,
  stagedSession,
} from "./backfill-fixtures.js";

setupBackfillTest();

describe("session backfill safety and boundaries", () => {
  it("fails closed when a parser lacks bounded parseFileResult metadata", async () => {
    const file = join(root, "legacy.jsonl");
    const parser = new LegacyParser(new Map([[file, parsedSession("legacy", file, [message("m1", "legacy")])]]));

    const result = await runSessionBackfill({
      parsers: [parser],
      checkpointPath: join(root, "checkpoint.json"),
    });

    expect(result.inventory.errors).toBe(1);
    expect(result.inventory.selectableSessions).toBe(0);
    expect(result.errors).toEqual([`codex:${file}: parser does not expose bounded parseFileResult for safe backfill`]);
  });

  it("runs backup preflight through the platform shell instead of a hard-coded bash path", async () => {
    const file = join(root, "portable-backup.jsonl");
    const parser = new FakeParser(new Map([[file, parsedSession("portable-backup", file, [message("m1", "hello")])]]));
    const store = fakeStore();

    const result = await runSessionBackfill({
      parsers: [parser],
      store,
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      allowProduction: true,
      backupCommand: `"${process.execPath}" --version`,
      source: "codex",
      pilot: 1,
      maxTotalBytes: 1024 * 1024,
      checkpointPath: join(root, "checkpoint.json"),
      env: { HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });

    expect(result.gates.backup.ran).toBe(true);
    expect(result.gates.backup.exitCode).toBe(0);
    expect(result.errors).toEqual([]);
    expect(store.imports).toEqual(["codex:portable-backup"]);
  });

  it("materializes staged sessions with the configured bounded batch size", async () => {
    const file = join(root, "staged.jsonl");
    const parser = new FakeParser(
      new Map([
        [
          file,
          stagedSession("staged", file, [
            message("m1", "one"),
            message("m2", "two"),
            message("m3", "three"),
            message("m4", "four"),
            message("m5", "five"),
          ]),
        ],
      ]),
    );
    const store = fakeStore();

    const result = await runSessionBackfill({
      parsers: [parser],
      store,
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      allowProduction: true,
      backupCommand: "true",
      source: "codex",
      pilot: 1,
      batchSize: 2,
      maxTotalBytes: 1024 * 1024,
      checkpointPath: join(root, "checkpoint.json"),
      env: { HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });

    expect(result.applied.pushed).toBe(1);
    expect(result.applied.maxMaterializedBatchRecords).toBeLessThanOrEqual(2);
    expect(result.applied.maxMaterializedSessionBytes).toBeLessThanOrEqual(result.limits.maxSessionBytes);
    expect(store.imports).toEqual(["codex:staged"]);
  });

  it("fails closed and cleans staged resources when staged parser omits source content digest", async () => {
    const file = join(root, "staged-missing-digest.jsonl");
    let cleanupCalls = 0;
    const alpha = stagedSession("staged-missing-digest", file, [message("m1", "alpha")], [], () => {
      cleanupCalls++;
    });
    const bravo = stagedSession("staged-missing-digest", file, [message("m1", "bravo")], [], () => {
      cleanupCalls++;
    });
    const parser = new StagedRaceParser(file, alpha, bravo);
    const store = fakeStore();

    const result = await runSessionBackfill({
      parsers: [parser],
      store,
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      allowProduction: true,
      backupCommand: "true",
      source: "codex",
      pilot: 1,
      maxTotalBytes: 1024 * 1024,
      checkpointPath: join(root, "checkpoint.json"),
      env: { HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });

    expect(parser.calls).toBe(1);
    expect(cleanupCalls).toBe(1);
    expect(result.inventory.errors).toBe(1);
    expect(result.inventory.selectableSessions).toBe(0);
    expect(result.applied.pushed).toBe(0);
    expect(result.errors).toEqual([`codex:${file}: staged parseFileResult requires sourceContentDigest for safe backfill`]);
    expect(store.imports).toEqual([]);
  });

  it("fails closed when source content changes between inventory and materialization", async () => {
    const file = join(root, "race.jsonl");
    const before = parsedSession("race", file, [message("m1", "before")]);
    const after = parsedSession("race", file, [message("m1", "after")]);
    const parser = new RaceParser(file, before, after);
    const store = fakeStore();

    const result = await runSessionBackfill({
      parsers: [parser],
      store,
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      allowProduction: true,
      backupCommand: "true",
      source: "codex",
      pilot: 1,
      maxTotalBytes: 1024 * 1024,
      checkpointPath: join(root, "checkpoint.json"),
      env: { HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });

    expect(parser.calls).toBe(2);
    expect(result.applied.pushed).toBe(0);
    expect(result.applied.failed).toBe(1);
    expect(store.imports).toEqual([]);
    expect(result.errors).toEqual([
      "codex:race: source changed after inventory; refusing to import stale selection",
    ]);
  });

  it("does not run backup or import when apply resolves to local store mode", async () => {
    const file = join(root, "local-mode.jsonl");
    const marker = join(root, "backup-ran");
    const parser = new FakeParser(new Map([[file, parsedSession("local-mode", file, [message("m1", "hello")])]]));
    const store = localFakeStore();

    const result = await runSessionBackfill({
      parsers: [parser],
      store,
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      allowProduction: true,
      backupCommand: `"${process.execPath}" -e "require('fs').writeFileSync('${marker}', 'ran')"`,
      source: "codex",
      pilot: 1,
      maxTotalBytes: 1024 * 1024,
      checkpointPath: join(root, "checkpoint.json"),
      env: { HASNA_SESSIONS_STORAGE_MODE: "local", HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });

    expect(result.gates.backup.ran).toBe(false);
    expect(result.applied.attempted).toBe(0);
    expect(store.imports).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    expect(result.errors).toContain("apply requires self_hosted/cloud API mode; local mode is inventory-only");
  });

  it("treats injected cloud stores without API provenance as production-like", async () => {
    const file = join(root, "injected-cloud.jsonl");
    const parser = new FakeParser(new Map([[file, parsedSession("injected-cloud", file, [message("m1", "hello")])]]));
    const store = fakeStore();

    const result = await runSessionBackfill({
      parsers: [parser],
      store,
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      backupCommand: "true",
      source: "codex",
      pilot: 1,
      maxTotalBytes: 1024 * 1024,
      checkpointPath: join(root, "checkpoint.json"),
      env: {},
    });

    expect(result.gates.production.productionLike).toBe(true);
    expect(result.gates.production.allowed).toBe(false);
    expect(result.gates.backup.ran).toBe(false);
    expect(result.applied.attempted).toBe(0);
    expect(store.imports).toEqual([]);
    expect(result.errors).toContain(
      "production-like injected cloud store requires --allow-production and separate out-of-band user approval",
    );
  });

  it("treats SESSIONS_API_URL production aliases as production-like before backup or import", async () => {
    const file = join(root, "alias-production.jsonl");
    const marker = join(root, "backup-ran");
    const parser = new FakeParser(new Map([[file, parsedSession("alias-production", file, [message("m1", "hello")])]]));
    const store = fakeStore();

    const result = await runSessionBackfill({
      parsers: [parser],
      store,
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      backupCommand: `"${process.execPath}" -e "require('fs').writeFileSync('${marker}', 'ran')"`,
      source: "codex",
      pilot: 1,
      maxTotalBytes: 1024 * 1024,
      checkpointPath: join(root, "checkpoint.json"),
      env: {
        SESSIONS_MODE: "self_hosted",
        SESSIONS_API_URL: "https://sessions.internal-test.example",
        SESSIONS_API_KEY: "placeholder",
        HASNA_SESSIONS_PRODUCTION_HOSTS: "internal-test.example",
      },
    });

    expect(result.gates.production).toEqual({
      url: "https://sessions.internal-test.example",
      productionLike: true,
      allowed: false,
    });
    expect(result.gates.backup.ran).toBe(false);
    expect(result.applied.attempted).toBe(0);
    expect(store.imports).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  it("persists completed checkpoints for concurrent imports", async () => {
    const files = ["a", "b", "c"].map((id) => join(root, `${id}.jsonl`));
    const parser = new FakeParser(
      new Map(files.map((file, index) => [file, parsedSession(String.fromCharCode(97 + index), file, [message(`m${index + 1}`, file)])])),
    );
    const store = fakeStore();
    const checkpoint = join(root, "checkpoint.json");

    const result = await runSessionBackfill({
      parsers: [parser],
      store,
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      allowProduction: true,
      backupCommand: "true",
      allSources: true,
      concurrency: 2,
      maxTotalBytes: 1024 * 1024,
      checkpointPath: checkpoint,
      env: { HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });

    expect(result.errors).toEqual([]);
    expect(result.applied.pushed).toBe(3);
    const saved = JSON.parse(readFileSync(checkpoint, "utf-8"));
    expect(Object.keys(saved.completed).sort()).toEqual(["codex:a", "codex:b", "codex:c"]);
  });

  it("does not run backup in local mode before resolving the default store", async () => {
    const file = join(root, "default-local-mode.jsonl");
    const marker = join(root, "default-backup-ran");
    const parser = new FakeParser(new Map([[file, parsedSession("default-local-mode", file, [message("m1", "hello")])]]));

    const result = await runSessionBackfill({
      parsers: [parser],
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      allowProduction: true,
      backupCommand: `"${process.execPath}" -e "require('fs').writeFileSync('${marker}', 'ran')"`,
      source: "codex",
      pilot: 1,
      maxTotalBytes: 1024 * 1024,
      checkpointPath: join(root, "checkpoint.json"),
      env: { HASNA_SESSIONS_MODE: "local", HASNA_SESSIONS_STORAGE_MODE: "local" },
    });

    expect(result.gates.backup.ran).toBe(false);
    expect(result.applied.attempted).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(result.errors).toContain("apply requires self_hosted/cloud API mode; local mode is inventory-only");
  });

  it("emits machine-readable CLI inventory JSON without API credentials", () => {
    const codexDir = join(root, "codex", "sessions", "2026", "07", "17");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "rollout-2026-07-17T10-00-00-cli-backfill.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-07-17T10:00:00Z",
          type: "session_meta",
          payload: { id: "cli-backfill", cwd: "/tmp/project" },
        }),
        JSON.stringify({
          timestamp: "2026-07-17T10:00:01Z",
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "inventory me" }] },
        }),
      ].join("\n"),
    );

    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "run",
        "src/cli/index.tsx",
        "backfill",
        "--source",
        "codex",
        "--pilot",
        "1",
        "--known-id",
        "codex:cli-backfill",
        "--checkpoint",
        join(root, "checkpoint.json"),
        "--json",
      ],
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: root,
        CODEX_PATH: join(root, "codex"),
        CLAUDE_PATH: join(root, "claude"),
        CODEWITH_PATH: join(root, "codewith"),
        GEMINI_PATH: join(root, "gemini"),
        HASNA_SESSIONS_DIR: join(root, "sessions-home"),
        HASNA_SESSIONS_API_URL: "",
        HASNA_SESSIONS_API_KEY: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stderr).toString("utf-8")).toBe("");
    const payload = JSON.parse(Buffer.from(result.stdout).toString("utf-8"));
    expect(payload.dryRun).toBe(true);
    expect(payload.inventory.sessions).toBe(1);
    expect(payload.selection.selectedKeys).toEqual(["codex:cli-backfill"]);
    expect(payload.gates.backup.ran).toBe(false);
  });

  it("enforces the streaming max-session byte cap before buffering a huge JSONL line", async () => {
    const codexDir = join(root, "codex", "sessions", "2026", "07", "17");
    mkdirSync(codexDir, { recursive: true });
    const file = join(codexDir, "rollout-2026-07-17T10-00-00-huge-line.jsonl");
    writeFileSync(file, JSON.stringify({ timestamp: "2026-07-17T10:00:00Z", type: "session_meta", payload: { id: "huge-line" } }));
    writeFileSync(file, `\n${"x".repeat(2 * 1024 * 1024)}\n`, { flag: "a" });
    const { CodexParser } = await import("../src/lib/ingest/codex.js");
    const previousCodexPath = process.env.CODEX_PATH;
    process.env.CODEX_PATH = join(root, "codex");

    try {
      const result = await runSessionBackfill({
        parsers: [new CodexParser()],
        maxSessionBytes: 1024,
        checkpointPath: join(root, "checkpoint.json"),
        env: {},
      });

      expect(result.inventory.errors).toBe(1);
      expect(result.inventory.maxBufferedLineBytes).toBe(0);
      expect(result.selection.selected).toBe(0);
      expect(result.errors[0]).toContain("JSONL pending line exceeds max buffered bytes 1024");
    } finally {
      if (previousCodexPath === undefined) delete process.env.CODEX_PATH;
      else process.env.CODEX_PATH = previousCodexPath;
    }
  });

  it("treats explicit production declarations as production-like even for alias hosts", async () => {
    const file = join(root, "one.jsonl");
    const parser = new FakeParser(new Map([[file, parsedSession("one", file, [message("m1", "hello")])]]));
    const store = fakeStore();

    const result = await runSessionBackfill({
      parsers: [parser],
      store,
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      backupCommand: "true",
      source: "codex",
      pilot: 1,
      maxTotalBytes: 1024 * 1024,
      checkpointPath: join(root, "checkpoint.json"),
      env: { HASNA_SESSIONS_API_URL: "https://sessions-prod.example.test", HASNA_SESSIONS_PRODUCTION: "1" },
    });

    expect(result.gates.production.productionLike).toBe(true);
    expect(result.gates.production.allowed).toBe(false);
    expect(result.applied.attempted).toBe(0);
    expect(store.imports).toEqual([]);
  });
});
