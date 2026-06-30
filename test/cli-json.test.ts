import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { closeDatabase, getDatabase, resetDatabase } from "../src/db/database.js";
import { saveParsedSession } from "../src/db/sessions.js";

const repoRoot = join(import.meta.dir, "..");
const TEST_DIR = join(import.meta.dir, ".test-cli-json");
const PROJECTS_DIR = join(TEST_DIR, "projects");
const EXPORT_OUTPUT_DIR = join(TEST_DIR, "exports");
const IMPORT_SOURCE_DIR = join(TEST_DIR, "import-source");

function runCli(args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.tsx", ...args],
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAUDE_PATH: TEST_DIR,
      CODEX_PATH: TEST_DIR,
      HASNA_SESSIONS_DB_PATH: join(TEST_DIR, "sessions.db"),
      SESSIONS_DB_PATH: join(TEST_DIR, "sessions.db"),
      HASNA_SESSIONS_DIR: join(TEST_DIR, "sessions-home"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function runCliPipe(command: string) {
  return Bun.spawnSync({
    cmd: ["bash", "-o", "pipefail", "-c", command],
    cwd: repoRoot,
    env: {
      ...process.env,
      CLAUDE_PATH: TEST_DIR,
      CODEX_PATH: TEST_DIR,
      HASNA_SESSIONS_DB_PATH: join(TEST_DIR, "sessions.db"),
      SESSIONS_DB_PATH: join(TEST_DIR, "sessions.db"),
      HASNA_SESSIONS_DIR: join(TEST_DIR, "sessions-home"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function parseJsonOutput(result: ReturnType<typeof Bun.spawnSync>) {
  expect(result.exitCode).toBe(0);
  expect(Buffer.from(result.stderr).toString("utf-8")).toBe("");
  return JSON.parse(Buffer.from(result.stdout).toString("utf-8"));
}

function setupProjectFixtures() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(PROJECTS_DIR, { recursive: true });
  mkdirSync(EXPORT_OUTPUT_DIR, { recursive: true });

  const projectDir = join(PROJECTS_DIR, "-Users-test-old-project");
  mkdirSync(projectDir, { recursive: true });

  writeFileSync(
    join(projectDir, "sessions-index.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          sessionId: "sess-001",
          fullPath: `${PROJECTS_DIR}/-Users-test-old-project/sess-001.jsonl`,
          projectPath: "/Users/test/old/project",
        },
      ],
    }),
    "utf-8"
  );

  writeFileSync(
    join(projectDir, "sess-001.jsonl"),
    [
      JSON.stringify({
        type: "user",
        timestamp: "2026-04-10T09:00:00.000Z",
        uuid: "u1",
        cwd: "/Users/test/old/project",
        sessionId: "sess-001",
        message: { role: "user", content: "hello" },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-04-10T09:01:00.000Z",
        uuid: "a1",
        cwd: "/Users/test/old/project",
        sessionId: "sess-001",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "done" }],
        },
      }),
    ].join("\n"),
    "utf-8"
  );
}

function setupImportFixtures() {
  mkdirSync(join(IMPORT_SOURCE_DIR, "projects", "-Users-test-old-project"), {
    recursive: true,
  });

  writeFileSync(
    join(IMPORT_SOURCE_DIR, "manifest.json"),
    JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      sourceComputer: "source-machine",
      sourceUser: "test",
      sourceClaudePath: "/Users/test/.claude/projects",
      projects: [
        {
          originalPath: "/Users/test/old/project",
          encodedDir: "-Users-test-old-project",
          sessionCount: 1,
          jsonlCount: 1,
        },
      ],
      totalFiles: 2,
      totalSize: 123,
    }),
    "utf-8"
  );

  writeFileSync(
    join(
      IMPORT_SOURCE_DIR,
      "projects",
      "-Users-test-old-project",
      "sess-001.jsonl"
    ),
    JSON.stringify({
      type: "user",
      cwd: "/Users/test/old/project",
      message: { role: "user", content: "import me" },
    }),
    "utf-8"
  );
}

