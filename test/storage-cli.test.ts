import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
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
      const status = JSON.parse(output) as {
        mode: string;
        enabled: boolean;
        tables: Array<{ table: string; rows: number }>;
        adapters: Array<{ id: string; kind: string; enabled: boolean }>;
        privacy: { default_remote_push: string; gated_tables: Array<{ table: string }> };
      };
      expect(status.mode).toBe("local");
      expect(status.enabled).toBe(false);
      expect(status.tables.some((table) => table.table === "sessions")).toBe(true);
      expect(status.adapters.some((adapter) => adapter.id === "local-sqlite-fts")).toBe(true);
      expect(status.privacy.default_remote_push).toBe("metadata_only");
      expect(status.privacy.gated_tables.some((table) => table.table === "messages")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("top-level sync indexes locally and skips remote storage when storage is not configured", () => {
    const home = mkdtempSync(join(tmpdir(), "open-sessions-sync-cli-"));
    try {
      const result = runCli(["sync", "--no-ingest", "--json"], {
        HOME: home,
        SESSIONS_DB_PATH: ":memory:",
        HASNA_SESSIONS_DIR: join(home, ".hasna", "sessions"),
        HASNA_SESSIONS_DATABASE_URL: "",
        SESSIONS_DATABASE_URL: "",
        HASNA_SESSIONS_STORAGE_MODE: "",
        SESSIONS_STORAGE_MODE: "",
      });
      const output = Buffer.from(result.stdout).toString("utf-8");

      expect(result.exitCode).toBe(0);
      const payload = JSON.parse(output) as {
        push: { code: number; output: string; skipped?: boolean };
        pull: { code: number; output: string; skipped?: boolean };
      };
      expect(payload.push).toEqual({
        code: 0,
        output: "storage not configured; skipped remote push",
        skipped: true,
      });
      expect(payload.pull).toEqual({
        code: 0,
        output: "storage not configured; skipped remote pull",
        skipped: true,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("top-level sync returns parseable JSON errors for malformed storage config", () => {
    const home = mkdtempSync(join(tmpdir(), "open-sessions-bad-storage-cli-"));
    const configPath = join(home, "storage-config.json");
    try {
      writeFileSync(configPath, "{ invalid json", "utf-8");
      const result = runCli(["sync", "--no-ingest", "--json"], {
        HOME: home,
        SESSIONS_DB_PATH: ":memory:",
        HASNA_SESSIONS_DIR: join(home, ".hasna", "sessions"),
        HASNA_SESSIONS_STORAGE_CONFIG_PATH: configPath,
        HASNA_SESSIONS_DATABASE_URL: "",
        SESSIONS_DATABASE_URL: "",
        HASNA_SESSIONS_STORAGE_MODE: "",
        SESSIONS_STORAGE_MODE: "",
      });
      const output = Buffer.from(result.stdout).toString("utf-8");

      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(output) as { error: string };
      expect(payload.error).toContain("Malformed sessions storage config");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("storage status returns parseable JSON errors for malformed storage config", () => {
    const home = mkdtempSync(join(tmpdir(), "open-sessions-bad-storage-status-"));
    const configPath = join(home, "storage-config.json");
    try {
      writeFileSync(configPath, "{ invalid json", "utf-8");
      const result = runCli(["storage", "status", "--json"], {
        HOME: home,
        SESSIONS_DB_PATH: ":memory:",
        HASNA_SESSIONS_STORAGE_CONFIG_PATH: configPath,
        HASNA_SESSIONS_DATABASE_URL: "",
        SESSIONS_DATABASE_URL: "",
        HASNA_SESSIONS_STORAGE_MODE: "",
        SESSIONS_STORAGE_MODE: "",
      });
      const output = Buffer.from(result.stdout).toString("utf-8");

      expect(result.exitCode).toBe(1);
      const payload = JSON.parse(output) as { error: string };
      expect(payload.error).toContain("Malformed sessions storage config");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("explicit storage sync exits non-zero when storage is not configured", () => {
    const home = mkdtempSync(join(tmpdir(), "open-sessions-storage-sync-cli-"));
    try {
      const result = runCli(["storage", "sync", "--json"], {
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
      const payload = JSON.parse(output) as { error: string };
      expect(payload.error).toContain("Storage database is not configured");
      expect(payload.error).toContain("HASNA_SESSIONS_DATABASE_URL");
      expect(payload.error).toContain("SESSIONS_DATABASE_URL");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
