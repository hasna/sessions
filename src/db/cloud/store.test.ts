import { describe, expect, test } from "bun:test";
import type { QueryResultRow } from "pg";
import type { PoolQueryClient, TypedQueryClient } from "../../generated/storage-kit/index.js";
import type { SessionContentImport } from "../../types/index.js";
import { SessionAmbiguousError, SessionInvalidIdentifierError } from "../../types/index.js";
import { getSessionByPrefix, importSessionContent, upsertSession } from "./store.js";

function splitSqlList(list: string): string[] {
  return list
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function sessionRowFromParams(params: readonly unknown[]): QueryResultRow {
  return {
    id: params[0],
    source: params[1],
    source_id: params[2],
    source_path: params[3],
    title: params[4],
    project_path: params[5],
    project_name: params[6],
    model: params[7],
    model_provider: params[8],
    git_branch: params[9],
    git_sha: params[10],
    git_origin_url: params[11],
    cli_version: params[12],
    is_subagent: params[13],
    parent_session_id: params[14],
    total_input_tokens: params[15],
    total_output_tokens: params[16],
    total_cache_read_tokens: params[17],
    total_cache_write_tokens: params[18],
    total_thinking_tokens: params[19],
    message_count: params[20],
    tool_call_count: params[21],
    started_at: params[22],
    ended_at: params[23],
    duration_seconds: params[24],
    source_modified_at: params[25],
    machine: params[26],
    ingested_at: params[27],
    updated_at: params[28],
    metadata: params[29],
  };
}

function sessionRow(overrides: Partial<QueryResultRow>): QueryResultRow {
  return {
    id: "row-id",
    source: "claude",
    source_id: "row-source-id",
    source_path: null,
    title: null,
    project_path: null,
    project_name: null,
    model: null,
    model_provider: null,
    git_branch: null,
    git_sha: null,
    git_origin_url: null,
    cli_version: null,
    is_subagent: false,
    parent_session_id: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_write_tokens: 0,
    total_thinking_tokens: 0,
    message_count: 0,
    tool_call_count: 0,
    started_at: null,
    ended_at: null,
    duration_seconds: null,
    ingested_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    source_modified_at: null,
    machine: null,
    metadata: "{}",
    ...overrides,
  };
}

function literalPrefixFromSqlLikePattern(pattern: string): string {
  if (!pattern.endsWith("%")) throw new Error(`expected trailing wildcard: ${pattern}`);
  let literal = "";
  for (let i = 0; i < pattern.length - 1; i++) {
    const char = pattern[i];
    if (char === "\\") {
      i++;
      literal += pattern[i] ?? "";
    } else {
      literal += char;
    }
  }
  return literal;
}

describe("cloud getSessionByPrefix lookup semantics", () => {
  test("prefers exact internal ids over provider-native id collisions", async () => {
    const internal = sessionRow({
      id: "same-string",
      source: "claude",
      source_id: "claude-native",
      title: "internal",
    });
    const client: TypedQueryClient = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async many() {
        throw new Error("many() should not be used after exact internal id match");
      },
      async one() {
        throw new Error("one() not used in this test");
      },
      async get<T extends QueryResultRow>(sql: string): Promise<T | null> {
        if (sql.includes("WHERE id = $1")) return internal as T;
        return null;
      },
      async execute() {},
    };

    await expect(getSessionByPrefix("same-string", client)).resolves.toMatchObject({
      id: "same-string",
      source_id: "claude-native",
    });
  });

  test("throws on unqualified duplicate provider-native ids and resolves qualified ids", async () => {
    const codex = sessionRow({ id: "codex-row", source: "codex", source_id: "native-dup" });
    const codewith = sessionRow({ id: "codewith-row", source: "codewith", source_id: "native-dup" });
    const client: TypedQueryClient = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async many<T extends QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<T[]> {
        if (sql.includes("source = $1 AND source_id = $2")) {
          return (params?.[0] === "codewith" ? [codewith] : [codex]) as T[];
        }
        if (sql.includes("source_id = $1")) return [codex, codewith] as T[];
        if (sql.includes("LIKE")) return [];
        throw new Error(`unexpected many SQL: ${sql}`);
      },
      async one() {
        throw new Error("one() not used in this test");
      },
      async get() {
        return null;
      },
      async execute() {},
    };

    await expect(getSessionByPrefix("native-dup", client)).rejects.toThrow(SessionAmbiguousError);
    await expect(getSessionByPrefix("codewith:native-dup", client)).resolves.toMatchObject({
      id: "codewith-row",
      source: "codewith",
    });
    await expect(getSessionByPrefix("native-dup", { source: "codex" }, client)).resolves.toMatchObject({
      id: "codex-row",
      source: "codex",
    });
  });

  test("treats _ and % in cloud prefix lookups as literals", async () => {
    const rows = [
      sessionRow({ id: "codex-abc1", source: "codex", source_id: "abc1" }),
      sessionRow({ id: "codewith-pct1", source: "codewith", source_id: "pct1" }),
    ];
    const seenPatterns: string[] = [];
    const client: TypedQueryClient = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async many<T extends QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<T[]> {
        if (sql.includes("source = $1 AND source_id = $2")) {
          return rows.filter((row) => row.source === params?.[0] && row.source_id === params?.[1]) as T[];
        }
        if (sql.includes("source_id = $1") && !sql.includes("LIKE")) {
          return rows.filter((row) => row.source_id === params?.[0]) as T[];
        }
        if (sql.includes("LIKE")) {
          expect(sql).toContain("ESCAPE '\\'");
          const pattern = params?.[sql.includes("source = $1") ? 1 : 0] as string;
          seenPatterns.push(pattern);
          const literal = literalPrefixFromSqlLikePattern(pattern);
          return rows
            .filter((row) => {
              if (sql.includes("source = $1") && row.source !== params?.[0]) return false;
              return row.source_id.startsWith(literal) || row.id.startsWith(literal);
            }) as T[];
        }
        throw new Error(`unexpected many SQL: ${sql}`);
      },
      async one() {
        throw new Error("one() not used in this test");
      },
      async get() {
        return null;
      },
      async execute() {},
    };

    await expect(getSessionByPrefix("abc_", client)).resolves.toBeNull();
    await expect(getSessionByPrefix("codewith:abc_", client)).resolves.toBeNull();
    await expect(getSessionByPrefix("pct%", client)).resolves.toBeNull();
    await expect(getSessionByPrefix("codewith:pct%", client)).resolves.toBeNull();
    expect(seenPatterns).toContain("abc\\_%");
    expect(seenPatterns).toContain("pct\\%%");
  });

  test("keeps literal _ and % cloud prefixes ambiguous when multiple rows match", async () => {
    const rows = [
      sessionRow({ id: "codewith-abc-under-1", source: "codewith", source_id: "abc_1" }),
      sessionRow({ id: "codewith-abc-under-2", source: "codewith", source_id: "abc_2" }),
      sessionRow({ id: "codewith-pct-1", source: "codewith", source_id: "pct%1" }),
      sessionRow({ id: "codewith-pct-2", source: "codewith", source_id: "pct%2" }),
    ];
    const client: TypedQueryClient = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async many<T extends QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<T[]> {
        if (sql.includes("source = $1 AND source_id = $2")) return [] as T[];
        if (sql.includes("source_id = $1") && !sql.includes("LIKE")) return [] as T[];
        if (sql.includes("LIKE")) {
          expect(sql).toContain("ESCAPE '\\'");
          const pattern = params?.[sql.includes("source = $1") ? 1 : 0] as string;
          const literal = literalPrefixFromSqlLikePattern(pattern);
          return rows
            .filter((row) => {
              if (sql.includes("source = $1") && row.source !== params?.[0]) return false;
              return row.source_id.startsWith(literal) || row.id.startsWith(literal);
            }) as T[];
        }
        throw new Error(`unexpected many SQL: ${sql}`);
      },
      async one() {
        throw new Error("one() not used in this test");
      },
      async get() {
        return null;
      },
      async execute() {},
    };

    await expect(getSessionByPrefix("abc_", client)).rejects.toThrow(SessionAmbiguousError);
    await expect(getSessionByPrefix("codewith:abc_", client)).rejects.toThrow(SessionAmbiguousError);
    await expect(getSessionByPrefix("pct%", client)).rejects.toThrow(SessionAmbiguousError);
    await expect(getSessionByPrefix("codewith:pct%", client)).rejects.toThrow(SessionAmbiguousError);
  });

  test("rejects empty source-qualified cloud identifiers before prefix queries", async () => {
    let reads = 0;
    const client: TypedQueryClient = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async many() {
        reads++;
        throw new Error("many() should not be used for an empty source-qualified identifier");
      },
      async one() {
        throw new Error("one() not used in this test");
      },
      async get() {
        reads++;
        return null;
      },
      async execute() {},
    };

    await expect(getSessionByPrefix("codewith:", client)).rejects.toThrow(
      SessionInvalidIdentifierError,
    );
    await expect(getSessionByPrefix("", { source: "codewith" }, client)).rejects.toThrow(
      SessionInvalidIdentifierError,
    );
    expect(reads).toBe(0);
  });
});