function seedLargeIndexedDb(count: number): void {
  const previousDbPath = process.env.SESSIONS_DB_PATH;
  const previousHasnaDbPath = process.env.HASNA_SESSIONS_DB_PATH;
  process.env.SESSIONS_DB_PATH = join(TEST_DIR, "sessions.db");
  process.env.HASNA_SESSIONS_DB_PATH = join(TEST_DIR, "sessions.db");
  resetDatabase();
  getDatabase();
  try {
    for (let index = 0; index < count; index++) {
      saveParsedSession({
        session: {
          source: index % 2 === 0 ? "claude" : "codex",
          source_id: `large-${index}`,
          title: `Large JSON fixture ${index}`,
          project_path: `/Users/test/client-dashboard/${index % 5}`,
          project_name: "client-dashboard",
          started_at: `2026-04-10T09:${String(index % 60).padStart(2, "0")}:00.000Z`,
          machine: "machine-a",
        },
        messages: [
          {
            session_id: "",
            role: "user",
            content: `large-json-token request ${index}`,
            sequence_num: 0,
          },
          {
            session_id: "",
            role: "assistant",
            content: `large-json-token response ${index}`,
            sequence_num: 1,
          },
        ],
        toolCalls: [
          {
            session_id: "",
            tool_name: "Bash",
            tool_input: `echo large-json-token ${index}`,
            tool_output: `large-json-token output ${index}`,
          },
        ],
      });
    }
  } finally {
    closeDatabase();
    if (previousDbPath === undefined) delete process.env.SESSIONS_DB_PATH;
    else process.env.SESSIONS_DB_PATH = previousDbPath;
    if (previousHasnaDbPath === undefined) delete process.env.HASNA_SESSIONS_DB_PATH;
    else process.env.HASNA_SESSIONS_DB_PATH = previousHasnaDbPath;
  }
}

