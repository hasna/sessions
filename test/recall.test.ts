import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDatabase, resetDatabase } from "../src/db/database.js";
import { saveParsedSession } from "../src/db/sessions.js";
import { embedSessions, type Embedder } from "../src/lib/embeddings.js";
import { recallSessions } from "../src/lib/recall.js";

const repoRoot = join(import.meta.dir, "..");

const fakeEmbedder: Embedder = async (texts) => {
  const vocab = ["stripe", "webhook", "payment", "auth", "storage"];
  return texts.map((text) => {
    const lower = text.toLowerCase();
    return vocab.map((word) => (lower.match(new RegExp(word, "g")) ?? []).length);
  });
};

function seedRecallFixtures() {
  const stripe = saveParsedSession({
    session: {
      source: "claude",
      source_id: "claude-stripe-001",
      title: "Stripe webhook implementation",
      project_path: "/repo/web",
      project_name: "web",
      model: "claude-sonnet-4-6",
      model_provider: "anthropic",
      git_branch: "feature/stripe-webhook",
      git_sha: "abc1234",
      git_origin_url: "https://github.com/hasna/web.git",
      started_at: "2026-05-01T10:00:00.000Z",
      machine: "test-machine",
    },
    messages: [
      {
        session_id: "",
        role: "user",
        content: "We need to implement the Stripe webhook payment handler and tests.",
        sequence_num: 0,
      },
      {
        session_id: "",
        role: "assistant",
        content: "Implemented signature verification in src/routes/stripe-webhook.ts and covered invoice events.",
        sequence_num: 1,
      },
    ],
    toolCalls: [
      {
        session_id: "",
        tool_name: "Edit",
        tool_input: JSON.stringify({
          file_path: "src/routes/stripe-webhook.ts",
          new_string: "export async function stripeWebhook() {}",
        }),
        tool_output: "updated src/routes/stripe-webhook.ts",
        status: "success",
      },
      {
        session_id: "",
        tool_name: "Bash",
        tool_input: JSON.stringify({
          command: "bun test test/stripe-webhook.test.ts",
        }),
        tool_output: "ok on branch feature/stripe-webhook",
        status: "success",
      },
    ],
  });

  const auth = saveParsedSession({
    session: {
      source: "codex",
      source_id: "codex-auth-001",
      title: "Auth middleware cleanup",
      project_path: "/repo/web",
      project_name: "web",
      started_at: "2026-05-02T10:00:00.000Z",
      machine: "test-machine",
    },
    messages: [
      {
        session_id: "",
        role: "user",
        content: "Fix auth middleware redirect behavior.",
        sequence_num: 0,
      },
    ],
    toolCalls: [
      {
        session_id: "",
        tool_name: "Read",
        tool_input: JSON.stringify({ file_path: "src/auth/middleware.ts" }),
      },
    ],
  });

  return { stripe, auth };
}

beforeEach(() => {
  process.env.SESSIONS_DB_PATH = ":memory:";
  delete process.env.OPENAI_API_KEY;
  resetDatabase();
  getDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env.SESSIONS_DB_PATH;
  delete process.env.OPENAI_API_KEY;
});

describe("recallSessions", () => {
  it("ranks the coding thread for a natural-language implemented-X query", async () => {
    const { stripe } = seedRecallFixtures();

    const response = await recallSessions("find me the thread where we implemented stripe webhook", {
      limit: 5,
    });

    expect(response.count).toBeGreaterThan(0);
    expect(response.results[0].session_id).toBe(stripe.id);
    expect(response.results[0].rank).toBe(1);
    expect(response.results[0].reason).toContain("matched");
    expect(response.results[0].evidence.some((e) => e.snippet.toLowerCase().includes("stripe"))).toBe(true);
  });

  it("returns evidence, matching tool calls, touched files, graph context, and a Claude resume command", async () => {
    const { stripe } = seedRecallFixtures();

    const response = await recallSessions("stripe webhook", { limit: 1 });
    const result = response.results[0];

    expect(result.session_id).toBe(stripe.id);
    expect(result.matching_tool_calls.map((tool) => tool.tool_name)).toContain("Edit");
    expect(result.touched_file_paths).toContain("src/routes/stripe-webhook.ts");
    expect(result.coding_entities.commands).toContain("bun test test/stripe-webhook.test.ts");
    expect(result.coding_entities.branches).toContain("feature/stripe-webhook");
    expect(result.coding_entities.commits).toContain("abc1234");
    expect(result.related_graph_entities.project).toBe("web");
    expect(result.related_graph_entities.tools).toContain("Bash");
    expect(result.resume).toEqual({
      available: true,
      command: ["claude", "--resume", "claude-stripe-001"],
      shell_command: "claude --resume claude-stripe-001",
      reason: null,
    });
  });

  it("degrades gracefully when embeddings and OPENAI_API_KEY are absent", async () => {
    seedRecallFixtures();

    const response = await recallSessions("stripe webhook", { limit: 2 });

    expect(response.results.length).toBeGreaterThan(0);
    expect(response.metadata.semantic.status).toBe("skipped");
    expect(response.metadata.semantic.attempted).toBe(false);
    expect(response.metadata.semantic.reason).toContain("no stored embeddings");
  });

  it("falls back to recent sessions for vague resume-style prompts", async () => {
    const { auth } = seedRecallFixtures();

    const response = await recallSessions("resume building this thing", { limit: 2 });

    expect(response.results[0].session_id).toBe(auth.id);
    expect(response.results[0].evidence[0].signal).toBe("recent_fallback");
    expect(response.metadata.signals.recent).toBe(2);
    expect(response.metadata.query_variants).toHaveLength(0);
  });

  it("uses deterministic semantic search when embeddings and an injected embedder exist", async () => {
    seedRecallFixtures();
    await embedSessions({ embedder: fakeEmbedder });

    const response = await recallSessions("payment webhook", {
      limit: 2,
      embedder: fakeEmbedder,
    });

    expect(response.metadata.semantic.status).toBe("used");
    expect(response.metadata.signals.semantic).toBeGreaterThan(0);
    expect(response.results[0].title).toBe("Stripe webhook implementation");
  });

  it("explains unavailable resume commands for non-Claude sources", async () => {
    const { auth } = seedRecallFixtures();

    const response = await recallSessions("auth middleware", { limit: 1 });

    expect(response.results[0].session_id).toBe(auth.id);
    expect(response.results[0].resume.available).toBe(false);
    expect(response.results[0].resume.reason).toContain("codex");
  });
});

describe("sessions recall CLI", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sessions-recall-cli-"));
    dbPath = join(dir, "sessions.db");
    process.env.SESSIONS_DB_PATH = dbPath;
    delete process.env.OPENAI_API_KEY;
    resetDatabase();
    getDatabase();
    seedRecallFixtures();
    closeDatabase();
  });

  afterEach(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SESSIONS_DB_PATH;
  });

  it("prints the recall response as JSON", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "run", "src/cli/index.tsx", "recall", "stripe webhook", "--json"],
      cwd: repoRoot,
      env: {
        ...process.env,
        SESSIONS_DB_PATH: dbPath,
        OPENAI_API_KEY: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stderr).toString("utf-8")).toBe("");
    const payload = JSON.parse(Buffer.from(result.stdout).toString("utf-8"));
    expect(payload.query).toBe("stripe webhook");
    expect(payload.results[0].resume.shell_command).toBe("claude --resume claude-stripe-001");
    expect(payload.results[0].touched_file_paths).toContain("src/routes/stripe-webhook.ts");
  });
});
