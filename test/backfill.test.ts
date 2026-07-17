import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSessionBackfill } from "../src/lib/backfill.js";
import type { SessionParser } from "../src/lib/ingest/types.js";
import type {
  MessageInsert,
  ParsedSession,
  Session,
  SessionContentImport,
  SessionSource,
  StagedParsedSession,
  ToolCallInsert,
} from "../src/types/index.js";
import type { SessionStore } from "../src/db/session-store.js";

let root: string;
const repoRoot = join(import.meta.dir, "..");

beforeEach(() => {
  root = join(tmpdir(), `sessions-backfill-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function message(id: string, content: string): MessageInsert {
  return {
    id,
    session_id: "",
    role: "user",
    content,
    sequence_num: Number(id.replace(/\D/g, "")) || 0,
    timestamp: "2026-07-17T10:00:00Z",
  };
}

function parsedSession(sourceId: string, sourcePath: string, messages: MessageInsert[]): ParsedSession {
  return {
    session: {
      source: "codex",
      source_id: sourceId,
      source_path: sourcePath,
      project_path: "/tmp/project",
      project_name: "project",
      title: sourceId,
    },
    messages,
    toolCalls: [],
  };
}

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function stagedSession(
  sourceId: string,
  sourcePath: string,
  messages: MessageInsert[],
  toolCalls: ToolCallInsert[] = [],
): StagedParsedSession {
  return {
    session: {
      source: "codex",
      source_id: sourceId,
      source_path: sourcePath,
      project_path: "/tmp/project",
      project_name: "project",
      title: sourceId,
    },
    messageCount: messages.length,
    toolCallCount: toolCalls.length,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalThinkingTokens: 0,
    maxNormalizedBatchRecords: 1,
    forEachMessageBatch: (batchSize, callback) => {
      for (const batch of chunked(messages, batchSize)) callback(batch);
    },
    forEachToolCallBatch: (batchSize, callback) => {
      for (const batch of chunked(toolCalls, batchSize)) callback(batch);
    },
    cleanup: () => {},
  };
}

class FakeParser implements SessionParser {
  readonly source: SessionSource = "codex";

  constructor(private readonly byFile: Map<string, ParsedSession | StagedParsedSession>) {}

  sessionRoots(): string[] {
    return [root];
  }

  listSessionFiles(): string[] {
    return [...this.byFile.keys()];
  }

  parseFile(filePath: string): ParsedSession[] {
    const value = this.byFile.get(filePath);
    return value && "messages" in value ? [value] : [];
  }

  parseFileResult(filePath: string) {
    const value = this.byFile.get(filePath);
    if (!value) return { sessions: [] };
    if ("messages" in value) {
      return { sessions: [value], maxBufferedLineBytes: 7, maxNormalizedBatchRecords: value.messages.length };
    }
    return { sessions: [], stagedSessions: [value], maxBufferedLineBytes: 11, maxNormalizedBatchRecords: 1 };
  }
}

function sessionFromImport(input: SessionContentImport): Session {
  return {
    id: `${input.session.source}-${input.session.source_id}`,
    source: input.session.source,
    source_id: input.session.source_id,
    source_path: input.session.source_path ?? null,
    title: input.session.title ?? null,
    project_path: input.session.project_path ?? null,
    project_name: input.session.project_name ?? null,
    model: input.session.model ?? null,
    model_provider: input.session.model_provider ?? null,
    git_branch: input.session.git_branch ?? null,
    git_sha: input.session.git_sha ?? null,
    git_origin_url: input.session.git_origin_url ?? null,
    cli_version: input.session.cli_version ?? null,
    is_subagent: input.session.is_subagent ?? false,
    parent_session_id: input.session.parent_session_id ?? null,
    total_input_tokens: input.session.total_input_tokens ?? 0,
    total_output_tokens: input.session.total_output_tokens ?? 0,
    total_cache_read_tokens: input.session.total_cache_read_tokens ?? 0,
    total_cache_write_tokens: input.session.total_cache_write_tokens ?? 0,
    total_thinking_tokens: input.session.total_thinking_tokens ?? 0,
    message_count: input.messages.length,
    tool_call_count: input.toolCalls.length,
    started_at: input.session.started_at ?? null,
    ended_at: input.session.ended_at ?? null,
    duration_seconds: input.session.duration_seconds ?? null,
    ingested_at: "2026-07-17T10:00:00Z",
    updated_at: "2026-07-17T10:00:00Z",
    source_modified_at: input.session.source_modified_at ?? null,
    machine: input.session.machine ?? null,
    metadata: input.session.metadata ?? {},
  };
}

function fakeStore(options: { failOn?: string } = {}): SessionStore & { imports: string[] } {
  const imported = new Map<string, Session>();
  const store = {
    mode: "cloud" as const,
    imports: [] as string[],
    async importContent(input: SessionContentImport) {
      const key = `${input.session.source}:${input.session.source_id}`;
      store.imports.push(key);
      if (options.failOn === key) throw new Error("simulated interruption");
      const session = sessionFromImport(input);
      imported.set(key, session);
      return { session, imported: { messages: input.messages.length, toolCalls: input.toolCalls.length }, backup: input.backup ?? null };
    },
    async get(idOrPrefix: string, opts = {}) {
      return imported.get(`${opts.source ?? "codex"}:${idOrPrefix}`) ?? null;
    },
    list: async () => [],
    recent: async () => [],
    create: async () => {
      throw new Error("not used");
    },
    remove: async () => false,
    rename: async () => null,
    relocatePaths: async () => ({ rowsUpdated: 0 }),
    search: async () => [],
    machines: async () => [],
    stats: async () => ({ session_count: 0, message_count: 0, tool_call_count: 0, by_source: [], projects: [] }),
    messages: async () => [],
    toolCalls: async () => [],
    searchContent: async () => [],
    searchToolCalls: async () => [],
    semanticSearch: async () => [],
    hybridSearch: async () => [],
    recall: async () => ({ query: "", results: [], evidence: [], metadata: { degraded: [], variants: [] } }),
    graphEntities: async () => [],
    graphRelated: async () => [],
    graphSession: async () => null,
    embed: async () => ({ embedded: 0, skipped: 0 }),
    mergeFromDb: async () => ({ sessions: 0, messages: 0, tool_calls: 0, embeddings: 0 }),
    ingest: async () => [],
    recomputeMachines: async () => {},
  } satisfies SessionStore & { imports: string[] };
  return store;
}

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
      env: { HASNA_SESSIONS_API_URL: "https://sessions.hasna.xyz" },
    });

    expect(result.gates.production.allowed).toBe(false);
    expect(result.gates.backup.ran).toBe(false);
    expect(result.applied.attempted).toBe(0);
    expect(store.imports).toEqual([]);
    expect(result.errors.some((error) => error.includes("requires --allow-production"))).toBe(true);
  });

  it("resumes from checkpoints without re-importing completed sessions", async () => {
    const fileA = join(root, "a.jsonl");
    const fileB = join(root, "b.jsonl");
    const parser = new FakeParser(
      new Map([
        [fileA, parsedSession("a", fileA, [message("m1", "first")])],
        [fileB, parsedSession("b", fileB, [message("m2", "second")])],
      ]),
    );
    const checkpoint = join(root, "checkpoint.json");

    const firstStore = fakeStore({ failOn: "codex:b" });
    const first = await runSessionBackfill({
      parsers: [parser],
      store: firstStore,
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      allowProduction: true,
      backupCommand: "true",
      maxTotalBytes: 1024 * 1024,
      checkpointPath: checkpoint,
      env: { HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });

    expect(first.applied.pushed).toBe(1);
    expect(first.applied.failed).toBe(1);
    expect(firstStore.imports).toEqual(["codex:a", "codex:b"]);

    const secondStore = fakeStore();
    const second = await runSessionBackfill({
      parsers: [parser],
      store: secondStore,
      apply: true,
      confirmApply: "BACKFILL_APPLY",
      allowProduction: true,
      backupCommand: "true",
      maxTotalBytes: 1024 * 1024,
      checkpointPath: checkpoint,
      env: { HASNA_SESSIONS_API_URL: "https://staging.example.test" },
    });

    expect(second.checkpoint.loadedCompleted).toBe(1);
    expect(second.checkpoint.resumedSkipped).toBe(1);
    expect(second.applied.pushed).toBe(1);
    expect(secondStore.imports).toEqual(["codex:b"]);
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
});
