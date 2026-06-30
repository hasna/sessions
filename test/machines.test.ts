import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getDatabase, resetDatabase, closeDatabase } from "../src/db/database.js";
import { saveParsedSession, listSessions } from "../src/db/sessions.js";
import { registerMachine, listMachines, recomputeMachineCounts } from "../src/db/machines.js";
import { searchMessages } from "../src/lib/search.js";
import { getMachineName } from "../src/lib/machine.js";

beforeEach(() => {
  process.env.SESSIONS_DB_PATH = ":memory:";
  process.env.HASNA_MACHINE = "testbox";
  resetDatabase();
  getDatabase();
});

afterEach(() => {
  closeDatabase();
  delete process.env.SESSIONS_DB_PATH;
  delete process.env.HASNA_MACHINE;
});

describe("getMachineName", () => {
  it("honors HASNA_MACHINE override", () => {
    expect(getMachineName()).toBe("testbox");
  });
});

describe("machine tagging", () => {
  it("defaults a session's machine to the current machine", () => {
    const s = saveParsedSession({
      session: { source: "claude", source_id: "m1", title: "t" },
      messages: [{ session_id: "", role: "user", content: "hello", sequence_num: 0 }],
      toolCalls: [],
    });
    expect(s.machine).toBe("testbox");
  });

  it("preserves an explicit machine (as for sessions synced from another machine)", () => {
    const s = saveParsedSession({
      session: { source: "codex", source_id: "m2", title: "t", machine: "machine-b" },
      messages: [{ session_id: "", role: "user", content: "x", sequence_num: 0 }],
      toolCalls: [],
    });
    expect(s.machine).toBe("machine-b");
  });
});

describe("machines registry", () => {
  it("registers the current machine and counts sessions per machine", () => {
    registerMachine();
    saveParsedSession({ session: { source: "claude", source_id: "a", machine: "testbox" }, messages: [{ session_id: "", role: "user", content: "x" }], toolCalls: [] });
    saveParsedSession({ session: { source: "claude", source_id: "b", machine: "machine-b" }, messages: [{ session_id: "", role: "user", content: "y" }], toolCalls: [] });
    saveParsedSession({ session: { source: "codex", source_id: "c", machine: "machine-b" }, messages: [{ session_id: "", role: "user", content: "z" }], toolCalls: [] });
    recomputeMachineCounts();

    const machines = listMachines();
    const byName = Object.fromEntries(machines.map((m) => [m.name, m.session_count]));
    expect(byName.testbox).toBe(1);
    expect(byName["machine-b"]).toBe(2);
    // current machine has platform recorded
    expect(machines.find((m) => m.name === "testbox")?.platform).toBeTruthy();
  });
});

describe("machine filtering", () => {
  beforeEach(() => {
    saveParsedSession({ session: { source: "claude", source_id: "s-a", machine: "machine-a", project_name: "app" }, messages: [{ session_id: "", role: "user", content: "deploy kubernetes" }], toolCalls: [] });
    saveParsedSession({ session: { source: "codex", source_id: "s-b", machine: "machine-b", project_name: "api" }, messages: [{ session_id: "", role: "user", content: "deploy kubernetes" }], toolCalls: [] });
  });

  it("filters listSessions by machine", () => {
    expect(listSessions({ machine: "machine-a" })).toHaveLength(1);
    expect(listSessions({ machine: "machine-b" })).toHaveLength(1);
    expect(listSessions({})).toHaveLength(2);
  });

  it("filters search by machine", () => {
    expect(searchMessages("kubernetes", { machine: "machine-a" })).toHaveLength(1);
    expect(searchMessages("kubernetes", { machine: "machine-b" })).toHaveLength(1);
    expect(searchMessages("kubernetes")).toHaveLength(2);
  });
});
