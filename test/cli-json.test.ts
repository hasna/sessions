import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

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
    JSON.stringify({
      type: "user",
      cwd: "/Users/test/old/project",
      message: { role: "user", content: "hello" },
    }),
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
});
