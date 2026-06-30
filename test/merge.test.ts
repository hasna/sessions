import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDatabase, resetDatabase, closeDatabase } from "../src/db/database.js";
import { saveParsedSession, listSessions } from "../src/db/sessions.js";
import { listMachines } from "../src/db/machines.js";
import { searchMessages } from "../src/lib/search.js";
import { mergeFromDb } from "../src/db/merge.js";

let dir: string;
let srcPath: string;
let targetPath: string;

function buildDb(path: string, build: () => void) {
  process.env.SESSIONS_DB_PATH = path;
  resetDatabase();
  getDatabase();
  build();
  closeDatabase();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sessions-merge-"));
  srcPath = join(dir, "src.db");
  targetPath = join(dir, "target.db");

  // Source DB — sessions tagged as if ingested on machine-b
  buildDb(srcPath, () => {
    saveParsedSession({
      session: { source: "claude", source_id: "remote-1", title: "Remote deploy", machine: "machine-b", project_name: "infra" },
      messages: [{ session_id: "", role: "user", content: "restart the remote cluster", sequence_num: 0 }],
      toolCalls: [{ session_id: "", tool_name: "Bash", tool_input: "systemctl restart" }],
    });
    saveParsedSession({
      session: { source: "codex", source_id: "remote-2", title: "Remote fix", machine: "machine-b" },
      messages: [{ session_id: "", role: "user", content: "fix the disk full error", sequence_num: 0 }],
      toolCalls: [],
    });
  });

  // Target DB — a local machine-a session
  process.env.SESSIONS_DB_PATH = targetPath;
  resetDatabase();
  getDatabase();
  saveParsedSession({
    session: { source: "claude", source_id: "local-1", title: "Local work", machine: "machine-a", project_name: "app" },
    messages: [{ session_id: "", role: "user", content: "build the local feature", sequence_num: 0 }],
    toolCalls: [],
  });
});

afterEach(() => {
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SESSIONS_DB_PATH;
});

describe("mergeFromDb", () => {
  it("merges another machine's sessions, preserving machine tags", () => {
    const result = mergeFromDb(srcPath);
    expect(result.sessions).toBe(2);
    expect(result.messages).toBe(2);
    expect(result.tool_calls).toBe(1);

    // target now has all three sessions
    expect(listSessions({})).toHaveLength(3);
    // machine tags preserved from source
    expect(listSessions({ machine: "machine-b" })).toHaveLength(2);
    expect(listSessions({ machine: "machine-a" })).toHaveLength(1);
  });

  it("makes merged sessions searchable (FTS repopulated via triggers)", () => {
    mergeFromDb(srcPath);
    const hits = searchMessages("disk full");
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe("codex");
  });

  it("records both machines in the registry", () => {
    mergeFromDb(srcPath);
    const names = listMachines().map((m) => m.name).sort();
    expect(names).toEqual(["machine-a", "machine-b"]);
  });

  it("is idempotent — merging twice does not duplicate", () => {
    mergeFromDb(srcPath);
    const second = mergeFromDb(srcPath);
    expect(second.sessions).toBe(0);
    expect(listSessions({})).toHaveLength(3);
  });

  it("throws on a missing database path", () => {
    expect(() => mergeFromDb(join(dir, "nope.db"))).toThrow(/No such database/);
  });
});
