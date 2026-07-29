import type { Command } from "commander";
import { existsSync } from "fs";
import { createInterface } from "readline/promises";
import type { Session } from "../types/index.js";
import type { SessionStore } from "../db/session-store.js";
import {
  formatLivePaneTable,
  listLivePanes,
  parseLiveStatusFilter,
} from "../lib/live.js";
import {
  buildBulkSessionPlan,
  formatBulkSessionPlan,
  isBulkSessionAction,
  listBulkLivePanes,
  parseConcurrency,
  parseJitterMs,
} from "../lib/bulk.js";
import {
  failCli,
  parseOptionalNonNegativeNumberOption,
  parsePositiveIntOption,
  printJson,
  writeStdout,
} from "./common.js";

function formatSessionTable(sessions: Session[]): string {
  if (sessions.length === 0) {
    return "No sessions found.";
  }

  const headers = ["TITLE", "SOURCE", "PROJECT", "MODEL", "MACHINE", "SESSION"];
  const rows = sessions.map((s) => [
    s.title ?? "(untitled)",
    s.source,
    s.project_name ?? "",
    s.model ?? "-",
    s.machine ?? "?",
    s.id.slice(0, 12),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length))
  );

  const render = (cols: string[]) =>
    cols
      .map((value, index) => value.padEnd(widths[index]))
      .join("  ")
      .trimEnd();

  return [render(headers), ...rows.map(render)].join("\n");
}

/**
 * Build the underlying resume command for a Store session using its provider
 * and provider-native id. Only claude sessions are resumable this way today.
 */
function buildResumeCommand(session: Session): string[] {
  if (session.source === "claude") {
    return ["claude", "--resume", session.source_id];
  }
  throw new Error(`resume is not supported for source '${session.source}' (only claude)`);
}

async function pickSessionFromList(store: SessionStore): Promise<Session> {
  const sessions = await store.recent(20);
  if (sessions.length === 0) {
    throw new Error("No sessions available to pick from");
  }

  console.log("Select a session to resume:\n");
  sessions.forEach((session, index) => {
    console.log(
      `  ${index + 1}. ${session.title ?? "(untitled)"}  ${session.project_name ?? ""}  ${session.source}  ${session.id.slice(0, 12)}`
    );
  });

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question("\nSession number: ");
    const parsed = Number.parseInt(answer, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > sessions.length) {
      throw new Error("Invalid selection");
    }
    return sessions[parsed - 1];
  } finally {
    rl.close();
  }
}

export function registerStoreCommands(program: Command): void {
// ─── list-projects (helper to see what's available) ────────────────────────

program
  .command("list")
  .description("List known sessions from the active store (local index, or the self_hosted /v1 API when HASNA_SESSIONS_API_URL + HASNA_SESSIONS_API_KEY are set)")
  .option("-p, --project <value>", "Filter by project name or path")
  .option("-l, --limit <n>", "Maximum results", "50")
  .option("--json", "Output as JSON")
  .action(async (opts: any) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    const sessions = await resolveSessionStore().list({
      project_path: opts.project,
      limit: parsePositiveIntOption(opts.limit, 50, "--limit"),
    });
    if (opts.json) {
      printJson(sessions);
      return;
    }

    console.log(formatSessionTable(sessions));
  });

program
  .command("rename <id-or-prefix> <title>")
  .description("Set a session's title in the active store (local index, or the self_hosted /v1 API when HASNA_SESSIONS_API_URL + HASNA_SESSIONS_API_KEY are set)")
  .option("-s, --source <source>", "Resolve the identifier as a native source id for this source")
  .option("--json", "Output as JSON")
  .action(async (identifier: string, title: string, opts: any) => {
    const trimmed = title.trim();
    if (!trimmed) {
      console.error("Error: title cannot be empty");
      process.exit(1);
    }
    const { resolveSessionStore } = await import("../db/session-store.js");
    let session: Session | null;
    try {
      session = await resolveSessionStore().rename(identifier, trimmed, { source: opts.source });
    } catch (error) {
      failCli(error);
    }
    if (!session) {
      console.error(`Error: session not found (or ambiguous prefix): ${identifier}`);
      process.exit(1);
    }
    if (opts.json) {
      printJson(session);
      return;
    }
    console.log(`Renamed ${session.id} -> ${session.title}`);
  });

