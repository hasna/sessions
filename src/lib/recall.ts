import { getDatabase } from "../db/database.js";
import {
  getSession,
  listSessions as listIndexedSessions,
} from "../db/sessions.js";
import type { Message, Session, ToolCall } from "../types/index.js";
import { sessionGraph } from "./graph.js";
import type { Embedder } from "./embeddings.js";
import { appendProjectFilter } from "./project-filter.js";
import {
  searchMessages,
  searchSessions as searchSessionFields,
  searchToolCalls,
  type SearchHit,
  type SearchOptions,
  type ToolCallHit,
} from "./search.js";
import { semanticSearch } from "./vector-search.js";
import {
  buildResumeMetadata,
  compareSessionRecency,
  extractCodingEntities,
  loadRecallContext,
  selectMatchingToolCalls,
  stripFtsMarkers,
  trimToken,
  unique,
} from "./recall-context.js";

export { extractCodingEntities };

const MAX_VARIANT_TERMS = 8;
const MAX_EVIDENCE_PER_RESULT = 8;
const MAX_TOOL_CALLS_PER_RESULT = 8;
const MAX_TOUCHED_FILES = 16;
const MAX_ENTITY_VALUES = 16;
const MAX_CONTEXT_MESSAGES_PER_RESULT = 24;
const MAX_CONTEXT_TOOL_CALLS_PER_RESULT = 64;
const MAX_RECENT_TOOL_CALLS_PER_RESULT = 12;
const MAX_ENTITY_SCAN_CHARS = 8_000;
const MAX_JSON_PARSE_CHARS = 24_000;

const STOPWORDS = new Set([
  "a",
  "about",
  "again",
  "all",
  "an",
  "and",
  "any",
  "ask",
  "building",
  "built",
  "can",
  "code",
  "coding",
  "did",
  "do",
  "find",
  "for",
  "from",
  "get",
  "implemented",
  "implementing",
  "implementation",
  "in",
  "it",
  "let",
  "lets",
  "me",
  "of",
  "on",
  "please",
  "recall",
  "resume",
  "search",
  "session",
  "sessions",
  "that",
  "the",
  "thing",
  "this",
  "thread",
  "to",
  "we",
  "where",
  "with",
]);

export interface RecallOptions extends SearchOptions {
  /** Max results to return. */
  limit?: number;
  /**
   * Whether to use semantic search when possible. Defaults to true, but it
   * degrades to lexical/tool/graph recall if embeddings or API credentials are
   * unavailable.
   */
  semantic?: boolean;
  /** Deterministic fake embedders can be injected in tests. */
  embedder?: Embedder;
}

export interface RecallEvidence {
  kind: "message" | "session" | "tool_call" | "semantic" | "graph";
  signal: string;
  snippet: string;
  score?: number;
}

export interface RecallToolCall {
  id: string;
  tool_name: string;
  status: string | null;
  timestamp: string | null;
  snippet: string;
  input_preview: string | null;
  output_preview: string | null;
}

export interface CodingThreadEntities {
  file_paths: string[];
  tool_names: string[];
  commands: string[];
  repos: string[];
  branches: string[];
  commits: string[];
}

export interface RecallGraphContext {
  project: string | null;
  model: string | null;
  provider: string | null;
  repo: string | null;
  branch: string | null;
  commit: string | null;
  tools: string[];
}

export interface RecallResume {
  available: boolean;
  command: string[] | null;
  shell_command: string | null;
  reason: string | null;
}

export interface RecallResult {
  session_id: string;
  source: string;
  source_id: string;
  source_path: string | null;
  title: string | null;
  project_name: string | null;
  project_path: string | null;
  started_at: string | null;
  updated_at: string | null;
  rank: number;
  score: number;
  reason: string;
  evidence: RecallEvidence[];
  matching_tool_calls: RecallToolCall[];
  touched_file_paths: string[];
  coding_entities: CodingThreadEntities;
  related_graph_entities: RecallGraphContext;
  resume: RecallResume;
}

