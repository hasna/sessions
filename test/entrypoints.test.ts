import { describe, expect, it } from "bun:test";
import { join } from "path";
import { getPackageVersion } from "../src/lib/package";

const repoRoot = join(import.meta.dir, "..");

function runBun(args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("entrypoint help and version", () => {
  it("prints MCP help and exits successfully", () => {
    const result = runBun(["run", "src/mcp/index.ts", "--help"]);
    const output = Buffer.from(result.stdout).toString("utf-8");

    expect(result.exitCode).toBe(0);
    expect(output).toContain("Usage: sessions-mcp");
    expect(output).toContain("--version");
  });

  it("prints server help and exits successfully", () => {
    const result = runBun(["run", "src/server/index.ts", "--help"]);
    const output = Buffer.from(result.stdout).toString("utf-8");

    expect(result.exitCode).toBe(0);
    expect(output).toContain("Usage: sessions-serve");
    expect(output).toContain("/health");
  });

  it("keeps CLI version aligned with package.json", () => {
    const result = runBun(["run", "src/cli/index.tsx", "--version"]);
    const output = Buffer.from(result.stdout).toString("utf-8").trim();

    expect(result.exitCode).toBe(0);
    expect(output).toBe(getPackageVersion());
  });

  // Regression: commander 13 throws "cannot add command 'X' as already have
  // command 'X'" when two top-level commands share a name, crashing every CLI
  // invocation. `watch` and `list` were each registered twice.
  it("loads without duplicate-command collisions and lists renamed commands", () => {
    const result = runBun(["run", "src/cli/index.tsx", "--help"]);
    const stdout = Buffer.from(result.stdout).toString("utf-8");
    const stderr = Buffer.from(result.stderr).toString("utf-8");

    expect(result.exitCode).toBe(0);
    expect(stderr).not.toContain("already have command");
    expect(stdout).toContain("watch");
    expect(stdout).toContain("ingest-watch");
    expect(stdout).toContain("list");
    expect(stdout).toContain("list-indexed");
  });
});