program
  .command("resume [id-or-prefix]")
  .description("Resume a session by id/prefix, latest project session, or the most recent session (resolved via the active store)")
  .option("-p, --project <value>", "Resume the most recent session for a project")
  .option("-s, --source <source>", "Resolve the identifier as a native source id for this source")
  .option("--last", "Resume the most recently active session")
  .option("--pick", "Interactively pick a session from the most recent results")
  .option("--print-command", "Print the underlying resume command without executing it")
  .option("--json", "Output the selected session as JSON")
  .action(async (identifier: string | undefined, opts: any) => {
    try {
      const { resolveSessionStore } = await import("../db/session-store.js");
      const store = resolveSessionStore();
      let session: Session | null = null;

      if (opts.pick) {
        session = await pickSessionFromList(store);
      } else if (opts.project) {
        session = (await store.list({ project_path: opts.project, limit: 1 }))[0] ?? null;
      } else if (opts.last || !identifier) {
        session = (await store.recent(1))[0] ?? null;
      } else {
        session = await store.get(identifier, { source: opts.source });
      }

      if (!session) {
        throw new Error("No matching session found");
      }

      const command = buildResumeCommand(session);
      if (opts.json) {
        printJson({
          session,
          command,
        });
        return;
      }

      if (opts.printCommand) {
        console.log(command.join(" "));
        return;
      }

      const proc = Bun.spawn({
        cmd: command,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = await proc.exited;
      process.exit(exitCode);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command("history")
  .description("Show sessions from the active store with history filters")
  .option("-p, --project <value>", "Filter by project name or path")
  .option("--today", "Only include sessions active today")
  .option("--agent <value>", "Filter by provider (source) or title substring")
  .option("-l, --limit <n>", "Maximum results before filtering", "200")
  .option("--json", "Output as JSON")
  .action(async (opts: any) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    let sessions = await resolveSessionStore().list({
      project_path: opts.project,
      limit: parsePositiveIntOption(opts.limit, 200, "--limit"),
    });

    if (opts.today) {
      const today = new Date().toISOString().slice(0, 10);
      sessions = sessions.filter((s) => (s.started_at ?? s.ingested_at ?? "").startsWith(today));
    }

    if (opts.agent) {
      const needle = String(opts.agent).toLowerCase();
      sessions = sessions.filter(
        (s) =>
          s.source.toLowerCase().includes(needle) ||
          (s.title ?? "").toLowerCase().includes(needle) ||
          (s.model ?? "").toLowerCase().includes(needle)
      );
    }

    if (opts.json) {
      printJson(sessions);
      return;
    }

    console.log(formatSessionTable(sessions));
  });

program
  .command("transcript-search <query>")
  .alias("registry-search")
  .description("Full-text search across indexed session transcripts via the active store (local index, or the self_hosted /v1 API)")
  .option("-p, --project <value>", "Filter by project name or path")
  .option("--limit <count>", "Maximum matches to return", "20")
  .option("--json", "Output as JSON")
  .action(async (query: string, opts: any) => {
    const limit = parsePositiveIntOption(opts.limit, 20, "--limit");
    const { resolveSessionStore } = await import("../db/session-store.js");
    const matches = await resolveSessionStore().searchContent(query, {
      project_path: opts.project,
      limit,
    });

    if (opts.json) {
      printJson(matches);
      return;
    }

    if (matches.length === 0) {
      console.log("No matching sessions found.");
      return;
    }

    for (const match of matches) {
      console.log(`${match.source}  ${match.title ?? "(untitled)"}${match.project_name ? `  [${match.project_name}]` : ""}`);
      console.log(`  ${match.snippet}`);
      console.log(`  ${match.session_id}`);
    }
  });

program
  .command("live")
  .description("List live tmux-backed Codewith/session panes")
  .option("--open-only", "Only include open-* tmux sessions or projects")
  .option("-p, --project <value>", "Filter by project slug or path")
  .option("-m, --machine <name>", "Filter by machine name")
  .option("--status <values>", "Filter by status: active,idle,needs_attention,dead")
  .option("--interval <seconds>", "Refresh interval with --watch", "5")
  .option("--json", "Output JSON")
  .option("--once", "Render a single snapshot and exit")
  .option("--watch", "Keep refreshing until interrupted")
  .action(async (opts: any) => {
    const intervalSeconds = Number.parseInt(opts.interval, 10);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      console.error("Error: --interval must be a positive integer");
      process.exit(1);
    }

    let statuses;
    try {
      statuses = parseLiveStatusFilter(opts.status);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }

    const shouldWatch = Boolean(opts.watch) && !opts.once;
    const render = async () => {
      const panes = listLivePanes({
        openOnly: Boolean(opts.openOnly),
        project: opts.project,
        machine: opts.machine,
        statuses,
      });

      if (opts.json) {
        await writeStdout(`${JSON.stringify(panes, null, shouldWatch ? 0 : 2)}\n`);
        return;
      }

      if (shouldWatch) console.clear();
      console.log(`sessions live (${new Date().toISOString()})\n`);
      console.log(formatLivePaneTable(panes));
    };

    await render();
    if (!shouldWatch) {
      return;
    }

    const timer = setInterval(() => {
      void render();
    }, intervalSeconds * 1000);
    process.on("SIGINT", () => {
      clearInterval(timer);
      process.exit(0);
    });
  });

program
  .command("bulk <action>")
  .description("Plan safe bulk operations for live tmux-backed sessions")
  .option("--open-only", "Only include open-* tmux sessions or projects")
  .option("-p, --project <value>", "Filter by project slug or path")
  .option("-m, --machine <name>", "Filter by machine name")
  .option("--status <values>", "Filter by status: active,idle,needs_attention,dead")
  .option("--json", "Output JSON")
  .option("--dry-run", "Show the plan without mutating tmux")
  .option("--yes", "Confirm a mutating bulk operation")
  .option("--no-queue", "Do not mark confirmed work as locally queued")
  .option("--concurrency <count>", "Maximum queued operations to run at once", "2")
  .option("--jitter <ms>", "Deterministic delay jitter per target in milliseconds", "0")
  .option("--max-active-agents <count>", "Refuse mutating work when active agent count is above this value", "12")
  .option("--max-load1 <value>", "Refuse mutating work when 1 minute load is above this value")
  .option("--max-load-per-core <value>", "Refuse mutating work when 1 minute load per CPU core is above this value", "1.5")
  .action(async (action: string, opts: any) => {
    if (!isBulkSessionAction(action)) {
      console.error(`Error: unknown bulk action '${action}'. Use: status, capture, ensure, start, stop, restart, doctor`);
      process.exit(1);
    }

    let statuses;
    let concurrency;
    let jitterMs;
    try {
      statuses = parseLiveStatusFilter(opts.status);
      concurrency = parseConcurrency(opts.concurrency);
      jitterMs = parseJitterMs(opts.jitter);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }

    const panes = listBulkLivePanes({
      openOnly: Boolean(opts.openOnly),
      project: opts.project,
    });
    const plan = buildBulkSessionPlan({
      action,
      panes,
      openOnly: Boolean(opts.openOnly),
      project: opts.project,
      machine: opts.machine,
      statuses,
      statusFilterExplicit: Boolean(opts.status),
      dryRun: Boolean(opts.dryRun),
      yes: Boolean(opts.yes),
      queue: opts.queue !== false,
      executionEnabled: false,
      concurrency,
      jitterMs,
      maxActiveAgents: parsePositiveIntOption(opts.maxActiveAgents, 12, "--max-active-agents"),
      maxLoad1: parseOptionalNonNegativeNumberOption(opts.maxLoad1, "--max-load1"),
      maxLoadPerCore: parseOptionalNonNegativeNumberOption(opts.maxLoadPerCore, "--max-load-per-core"),
    });

    if (opts.json) {
      await writeStdout(`${JSON.stringify(plan, null, 2)}\n`);
    } else {
      console.log(formatBulkSessionPlan(plan));
      if (!opts.dryRun && ["ensure", "start", "stop", "restart"].includes(action)) {
        console.log("\nMutating execution is intentionally disabled in this build; use --dry-run for planning.");
      }
    }

    if (["ensure", "start", "stop", "restart"].includes(action) && (!plan.guard.ok || plan.summary.refused > 0)) {
      process.exit(1);
    }
  });

program
  .command("watch")
  .description("Watch session activity in a live-updating table")
  .option("-p, --project <value>", "Filter by project slug or path")
  .option("--interval <seconds>", "Refresh interval in seconds", "5")
  .option("--json", "Output one JSON snapshot and exit")
  .option("--once", "Render a single snapshot and exit")
  .action(async (opts: any) => {
    const intervalSeconds = Number.parseInt(opts.interval, 10);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      console.error("Error: --interval must be a positive integer");
      process.exit(1);
    }

    const { resolveSessionStore } = await import("../db/session-store.js");
    const store = resolveSessionStore();
    const render = async () => {
      const sessions = await store.list({ project_path: opts.project });
      if (opts.json) {
        printJson(sessions);
        return;
      }

      console.clear();
      console.log(
        `sessions watch (${new Date().toISOString()})\n`
      );
      console.log(formatSessionTable(sessions));
    };

    await render();
    if (opts.json || opts.once) {
      return;
    }

    const timer = setInterval(() => void render(), intervalSeconds * 1000);
    process.on("SIGINT", () => {
      clearInterval(timer);
      process.exit(0);
    });
  });

program
  .command("paths")
  .description("List all project paths with session counts")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    // Route through the Store so this is mode-aware: local mode reads the on-box
    // index; self_hosted mode hits /v1/stats and reports the SHARED cloud
    // registry's project paths. Never scan the local filesystem in cloud mode —
    // that was the split-brain bug (byte-identical local output regardless of
    // mode). The orphaned-path (`!`) marker is a local-filesystem concern and is
    // only meaningful for on-box projects, so it is shown in local mode only.
    const { resolveSessionStore } = await import("../db/session-store.js");
    const store = resolveSessionStore();
    const stats = await store.stats();

    const projects = stats.projects
      .map((p) => {
        const path = p.project_path ?? p.project_name ?? "(unknown)";
        const exists =
          store.mode === "local" && p.project_path ? existsSync(p.project_path) : true;
        return { path, sessions: p.session_count, exists };
      })
      .sort((a, b) => b.sessions - a.sessions);

    if (opts.json) {
      printJson(projects);
      return;
    }

    console.log(`Session Paths (${store.mode})\n`);
    const maxPath = Math.max(60, ...projects.map((p) => p.path.length));

    for (const p of projects) {
      const marker = p.exists ? " " : "!";
      const countStr = String(p.sessions).padStart(4);
      console.log(`${marker} ${p.path.padEnd(maxPath)} ${countStr} sessions`);
    }

    if (store.mode === "local") {
      const orphaned = projects.filter((p) => !p.exists);
      if (orphaned.length > 0) {
        console.log(
          `\n! = path no longer exists (${orphaned.length} orphaned, use 'sessions relocate' to fix)`
        );
      }
    }
    console.log(
      `\nTotal: ${projects.length} projects, ${projects.reduce((s, p) => s + p.sessions, 0)} sessions`
    );
  });

program
  .command("machines")
  .description("List machines that have contributed sessions, with counts")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    const { resolveSessionStore } = await import("../db/session-store.js");
    const machines = await resolveSessionStore().machines();
    if (opts.json) return void printJson(machines);
    if (machines.length === 0) {
      console.log("No machines recorded yet. Run 'sessions ingest' or 'sessions sync'.");
      return;
    }
    for (const m of machines) {
      console.log(`${m.name.padEnd(10)} ${String(m.session_count).padStart(6)} sessions   ${(m.platform ?? "").padEnd(8)} last seen ${m.last_seen_at}`);
    }
  });
}

