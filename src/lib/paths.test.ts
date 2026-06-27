import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getSessionsDbPath, getSessionsDir } from "./paths.js";

describe("sessions package state paths", () => {
  let tempRoot: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalSessionsDir: string | undefined;
  let originalSessionsDbPath: string | undefined;
  let originalLegacyDbPath: string | undefined;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "sessions-paths-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalSessionsDir = process.env.HASNA_SESSIONS_DIR;
    originalSessionsDbPath = process.env.HASNA_SESSIONS_DB_PATH;
    originalLegacyDbPath = process.env.SESSIONS_DB_PATH;
    process.env.HOME = join(tempRoot, "home");
    delete process.env.USERPROFILE;
    delete process.env.HASNA_SESSIONS_DIR;
    delete process.env.HASNA_SESSIONS_DB_PATH;
    delete process.env.SESSIONS_DB_PATH;
  });

  afterEach(() => {
    restoreEnv("HOME", originalHome);
    restoreEnv("USERPROFILE", originalUserProfile);
    restoreEnv("HASNA_SESSIONS_DIR", originalSessionsDir);
    restoreEnv("HASNA_SESSIONS_DB_PATH", originalSessionsDbPath);
    restoreEnv("SESSIONS_DB_PATH", originalLegacyDbPath);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("copies legacy sessions.db into ~/.hasna/sessions", () => {
    const home = process.env.HOME!;
    const legacyDb = join(home, ".sessions", "sessions.db");
    const newDir = join(home, ".hasna", "sessions");
    const newDb = join(newDir, "sessions.db");
    mkdirSync(join(home, ".sessions"), { recursive: true });
    writeFileSync(legacyDb, "legacy-db");

    expect(getSessionsDir()).toBe(newDir);
    expect(getSessionsDbPath()).toBe(newDb);
    expect(readFileSync(newDb, "utf8")).toBe("legacy-db");
    expect(existsSync(legacyDb)).toBe(true);
  });

  test("does not overwrite an existing ~/.hasna/sessions database", () => {
    const home = process.env.HOME!;
    const legacyDb = join(home, ".sessions", "sessions.db");
    const newDb = join(home, ".hasna", "sessions", "sessions.db");
    mkdirSync(join(home, ".sessions"), { recursive: true });
    mkdirSync(join(home, ".hasna", "sessions"), { recursive: true });
    writeFileSync(legacyDb, "legacy-db");
    writeFileSync(newDb, "new-db");

    expect(getSessionsDbPath()).toBe(newDb);
    expect(readFileSync(newDb, "utf8")).toBe("new-db");
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