describe("cloud upsertSession SQL", () => {
  test("binds one value per sessions column including metadata", async () => {
    let insertSql = "";
    let insertParams: readonly unknown[] = [];
    const client: TypedQueryClient = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async many() {
        return [];
      },
      async one() {
        throw new Error("one() not used in this test");
      },
      async get<T extends QueryResultRow>(sql: string): Promise<T | null> {
        if (sql.includes("WHERE source = $1 AND source_id = $2")) return null;
        if (sql.includes("WHERE id = $1")) return sessionRowFromParams(insertParams) as T;
        throw new Error(`unexpected get SQL: ${sql}`);
      },
      async execute(sql: string, params?: readonly unknown[]): Promise<void> {
        insertSql = sql;
        insertParams = params ?? [];
      },
    };

    const session = await upsertSession(
      {
        id: "cloud-bind-1",
        source: "claude",
        source_id: "cloud-bind-1",
        title: "metadata binding regression",
        machine: "spark01",
        metadata: { reviewer: "postgres", safe: true },
      },
      client,
    );

    const columns = splitSqlList(insertSql.match(/INSERT INTO sessions \(([\s\S]*?)\)\s+VALUES/)?.[1] ?? "");
    const values = splitSqlList(insertSql.match(/VALUES \(([\s\S]*?)\)\s+ON CONFLICT/)?.[1] ?? "");
    expect(columns).toHaveLength(30);
    expect(values).toHaveLength(30);
    expect(values.at(-4)).toBe("$27");
    expect(values.at(-3)).toBe("$28");
    expect(values.at(-2)).toBe("$29");
    expect(values.at(-1)).toBe("$30");
    expect(new Set(values)).toHaveProperty("size", 30);
    expect(insertParams).toHaveLength(30);
    expect(insertParams[26]).toBe("spark01");
    expect(typeof insertParams[27]).toBe("string");
    expect(typeof insertParams[28]).toBe("string");
    expect(JSON.parse(insertParams[29] as string)).toEqual({ reviewer: "postgres", safe: true });
    expect(session.metadata).toEqual({ reviewer: "postgres", safe: true });
  });

  test("accepts codewith and keeps rejecting unknown sources before SQL writes", async () => {
    let insertParams: readonly unknown[] = [];
    let writes = 0;
    const client: TypedQueryClient = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async many() {
        return [];
      },
      async one() {
        throw new Error("one() not used in this test");
      },
      async get<T extends QueryResultRow>(sql: string): Promise<T | null> {
        if (sql.includes("WHERE source = $1 AND source_id = $2")) return null;
        if (sql.includes("WHERE id = $1")) return sessionRowFromParams(insertParams) as T;
        throw new Error(`unexpected get SQL: ${sql}`);
      },
      async execute(_sql: string, params?: readonly unknown[]): Promise<void> {
        writes++;
        insertParams = params ?? [];
      },
    };

    const session = await upsertSession(
      {
        id: "cloud-codewith-1",
        source: "codewith",
        source_id: "shared-native-id",
        title: "Codewith cloud source",
      },
      client,
    );
    expect(session.source).toBe("codewith");
    expect(insertParams[1]).toBe("codewith");

    await expect(
      upsertSession({ source: "unknown", source_id: "bad" }, client)
    ).rejects.toThrow(/expected claude\|codex\|codewith\|gemini/);
    expect(writes).toBe(1);
  });
});

