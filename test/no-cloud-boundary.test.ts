import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf-8");
}

describe("no-cloud package boundary", () => {
  it("does not declare @hasna/cloud in package dependencies", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    const dependencyNames = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ];

    expect(dependencyNames).not.toContain("@hasna/cloud");
  });

  it("keeps MCP entrypoints on sessions-native storage tools", () => {
    const entrypoints = ["src/mcp/index.ts", "src/mcp/http.ts", "src/mcp/storage-tools.ts", "bun.lock"];

    for (const path of entrypoints) {
      const source = readRepoFile(path);
      expect(source).not.toContain("@hasna/cloud");
      expect(source).not.toContain("registerCloudTools");
    }

    expect(readRepoFile("src/mcp/index.ts")).toContain("registerSessionsStorageTools");
  });
});
