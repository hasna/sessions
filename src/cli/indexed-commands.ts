import type { Command } from "commander";
import type { Session } from "../types/index.js";
import {
  failCli,
  parseNonNegativeIntOption,
  parsePositiveIntOption,
  printJson,
} from "./common.js";

export function registerIndexedCommands(program: Command): void {
program
  .command("import-db <path>")
  .description("Merge another machine's sessions database into this one (preserves machine tags) — RDS-free sync")
  .option("--json", "Output as JSON")
  .action(async (path: string, opts: { json?: boolean }) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    try {
      const r = await resolveSessionStore().mergeFromDb(path);
      if (opts.json) return void printJson(r);
      console.log(`Merged from ${path}: +${r.sessions} sessions, +${r.messages} messages, +${r.tool_calls} tool calls, +${r.embeddings} embeddings`);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  });

program
  .command("ingest-watch")
  .alias("watch-ingest")
  .description("Continuously index new/changed sessions as they happen (Ctrl-C to stop)")
  .option("-s, --source <source...>", "Only watch one or more providers: claude, codex, codewith, gemini")
  .option("--no-initial", "Skip the startup ingest and only ingest future changes/poll ticks")
  .option("--debounce <ms>", "Debounce window after a change before ingesting", "2000")
  .option("--poll <ms>", "Safety-net poll interval; set 0 to disable", "10000")
  .option("--status", "Print provider watch status and exit")
  .option("--json", "Output status as JSON with --status")
  .action(async (opts: { source?: string[]; initial?: boolean; debounce?: string; poll?: string; status?: boolean; json?: boolean }) => {
    const { getLocalStore } = await import("../db/session-store.js");
    const { getWatchStatus, startWatch } = await import("../lib/watch.js");
    const sources = opts.source?.length ? opts.source : undefined;
    const debounceMs = parsePositiveIntOption(opts.debounce, 2000, "--debounce");
    const pollMs = parseNonNegativeIntOption(opts.poll, 10000, "--poll");
    if (opts.status) {
      const status = getWatchStatus({ sources, debounceMs, pollMs });
      if (opts.json) return void printJson(status);
      console.log("watch-ingest status");
      console.log(`  sources:  ${status.sources.join(", ") || "(no provider dirs found)"}`);
      console.log(`  debounce: ${status.debounceMs}ms`);
      console.log(`  poll:     ${status.pollMs}ms`);
      for (const root of status.roots) {
        console.log(`  ${root.exists ? "ok " : "miss"} ${root.source.padEnd(7)} ${root.root}`);
      }
      return;
    }
    if (opts.initial !== false) {
      console.log("Initial ingest…");
      for (const r of await getLocalStore().ingest({ sources })) {
        console.log(`  ${r.source}: ${r.sessions} sessions (${r.ingested} files, ${r.skipped} unchanged)`);
      }
    } else {
      console.log("Initial ingest skipped.");
    }
    const watcher = startWatch({
      sources,
      debounceMs,
      pollMs,
      onIngest: (r) => {
        if (r.ingested > 0 || r.errors > 0) {
          console.log(`[${new Date().toLocaleTimeString()}] ${r.source}: +${r.sessions} sessions (${r.ingested} files${r.errors ? `, ${r.errors} errors` : ""})`);
        }
      },
      onError: (e) => console.error("watch error:", e.message),
    });
    console.log(`Watching: ${watcher.sources.join(", ") || "(no provider dirs found)"}. Press Ctrl-C to stop.`);
    const shutdown = () => {
      watcher.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise<void>(() => {});
  });

program
  .command("recent")
  .description("Show the most recently active sessions across all providers")
  .option("-m, --machine <name>", "Filter by machine")
  .option("-l, --limit <n>", "Maximum results", "20")
  .option("--json", "Output as JSON")
  .action(async (opts: { machine?: string; limit?: string; json?: boolean }) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    const sessions = await resolveSessionStore().list({ machine: opts.machine, limit: parseInt(opts.limit ?? "20", 10) || 20 });
    if (opts.json) return void printJson(sessions);
    for (const s of sessions) {
      console.log(
        `${(s.started_at ?? "").slice(0, 16).padEnd(16)}  ${(s.machine ?? "?").padEnd(9)} ${s.source.padEnd(7)} ${(s.project_name ?? "").padEnd(18)} ${s.title ?? "(untitled)"}  ${s.id.slice(0, 8)}`
      );
    }
  });

program
  .command("list-indexed")
  .alias("indexed-list")
  .description("List indexed sessions, optionally filtered")
  .option("-s, --source <source>", "Filter by provider")
  .option("-p, --project <value>", "Filter by project name or path")
  .option("-m, --machine <name>", "Filter by machine")
  .option("-l, --limit <n>", "Maximum results", "50")
  .option("--json", "Output as JSON")
  .action(async (opts: { source?: string; project?: string; machine?: string; limit?: string; json?: boolean }) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    const sessions = await resolveSessionStore().list({
      source: opts.source,
      project_path: opts.project,
      machine: opts.machine,
      limit: parseInt(opts.limit ?? "50", 10) || 50,
    });
    if (opts.json) return void printJson(sessions);
    for (const s of sessions) {
      console.log(`${(s.machine ?? "?").padEnd(9)} ${s.source.padEnd(7)} ${(s.project_name ?? "").padEnd(18)} ${s.title ?? "(untitled)"}  ${s.id.slice(0, 8)}`);
    }
  });

