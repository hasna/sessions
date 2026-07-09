import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
let root: string;

function runCli(args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.tsx", ...args],
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: root,
      CLAUDE_PATH: join(root, "claude"),
      CODEX_PATH: join(root, "codex"),
      GEMINI_PATH: join(root, "gemini"),
      SESSIONS_DB_PATH: join(root, "sessions.db"),
      HASNA_SESSIONS_DB_PATH: join(root, "sessions.db"),
      HASNA_SESSIONS_DIR: join(root, "sessions-home"),
      HASNA_SESSIONS_MODE: "local",
      HASNA_SESSIONS_API_URL: "",
      HASNA_SESSIONS_API_KEY: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

beforeEach(() => {
  root = join(tmpdir(), `sessions-sync-cli-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("sessions content sync CLI", () => {
  it("exposes content sync and daemon help", () => {
    const syncHelp = runCli(["sync", "--help"]);
    expect(syncHelp.exitCode).toBe(0);
    expect(Buffer.from(syncHelp.stdout).toString("utf-8")).toContain("--dry-run");
    expect(Buffer.from(syncHelp.stdout).toString("utf-8")).toContain("--watch");

    const daemonHelp = runCli(["daemon", "--help"]);
    expect(daemonHelp.exitCode).toBe(0);
    expect(Buffer.from(daemonHelp.stdout).toString("utf-8")).toContain("self_hosted");
    expect(Buffer.from(daemonHelp.stdout).toString("utf-8")).toContain("/v1 API");
    expect(Buffer.from(daemonHelp.stdout).toString("utf-8")).toContain("--max-iterations");
  });

  it("dry-runs content sync as parseable JSON without API credentials", () => {
    const result = runCli([
      "sync",
      "--dry-run",
      "--no-ingest",
      "--limit",
      "1",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(result.stderr).toString("utf-8")).toBe("");

    const payload = JSON.parse(Buffer.from(result.stdout).toString("utf-8"));
    expect(payload.target).toBe("self_hosted_api");
    expect(payload.dryRun).toBe(true);
    expect(payload.scanned).toBe(0);
    expect(payload.backup.guidance).toContain("local SQLite backup");
    expect(payload.backup.hook.configured).toBe(false);
  });
});
