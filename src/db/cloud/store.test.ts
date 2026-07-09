import { describe, expect, test } from "bun:test";
import type { QueryResultRow } from "pg";
import type { TypedQueryClient } from "../../generated/storage-kit/index.js";
import { upsertSession } from "./store.js";

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
});
