import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDatabase, resetDatabase, closeDatabase } from "../src/db/database.js";
import { saveParsedSession } from "../src/db/sessions.js";
import {
  chunkText,
  serializeVector,
  deserializeVector,
  embedSessions,
  type Embedder,
} from "../src/lib/embeddings.js";
import {
  cosineSimilarity,
  semanticSearch,
  hybridSearch,
  reciprocalRankFusion,
} from "../src/lib/vector-search.js";

// Deterministic fake embedder: keyword-count vectors over a fixed vocabulary,
// so semantically-related text lands near each other without calling OpenAI.
const VOCAB = ["deploy", "kubernetes", "billing", "stripe", "error", "webhook"];
const fakeEmbedder: Embedder = async (texts) =>
  texts.map((t) => {
    const lower = t.toLowerCase();
    return VOCAB.map((w) => (lower.match(new RegExp(w, "g")) ?? []).length);
  });

beforeEach(() => {
  process.env.SESSIONS_DB_PATH = ":memory:";
  resetDatabase();
  getDatabase();
  saveParsedSession({
    session: { source: "claude", source_id: "k8s", title: "Deploy", project_path: "/p/infra", project_name: "infra" },
    messages: [{ session_id: "", role: "user", content: "deploy the kubernetes cluster to production", sequence_num: 0 }],
    toolCalls: [],
  });
  saveParsedSession({
    session: { source: "codex", source_id: "bill", title: "Billing", project_path: "/p/web", project_name: "web" },
    messages: [{ session_id: "", role: "user", content: "the stripe billing webhook threw an error", sequence_num: 0 }],
    toolCalls: [],
  });
});

afterEach(() => {
  closeDatabase();
  delete process.env.SESSIONS_DB_PATH;
});

describe("chunkText", () => {
  it("returns one chunk when short, splits when long", () => {
    expect(chunkText("hi")).toEqual(["hi"]);
    expect(chunkText("")).toEqual([]);
    expect(chunkText("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
  });
});

describe("vector serialization", () => {
  it("round-trips a float vector through a BLOB", () => {
    const v = [0.1, -0.5, 1, 0];
    const back = Array.from(deserializeVector(serializeVector(v)));
    for (let i = 0; i < v.length; i++) expect(back[i]).toBeCloseTo(v[i], 5);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical, 0 for orthogonal", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("embedSessions + semanticSearch", () => {
  it("does not call the query embedder when no embeddings are stored", async () => {
    const hits = await semanticSearch("kubernetes deployment", {
      embedder: async () => {
        throw new Error("embedder should not be called");
      },
    });
    expect(hits).toEqual([]);
  });

  it("embeds messages and ranks the semantically-closest session first", async () => {
    const res = await embedSessions({ embedder: fakeEmbedder });
    expect(res.messagesProcessed).toBe(2);
    expect(res.chunksEmbedded).toBe(2);

    const hits = await semanticSearch("kubernetes deployment", { embedder: fakeEmbedder });
    expect(hits[0].source).toBe("claude"); // the k8s session
    expect(hits[0].rank).toBeGreaterThan(0);
  });

  it("is idempotent — re-embedding does not duplicate", async () => {
    await embedSessions({ embedder: fakeEmbedder });
    const second = await embedSessions({ embedder: fakeEmbedder });
    expect(second.messagesProcessed).toBe(0); // all already embedded
    const db = getDatabase();
    const count = db.prepare("SELECT COUNT(*) AS c FROM embeddings").get() as { c: number };
    expect(count.c).toBe(2);
  });
});

describe("hybridSearch", () => {
  it("blends full-text and semantic results", async () => {
    await embedSessions({ embedder: fakeEmbedder });
    const hits = await hybridSearch("stripe billing", { embedder: fakeEmbedder });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].source).toBe("codex"); // billing/stripe session
  });
});

describe("reciprocalRankFusion", () => {
  it("ranks items appearing high in multiple lists first", () => {
    const a = { session_id: "a", source: "claude", title: null, project_name: null, project_path: null, started_at: null, snippet: "", rank: 0 };
    const b = { session_id: "b", source: "codex", title: null, project_name: null, project_path: null, started_at: null, snippet: "", rank: 0 };
    const fused = reciprocalRankFusion([[a, b], [b, a]], 2);
    // b is rank0 in list2 and rank1 in list1; a is rank0 in list1 and rank1 in list2 — tie, both present
    expect(fused).toHaveLength(2);
    expect(fused.map((h) => h.session_id).sort()).toEqual(["a", "b"]);
  });
});
