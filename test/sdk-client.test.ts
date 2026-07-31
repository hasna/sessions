import { describe, expect, it } from "bun:test";
import { ApiError, SessionsApi } from "../src/sdk/client.js";
import { createSessionsClientFromEnv, SessionsClient } from "../src/sdk/index.js";

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SessionsApi source lookup compatibility", () => {
  it("keeps old getSession(id, init) RequestInit arguments out of query params", async () => {
    const controller = new AbortController();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const api = new SessionsApi({
      baseUrl: "https://sessions.example",
      fetch: ((url, init) => {
        requests.push({ url: String(url), init });
        return Promise.resolve(okJson({ ok: true, session: { id: "s", source: "codex", source_id: "n", is_subagent: false } }));
      }) as typeof fetch,
    });

    await api.getSession("native", {
      headers: { "x-test": "kept" },
      signal: controller.signal,
    });

    expect(requests[0].url).toBe("https://sessions.example/v1/sessions/native");
    expect((requests[0].init?.headers as Record<string, string>)["x-test"]).toBe("kept");
    expect(requests[0].init?.signal).toBe(controller.signal);
  });

  it("keeps old rename/message/tool RequestInit arguments and supports new source query", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const api = new SessionsApi({
      baseUrl: "https://sessions.example",
      fetch: ((url, init) => {
        requests.push({ url: String(url), init });
        if (String(url).includes("/messages")) return Promise.resolve(okJson({ ok: true, messages: [] }));
        if (String(url).includes("/tool-calls")) return Promise.resolve(okJson({ ok: true, toolCalls: [] }));
        return Promise.resolve(okJson({ ok: true, session: { id: "s", source: "codewith", source_id: "n", is_subagent: false } }));
      }) as typeof fetch,
    });

    await api.renameSession("native", { title: "Renamed" }, { headers: { "x-old": "rename" } });
    await api.listSessionMessages("native", { headers: { "x-old": "messages" } });
    await api.listSessionToolCalls("native", { headers: { "x-old": "tools" } });
    await api.getSession("native", { source: "codewith" }, { headers: { "x-new": "source" } });

    expect(requests[0].url).toBe("https://sessions.example/v1/sessions/native");
    expect((requests[0].init?.headers as Record<string, string>)["x-old"]).toBe("rename");
    expect(requests[1].url).toBe("https://sessions.example/v1/sessions/native/messages");
    expect((requests[1].init?.headers as Record<string, string>)["x-old"]).toBe("messages");
    expect(requests[2].url).toBe("https://sessions.example/v1/sessions/native/tool-calls");
    expect((requests[2].init?.headers as Record<string, string>)["x-old"]).toBe("tools");
    expect(requests[3].url).toBe("https://sessions.example/v1/sessions/native?source=codewith");
    expect((requests[3].init?.headers as Record<string, string>)["x-new"]).toBe("source");
  });
});

describe("SessionsApi complete HTTP surface", () => {
  it("validates configuration and builds clients from env or explicit overrides", () => {
    expect(() => new SessionsApi({ baseUrl: "" })).toThrow("requires a baseUrl");
    expect(() => createSessionsClientFromEnv({}, {})).toThrow("SESSIONS_API_URL is required");
    expect(SessionsClient).toBe(SessionsApi);
    expect(createSessionsClientFromEnv({}, { SESSIONS_API_URL: "https://env.example", SESSIONS_API_KEY: "env-key" }))
      .toBeInstanceOf(SessionsApi);
    expect(createSessionsClientFromEnv({ baseUrl: "https://override.example", apiKey: "override" }, {}))
      .toBeInstanceOf(SessionsApi);
  });

  it("calls every generated endpoint with query, body, auth, and merged headers", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const api = new SessionsApi({
      baseUrl: "https://sessions.example/",
      apiKey: "secret",
      headers: { "x-base": "base", "x-replaced": "base" },
      fetch: (async (input, init = {}) => {
        requests.push({ url: String(input), init });
        return okJson({ ok: true, session: {}, sessions: [], machines: [], messages: [], toolCalls: [], results: [], deleted: true });
      }) as typeof fetch,
    });
    const init = { headers: { "x-request": "request", "x-replaced": "request" } };
    await api.getHealth(init);
    await api.getReady();
    await api.listMachines();
    await api.recentSessions({ limit: 0 });
    await api.searchSessions({ q: "hello", source: undefined, project: null as any, machine: "m", limit: 2 });
    await api.listSessions({ source: "claude", project: "/work", machine: "m", limit: 3 });
    await api.createSession({ source: "codex", source_id: "native" }, init);
    await api.importSessionContent({ session: { source: "codex", source_id: "native" }, messages: [], toolCalls: [] });
    await api.getSession("id with/slash", { source: "codex" });
    await api.deleteSession("id with/slash");
    await api.renameSession("native", { title: "new" }, { source: "codex" });
    await api.listSessionMessages("native", { source: "codex" });
    await api.listSessionToolCalls("native", { source: "codex" });
    await api.getStats();
    await api.getVersion();

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/health", "/ready", "/v1/machines", "/v1/recent", "/v1/search", "/v1/sessions",
      "/v1/sessions", "/v1/sessions/import", "/v1/sessions/id%20with%2Fslash", "/v1/sessions/id%20with%2Fslash",
      "/v1/sessions/native", "/v1/sessions/native/messages", "/v1/sessions/native/tool-calls", "/v1/stats", "/version",
    ]);
    expect(requests[0].init.headers).toMatchObject({
      Accept: "application/json",
      "x-api-key": "secret",
      "x-base": "base",
      "x-request": "request",
      "x-replaced": "request",
    });
    expect(requests[4].url).toContain("q=hello");
    expect(requests[4].url).not.toContain("source=");
    expect(requests[4].url).not.toContain("project=");
    expect(requests[6].init.method).toBe("POST");
    expect(requests[6].init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(String(requests[6].init.body))).toMatchObject({ source: "codex", source_id: "native" });
  });

  it("handles JSON, text, empty success bodies and exposes structured API errors", async () => {
    const responses = [
      new Response("plain text", { status: 200 }),
      new Response(null, { status: 200 }),
      new Response(JSON.stringify({ error: "bad" }), { status: 422 }),
    ];
    const api = new SessionsApi({
      baseUrl: "https://sessions.example",
      fetch: (async () => responses.shift()!) as typeof fetch,
    });
    expect(await api.getHealth()).toBe("plain text" as any);
    expect(await api.getReady()).toBeUndefined();
    try {
      await api.getVersion();
      throw new Error("expected request failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ name: "ApiError", status: 422, body: { error: "bad" } });
      expect((error as Error).message).toContain("GET /version failed: 422");
    }
  });
});
