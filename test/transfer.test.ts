import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "fs";
import { join } from "path";
import { exportSessions, importSessions } from "../src/lib/transfer";

const TEST_DIR = join(import.meta.dir, ".test-transfer");
const PROJECTS_DIR = join(TEST_DIR, "projects");
const EXPORT_DIR = join(TEST_DIR, "export");
const IMPORT_DIR = join(TEST_DIR, "import-target");

function setup() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(PROJECTS_DIR, { recursive: true });
  mkdirSync(EXPORT_DIR, { recursive: true });
  mkdirSync(join(IMPORT_DIR, "projects"), { recursive: true });

  // Create a fake project directory
  const projectDir = join(PROJECTS_DIR, "-Users-alice-project");
  mkdirSync(projectDir, { recursive: true });

  writeFileSync(
    join(projectDir, "sessions-index.json"),
    JSON.stringify({
      version: 1,
      entries: [
        {
          sessionId: "sess-001",
          fullPath: `${PROJECTS_DIR}/-Users-alice-project/sess-001.jsonl`,
          projectPath: "/Users/alice/project",
        },
      ],
    }),
    "utf-8"
  );

  writeFileSync(
    join(projectDir, "sess-001.jsonl"),
    JSON.stringify({
      type: "user",
      cwd: "/Users/alice/project",
      message: { role: "user", content: "test" },
    }),
    "utf-8"
  );
}

function cleanup() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("exportSessions", () => {
  beforeEach(setup);
  afterEach(cleanup);

  it("exports sessions to a staging directory", () => {
    const origEnv = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = TEST_DIR;

    const result = exportSessions({
      outputDir: EXPORT_DIR,
      outputName: "test-export",
    });

    process.env.CLAUDE_PATH = origEnv;

    expect(result.errors).toHaveLength(0);
    expect(result.manifest.projects).toHaveLength(1);
    expect(result.manifest.totalFiles).toBeGreaterThan(0);

    // Verify files were created
    const manifestPath = join(EXPORT_DIR, "test-export", "manifest.json");
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(manifest.version).toBe(1);
    expect(manifest.projects[0].encodedDir).toBe("-Users-alice-project");
  });

  it("dry-run does not create files", () => {
    const origEnv = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = TEST_DIR;

    const result = exportSessions({
      outputDir: EXPORT_DIR,
      outputName: "dry-test",
      dryRun: true,
    });

    process.env.CLAUDE_PATH = origEnv;

    expect(result.manifest.totalFiles).toBeGreaterThan(0);
    expect(existsSync(join(EXPORT_DIR, "dry-test"))).toBe(false);
  });
});

describe("importSessions", () => {
  beforeEach(() => {
    setup();

    // Create a mock export directory for import
    const exportProjectDir = join(
      IMPORT_DIR,
      "projects",
      "-Users-alice-project"
    );
    mkdirSync(exportProjectDir, { recursive: true });

    writeFileSync(
      join(IMPORT_DIR, "manifest.json"),
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        sourceComputer: "source-machine",
        sourceUser: "alice",
        sourceClaudePath: "/Users/alice/.claude/projects",
        projects: [
          {
            originalPath: "/Users/alice/project",
            encodedDir: "-Users-alice-project",
            sessionCount: 1,
            jsonlCount: 1,
          },
        ],
        totalFiles: 2,
        totalSize: 1000,
      }),
      "utf-8"
    );

    writeFileSync(
      join(exportProjectDir, "sess-001.jsonl"),
      JSON.stringify({
        type: "user",
        cwd: "/Users/alice/project",
        message: { role: "user", content: "test" },
      }),
      "utf-8"
    );
  });
  afterEach(cleanup);

  it("imports sessions with path remapping", () => {
    // Use a clean target
    const targetProjectsDir = join(TEST_DIR, "target-projects");
    mkdirSync(targetProjectsDir, { recursive: true });
    const origEnv = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = join(TEST_DIR, "target");
    mkdirSync(join(TEST_DIR, "target", "projects"), { recursive: true });

    const result = importSessions(IMPORT_DIR, {
      remapPath: { from: "/Users/alice", to: "/Users/bob" },
    });

    process.env.CLAUDE_PATH = origEnv;

    expect(result.errors).toHaveLength(0);
    expect(result.projectsImported).toBe(1);
    expect(result.filesImported).toBeGreaterThan(0);
    expect(result.pathsRemapped).toBe(1);

    // Verify the imported file has remapped paths
    const importedJsonl = join(
      TEST_DIR,
      "target",
      "projects",
      "-Users-bob-project",
      "sess-001.jsonl"
    );
    expect(existsSync(importedJsonl)).toBe(true);
    const content = readFileSync(importedJsonl, "utf-8");
    const parsed = JSON.parse(content);
    expect(parsed.cwd).toBe("/Users/bob/project");
  });

  it("dry-run does not create files", () => {
    const origEnv = process.env.CLAUDE_PATH;
    process.env.CLAUDE_PATH = join(TEST_DIR, "target2");
    mkdirSync(join(TEST_DIR, "target2", "projects"), { recursive: true });

    const result = importSessions(IMPORT_DIR, {
      dryRun: true,
      remapPath: { from: "/Users/alice", to: "/Users/bob" },
    });

    process.env.CLAUDE_PATH = origEnv;

    expect(result.filesImported).toBeGreaterThan(0);
    expect(
      existsSync(
        join(TEST_DIR, "target2", "projects", "-Users-bob-project")
      )
    ).toBe(false);
  });
});
