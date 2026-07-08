import { describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { getPackageVersion } from "../src/lib/package";

const repoRoot = join(import.meta.dir, "..");

function runBun(args: string[]) {
  const eventsDir = join(tmpdir(), `sessions-events-${randomUUID()}`);
  return Bun.spawnSync({
    cmd: ["bun", ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HASNA_EVENTS_DIR: eventsDir },
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
    expect(stdout).toContain("live");
    expect(stdout).toContain("bulk");
    expect(stdout).toContain("ingest-watch");
    expect(stdout).toContain("watch-ingest");
    expect(stdout).toContain("list");
    expect(stdout).toContain("list-indexed");
    expect(stdout).toContain("indexed-list");
    expect(stdout).toContain("events");
    expect(stdout).toContain("channels");
  });

  it("prints CLI help with shared events and channels commands", () => {
    const result = runBun(["run", "src/cli/index.tsx", "--help"]);
    const output = Buffer.from(result.stdout).toString("utf-8");

    expect(result.exitCode).toBe(0);
    expect(output).toContain("events");
    expect(output).toContain("channels");
  });

  it("prints watch-ingest help with daemon controls", () => {
    const result = runBun(["run", "src/cli/index.tsx", "watch-ingest", "--help"]);
    const output = Buffer.from(result.stdout).toString("utf-8");

    expect(result.exitCode).toBe(0);
    expect(output).toContain("--source");
    expect(output).toContain("--no-initial");
    expect(output).toContain("--poll");
  });

  it("prints bulk help with safety controls", () => {
    const result = runBun(["run", "src/cli/index.tsx", "bulk", "--help"]);
    const output = Buffer.from(result.stdout).toString("utf-8");

    expect(result.exitCode).toBe(0);
    expect(output).toContain("--open-only");
    expect(output).toContain("--dry-run");
    expect(output).toContain("--concurrency");
    expect(output).toContain("--max-active-agents");
  });
});
