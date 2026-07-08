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

  it("keeps metadata, docs, source, lockfile, and MCP entrypoints on sessions-native storage", () => {
    const forbiddenMarkers = [
      "@hasna/cloud",
      "open-cloud",
      "cloud-mcp",
      "registerCloudTools",
      "registerCloudCommands",
      ".hasna/cloud",
      "HASNA_CLOUD_",
      "HASNA_RDS_PASSWORD",
      "--cloud",
      "HASNA_SESSIONS_CLOUD",
      "SESSIONS_CLOUD",
    ];
    const entrypoints = [
      "README.md",
      "package.json",
      "bun.lock",
      "src/cli/index.tsx",
      "src/db/session-store.ts",
      "src/index.ts",
      "src/mcp/index.ts",
      "src/mcp/http.ts",
    ];

    for (const path of entrypoints) {
      const source = readRepoFile(path);
      for (const marker of forbiddenMarkers) {
        expect(source.includes(marker), `${path} contains ${marker}`).toBe(false);
      }
    }

    // The client routes through the sessions-native Store abstraction
    // (LocalStore | ApiStore over /v1) — never @hasna/cloud, never a DSN.
    expect(readRepoFile("src/mcp/index.ts")).toContain("resolveSessionStore");
    expect(readRepoFile("src/cli/index.tsx")).toContain("resolveSessionStore");
  });
});
