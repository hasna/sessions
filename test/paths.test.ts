import { describe, it, expect } from "bun:test";
import {
  encodePath,
  decodePath,
  findMatchingProjectDirs,
  computeRelocatedDir,
} from "../src/lib/paths";

describe("encodePath", () => {
  it("encodes filesystem path to directory name", () => {
    expect(encodePath("/Users/hasna/Workspace")).toBe("-Users-hasna-Workspace");
    expect(encodePath("/Users/hasna/Workspace/foo/bar")).toBe(
      "-Users-hasna-Workspace-foo-bar"
    );
  });

  it("encodes root path", () => {
    expect(encodePath("/")).toBe("-");
  });
});

describe("decodePath", () => {
  it("decodes directory name back to path (naive)", () => {
    expect(decodePath("-Users-hasna-Workspace")).toBe(
      "/Users/hasna/Workspace"
    );
  });

  it("handles non-leading-dash input", () => {
    expect(decodePath("foo-bar")).toBe("foo/bar");
  });
});

describe("findMatchingProjectDirs", () => {
  const dirs = [
    "-Users-hasna-Workspace",
    "-Users-hasna-Workspace-foo",
    "-Users-hasna-Workspace-foo-bar",
    "-Users-hasna-Other",
  ];

  it("finds exact match", () => {
    const result = findMatchingProjectDirs(dirs, "/Users/hasna/Workspace");
    expect(result).toContain("-Users-hasna-Workspace");
    expect(result).toContain("-Users-hasna-Workspace-foo");
    expect(result).toContain("-Users-hasna-Workspace-foo-bar");
    expect(result).not.toContain("-Users-hasna-Other");
  });

  it("finds child matches", () => {
    const result = findMatchingProjectDirs(dirs, "/Users/hasna/Workspace/foo");
    expect(result).toContain("-Users-hasna-Workspace-foo");
    expect(result).toContain("-Users-hasna-Workspace-foo-bar");
    expect(result).not.toContain("-Users-hasna-Workspace");
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
        "-Users-hasna-Workspace-old",
        "/Users/hasna/Workspace/old",
        "/Users/hasna/Workspace/new"
      )
    ).toBe("-Users-hasna-Workspace-new");
  });

  it("renames child paths", () => {
    expect(
      computeRelocatedDir(
        "-Users-hasna-Workspace-old-sub-project",
        "/Users/hasna/Workspace/old",
        "/Users/hasna/Workspace/new"
      )
    ).toBe("-Users-hasna-Workspace-new-sub-project");
  });

  it("leaves unrelated paths unchanged", () => {
    expect(
      computeRelocatedDir(
        "-Users-hasna-Other",
        "/Users/hasna/Workspace/old",
        "/Users/hasna/Workspace/new"
      )
    ).toBe("-Users-hasna-Other");
  });

  it("handles home directory change", () => {
    expect(
      computeRelocatedDir(
        "-Users-hasna-Workspace-project",
        "/Users/hasna",
        "/Users/john"
      )
    ).toBe("-Users-john-Workspace-project");
  });
});
