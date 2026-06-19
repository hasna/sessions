import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");

function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.tsx", ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...env,
    },
  });
}

describe("sessions storage CLI", () => {
  it("help advertises storage sync without legacy cloud command", () => {
    const result = runCli(["--help"]);
    const output = Buffer.from(result.stdout).toString("utf-8");

    expect(result.exitCode).toBe(0);
    expect(output).toContain("storage");
    expect(output).not.toContain("cloud");
  });

  it("storage status reports local mode as JSON", () => {
    const home = mkdtempSync(join(tmpdir(), "open-sessions-storage-cli-"));
    try {
      const result = runCli(["storage", "status", "--json"], {
        HOME: home,
        SESSIONS_DB_PATH: ":memory:",
        HASNA_SESSIONS_DATABASE_URL: "",
        SESSIONS_DATABASE_URL: "",
        HASNA_SESSIONS_STORAGE_MODE: "",
        SESSIONS_STORAGE_MODE: "",
      });
      const output = Buffer.from(result.stdout).toString("utf-8");

      expect(result.exitCode).toBe(0);
      const status = JSON.parse(output) as { mode: string; enabled: boolean; tables: Array<{ table: string; rows: number }> };
      expect(status.mode).toBe("local");
      expect(status.enabled).toBe(false);
      expect(status.tables.some((table) => table.table === "sessions")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("sync exits non-zero when storage is not configured", () => {
    const home = mkdtempSync(join(tmpdir(), "open-sessions-sync-cli-"));
    try {
      const result = runCli(["sync", "--no-ingest", "--no-pull", "--json"], {
        HOME: home,
        SESSIONS_DB_PATH: ":memory:",
        HASNA_SESSIONS_DIR: join(home, ".hasna", "sessions"),
        HASNA_SESSIONS_DATABASE_URL: "",
        SESSIONS_DATABASE_URL: "",
        HASNA_SESSIONS_STORAGE_MODE: "",
        SESSIONS_STORAGE_MODE: "",
      });
      const output = Buffer.from(result.stdout).toString("utf-8");

      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(output) as { push: { code: number; output: string } };
      expect(payload.push.code).toBe(1);
      expect(payload.push.output).toContain("Storage database is not configured");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
