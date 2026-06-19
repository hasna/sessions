import { getDatabase } from "../db/database.js";
import { deserializeVector, openaiEmbedder, type Embedder } from "./embeddings.js";
import { search, type SearchHit, type SearchOptions } from "./search.js";

/** Cosine similarity of two equal-ish-length vectors (0 when either is zero). */
export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface SemanticOptions extends SearchOptions {
  /** Embedder for the query (defaults to OpenAI). Inject a fake in tests. */
  embedder?: Embedder;
}

/** Rank stored embeddings against a query vector (brute-force cosine), one hit per session. */
export function vectorSearchByEmbedding(queryVec: number[], opts: SemanticOptions = {}): SearchHit[] {
  const db = getDatabase();
  const where: string[] = [];
  const params: any[] = [];
  if (opts.source) {
    where.push("s.source = ?");
    params.push(opts.source);
  }
  if (opts.project_path) {
    where.push("s.project_path = ?");
    params.push(opts.project_path);
  }
  if (opts.machine) {
    where.push("s.machine = ?");
    params.push(opts.machine);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const rows = db
    .prepare(
      `SELECT e.session_id, e.chunk_text, e.embedding,
              s.source, s.title, s.project_name, s.project_path, s.started_at
       FROM embeddings e JOIN sessions s ON s.id = e.session_id ${clause}`
    )
    .all(...params) as Record<string, unknown>[];

  const scored = rows
    .map((r) => ({ r, score: cosineSimilarity(queryVec, deserializeVector(r.embedding as Buffer)) }))
    .sort((a, b) => b.score - a.score);

  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  const limit = opts.limit ?? 20;
  for (const { r, score } of scored) {
    const id = r.session_id as string;
    if (seen.has(id)) continue;
    seen.add(id);
    hits.push({
      session_id: id,
      source: r.source as string,
      title: (r.title as string) ?? null,
      project_name: (r.project_name as string) ?? null,
      project_path: (r.project_path as string) ?? null,
      started_at: (r.started_at as string) ?? null,
      snippet: ((r.chunk_text as string) ?? "").slice(0, 200),
      rank: score,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Semantic search: embed the query, then cosine-rank stored embeddings. */
export async function semanticSearch(query: string, opts: SemanticOptions = {}): Promise<SearchHit[]> {
  if (!hasStoredEmbeddings(opts)) return [];
  const embedder = opts.embedder ?? openaiEmbedder();
  const [queryVec] = await embedder([query]);
  return vectorSearchByEmbedding(queryVec, opts);
}

function hasStoredEmbeddings(opts: SemanticOptions = {}): boolean {
  const db = getDatabase();
  const where: string[] = ["e.embedding IS NOT NULL"];
  const params: any[] = [];
  if (opts.source) {
    where.push("s.source = ?");
    params.push(opts.source);
  }
  if (opts.project_path) {
    where.push("s.project_path = ?");
    params.push(opts.project_path);
  }
  if (opts.machine) {
    where.push("s.machine = ?");
    params.push(opts.machine);
  }
  const row = db
    .prepare(
      `SELECT 1 AS present
       FROM embeddings e
       JOIN sessions s ON s.id = e.session_id
       WHERE ${where.join(" AND ")}
       LIMIT 1`
    )
    .get(...params) as { present: number } | undefined;
  return Boolean(row?.present);
}

/** Reciprocal-rank fusion of multiple ranked result lists. */
export function reciprocalRankFusion(lists: SearchHit[][], limit: number, k = 60): SearchHit[] {
  const scores = new Map<string, { hit: SearchHit; score: number }>();
  for (const list of lists) {
    list.forEach((hit, i) => {
      const add = 1 / (k + i + 1);
      const cur = scores.get(hit.session_id);
      if (cur) cur.score += add;
      else scores.set(hit.session_id, { hit, score: add });
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.hit);
}

/** Hybrid search: blend full-text (FTS5) and semantic (vector) results via RRF. */
export async function hybridSearch(query: string, opts: SemanticOptions = {}): Promise<SearchHit[]> {
  const limit = opts.limit ?? 20;
  const fts = search(query, { ...opts, limit: limit * 2 });
  const semantic = await semanticSearch(query, { ...opts, limit: limit * 2 });
  return reciprocalRankFusion([fts, semantic], limit);
}
