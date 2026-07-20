import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, resetDatabase } from "./database.js";
import { resolveSessionStore } from "./session-store.js";

const CLOUD_ENV = {
  HASNA_SESSIONS_MODE: "self_hosted",
  HASNA_SESSIONS_API_URL: "https://sessions.your-deployment.example",
  HASNA_SESSIONS_API_KEY: "hasna_sessions_test_key",
} as const;

interface Call {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

function cloudStore(handler: (call: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers as HeadersInit);
    calls.push({
      method,
      url,
      auth: headers.get("authorization"),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const { status = 200, json = {} } = handler(calls[calls.length - 1]);
    return new Response(status === 204 ? null : JSON.stringify(json), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  const store = resolveSessionStore(CLOUD_ENV, { fetchImpl });
  return { store, calls };
}

describe("resolveSessionStore flip", () => {
  test("local when env unset", () => {
    expect(resolveSessionStore({}).mode).toBe("local");
  });

  test("cloud when self_hosted + URL + key set", () => {
    expect(resolveSessionStore(CLOUD_ENV).mode).toBe("cloud");
  });

  test("throws (no silent local drift) when cloud requested but misconfigured", () => {
    expect(() => resolveSessionStore({ HASNA_SESSIONS_MODE: "self_hosted" })).toThrow();
  });
});

describe("local Store importContent safety", () => {
  beforeEach(() => {
    process.env.SESSIONS_DB_PATH = ":memory:";
    resetDatabase();
  });

  afterEach(() => {
    closeDatabase();
    delete process.env.SESSIONS_DB_PATH;
  });

  test("blocks shrinking existing child content unless explicit destructive intent is present", async () => {
    const store = resolveSessionStore({});
    await store.importContent({
      session: { id: "safe-import-1", source: "claude", source_id: "safe-import-1" },
      messages: [
        { id: "m1", session_id: "safe-import-1", role: "user", content: "one" },
        { id: "m2", session_id: "safe-import-1", role: "assistant", content: "two" },
      ],
      toolCalls: [{ id: "t1", session_id: "safe-import-1", tool_name: "Bash" }],
    });

    await expect(
      store.importContent({
        session: { id: "safe-import-1", source: "claude", source_id: "safe-import-1" },
        messages: [],
        toolCalls: [],
      }),
    ).rejects.toThrow("content import would shrink existing session content");

    const replacement = await store.importContent({
      session: { id: "safe-import-1", source: "claude", source_id: "safe-import-1" },
      messages: [{ id: "m3", session_id: "safe-import-1", role: "user", content: "intentional replacement" }],
      toolCalls: [],
      destructive: {
        allowContentShrink: true,
        reason: "intentional test replacement",
      },
    });
    expect(replacement.imported).toEqual({ messages: 1, toolCalls: 0 });
  });
});

describe("cloud store routes to /v1 with bearer key", () => {
  test("list -> GET /v1/sessions with query + bearer, unwraps {sessions}", async () => {
    const { store, calls } = cloudStore(() => ({ json: { ok: true, sessions: [{ id: "s1" }] } }));
    const rows = await store.list({ machine: "spark01", limit: 5, source: "claude" });
    expect(rows).toEqual([{ id: "s1" }] as never);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("/v1/sessions");
    expect(calls[0].url).toContain("machine=spark01");
    expect(calls[0].url).toContain("source=claude");
    expect(calls[0].url).toContain("limit=5");
    expect(calls[0].auth).toBe("Bearer hasna_sessions_test_key");
  });

  test("create -> POST /v1/sessions, unwraps {session}", async () => {
    const { store, calls } = cloudStore((c) => ({ status: 201, json: { ok: true, session: { id: "new", ...(c.body as object) } } }));
    const created = await store.create({ source: "claude", source_id: "abc", title: "T" });
    expect((created as { id: string }).id).toBe("new");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/v1/sessions");
    expect(calls[0].body).toMatchObject({ source: "claude", source_id: "abc", title: "T" });
  });

  test("importContent -> POST /v1/sessions/import with content idempotency key", async () => {
    const { store, calls } = cloudStore((c) => ({
      status: 201,
      json: {
        ok: true,
        session: { id: "s1", source: "claude", source_id: "abc" },
        imported: {
          messages: ((c.body as { messages: unknown[] }).messages ?? []).length,
          toolCalls: ((c.body as { toolCalls: unknown[] }).toolCalls ?? []).length,
        },
        backup: (c.body as { backup?: unknown }).backup ?? null,
      },
    }));
    const result = await store.importContent({
      session: { id: "s1", source: "claude", source_id: "abc", title: "T" },
      messages: [{ id: "m1", session_id: "s1", role: "user", content: "hello" }],
      toolCalls: [{ id: "t1", session_id: "s1", tool_name: "Bash", tool_input: "pwd" }],
      backup: { artifact: "/tmp/pre-cloud-sync.db", created_at: "2026-07-09T10:00:00.000Z" },
      destructive: { allowContentShrink: true, reason: "test route shape" },
    });
    expect(result.imported).toEqual({ messages: 1, toolCalls: 1 });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/v1/sessions/import");
    expect(calls[0].body).toMatchObject({
      session: { source: "claude", source_id: "abc" },
      backup: { artifact: "/tmp/pre-cloud-sync.db" },
      destructive: { allowContentShrink: true, reason: "test route shape" },
    });
  });

  test("get -> 404 resolves to null", async () => {
    const { store } = cloudStore(() => ({ status: 404, json: { ok: false, error: "not found" } }));
    expect(await store.get("missing")).toBeNull();
  });

  test("remove -> DELETE /v1/sessions/:id true; 404 => false", async () => {
    const ok = cloudStore(() => ({ json: { ok: true, deleted: true, id: "x" } }));
    expect(await ok.store.remove("x")).toBe(true);
    expect(ok.calls[0].method).toBe("DELETE");
    expect(ok.calls[0].url).toContain("/v1/sessions/x");
    const gone = cloudStore(() => ({ status: 404, json: { ok: false } }));
    expect(await gone.store.remove("y")).toBe(false);
  });

  test("recent -> GET /v1/recent", async () => {
    const { store, calls } = cloudStore(() => ({ json: { ok: true, sessions: [] } }));
    await store.recent(3);
    expect(calls[0].url).toContain("/v1/recent");
    expect(calls[0].url).toContain("limit=3");
  });

  test("stats -> GET /v1/stats, strips ok", async () => {
    const { store } = cloudStore(() => ({
      json: { ok: true, session_count: 2, message_count: 4, tool_call_count: 6, by_source: [], projects: [] },
    }));
    const s = await store.stats();
    expect(s.session_count).toBe(2);
    expect((s as { ok?: boolean }).ok).toBeUndefined();
  });

  test("search -> GET /v1/search?q=, unwraps {results}", async () => {
    const { store, calls } = cloudStore(() => ({ json: { ok: true, results: [{ session: { id: "s" }, match: "title" }] } }));
    const hits = await store.search("hello", { limit: 2 });
    expect(hits).toHaveLength(1);
    expect(calls[0].url).toContain("/v1/search");
    expect(calls[0].url).toContain("q=hello");
  });

  test("machines -> GET /v1/machines, unwraps {machines}", async () => {
    const { store, calls } = cloudStore(() => ({ json: { ok: true, machines: [{ name: "spark01" }] } }));
    const m = await store.machines();
    expect(m).toHaveLength(1);
    expect(calls[0].url).toContain("/v1/machines");
  });

  test("messages/toolCalls -> /v1/sessions/:id content endpoints", async () => {
    const { store, calls } = cloudStore((c) => {
      if (c.url.includes("/messages")) return { json: { ok: true, messages: [{ id: "m1" }] } };
      return { json: { ok: true, toolCalls: [{ id: "t1" }] } };
    });
    expect(await store.messages("s1")).toEqual([{ id: "m1" }] as never);
    expect(await store.toolCalls("s1")).toEqual([{ id: "t1" }] as never);
    expect(calls[0].url).toContain("/v1/sessions/s1/messages");
    expect(calls[1].url).toContain("/v1/sessions/s1/tool-calls");
  });
});
