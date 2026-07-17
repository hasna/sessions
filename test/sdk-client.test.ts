import { describe, expect, it } from "bun:test";
import { SessionsApi } from "../src/sdk/client.js";

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