export interface RecallMetadata {
  query: string;
  query_variants: string[];
  significant_terms: string[];
  semantic: {
    attempted: boolean;
    status: "used" | "skipped" | "failed";
    stored_embeddings: number;
    openai_api_key_present: boolean;
    reason: string | null;
  };
  signals: Record<string, number>;
}

export interface RecallResponse {
  query: string;
  count: number;
  results: RecallResult[];
  metadata: RecallMetadata;
}

interface QueryVariant {
  query: string;
  label: string;
  weight: number;
}

interface Candidate {
  sessionId: string;
  score: number;
  signals: Record<string, number>;
  evidence: RecallEvidence[];
  toolHitSnippets: string[];
}

interface MetadataHit {
  session_id: string;
  snippet: string;
  signal: string;
}

export async function recallSessions(
  query: string,
  opts: RecallOptions = {}
): Promise<RecallResponse> {
  const normalizedQuery = query.trim();
  const limit = opts.limit ?? 10;
  const terms = significantTerms(normalizedQuery);
  const variants = buildQueryVariants(normalizedQuery, terms);
  const candidates = new Map<string, Candidate>();
  const signalCounts: Record<string, number> = {
    message: 0,
    session: 0,
    tool_call: 0,
    semantic: 0,
    graph: 0,
    recent: 0,
  };

  for (const variant of variants) {
    const messageHits = safeSearch(() =>
      searchMessages(variant.query, { ...opts, limit: limit * 4 })
    );
    signalCounts.message += messageHits.length;
    addSearchHits(candidates, messageHits, {
      kind: "message",
      signal: `message:${variant.label}`,
      weight: 5 * variant.weight,
    });

    const sessionHits = safeSearch(() =>
      searchSessionFields(variant.query, { ...opts, limit: limit * 4 })
    );
    signalCounts.session += sessionHits.length;
    addSearchHits(candidates, sessionHits, {
      kind: "session",
      signal: `session:${variant.label}`,
      weight: 3.25 * variant.weight,
    });

    const toolHits = safeSearch(() =>
      searchToolCalls(variant.query, { ...opts, limit: limit * 4 })
    );
    signalCounts.tool_call += toolHits.length;
    addToolHits(candidates, toolHits, {
      signal: `tool_call:${variant.label}`,
      weight: 4.5 * variant.weight,
    });
  }

  const semantic = await maybeSemanticSearch(normalizedQuery, opts, limit);
  if (semantic.hits.length > 0) {
    signalCounts.semantic = semantic.hits.length;
    addSearchHits(candidates, semantic.hits, {
      kind: "semantic",
      signal: "semantic",
      weight: 3.75,
      scoreFromRank: true,
    });
  }

  const graphHits = metadataAndGraphHits(terms, normalizedQuery, opts, limit * 6);
  signalCounts.graph = graphHits.length;
  for (let i = 0; i < graphHits.length; i++) {
    const hit = graphHits[i];
    addCandidate(candidates, hit.session_id, 2.25 / (i + 1), {
      kind: "graph",
      signal: hit.signal,
      snippet: hit.snippet,
    });
  }

  if (candidates.size === 0 && shouldUseRecentFallback(normalizedQuery, terms)) {
    const recent = listIndexedSessions({
      source: opts.source,
      project_path: opts.project_path,
      machine: opts.machine,
      limit,
    });
    signalCounts.recent = recent.length;
    for (let i = 0; i < recent.length; i++) {
      addCandidate(candidates, recent[i].id, 0.75 / (i + 1), {
        kind: "session",
        signal: "recent_fallback",
        snippet: `Recent ${recent[i].source} session ${recent[i].title ?? "(untitled)"} in ${recent[i].project_name ?? recent[i].project_path ?? "unknown project"}`,
      });
    }
  }

  const ranked = [...candidates.values()]
    .sort((a, b) => b.score - a.score || compareSessionRecency(b.sessionId, a.sessionId))
    .slice(0, limit);

  const results = ranked.map((candidate, index) =>
    buildRecallResult(candidate, index + 1, terms, normalizedQuery)
  );

  return {
    query: normalizedQuery,
    count: results.length,
    results,
    metadata: {
      query: normalizedQuery,
      query_variants: variants.map((variant) => variant.query),
      significant_terms: terms,
      semantic: semantic.metadata,
      signals: signalCounts,
    },
  };
}