program
  .command("show <id>")
  .description("Show a session's details and message previews (id or unique prefix)")
  .option("-s, --source <source>", "Resolve the id as a native source id for this source")
  .option("-m, --messages <n>", "How many messages to preview", "12")
  .option("--json", "Output as JSON")
  .action(async (id: string, opts: { source?: string; messages?: string; json?: boolean }) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    const store = resolveSessionStore();
    let s: Session | null;
    try {
      s = await store.get(id, { source: opts.source });
    } catch (error) {
      failCli(error);
    }
    if (!s) {
      console.error(`Session not found (or ambiguous prefix): ${id}`);
      process.exit(1);
    }
    // Message/tool-call bodies come through the Store: local SQLite in local mode
    // or the authenticated /v1 content endpoints in self_hosted mode.
    const messages = await store.messages(s.id);
    const tools = await store.toolCalls(s.id);
    const n = parsePositiveIntOption(opts.messages, 12, "--messages");
    const previewMessages = messages.slice(0, n);
    if (opts.json) return void printJson({ session: s, messages: previewMessages, tools });
    console.log(`${s.title ?? "(untitled)"}`);
    console.log(`  source:   ${s.source}   model: ${s.model ?? "?"}`);
    console.log(`  project:  ${s.project_name ?? "?"} (${s.project_path ?? "?"})`);
    console.log(`  git:      ${s.git_branch ?? "?"}`);
    console.log(`  when:     ${s.started_at ?? "?"} → ${s.ended_at ?? "?"}`);
    console.log(`  counts:   ${s.message_count} messages, ${s.tool_call_count} tool calls, ${s.total_input_tokens + s.total_output_tokens} tokens`);
    console.log(`  id:       ${s.id}`);
    console.log("");
    for (const m of previewMessages) {
      console.log(`  [${m.role}] ${(m.content ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
    }
    if (tools.length) console.log(`\n  tools used: ${[...new Set(tools.map((t) => t.tool_name))].join(", ")}`);
  });

program
  .command("stats")
  .description("Show ingestion and project statistics")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    const stats = await resolveSessionStore().stats();
    if (opts.json) return void printJson(stats);
    console.log("By source:");
    for (const s of stats.by_source) {
      console.log(`  ${s.source.padEnd(8)} ${s.sessions} sessions`);
    }
    console.log(`\nTotals: ${stats.session_count} sessions, ${stats.message_count} messages, ${stats.tool_call_count} tool calls`);
    console.log("\nTop projects:");
    for (const p of stats.projects.slice(0, 15)) {
      console.log(`  ${String(p.session_count).padStart(4)}  ${p.project_name ?? p.project_path}`);
    }
  });

program
  .command("create")
  .description("Create a session record in the active store (local index, or the self_hosted /v1 API when HASNA_SESSIONS_API_URL + HASNA_SESSIONS_API_KEY are set)")
  .requiredOption("--source <source>", "Session source: claude, codex, codewith, or gemini")
  .requiredOption("--source-id <id>", "Provider-native session id")
  .option("--title <title>", "Session title")
  .option("--project-path <path>", "Project path")
  .option("--project-name <name>", "Project name")
  .option("--model <model>", "Model")
  .option("--machine <machine>", "Machine name")
  .option("--json", "Output as JSON")
  .action(async (opts: {
    source: string;
    sourceId: string;
    title?: string;
    projectPath?: string;
    projectName?: string;
    model?: string;
    machine?: string;
    json?: boolean;
  }) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    const session = await resolveSessionStore().create({
      source: opts.source,
      source_id: opts.sourceId,
      ...(opts.title !== undefined ? { title: opts.title } : {}),
      ...(opts.projectPath !== undefined ? { project_path: opts.projectPath } : {}),
      ...(opts.projectName !== undefined ? { project_name: opts.projectName } : {}),
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.machine !== undefined ? { machine: opts.machine } : {}),
    });
    if (opts.json) return void printJson(session);
    console.log(`Created session ${session.id} (${session.source}:${session.source_id})`);
  });

program
  .command("delete <id>")
  .description("Delete a session record from the active store (local index, or the self_hosted /v1 API when HASNA_SESSIONS_API_URL + HASNA_SESSIONS_API_KEY are set)")
  .option("--json", "Output as JSON")
  .action(async (id: string, opts: { json?: boolean }) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    const deleted = await resolveSessionStore().remove(id);
    if (opts.json) return void printJson({ deleted, id });
    if (deleted) console.log(`Deleted session ${id}`);
    else {
      console.error(`Session not found: ${id}`);
      process.exit(1);
    }
  });

program
  .command("graph")
  .description("Explore the session knowledge graph — entities (projects/tools/models/repos) and links")
  .option("-t, --type <type>", "List one entity type: project, tool, model, provider, repo")
  .option("-r, --related <type:name>", "Sessions related to an entity, e.g. tool:Bash or project:infra")
  .option("--session <id>", "Show a single session's entity neighborhood")
  .option("-s, --source <source>", "Resolve --session as a native source id for this source")
  .option("-l, --limit <n>", "Max results", "50")
  .option("--json", "Output as JSON")
  .action(async (opts: { type?: string; related?: string; session?: string; source?: string; limit?: string; json?: boolean }) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    const store = resolveSessionStore();
    type EntityType = "project" | "tool" | "model" | "provider" | "repo";
    const TYPES = ["project", "tool", "model", "provider", "repo"];
    const limit = parseInt(opts.limit ?? "50", 10) || 50;

    if (opts.session) {
      let g;
      try {
        g = await store.graphSession(opts.session, { source: opts.source });
      } catch (error) {
        failCli(error);
      }
      if (!g) {
        console.error(`Session not found: ${opts.session}`);
        process.exit(1);
      }
      if (opts.json) return void printJson(g);
      console.log(`project: ${g?.project ?? "?"}`);
      console.log(`model:   ${g?.model ?? "?"} (${g?.provider ?? "?"})`);
      console.log(`repo:    ${g?.repo ?? "?"}`);
      console.log(`tools:   ${g?.tools.join(", ") || "none"}`);
      return;
    }

    if (opts.related) {
      const idx = opts.related.indexOf(":");
      const type = idx >= 0 ? opts.related.slice(0, idx) : "";
      const name = idx >= 0 ? opts.related.slice(idx + 1) : "";
      if (!TYPES.includes(type) || !name) {
        console.error("--related must be <type>:<name>, e.g. tool:Bash (type: project|tool|model|provider|repo)");
        process.exit(1);
      }
      const sessions = await store.graphRelated(type as EntityType, name, limit);
      if (opts.json) return void printJson(sessions);
      for (const s of sessions) {
        console.log(`${s.source.padEnd(7)} ${(s.project_name ?? "").padEnd(20)} ${s.title ?? "(untitled)"}  ${s.session_id.slice(0, 8)}`);
      }
      return;
    }

    if (opts.type && !TYPES.includes(opts.type)) {
      console.error(`Unknown type '${opts.type}'. Use: ${TYPES.join(", ")}`);
      process.exit(1);
    }
    const entities = await store.graphEntities(opts.type as EntityType | undefined);
    if (opts.json) return void printJson(entities);
    let lastType = "";
    for (const e of entities.slice(0, opts.type ? entities.length : 100)) {
      if (e.type !== lastType) {
        console.log(`\n${e.type}:`);
        lastType = e.type;
      }
      console.log(`  ${String(e.session_count).padStart(4)}  ${e.name}`);
    }
  });

program
  .command("embed")
  .description("Generate embeddings for indexed messages (enables semantic search; needs OPENAI_API_KEY)")
  .option("-l, --limit <n>", "Max messages to embed this run", "200")
  .option("--json", "Output as JSON")
  .action(async (opts: { limit?: string; json?: boolean }) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    try {
      const result = await resolveSessionStore().embed({ limit: parseInt(opts.limit ?? "200", 10) || 200 });
      if (opts.json) return void printJson(result);
      console.log(`Embedded ${result.chunksEmbedded} chunks across ${result.messagesProcessed} messages.`);
    } catch (err) {
      console.error(`Embed failed (is OPENAI_API_KEY set?): ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("search-indexed <query>")
  .aliases(["search", "indexed-search"])
  .description("Full-text search across your indexed AI coding sessions")
  .option("-s, --source <source>", "Filter by provider: claude, codex, codewith, or gemini")
  .option("-p, --project <value>", "Filter by project name or path")
  .option("-m, --machine <name>", "Filter by machine (laptop-a, workstation-b, ...)")
  .option("-l, --limit <n>", "Maximum results", "20")
  .option("--tools", "Search tool calls (name/input/output) instead of message content")
  .option("--semantic", "Semantic (embedding) search — requires 'sessions embed' first")
  .option("--hybrid", "Blend full-text + semantic results (RRF)")
  .option("--json", "Output as JSON")
  .action(
    async (
      query: string,
      opts: { source?: string; project?: string; machine?: string; limit?: string; tools?: boolean; semantic?: boolean; hybrid?: boolean; json?: boolean }
    ) => {
      const { resolveSessionStore } = await import("../db/session-store.js");
      const store = resolveSessionStore();
      const limit = parsePositiveIntOption(opts.limit, 20, "--limit");
      const o = { limit, source: opts.source, project_path: opts.project, machine: opts.machine };

      if (opts.tools) {
        const hits = await store.searchToolCalls(query, o);
        if (opts.json) return void printJson(hits);
        if (hits.length === 0) return void console.log("No matching tool calls.");
        for (const h of hits) {
          console.log(`${h.source}  ${h.tool_name}${h.project_name ? `  [${h.project_name}]` : ""}`);
          console.log(`  ${h.snippet}`);
        }
        return;
      }

      let hits;
      if (opts.semantic || opts.hybrid) {
        try {
          hits = opts.hybrid ? await store.hybridSearch(query, o) : await store.semanticSearch(query, o);
        } catch (err) {
          console.error(`Semantic search failed (is OPENAI_API_KEY set and have you run 'sessions embed'?): ${(err as Error).message}`);
          process.exit(1);
        }
      } else {
        hits = await store.searchContent(query, o);
      }
      if (opts.json) return void printJson(hits);
      if (hits.length === 0) return void console.log("No matching sessions.");
      for (const h of hits) {
        console.log(
          `${h.source}  ${h.title ?? "(untitled)"}${h.project_name ? `  [${h.project_name}]` : ""}`
        );
        console.log(`  ${h.snippet}`);
        console.log(`  ${h.session_id}  ${h.started_at ?? ""}`);
      }
    }
  );

program
  .command("recall <query>")
  .description("Local-only recall by natural language, with evidence, touched files, graph context, and resume metadata")
  .option("-s, --source <source>", "Filter by provider: claude, codex, codewith, or gemini")
  .option("-p, --project <value>", "Filter by project name or path")
  .option("-m, --machine <name>", "Filter by machine")
  .option("-l, --limit <n>", "Maximum results", "10")
  .option("--no-semantic", "Disable semantic/vector recall even when embeddings are available")
  .option("--json", "Output as JSON")
  .action(
    async (
      query: string,
      opts: { source?: string; project?: string; machine?: string; limit?: string; semantic?: boolean; json?: boolean }
    ) => {
      const limit = parsePositiveIntOption(opts.limit, 10, "--limit");
      const { resolveSessionStore } = await import("../db/session-store.js");
      const response = await resolveSessionStore().recall(query, {
        source: opts.source,
        project_path: opts.project,
        machine: opts.machine,
        limit,
        semantic: opts.semantic,
      });

      if (opts.json) return void printJson(response);
      if (response.results.length === 0) {
        console.log("No matching sessions found.");
        if (response.metadata.semantic.reason) {
          console.log(`semantic: ${response.metadata.semantic.reason}`);
        }
        return;
      }

      for (const result of response.results) {
        console.log(
          `#${result.rank} ${result.source}  ${result.title ?? "(untitled)"}${result.project_name ? `  [${result.project_name}]` : ""}`
        );
        console.log(`  score: ${result.score}  id: ${result.session_id}  updated: ${result.updated_at ?? "?"}`);
        console.log(`  reason: ${result.reason}`);
        for (const evidence of result.evidence.slice(0, 3)) {
          console.log(`  evidence (${evidence.kind}): ${evidence.snippet.replace(/\s+/g, " ")}`);
        }
        if (result.touched_file_paths.length > 0) {
          console.log(`  files: ${result.touched_file_paths.slice(0, 6).join(", ")}`);
        }
        if (result.related_graph_entities.tools.length > 0) {
          console.log(`  graph: project=${result.related_graph_entities.project ?? "?"} tools=${result.related_graph_entities.tools.slice(0, 6).join(", ")}`);
        }
        if (result.resume.available) {
          console.log(`  resume: ${result.resume.shell_command}`);
        } else {
          console.log(`  resume: unavailable (${result.resume.reason})`);
        }
      }

      if (response.metadata.semantic.reason) {
        console.log(`\nsemantic: ${response.metadata.semantic.reason}`);
      }
    }
  );

async function runIngestCommand(opts: { source?: string; force?: boolean; verbose?: boolean; json?: boolean }) {
  const { getLocalStore } = await import("../db/session-store.js");
  const onProgress = opts.verbose ? (m: string) => console.log(m) : undefined;
  try {
    const results = await getLocalStore().ingest({
      source: opts.source,
      force: opts.force,
      onProgress,
    });
    if (opts.json) {
      printJson(results);
      return;
    }
    for (const r of results) {
      console.log(
        `${r.source}: scanned ${r.scanned}, ingested ${r.ingested}, skipped ${r.skipped}, sessions ${r.sessions}, errors ${r.errors}`
      );
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

function addIngestCommand(name: string, description: string) {
  program
    .command(name)
    .description(description)
    .option("-s, --source <source>", "Only ingest one provider: claude, codex, codewith, or gemini")
    .option("-f, --force", "Re-ingest even files that are unchanged since last run")
    .option("-v, --verbose", "Print each file as it is ingested")
    .option("--json", "Output the result as JSON")
    .action(runIngestCommand);
}

addIngestCommand("ingest", "Index AI coding sessions (claude, codex, codewith, gemini) into the searchable database");
addIngestCommand("reindex", "Alias for ingest; refresh the searchable session index");
}

