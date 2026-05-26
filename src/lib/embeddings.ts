import { getDatabase } from "../db/database.js";

export type Embedder = (texts: string[]) => Promise<number[][]>;

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

/** Split text into chunks of at most maxChars (embeddings have token limits). */
export function chunkText(text: string, maxChars = 2000): string[] {
  if (!text) return [];
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) chunks.push(text.slice(i, i + maxChars));
  return chunks;
}

/** Pack a float vector into a compact Float32 BLOB for SQLite storage. */
export function serializeVector(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

/** Unpack a Float32 BLOB back into a vector. */
export function deserializeVector(buf: Buffer): Float32Array {
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}

/** Real embedder backed by the OpenAI embeddings API (reads OPENAI_API_KEY). */
export function openaiEmbedder(model = DEFAULT_EMBEDDING_MODEL): Embedder {
  return async (texts) => {
    const mod = (await import("openai")) as unknown as { default: new () => any };
    const client = new mod.default();
    const res = await client.embeddings.create({ model, input: texts });
    return (res.data as { embedding: number[] }[]).map((d) => d.embedding);
  };
}

export interface EmbedOptions {
  /** Embedder to use (defaults to OpenAI). Inject a fake in tests. */
  embedder?: Embedder;
  model?: string;
  /** Max messages to embed in this run. */
  limit?: number;
  maxChars?: number;
}

export interface EmbedResult {
  messagesProcessed: number;
  chunksEmbedded: number;
}

/**
 * Generate embeddings for messages that don't have any yet, storing one row per
 * chunk in the embeddings table. Idempotent — already-embedded messages are skipped.
 */
export async function embedSessions(opts: EmbedOptions = {}): Promise<EmbedResult> {
  const db = getDatabase();
  const model = opts.model ?? DEFAULT_EMBEDDING_MODEL;
  const embedder = opts.embedder ?? openaiEmbedder(model);

  const rows = db
    .prepare(
      `SELECT m.id, m.session_id, m.content
       FROM messages m
       WHERE m.content IS NOT NULL AND m.content != ''
         AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.message_id = m.id)
       LIMIT ?`
    )
    .all(opts.limit ?? 200) as { id: string; session_id: string; content: string }[];

  let chunksEmbedded = 0;
  const insert = db.prepare(
    `INSERT OR REPLACE INTO embeddings
       (id, message_id, session_id, chunk_index, chunk_text, embedding, embedding_model, dimensions, created_at, synced_to_s3)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 0)`
  );

  for (const m of rows) {
    const texts = chunkText(m.content, opts.maxChars ?? 2000);
    if (texts.length === 0) continue;
    const vectors = await embedder(texts);
    for (let i = 0; i < vectors.length; i++) {
      insert.run(
        crypto.randomUUID(),
        m.id,
        m.session_id,
        i,
        texts[i],
        serializeVector(vectors[i]),
        model,
        vectors[i].length
      );
      chunksEmbedded++;
    }
  }

  return { messagesProcessed: rows.length, chunksEmbedded };
}