export function buildQueryVariants(query: string, terms = significantTerms(query)): QueryVariant[] {
  const variants: QueryVariant[] = [];
  const compact = query.trim().replace(/\s+/g, " ");
  if (terms.length === 0 && shouldUseRecentFallback(compact, terms)) {
    return variants;
  }
  if (compact) {
    variants.push({ query: compact, label: "original", weight: terms.length > 0 ? 0.8 : 1 });
  }

  const distilled = terms.slice(0, MAX_VARIANT_TERMS).join(" ");
  if (distilled && distilled.toLowerCase() !== compact.toLowerCase()) {
    variants.push({ query: distilled, label: "terms", weight: 1.15 });
  }

  for (const term of terms.slice(0, MAX_VARIANT_TERMS)) {
    if (term.length >= 3 || /[./:@-]/.test(term)) {
      variants.push({ query: term, label: `term:${term}`, weight: 0.28 });
    }
  }

  const seen = new Set<string>();
  return variants.filter((variant) => {
    const key = variant.query.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function significantTerms(query: string): string[] {
  const normalized = query
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/let's/g, "lets");
  const raw = normalized.match(/[a-z0-9_./:@%+=-]+/g) ?? [];
  const terms: string[] = [];
  for (const token of raw) {
    const trimmed = trimToken(token);
    if (!trimmed) continue;
    const isPathLike = /[./:@=-]/.test(trimmed);
    if (!isPathLike && (STOPWORDS.has(trimmed) || trimmed.length < 3)) continue;
    if (!terms.includes(trimmed)) terms.push(trimmed);
  }
  return terms;
}


function addSearchHits(
  candidates: Map<string, Candidate>,
  hits: SearchHit[],
  options: {
    kind: RecallEvidence["kind"];
    signal: string;
    weight: number;
    scoreFromRank?: boolean;
  }
): void {
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const score = options.scoreFromRank
      ? options.weight * Math.max(0.05, Number(hit.rank) || 0.05)
      : options.weight / (i + 1);
    addCandidate(candidates, hit.session_id, score, {
      kind: options.kind,
      signal: options.signal,
      snippet: hit.snippet,
      score: hit.rank,
    });
  }
}

function addToolHits(
  candidates: Map<string, Candidate>,
  hits: ToolCallHit[],
  options: { signal: string; weight: number }
): void {
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    const candidate = addCandidate(candidates, hit.session_id, options.weight / (i + 1), {
      kind: "tool_call",
      signal: options.signal,
      snippet: `${hit.tool_name}: ${hit.snippet}`,
      score: hit.rank,
    });
    if (hit.snippet && !candidate.toolHitSnippets.includes(hit.snippet)) {
      candidate.toolHitSnippets.push(hit.snippet);
    }
  }
}

function addCandidate(
  candidates: Map<string, Candidate>,
  sessionId: string,
  score: number,
  evidence?: RecallEvidence
): Candidate {
  let candidate = candidates.get(sessionId);
  if (!candidate) {
    candidate = { sessionId, score: 0, signals: {}, evidence: [], toolHitSnippets: [] };
    candidates.set(sessionId, candidate);
  }
  candidate.score += score;
  if (evidence) {
    candidate.signals[evidence.kind] = (candidate.signals[evidence.kind] ?? 0) + score;
    addEvidence(candidate.evidence, evidence);
  }
  return candidate;
}

function addEvidence(evidence: RecallEvidence[], next: RecallEvidence): void {
  if (!next.snippet.trim()) return;
  const key = `${next.kind}:${next.signal}:${next.snippet}`;
  if (evidence.some((item) => `${item.kind}:${item.signal}:${item.snippet}` === key)) return;
  evidence.push(next);
}

function safeSearch<T>(fn: () => T[]): T[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

async function maybeSemanticSearch(
  query: string,
  opts: RecallOptions,
  limit: number
): Promise<{
  hits: SearchHit[];
  metadata: RecallMetadata["semantic"];
}> {
  const stored = embeddingCount();
  const apiKeyPresent = Boolean(process.env.OPENAI_API_KEY);
  const base = {
    attempted: false,
    status: "skipped" as const,
    stored_embeddings: stored,
    openai_api_key_present: apiKeyPresent,
    reason: null as string | null,
  };

  if (opts.semantic === false) {
    return { hits: [], metadata: { ...base, reason: "semantic recall disabled by request" } };
  }
  if (stored === 0) {
    return {
      hits: [],
      metadata: { ...base, reason: "no stored embeddings; run 'sessions embed' to enable semantic recall" },
    };
  }
  if (!opts.embedder && !apiKeyPresent) {
    return {
      hits: [],
      metadata: { ...base, reason: "OPENAI_API_KEY is not set; using FTS, tool-call, and graph signals" },
    };
  }

  try {
    const hits = await semanticSearch(query, {
      ...opts,
      limit: limit * 4,
      embedder: opts.embedder,
    });
    return {
      hits,
      metadata: {
        ...base,
        attempted: true,
        status: "used",
        reason: null,
      },
    };
  } catch (err) {
    return {
      hits: [],
      metadata: {
        ...base,
        attempted: true,
        status: "failed",
        reason: (err as Error).message,
      },
    };
  }
}

function embeddingCount(): number {
  const db = getDatabase();
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM embeddings WHERE embedding IS NOT NULL")
    .get() as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

function metadataAndGraphHits(
  terms: string[],
  query: string,
  opts: SearchOptions,
  limit: number
): MetadataHit[] {
  const needles = unique([...terms, query.toLowerCase().trim()].filter((term) => term.length >= 2));
  if (needles.length === 0) return [];

  const db = getDatabase();
  const params: any[] = [];
  const filters: string[] = [];
  if (opts.source) {
    filters.push("s.source = ?");
    params.push(opts.source);
  }
  if (opts.project_path) {
    appendProjectFilter(filters, params, opts.project_path);
  }
  if (opts.machine) {
    filters.push("s.machine = ?");
    params.push(opts.machine);
  }

  const fields = [
    "s.source",
    "s.title",
    "s.project_name",
    "s.project_path",
    "s.model",
    "s.model_provider",
    "s.git_branch",
    "s.git_sha",
    "s.git_origin_url",
  ];
  const matchClauses: string[] = [];
  for (const needle of needles.slice(0, MAX_VARIANT_TERMS)) {
    const like = `%${needle}%`;
    matchClauses.push(`(${fields.map((field) => `LOWER(COALESCE(${field}, '')) LIKE ?`).join(" OR ")})`);
    for (let i = 0; i < fields.length; i++) params.push(like);
  }

  const where = [...filters, `(${matchClauses.join(" OR ")})`].join(" AND ");
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT s.id, s.source, s.title, s.project_name, s.project_path,
              s.model, s.model_provider, s.git_branch, s.git_sha, s.git_origin_url
       FROM sessions s
       WHERE ${where}
       ORDER BY COALESCE(s.updated_at, s.started_at, s.ingested_at) DESC
       LIMIT ?`
    )
    .all(...params) as Record<string, unknown>[];

  return rows.map((row) => ({
    session_id: row.id as string,
    signal: "metadata_or_graph",
    snippet: graphSnippet(row),
  }));
}

function graphSnippet(row: Record<string, unknown>): string {
  const parts = [
    row.source ? `source ${row.source}` : "",
    row.project_name ? `project ${row.project_name}` : "",
    row.project_path ? `path ${row.project_path}` : "",
    row.git_branch ? `branch ${row.git_branch}` : "",
    row.git_sha ? `commit ${row.git_sha}` : "",
    row.git_origin_url ? `repo ${row.git_origin_url}` : "",
    row.model ? `model ${row.model}` : "",
    row.model_provider ? `provider ${row.model_provider}` : "",
    row.title ? `title ${row.title}` : "",
  ].filter(Boolean);
  return parts.join("; ");
}

function shouldUseRecentFallback(query: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  return /\b(resume|continue|pick up|where did we leave|building this|this thing)\b/i.test(query);
}

function buildRecallResult(
  candidate: Candidate,
  rank: number,
  terms: string[],
  query: string
): RecallResult {
  const session = getSession(candidate.sessionId);
  const context = loadRecallContext(session.id, terms);
  const messages = context.messages;
  const toolCalls = context.toolCalls;
  const entities = extractCodingEntities(session, messages, toolCalls);
  const graph = sessionGraph(session.id);
  const matchingToolCalls = selectMatchingToolCalls(toolCalls, terms, query, candidate.toolHitSnippets);
  const evidence = candidate.evidence
    .sort((a, b) => evidencePriority(a.kind) - evidencePriority(b.kind))
    .slice(0, MAX_EVIDENCE_PER_RESULT);

  return {
    session_id: session.id,
    source: session.source,
    source_id: session.source_id,
    source_path: session.source_path,
    title: session.title,
    project_name: session.project_name,
    project_path: session.project_path,
    started_at: session.started_at,
    updated_at: session.updated_at,
    rank,
    score: Number(candidate.score.toFixed(4)),
    reason: buildReason(candidate, evidence, matchingToolCalls, entities),
    evidence,
    matching_tool_calls: matchingToolCalls,
    touched_file_paths: entities.file_paths,
    coding_entities: entities,
    related_graph_entities: {
      project: graph?.project ?? session.project_name,
      model: graph?.model ?? session.model,
      provider: graph?.provider ?? session.model_provider,
      repo: graph?.repo ?? session.git_origin_url,
      branch: session.git_branch,
      commit: session.git_sha,
      tools: (graph?.tools ?? entities.tool_names).slice(0, MAX_ENTITY_VALUES),
    },
    resume: buildResumeMetadata(session),
  };
}

function buildReason(
  candidate: Candidate,
  evidence: RecallEvidence[],
  toolCalls: RecallToolCall[],
  entities: CodingThreadEntities
): string {
  const signals = Object.entries(candidate.signals)
    .sort((a, b) => b[1] - a[1])
    .map(([signal]) => signal.replace("_", " "));
  const parts: string[] = [];
  if (signals.length > 0) parts.push(`matched ${signals.slice(0, 3).join(", ")}`);
  if (toolCalls.length > 0) parts.push(`${toolCalls.length} matching tool call${toolCalls.length === 1 ? "" : "s"}`);
  if (entities.file_paths.length > 0) parts.push(`${entities.file_paths.length} touched file path${entities.file_paths.length === 1 ? "" : "s"}`);
  if (evidence[0]?.snippet) parts.push(`top evidence: ${stripFtsMarkers(evidence[0].snippet).slice(0, 140)}`);
  return parts.join("; ") || "matched recall signals";
}

function evidencePriority(kind: RecallEvidence["kind"]): number {
  switch (kind) {
    case "message":
      return 0;
    case "tool_call":
      return 1;
    case "semantic":
      return 2;
    case "session":
      return 3;
    case "graph":
      return 4;
  }
}
