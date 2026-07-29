import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

describe("session backfill", () => {
  it("inventories, estimates, skips duplicates, and selects a deterministic pilot", async () => {
    const fileA = join(root, "b.jsonl");
    const fileB = join(root, "a.jsonl");
    const duplicate = join(root, "duplicate.jsonl");
    const parser = new FakeParser(
      new Map([
        [fileA, parsedSession("b", fileA, [message("m2", "second")])],
        [fileB, parsedSession("a", fileB, [message("m1", "first")])],
        [duplicate, parsedSession("a", duplicate, [message("m3", "duplicate")])],
      ]),
    );

    const result = await runSessionBackfill({
      parsers: [parser],
      pilot: 1,
      knownIds: ["codex:a"],
      checkpointPath: join(root, "checkpoint.json"),
    });

    expect(result.dryRun).toBe(true);
    expect(result.inventory.sessions).toBe(3);
    expect(result.inventory.selectableSessions).toBe(2);
    expect(result.inventory.duplicates).toBe(1);
    expect(result.selection.selectedKeys).toEqual(["codex:a"]);
    expect(result.selection.knownIds).toEqual([
      { source: "codex", sourceId: "a", key: "codex:a", found: true, selected: true, verified: null },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("fails closed before backup or import when the production guard blocks apply", async () => {
    const file = join(root, "one.jsonl");
    const parser = new FakeParser(new Map([[file, parsedSession("one", file, [message("m1", "hello")])]]));
    const store = fakeStore();

    const result = await runSessionBackfill({
      parsers: [parser],
      store,
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      backupCommand: "false",
      maxTotalBytes: 1024 * 1024,
      checkpointPath: join(root, "checkpoint.json"),
      env: {
        HASNA_SESSIONS_API_URL: "https://sessions.internal-test.example",
        HASNA_SESSIONS_PRODUCTION_HOSTS: "internal-test.example",
      },
    });

    expect(result.gates.production.allowed).toBe(false);
    expect(result.gates.backup.ran).toBe(false);
    expect(result.applied.attempted).toBe(0);
    expect(store.imports).toEqual([]);
    expect(result.errors.some((error) => error.includes("requires --allow-production"))).toBe(true);
  });

  it("treats incomplete trailing rollout records as inventory errors", async () => {
    const file = join(root, "incomplete.jsonl");
    const parser = new FakeParser(
      new Map([[file, parsedSession("incomplete", file, [message("m1", "partial")])]]),
      new Set([file]),
    );

    const result = await runSessionBackfill({
      parsers: [parser],
      checkpointPath: join(root, "checkpoint.json"),
    });

    expect(result.inventory.errors).toBe(1);
    expect(result.inventory.selectableSessions).toBe(0);
    expect(result.selection.selectedKeys).toEqual([]);
    expect(result.errors).toEqual([`codex:${file}: incomplete trailing JSONL record`]);
  });

  it("treats malformed non-trailing rollout records as inventory errors", async () => {
    const file = join(root, "malformed-middle.jsonl");
    const parser = new FakeParser(
      new Map([[file, parsedSession("malformed", file, [message("m1", "before"), message("m2", "after")])]]),
      new Set(),
      new Set([file]),
    );

    const result = await runSessionBackfill({
      parsers: [parser],
      checkpointPath: join(root, "checkpoint.json"),
    });

    expect(result.inventory.errors).toBe(1);
    expect(result.inventory.selectableSessions).toBe(0);
    expect(result.selection.selectedKeys).toEqual([]);
    expect(result.errors).toEqual([`codex:${file}: malformed JSONL record count 1`]);
  });

  it("resumes from checkpoints only when the destination verifies completed content identity", async () => {
    const fileA = join(root, "a.jsonl");
    const fileB = join(root, "b.jsonl");
    const parser = new FakeParser(
      new Map([
        [fileA, parsedSession("a", fileA, [message("m1", "first")])],
        [fileB, parsedSession("b", fileB, [message("m2", "second")])],
      ]),
    );
    const checkpoint = join(root, "checkpoint.json");

    const firstStore = fakeStore();
    const first = await runSessionBackfill({
      parsers: [parser],
      store: firstStore,
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      allowProduction: true,
      backupCommand: "true",
      allSources: true,
      maxTotalBytes: 1024 * 1024,
      checkpointPath: checkpoint,
      env: { HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });

    expect(first.applied.pushed).toBe(2);
    expect(first.applied.failed).toBe(0);
    expect(firstStore.imports).toEqual(["codex:a", "codex:b"]);

    const secondStore = firstStore;
    secondStore.imports.length = 0;
    const second = await runSessionBackfill({
      parsers: [parser],
      store: secondStore,
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      allowProduction: true,
      backupCommand: "true",
      allSources: true,
      maxTotalBytes: 1024 * 1024,
      checkpointPath: checkpoint,
      env: { HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });

    expect(second.checkpoint.loadedCompleted).toBe(2);
    expect(second.checkpoint.resumedSkipped).toBe(2);
    expect(second.applied.pushed).toBe(0);
    expect(secondStore.imports).toEqual([]);
  });

  it("does not let a hand-authored matching checkpoint suppress import without destination proof", async () => {
    const file = join(root, "fabricated.jsonl");
    const parser = new FakeParser(new Map([[file, parsedSession("fabricated", file, [message("m1", "current")])]]));
    const checkpoint = join(root, "checkpoint.json");

    const inventory = await runSessionBackfill({
      parsers: [parser],
      source: "codex",
      pilot: 1,
      checkpointPath: checkpoint,
    });
    expect(inventory.errors).toEqual([]);
    const store = fakeStore();
    const entry = {
      source: "codex",
      sourceId: "fabricated",
      sourcePath: file,
      estimatedBytes: inventory.selection.selectedEstimatedBytes,
      messages: 1,
      toolCalls: 0,
      sourceContentDigest: "unknown-to-attacker",
      runConfigDigest: "unknown-to-attacker",
      updatedAt: "2026-07-17T09:00:00.000Z",
    };
    writeFileSync(
      checkpoint,
      `${JSON.stringify({
        version: 2,
        createdAt: "2026-07-17T09:00:00.000Z",
        updatedAt: "2026-07-17T09:00:00.000Z",
        completed: { "codex:fabricated": entry },
        failed: {},
        skipped: {},
      })}\n`,
    );

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
      checkpointPath: checkpoint,
      env: { HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });

    expect(result.checkpoint.loadedCompleted).toBe(1);
    expect(result.checkpoint.resumedSkipped).toBe(0);
    expect(result.applied.pushed).toBe(1);
    expect(store.imports).toEqual(["codex:fabricated"]);
    expect(result.warnings).toEqual([
      "codex:fabricated: quarantined invalid completed checkpoint entry; current inventory will be re-imported",
    ]);
  });

  it("does not resume when destination has matching path and counts but no backfill metadata", async () => {
    const file = join(root, "no-metadata.jsonl");
    const session = parsedSession("no-metadata", file, [message("m1", "current")]);
    const parser = new FakeParser(new Map([[file, session]]));
    const checkpoint = join(root, "checkpoint.json");
    const firstStore = fakeStore();

    const first = await runSessionBackfill({
      parsers: [parser],
      store: firstStore,
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      allowProduction: true,
      backupCommand: "true",
      source: "codex",
      pilot: 1,
      maxTotalBytes: 1024 * 1024,
      checkpointPath: checkpoint,
      env: { HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });
    expect(first.applied.pushed).toBe(1);

    const secondStore = fakeStore({
      existing: [{ ...session, session: { ...session.session, metadata: {} } }],
    });
    const second = await runSessionBackfill({
      parsers: [parser],
      store: secondStore,
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      allowProduction: true,
      backupCommand: "true",
      source: "codex",
      pilot: 1,
      maxTotalBytes: 1024 * 1024,
      checkpointPath: checkpoint,
      env: { HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });

    expect(second.checkpoint.resumedSkipped).toBe(0);
    expect(second.applied.pushed).toBe(1);
    expect(secondStore.imports).toEqual(["codex:no-metadata"]);
    expect(second.warnings).toEqual([
      "codex:no-metadata: quarantined invalid completed checkpoint entry; current inventory will be re-imported",
    ]);
  });

  it("does not resume when destination backfill metadata is stale despite matching path and counts", async () => {
    const file = join(root, "stale-destination.jsonl");
    const session = parsedSession("stale-destination", file, [message("m1", "current")]);
    const parser = new FakeParser(new Map([[file, session]]));
    const checkpoint = join(root, "checkpoint.json");
    const firstStore = fakeStore();

    const first = await runSessionBackfill({
      parsers: [parser],
      store: firstStore,
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      allowProduction: true,
      backupCommand: "true",
      source: "codex",
      pilot: 1,
      maxTotalBytes: 1024 * 1024,
      checkpointPath: checkpoint,
      env: { HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });
    expect(first.applied.pushed).toBe(1);

    const secondStore = fakeStore({
      existing: [
        {
          ...session,
          session: {
            ...session.session,
            metadata: { backfill: { version: 2, sourceContentDigest: "stale", runConfigDigest: "stale" } },
          },
        },
      ],
    });
    const second = await runSessionBackfill({
      parsers: [parser],
      store: secondStore,
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      allowProduction: true,
      backupCommand: "true",
      source: "codex",
      pilot: 1,
      maxTotalBytes: 1024 * 1024,
      checkpointPath: checkpoint,
      env: { HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });

    expect(second.checkpoint.resumedSkipped).toBe(0);
    expect(second.applied.pushed).toBe(1);
    expect(secondStore.imports).toEqual(["codex:stale-destination"]);
  });

  it("quarantines stale completed checkpoints instead of silently skipping selected apply entries", async () => {
    const file = join(root, "stale.jsonl");
    const parser = new FakeParser(new Map([[file, parsedSession("stale", file, [message("m1", "current")])]]));
    const checkpoint = join(root, "checkpoint.json");
    writeFileSync(
      checkpoint,
      `${JSON.stringify({
        version: 1,
        createdAt: "2026-07-17T09:00:00.000Z",
        updatedAt: "2026-07-17T09:00:00.000Z",
        completed: {
          "codex:stale": {
            source: "codex",
            sourceId: "stale",
            sourcePath: file,
            estimatedBytes: 1,
            messages: 99,
            toolCalls: 0,
            updatedAt: "2026-07-17T09:00:00.000Z",
          },
        },
        failed: {},
        skipped: {},
      })}\n`,
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
      maxTotalBytes: 1024 * 1024,
      checkpointPath: checkpoint,
      env: { HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });

    expect(result.checkpoint.loadedCompleted).toBe(0);
    expect(result.checkpoint.resumedSkipped).toBe(0);
    expect(result.applied.pushed).toBe(1);
    expect(store.imports).toEqual(["codex:stale"]);
    expect(result.warnings).toEqual([]);
    const saved = JSON.parse(readFileSync(checkpoint, "utf-8"));
    expect(saved.completed["codex:stale"].messages).toBe(1);
  });

  it("requires an explicit apply boundary so omitted selectors cannot import every session", async () => {
    const fileA = join(root, "a.jsonl");
    const fileB = join(root, "b.jsonl");
    const parser = new FakeParser(
      new Map([
        [fileA, parsedSession("a", fileA, [message("m1", "first")])],
        [fileB, parsedSession("b", fileB, [message("m2", "second")])],
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
      maxTotalBytes: 1024 * 1024,
      checkpointPath: join(root, "checkpoint.json"),
      env: { HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });

    expect(result.selection.selectedKeys).toEqual(["codex:a", "codex:b"]);
    expect(result.gates.backup.ran).toBe(false);
    expect(result.applied.attempted).toBe(0);
    expect(store.imports).toEqual([]);
    expect(result.errors).toContain(
      "apply requires an explicit boundary: --source plus --pilot, --range-start/--range-end, or --known-id; use --all-sources to acknowledge all non-duplicate sessions",
    );
  });

  it("allows all-session apply only with the explicit all-sources acknowledgement", async () => {
    const fileA = join(root, "a.jsonl");
    const fileB = join(root, "b.jsonl");
    const parser = new FakeParser(
      new Map([
        [fileA, parsedSession("a", fileA, [message("m1", "first")])],
        [fileB, parsedSession("b", fileB, [message("m2", "second")])],
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
      allSources: true,
      maxTotalBytes: 1024 * 1024,
      checkpointPath: join(root, "checkpoint.json"),
      env: { HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });

    expect(result.errors).toEqual([]);
    expect(result.applied.pushed).toBe(2);
    expect(store.imports).toEqual(["codex:a", "codex:b"]);
  });

  it("fails closed on contradictory all-sources and known-id selectors", async () => {
    const fileA = join(root, "a.jsonl");
    const parser = new FakeParser(new Map([[fileA, parsedSession("a", fileA, [message("m1", "first")])]]));
    const store = fakeStore();

    const result = await runSessionBackfill({
      parsers: [parser],
      store,
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      allowProduction: true,
      backupCommand: "true",
      allSources: true,
      knownIds: ["codex:a"],
      maxTotalBytes: 1024 * 1024,
      checkpointPath: join(root, "checkpoint.json"),
      env: { HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });

    expect(result.gates.backup.ran).toBe(false);
    expect(result.applied.attempted).toBe(0);
    expect(store.imports).toEqual([]);
    expect(result.errors).toContain("apply selectors are contradictory: --all-sources cannot be combined with --known-id");
  });

  it("uses known ids as the selected apply boundary when no pilot or range is supplied", async () => {
    const fileA = join(root, "a.jsonl");
    const fileB = join(root, "b.jsonl");
    const parser = new FakeParser(
      new Map([
        [fileA, parsedSession("a", fileA, [message("m1", "first")])],
        [fileB, parsedSession("b", fileB, [message("m2", "second")])],
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
      knownIds: ["codex:b"],
      maxTotalBytes: 1024 * 1024,
      checkpointPath: join(root, "checkpoint.json"),
      env: { HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });

    expect(result.selection.selectedKeys).toEqual(["codex:b"]);
    expect(result.selection.knownIds).toEqual([
      { source: "codex", sourceId: "b", key: "codex:b", found: true, selected: true, verified: true },
    ]);
    expect(result.errors).toEqual([]);
    expect(store.imports).toEqual(["codex:b"]);
  });

});
