import { afterEach, beforeEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

export let root: string;
export const repoRoot = join(import.meta.dir, "..");

export function setupBackfillTest(): void {
  beforeEach(() => {
    root = join(tmpdir(), `sessions-backfill-${crypto.randomUUID()}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
}

export function message(id: string, content: string): MessageInsert {
  return {
    id,
    session_id: "",
    role: "user",
    content,
    sequence_num: Number(id.replace(/\D/g, "")) || 0,
    timestamp: "2026-07-17T10:00:00Z",
  };
}

export function parsedSession(sourceId: string, sourcePath: string, messages: MessageInsert[]): ParsedSession {
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

export function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export function stagedSession(
  sourceId: string,
  sourcePath: string,
  messages: MessageInsert[],
  toolCalls: ToolCallInsert[] = [],
  cleanup: () => void = () => {},
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
    cleanup,
  };
}

export class FakeParser implements SessionParser {
  readonly source: SessionSource = "codex";

  constructor(
    private readonly byFile: Map<string, ParsedSession | StagedParsedSession>,
    private readonly incompleteFiles = new Set<string>(),
    private readonly malformedFiles = new Set<string>(),
  ) {}

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
      return {
        sessions: [value],
        incompleteTrailingRecord: this.incompleteFiles.has(filePath),
        malformedRecordCount: this.malformedFiles.has(filePath) ? 1 : 0,
        maxBufferedLineBytes: 7,
        maxNormalizedBatchRecords: value.messages.length,
      };
    }
    return {
      sessions: [],
      stagedSessions: [value],
      incompleteTrailingRecord: this.incompleteFiles.has(filePath),
      malformedRecordCount: this.malformedFiles.has(filePath) ? 1 : 0,
      maxBufferedLineBytes: 11,
      maxNormalizedBatchRecords: 1,
      sourceContentDigest: `digest-${value.session.source_id}`,
    };
  }
}

export class LegacyParser extends FakeParser {
  parseFileResult = undefined;
}

export class RaceParser implements SessionParser {
  readonly source: SessionSource = "codex";
  calls = 0;

  constructor(
    private readonly file: string,
    private readonly before: ParsedSession,
    private readonly after: ParsedSession,
  ) {}

  sessionRoots(): string[] {
    return [root];
  }

  listSessionFiles(): string[] {
    return [this.file];
  }

  parseFile(): ParsedSession[] {
    return [];
  }

  parseFileResult() {
    this.calls++;
    const session = this.calls === 1 ? this.before : this.after;
    return {
      sessions: [session],
      incompleteTrailingRecord: false,
      malformedRecordCount: 0,
      maxBufferedLineBytes: 7,
      maxNormalizedBatchRecords: session.messages.length,
      sourceContentDigest: `digest-${this.calls}`,
    };
  }
}

export class StagedRaceParser implements SessionParser {
  readonly source: SessionSource = "codex";
  calls = 0;

  constructor(
    private readonly file: string,
    private readonly before: StagedParsedSession,
    private readonly after: StagedParsedSession,
  ) {}

  sessionRoots(): string[] {
    return [root];
  }

  listSessionFiles(): string[] {
    return [this.file];
  }

  parseFile(): ParsedSession[] {
    return [];
  }

  parseFileResult() {
    this.calls++;
    const session = this.calls === 1 ? this.before : this.after;
    return {
      sessions: [],
      stagedSessions: [session],
      incompleteTrailingRecord: false,
      malformedRecordCount: 0,
      maxBufferedLineBytes: 7,
      maxNormalizedBatchRecords: session.maxNormalizedBatchRecords,
    };
  }
}

export function sessionFromImport(input: SessionContentImport): Session {
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

export function fakeStore(options: { failOn?: string; existing?: SessionContentImport[] } = {}): SessionStore & { imports: string[] } {
  const imported = new Map<string, Session>();
  for (const input of options.existing ?? []) {
    imported.set(`${input.session.source}:${input.session.source_id}`, sessionFromImport(input));
  }
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

export function localFakeStore(): SessionStore & { imports: string[] } {
  return {
    ...fakeStore(),
    mode: "local" as const,
  };
}
