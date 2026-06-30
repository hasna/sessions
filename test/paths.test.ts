import { afterEach, describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodePath,
  decodePath,
  findMatchingProjectDirs,
  computeRelocatedDir,
  getSessionsDbPath,
  resolveProjectPath,
} from "../src/lib/paths";

describe("encodePath", () => {
  it("encodes filesystem path to directory name", () => {
    expect(encodePath("/Users/alice/Workspace")).toBe("-Users-alice-Workspace");
    expect(encodePath("/Users/alice/Workspace/foo/bar")).toBe(
      "-Users-alice-Workspace-foo-bar"
    );
  });

  it("encodes root path", () => {
    expect(encodePath("/")).toBe("-");
  });
});

describe("decodePath", () => {
  it("decodes directory name back to path (naive)", () => {
    expect(decodePath("-Users-alice-Workspace")).toBe(
      "/Users/alice/Workspace"
    );
  });

  it("handles non-leading-dash input", () => {
    expect(decodePath("foo-bar")).toBe("foo/bar");
  });
});

describe("findMatchingProjectDirs", () => {
  const dirs = [
    "-Users-alice-Workspace",
    "-Users-alice-Workspace-foo",
    "-Users-alice-Workspace-foo-bar",
    "-Users-alice-Other",
  ];

  it("finds exact match", () => {
    const result = findMatchingProjectDirs(dirs, "/Users/alice/Workspace");
    expect(result).toContain("-Users-alice-Workspace");
    expect(result).toContain("-Users-alice-Workspace-foo");
    expect(result).toContain("-Users-alice-Workspace-foo-bar");
    expect(result).not.toContain("-Users-alice-Other");
  });

  it("finds child matches", () => {
    const result = findMatchingProjectDirs(dirs, "/Users/alice/Workspace/foo");
    expect(result).toContain("-Users-alice-Workspace-foo");
    expect(result).toContain("-Users-alice-Workspace-foo-bar");
    expect(result).not.toContain("-Users-alice-Workspace");
  });

  it("returns empty for no match", () => {
    const result = findMatchingProjectDirs(dirs, "/Users/john");
    expect(result).toHaveLength(0);
  });
});

describe("computeRelocatedDir", () => {
  it("renames exact match", () => {
    expect(
      computeRelocatedDir(
        "-Users-alice-Workspace-old",
        "/Users/alice/Workspace/old",
        "/Users/alice/Workspace/new"
      )
    ).toBe("-Users-alice-Workspace-new");
  });

  it("renames child paths", () => {
    expect(
      computeRelocatedDir(
        "-Users-alice-Workspace-old-sub-project",
        "/Users/alice/Workspace/old",
        "/Users/alice/Workspace/new"
      )
    ).toBe("-Users-alice-Workspace-new-sub-project");
  });

  it("leaves unrelated paths unchanged", () => {
    expect(
      computeRelocatedDir(
        "-Users-alice-Other",
        "/Users/alice/Workspace/old",
        "/Users/alice/Workspace/new"
      )
    ).toBe("-Users-alice-Other");
  });

  it("handles home directory change", () => {
    expect(
      computeRelocatedDir(
        "-Users-alice-Workspace-project",
        "/Users/alice",
        "/Users/bob"
      )
    ).toBe("-Users-bob-Workspace-project");
  });
});

describe("resolveProjectPath", () => {
  let root: string | null = null;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("uses cwd from transcript lines instead of lossy hyphen decoding", () => {
    root = mkdtempSync(join(tmpdir(), "open-sessions-path-resolve-"));
    const encodedDir = "-Users-dev-Workspace-hyphenated-project";
    const projectDir = join(root, encodedDir);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "a.jsonl"),
      [
        JSON.stringify({ type: "permission-mode", sessionId: "s1" }),
        JSON.stringify({
          type: "user",
          cwd: "/Users/dev/Workspace/hyphenated-project",
          message: { role: "user", content: "plan the project" },
        }),
      ].join("\n"),
      "utf-8"
    );

    expect(resolveProjectPath(root, encodedDir)).toBe("/Users/dev/Workspace/hyphenated-project");
  });

  it("checks later transcript files when the first file has no cwd", () => {
    root = mkdtempSync(join(tmpdir(), "open-sessions-path-resolve-"));
    const encodedDir = "-Users-dev-Workspace-client-dashboard";
    const projectDir = join(root, encodedDir);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "a.jsonl"), JSON.stringify({ type: "summary" }), "utf-8");
    writeFileSync(
      join(projectDir, "b.jsonl"),
      JSON.stringify({
        type: "user",
        cwd: "/Users/dev/Workspace/client-dashboard",
        message: { role: "user", content: "continue" },
      }),
      "utf-8"
    );

    expect(resolveProjectPath(root, encodedDir)).toBe("/Users/dev/Workspace/client-dashboard");
  });
});


describe("getSessionsDbPath", () => {
  let root: string | null = null;
  let previous: string | undefined;

  afterEach(() => {
    if (previous === undefined) delete process.env.SESSIONS_DB_PATH;
    else process.env.SESSIONS_DB_PATH = previous;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("creates parent directories for explicit database paths", () => {
    previous = process.env.SESSIONS_DB_PATH;
    root = mkdtempSync(join(tmpdir(), "open-sessions-db-path-"));
    const dbPath = join(root, "missing", "nested", "sessions.db");
    process.env.SESSIONS_DB_PATH = dbPath;

    expect(getSessionsDbPath()).toBe(dbPath);
    expect(existsSync(join(root, "missing", "nested"))).toBe(true);
  });
});