describe("cloud import sanitization", () => {
  test("strips NUL bytes from imported text and metadata before SQL binds", async () => {
    const messageParams: readonly unknown[][] = [];
    const toolParams: readonly unknown[][] = [];
    let sessionParams: readonly unknown[] = [];

    const tx: TypedQueryClient = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async many() {
        return [];
      },
      async one() {
        throw new Error("one() not used in this test");
      },
      async get<T extends QueryResultRow>(sql: string): Promise<T | null> {
        if (sql.includes("WHERE source = $1 AND source_id = $2")) return null;
        if (sql.includes("WHERE id = $1")) return sessionRowFromParams(sessionParams) as T;
        throw new Error(`unexpected get SQL: ${sql}`);
      },
      async execute(sql: string, params?: readonly unknown[]): Promise<void> {
        if (sql.includes("INSERT INTO sessions")) {
          sessionParams = params ?? [];
          return;
        }
        if (sql.includes("INSERT INTO messages")) {
          messageParams.push(params ?? []);
          return;
        }
        if (sql.includes("INSERT INTO tool_calls")) {
          toolParams.push(params ?? []);
        }
      },
    };

    const client: PoolQueryClient = {
      ...tx,
      pool: null as never,
      close: async () => {},
      transaction: async (fn) => fn(tx),
    };

    const input: SessionContentImport = {
      session: {
        id: "nul-session",
        source: "claude",
        source_id: "nul-session",
        title: "ti\u0000tle",
        project_path: "/tmp/pro\u0000ject",
        metadata: {
          "ke\u0000y": "va\u0000lue",
          nested: ["a\u0000b", { ok: "c\u0000d" }],
        },
      },
      messages: [
        {
          id: "nul-message",
          session_id: "nul-session",
          role: "assistant",
          content: "hel\u0000lo",
          content_preview: "pre\u0000view",
          metadata: { reason: "nul\u0000byte", nested: { value: "m\u0000eta" } },
        },
      ],
      toolCalls: [
        {
          id: "nul-tool",
          session_id: "nul-session",
          message_id: "nul-message",
          tool_name: "Ba\u0000sh",
          tool_input: "ec\u0000ho",
          tool_output: "do\u0000ne",
          metadata: { command: "ls\u0000 -la" },
        },
      ],
    };

    await importSessionContent(input, client);

    expect(sessionParams[4]).toBe("title");
    expect(sessionParams[5]).toBe("/tmp/project");
    expect(JSON.parse(sessionParams[29] as string)).toEqual({
      key: "value",
      nested: ["ab", { ok: "cd" }],
    });
    expect(messageParams[0]?.[5]).toBe("hello");
    expect(messageParams[0]?.[6]).toBe("preview");
    expect(JSON.parse(messageParams[0]?.[16] as string)).toEqual({
      reason: "nulbyte",
      nested: { value: "meta" },
    });
    expect(toolParams[0]?.[3]).toBe("Bash");
    expect(toolParams[0]?.[4]).toBe("echo");
    expect(toolParams[0]?.[5]).toBe("done");
    expect(JSON.parse(toolParams[0]?.[9] as string)).toEqual({ command: "ls -la" });
    expect(JSON.stringify(input)).toContain("\\u0000");
  });

  test("preserves large aggregate token totals in session bind params", async () => {
    let sessionParams: readonly unknown[] = [];
    const tx: TypedQueryClient = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
      async many() {
        return [];
      },
      async one() {
        throw new Error("one() not used in this test");
      },
      async get<T extends QueryResultRow>(sql: string): Promise<T | null> {
        if (sql.includes("WHERE source = $1 AND source_id = $2")) return null;
        if (sql.includes("WHERE id = $1")) return sessionRowFromParams(sessionParams) as T;
        throw new Error(`unexpected get SQL: ${sql}`);
      },
      async execute(sql: string, params?: readonly unknown[]): Promise<void> {
        if (sql.includes("INSERT INTO sessions")) sessionParams = params ?? [];
      },
    };
    const client: PoolQueryClient = {
      ...tx,
      pool: null as never,
      close: async () => {},
      transaction: async (fn) => fn(tx),
    };

    await importSessionContent(
      {
        session: {
          id: "large-int-session",
          source: "claude",
          source_id: "large-int-session",
          total_cache_read_tokens: 3933601403,
        },
        messages: [
          {
            id: "large-int-message",
            session_id: "large-int-session",
            role: "assistant",
            cache_read_tokens: 2000000000,
            content: "synthetic",
          },
        ],
        toolCalls: [],
      },
      client,
    );

    expect(sessionParams[17]).toBe(3933601403);
  });
});