beforeEach(() => {
  setupProjectFixtures();
  setupImportFixtures();
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("CLI JSON output", () => {
  it("emits parseable JSON for relocate dry-runs", () => {
    const result = runCli([
      "relocate",
      "/Users/test/old",
      "/Users/test/new",
      "--dry-run",
      "--json",
    ]);

    const payload = parseJsonOutput(result);
    expect(payload.oldPath).toBe("/Users/test/old");
    expect(payload.newPath).toBe("/Users/test/new");
    expect(payload.dryRun).toBe(true);
    expect(payload.dirsRenamed[0]).toEqual({
      from: "-Users-test-old-project",
      to: "-Users-test-new-project",
    });
  });

  it("emits parseable JSON for transfer export dry-runs", () => {
    const result = runCli([
      "transfer",
      "export",
      "--dry-run",
      "--json",
      "--output",
      EXPORT_OUTPUT_DIR,
    ]);

    const payload = parseJsonOutput(result);
    expect(payload.dryRun).toBe(true);
    expect(payload.manifest.projects).toHaveLength(1);
    expect(payload.manifest.projects[0].originalPath).toBe(
      "/Users/test/old/project"
    );
  });

  it("emits parseable JSON for transfer import dry-runs", () => {
    const result = runCli([
      "transfer",
      "import",
      IMPORT_SOURCE_DIR,
      "--dry-run",
      "--json",
      "--remap",
      "/Users/test:/Users/demo",
    ]);

    const payload = parseJsonOutput(result);
    expect(payload.importPath).toBe(IMPORT_SOURCE_DIR);
    expect(payload.dryRun).toBe(true);
    expect(payload.pathsRemapped).toBe(1);
    expect(payload.projectsImported).toBe(1);
  });

  it("resolves paths from transcript cwd for hyphenated Claude project directories", () => {
    const projectDir = join(PROJECTS_DIR, "-Users-test-client-dashboard");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "sess-hyphenated.jsonl"),
      [
        JSON.stringify({ type: "permission-mode", sessionId: "sess-hyphenated" }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-04-10T09:00:00.000Z",
          uuid: "u1",
          cwd: "/Users/test/client-dashboard",
          sessionId: "sess-hyphenated",
          message: { role: "user", content: "continue dashboard work" },
        }),
      ].join("\n"),
      "utf-8"
    );

    const result = runCli(["paths", "--json"]);
    const payload = parseJsonOutput(result);
    const project = payload.find((entry: { encodedDir: string }) => entry.encodedDir === "-Users-test-client-dashboard");
    expect(project).toMatchObject({
      path: "/Users/test/client-dashboard",
      sessions: 1,
    });
  });

  it("respects the message preview limit for indexed show JSON", () => {
    const ingestResult = runCli(["ingest", "--source", "claude", "--json"]);
    const ingestPayload = parseJsonOutput(ingestResult);
    expect(ingestPayload[0]).toMatchObject({ source: "claude", sessions: 1, errors: 0 });

    const result = runCli(["show", "sess-001", "--messages", "1", "--json"]);
    const payload = parseJsonOutput(result);
    expect(payload.session.source_id).toBe("sess-001");
    expect(payload.messages).toHaveLength(1);
    expect(payload.messages[0].content).toBe("hello");
  });

  it("filters indexed search and lists by project name or path substring", () => {
    const ingestResult = runCli(["ingest", "--source", "claude", "--json"]);
    const ingestPayload = parseJsonOutput(ingestResult);
    expect(ingestPayload[0]).toMatchObject({ source: "claude", sessions: 1, errors: 0 });

    const listResult = runCli(["indexed-list", "--project", "old", "--json"]);
    const listed = parseJsonOutput(listResult);
    expect(listed.map((session: { source_id: string }) => session.source_id)).toContain("sess-001");

    const searchResult = runCli(["search", "hello", "--project", "project", "--json"]);
    const hits = parseJsonOutput(searchResult);
    expect(hits.map((hit: { source_id?: string; session_id?: string }) => hit.session_id ?? hit.source_id)).toHaveLength(1);
  });

  it("keeps large JSON output parseable when piped", () => {
    seedLargeIndexedDb(220);
    const parser = `bun -e 'const text = await new Response(Bun.stdin.stream()).text(); const value = JSON.parse(text); if (Array.isArray(value)) console.log(value.length); else console.log(value.count ?? value.results?.length ?? 0);'`;
    const commands = [
      `bun run src/cli/index.tsx indexed-list --json --limit 220 | ${parser}`,
      `bun run src/cli/index.tsx recent --json --limit 220 | ${parser}`,
      `bun run src/cli/index.tsx search large-json-token --json --limit 220 | ${parser}`,
      `bun run src/cli/index.tsx search large-json-token --tools --json --limit 220 | ${parser}`,
      `bun run src/cli/index.tsx recall large-json-token --no-semantic --json --limit 40 | ${parser}`,
    ];

    for (const command of commands) {
      const result = runCliPipe(command);
      expect(Buffer.from(result.stderr).toString("utf-8")).toBe("");
      expect(result.exitCode).toBe(0);
      expect(Number(Buffer.from(result.stdout).toString("utf-8").trim())).toBeGreaterThan(0);
    }
  });

  it("emits parseable JSON for watch-ingest status and reindex alias", () => {
    const statusResult = runCli(["watch-ingest", "--status", "--json"]);
    const status = parseJsonOutput(statusResult);
    expect(status.sources).toContain("claude");
    expect(status.roots.some((root: { source: string; exists: boolean }) => root.source === "claude" && root.exists)).toBe(true);

    const reindexResult = runCli(["reindex", "--json"]);
    const reindex = parseJsonOutput(reindexResult);
    expect(reindex.some((entry: { source: string }) => entry.source === "claude")).toBe(true);
  });

  it("rejects invalid watch-ingest numeric options", () => {
    const badPoll = runCli(["watch-ingest", "--status", "--poll", "nope", "--json"]);
    expect(badPoll.exitCode).toBe(1);
    expect(Buffer.from(badPoll.stderr).toString("utf-8")).toContain("--poll must be a non-negative integer");

    const badDebounce = runCli(["watch-ingest", "--status", "--debounce", "-1", "--json"]);
    expect(badDebounce.exitCode).toBe(1);
    expect(Buffer.from(badDebounce.stderr).toString("utf-8")).toContain("--debounce must be a positive integer");
  });
});
