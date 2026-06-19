import { getDatabase } from "../db/database.js";
import {
  getSession,
  listSessions as listIndexedSessions,
} from "../db/sessions.js";
import type { Message, Session, ToolCall } from "../types/index.js";
import { sessionGraph } from "./graph.js";
import type { Embedder } from "./embeddings.js";
import {
  searchMessages,
  searchSessions as searchSessionFields,
  searchToolCalls,
  type SearchHit,
  type SearchOptions,
  type ToolCallHit,
} from "./search.js";
import { semanticSearch } from "./vector-search.js";

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

export function extractCodingEntities(
  session: Session,
  messages: Message[],
  toolCalls: ToolCall[]
): CodingThreadEntities {
  const textParts: string[] = [
    session.title ?? "",
    session.project_name ?? "",
    session.git_origin_url ?? "",
    session.git_branch ?? "",
    session.git_sha ?? "",
  ];
  for (const message of messages) textParts.push(message.content ?? "");
  for (const toolCall of toolCalls) {
    textParts.push(
      toolCall.tool_name,
      scanText(toolCall.tool_input),
      scanText(toolCall.tool_output)
    );
  }
  const text = textParts.join("\n");

  const files = new Set<string>();
  for (const value of extractJsonValues(toolCalls, ["file_path", "filepath", "path", "absolute_path", "relative_path"])) {
    addPath(files, value);
  }
  for (const path of extractFilePaths(text)) addPath(files, path);

  const commands = new Set<string>();
  for (const value of extractJsonValues(toolCalls, ["command", "cmd", "shell", "script"])) {
    addCommand(commands, value);
  }
  for (const toolCall of toolCalls) {
    if (isCommandTool(toolCall.tool_name)) {
      addCommand(commands, toolCall.tool_input ?? "");
    }
  }

  const repos = new Set<string>();
  if (session.git_origin_url) repos.add(session.git_origin_url);
  for (const repo of text.match(/(?:https?:\/\/|git@)[^\s"'<>]+/g) ?? []) {
    if (/github\.com|gitlab\.com|bitbucket\.org|\.git\b/.test(repo)) {
      repos.add(cleanTrailing(repo));
    }
  }

  const branches = new Set<string>();
  if (session.git_branch) branches.add(session.git_branch);
  for (const branch of extractBranches(text)) branches.add(branch);

  const commits = new Set<string>();
  if (session.git_sha) commits.add(session.git_sha);
  for (const commit of text.match(/\b[0-9a-f]{7,40}\b/gi) ?? []) commits.add(commit);

  return {
    file_paths: [...files].slice(0, MAX_TOUCHED_FILES),
    tool_names: unique(toolCalls.map((toolCall) => toolCall.tool_name)).slice(0, MAX_ENTITY_VALUES),
    commands: [...commands].slice(0, MAX_ENTITY_VALUES),
    repos: [...repos].slice(0, MAX_ENTITY_VALUES),
    branches: [...branches].slice(0, MAX_ENTITY_VALUES),
    commits: [...commits].slice(0, MAX_ENTITY_VALUES),
  };
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
    filters.push("s.project_path = ?");
    params.push(opts.project_path);
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

function loadRecallContext(
  sessionId: string,
  terms: string[]
): { messages: Message[]; toolCalls: ToolCall[] } {
  return {
    messages: loadRecallMessages(sessionId, terms),
    toolCalls: loadRecallToolCalls(sessionId, terms),
  };
}

function loadRecallMessages(sessionId: string, terms: string[]): Message[] {
  const db = getDatabase();
  const match = recallFtsOrQuery(terms);

  if (match) {
    try {
      const rows = db
        .prepare(
          `SELECT m.*
           FROM messages_fts
           JOIN messages m ON m.id = messages_fts.message_id
           WHERE messages_fts MATCH ? AND messages_fts.session_id = ?
           ORDER BY bm25(messages_fts) ASC
           LIMIT ?`
        )
        .all(match, sessionId, MAX_CONTEXT_MESSAGES_PER_RESULT) as Record<string, unknown>[];
      if (rows.length > 0) return rows.map(rowToMessage);
    } catch {
      // Fall through to a bounded chronological sample if FTS rejects a rare token.
    }
  }

  const rows = db
    .prepare(
      `SELECT *
       FROM messages
       WHERE session_id = ?
       ORDER BY sequence_num ASC, timestamp ASC
       LIMIT ?`
    )
    .all(sessionId, Math.min(12, MAX_CONTEXT_MESSAGES_PER_RESULT)) as Record<string, unknown>[];
  return rows.map(rowToMessage);
}

function loadRecallToolCalls(sessionId: string, terms: string[]): ToolCall[] {
  const db = getDatabase();
  const seen = new Set<string>();
  const toolCalls: ToolCall[] = [];
  const addRows = (rows: Record<string, unknown>[]) => {
    for (const row of rows) {
      const id = row.id as string;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      toolCalls.push(rowToToolCall(row));
      if (toolCalls.length >= MAX_CONTEXT_TOOL_CALLS_PER_RESULT) break;
    }
  };

  const match = recallFtsOrQuery(terms);
  if (match) {
    try {
      addRows(
        db
          .prepare(
            `SELECT tc.*
             FROM tool_calls_fts
             JOIN tool_calls tc ON tc.id = tool_calls_fts.tool_call_id
             WHERE tool_calls_fts MATCH ? AND tool_calls_fts.session_id = ?
             ORDER BY bm25(tool_calls_fts) ASC
             LIMIT ?`
          )
          .all(match, sessionId, MAX_CONTEXT_TOOL_CALLS_PER_RESULT) as Record<string, unknown>[]
      );
    } catch {
      // Fall through to a bounded recent sample if FTS rejects a rare token.
    }
  }

  if (toolCalls.length < MAX_RECENT_TOOL_CALLS_PER_RESULT) {
    addRows(
      db
        .prepare(
          `SELECT *
           FROM tool_calls
           WHERE session_id = ?
           ORDER BY COALESCE(timestamp, '') DESC
           LIMIT ?`
        )
        .all(sessionId, MAX_RECENT_TOOL_CALLS_PER_RESULT) as Record<string, unknown>[]
    );
  }

  return toolCalls;
}

function recallFtsOrQuery(terms: string[]): string | null {
  const tokens = unique(
    terms
      .map((term) => term.trim())
      .filter((term) => term.length >= 2)
      .slice(0, MAX_VARIANT_TERMS)
  );
  if (tokens.length === 0) return null;
  return tokens.map(quoteFtsTerm).join(" OR ");
}

function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

function parseMeta(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "string") return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function rowToMessage(row: Record<string, unknown>): Message {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    source_id: (row.source_id as string) ?? null,
    parent_message_id: (row.parent_message_id as string) ?? null,
    role: row.role as Message["role"],
    content: (row.content as string) ?? null,
    content_preview: (row.content_preview as string) ?? null,
    model: (row.model as string) ?? null,
    is_sidechain: Boolean(row.is_sidechain),
    sequence_num: row.sequence_num == null ? null : Number(row.sequence_num),
    input_tokens: Number(row.input_tokens ?? 0),
    output_tokens: Number(row.output_tokens ?? 0),
    cache_read_tokens: Number(row.cache_read_tokens ?? 0),
    cache_write_tokens: Number(row.cache_write_tokens ?? 0),
    thinking_tokens: Number(row.thinking_tokens ?? 0),
    timestamp: (row.timestamp as string) ?? null,
    metadata: parseMeta(row.metadata),
  };
}

function rowToToolCall(row: Record<string, unknown>): ToolCall {
  return {
    id: row.id as string,
    message_id: (row.message_id as string) ?? null,
    session_id: row.session_id as string,
    tool_name: row.tool_name as string,
    tool_input: (row.tool_input as string) ?? null,
    tool_output: (row.tool_output as string) ?? null,
    duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
    status: (row.status as ToolCall["status"]) ?? null,
    timestamp: (row.timestamp as string) ?? null,
    metadata: parseMeta(row.metadata),
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

function selectMatchingToolCalls(
  toolCalls: ToolCall[],
  terms: string[],
  query: string,
  toolHitSnippets: string[]
): RecallToolCall[] {
  const loweredQuery = query.toLowerCase();
  const loweredTerms = terms.map((term) => term.toLowerCase());
  const matches: RecallToolCall[] = [];
  for (const toolCall of toolCalls) {
    const haystack = [
      toolCall.tool_name,
      toolCall.tool_input ?? "",
      toolCall.tool_output ?? "",
    ]
      .join("\n")
      .toLowerCase();
    const exact = loweredQuery.length > 0 && haystack.includes(loweredQuery);
    const termMatch = loweredTerms.some((term) => haystack.includes(term));
    const snippetMatch = toolHitSnippets.some((snippet) =>
      haystack.includes(stripFtsMarkers(snippet).toLowerCase().slice(0, 30))
    );
    if (!exact && !termMatch && !snippetMatch) continue;
    matches.push({
      id: toolCall.id,
      tool_name: toolCall.tool_name,
      status: toolCall.status,
      timestamp: toolCall.timestamp,
      snippet: snippetForToolCall(toolCall, terms, query),
      input_preview: preview(toolCall.tool_input),
      output_preview: preview(toolCall.tool_output),
    });
    if (matches.length >= MAX_TOOL_CALLS_PER_RESULT) break;
  }
  return matches;
}

function snippetForToolCall(toolCall: ToolCall, terms: string[], query: string): string {
  const text = [toolCall.tool_name, toolCall.tool_input ?? "", toolCall.tool_output ?? ""].join("\n");
  return snippetAround(text, [query, ...terms]) || preview(text) || toolCall.tool_name;
}

function snippetAround(text: string, needles: string[]): string {
  const compact = text.replace(/\s+/g, " ").trim();
  const lower = compact.toLowerCase();
  const needle = needles
    .map((item) => item.toLowerCase().trim())
    .filter(Boolean)
    .find((item) => lower.includes(item));
  if (!needle) return "";
  const index = lower.indexOf(needle);
  const start = Math.max(0, index - 70);
  const end = Math.min(compact.length, index + needle.length + 120);
  return compact.slice(start, end);
}

function preview(value: string | null | undefined, max = 220): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}

function buildResumeMetadata(session: Session): RecallResume {
  const metadataCommand = metadataResumeCommand(session.metadata);
  if (metadataCommand) return metadataCommand;

  if (session.source === "claude") {
    const command = ["claude", "--resume", session.source_id];
    return {
      available: true,
      command,
      shell_command: command.map(shellQuote).join(" "),
      reason: null,
    };
  }

  return {
    available: false,
    command: null,
    shell_command: null,
    reason: `No stable resume command is configured for ${session.source} indexed sessions yet; inspect source_path or use the provider's native history UI.`,
  };
}

function metadataResumeCommand(metadata: Record<string, unknown>): RecallResume | null {
  const raw = metadata.resume_command;
  if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) {
    const command = raw as string[];
    return {
      available: true,
      command,
      shell_command: command.map(shellQuote).join(" "),
      reason: null,
    };
  }
  if (typeof raw === "string" && raw.trim()) {
    return {
      available: true,
      command: null,
      shell_command: raw.trim(),
      reason: null,
    };
  }
  return null;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function compareSessionRecency(a: string, b: string): number {
  const sa = getSession(a);
  const sb = getSession(b);
  const at = new Date(sa.updated_at ?? sa.started_at ?? 0).getTime();
  const bt = new Date(sb.updated_at ?? sb.started_at ?? 0).getTime();
  return at - bt;
}

function trimToken(token: string): string {
  return token
    .replace(/^[^\w/.:@%+=-]+|[^\w/.:@%+=-]+$/g, "")
    .replace(/^['"]+|['"]+$/g, "");
}

function extractFilePaths(text: string): string[] {
  const matches = [
    ...(text.match(/(?:^|[\s"'`(])((?:\/[A-Za-z0-9._@%+=:,~-]+)+)(?=$|[\s"'`),\]}])/g) ?? []),
    ...(text.match(/(?:^|[\s"'`(])((?:\.{1,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,10})(?=$|[\s"'`),\]}])/g) ?? []),
    ...(text.match(/(?:^|[\s"'`(])((?:README|CHANGELOG|LICENSE|Dockerfile|Makefile|package|tsconfig|bun\.lock|Cargo|Gemfile|go\.mod)(?:\.[A-Za-z0-9]+)?)(?=$|[\s"'`),\]}])/gi) ?? []),
  ];
  return matches
    .map((match) => match.trim().replace(/^["'`()]+|["'`(),\]}]+$/g, ""))
    .map(cleanPath)
    .filter(Boolean);
}

function addPath(paths: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  for (const path of extractFilePaths(value).length ? extractFilePaths(value) : [cleanPath(value)]) {
    if (!path) continue;
    if (path.includes("://")) continue;
    if (path === "/" || path.length < 3) continue;
    paths.add(path);
  }
}

function cleanPath(value: string): string {
  return cleanTrailing(value)
    .replace(/^["'`()]+|["'`]+$/g, "")
    .replace(/:\d+(?::\d+)?$/g, "");
}

function cleanTrailing(value: string): string {
  return value.replace(/[),.;\]}>"'`]+$/g, "");
}

function extractJsonValues(toolCalls: ToolCall[], keys: string[]): unknown[] {
  const wanted = new Set(keys);
  const values: unknown[] = [];
  for (const toolCall of toolCalls) {
    for (const raw of [toolCall.tool_input, toolCall.tool_output]) {
      if (!raw) continue;
      if (raw.length > MAX_JSON_PARSE_CHARS) continue;
      try {
        collectJsonValues(JSON.parse(raw), wanted, values);
      } catch {
        // Tool inputs are often plain command strings.
      }
    }
  }
  return values;
}

function scanText(value: string | null | undefined): string {
  if (!value) return "";
  return value.length > MAX_ENTITY_SCAN_CHARS ? value.slice(0, MAX_ENTITY_SCAN_CHARS) : value;
}

function collectJsonValues(value: unknown, keys: Set<string>, out: unknown[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonValues(item, keys, out);
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (keys.has(key.toLowerCase())) out.push(nested);
    collectJsonValues(nested, keys, out);
  }
}

function addCommand(commands: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const command = value
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("{"));
  if (!command) return;
  commands.add(command.slice(0, 300));
}

function isCommandTool(toolName: string): boolean {
  return /^(bash|shell|terminal|run_command|exec|command)$/i.test(toolName);
}

function extractBranches(text: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /\bgit\s+(?:checkout|switch)\s+(?:-b\s+)?([A-Za-z0-9._/-]+)/g,
    /\bbranch[:=]\s*([A-Za-z0-9._/-]+)/gi,
    /\bon branch\s+([A-Za-z0-9._/-]+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) out.add(cleanTrailing(match[1]));
    }
  }
  return [...out];
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function stripFtsMarkers(value: string): string {
  return value.replace(/\[|\]/g, "");
}
