import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findExplicitResumeCommand,
  findLastSession,
  listSessionsByProject,
  resumeGroup,
} from "../src/lib/session-resume.js";
import { encodePath } from "../src/lib/paths.js";
import type { TmuxCommandResult, TmuxRunner } from "../src/lib/live.js";

const CLAUDE_ID_1 = "11111111-1111-4111-8111-111111111111";
const CLAUDE_ID_2 = "22222222-2222-4222-8222-222222222222";
const CODEX_ID = "33333333-3333-4333-8333-333333333333";
const TAKUMI_ID = "44444444-4444-4444-8444-444444444444";

let root: string;
let projectPath: string;
let claudeProjectsDir: string;
let codexSessionsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "open-sessions-resume-"));
  projectPath = join(root, "workspace", "project-with-hyphen");
  claudeProjectsDir = join(root, "claude", "projects");
  codexSessionsDir = join(root, "codex", "sessions");
  mkdirSync(projectPath, { recursive: true });
  mkdirSync(claudeProjectsDir, { recursive: true });
  mkdirSync(codexSessionsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resume session discovery", () => {
  it("uses the documented explicit-command provider priority and latest matching id", () => {
    const history = [
      `codex resume ${CODEX_ID}`,
      `claude --resume ${CLAUDE_ID_1}`,
      `claude --resume '${CLAUDE_ID_2}'`,
      `takumi --resume ${TAKUMI_ID}`,
    ].join("\n");

    expect(findExplicitResumeCommand(history)).toEqual({
      agent: "claude",
      sessionId: CLAUDE_ID_2,
    });
  });

  it("lists matching Claude and Codex files together by mtime", () => {
    const claudeDir = join(claudeProjectsDir, encodePath(projectPath));
    const codexDay = join(codexSessionsDir, "2026", "07", "29");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDay, { recursive: true });

    const claudeFile = join(claudeDir, `${CLAUDE_ID_1}.jsonl`);
    const codexFile = join(codexDay, `rollout-2026-07-29T10-00-00-${CODEX_ID}.jsonl`);
    const otherFile = join(codexDay, "rollout-other.jsonl");
    writeFileSync(claudeFile, JSON.stringify({ sessionId: CLAUDE_ID_1, cwd: projectPath }));
    writeFileSync(
      codexFile,
      JSON.stringify({ type: "session_meta", payload: { id: CODEX_ID, cwd: projectPath } })
    );
    writeFileSync(
      otherFile,
      JSON.stringify({ type: "session_meta", payload: { id: "other", cwd: join(root, "other") } })
    );
    utimesSync(claudeFile, new Date(1_000), new Date(1_000));
    utimesSync(codexFile, new Date(2_000), new Date(2_000));

    const sessions = listSessionsByProject(projectPath, { claudeProjectsDir, codexSessionsDir });
    expect(sessions.map((session) => [session.agent, session.sessionId])).toEqual([
      ["codex", CODEX_ID],
      ["claude", CLAUDE_ID_1],
    ]);
  });

  it("finds an explicit resume command for a window target", () => {
    const calls: string[][] = [];
    const runner: TmuxRunner = (args) => {
      calls.push(args);
      if (args[0] === "list-panes") {
        return ok(`group-a\t3\tapi\t1\t%31\t${projectPath}\tCodex\t1\n`);
      }
      if (args[0] === "capture-pane") return ok(`$ codex resume ${CODEX_ID}\n`);
      if (args[0] === "list-windows") return ok("1\n3\n");
      return failResult();
    };

    const match = findLastSession("group-a:3", {
      runner,
      claudeProjectsDir,
      codexSessionsDir,
    });
    expect(match?.agent).toBe("codex");
    expect(match?.sessionId).toBe(CODEX_ID);
    expect(match?.resumeCommand).toEqual(["codex", "resume", CODEX_ID]);
    expect(calls.some((args) => args.join(" ").includes("capture-pane -p -t %31 -S -"))).toBe(true);
  });

  it("uses each window ordinal to select the Nth-most-recent Claude transcript", () => {
    const claudeDir = join(claudeProjectsDir, encodePath(projectPath));
    mkdirSync(claudeDir, { recursive: true });
    const older = join(claudeDir, `${CLAUDE_ID_1}.jsonl`);
    const newer = join(claudeDir, `${CLAUDE_ID_2}.jsonl`);
    writeFileSync(older, "{}\n");
    writeFileSync(newer, "{}\n");
    utimesSync(older, new Date(1_000), new Date(1_000));
    utimesSync(newer, new Date(2_000), new Date(2_000));

    const calls: string[][] = [];
    const runner: TmuxRunner = (args) => {
      calls.push(args);
      if (args[0] === "list-sessions") return ok("member-a\tplatform-alumia\n");
      if (args[0] === "list-windows") {
        return ok([
          `1\tweb\t0\t%10\t${projectPath}\tweb`,
          `3\tapi\t0\t%30\t${projectPath}\tapi`,
        ].join("\n"));
      }
      if (args[0] === "capture-pane") return ok("shell prompt only\n");
      return failResult();
    };

    const result = resumeGroup("platform-alumia", {
      runner,
      dryRun: true,
      claudeProjectsDir,
      codexSessionsDir,
    });
    expect(result.tmuxSession).toBe("member-a");
    expect(result.entries.map((entry) => entry.sessionId)).toEqual([CLAUDE_ID_2, CLAUDE_ID_1]);
    expect(result.entries.every((entry) => entry.status === "planned")).toBe(true);
    expect(calls.some((args) => args[0] === "kill-window" || args[0] === "new-window")).toBe(false);
  });

  it("kills and recreates resumable windows in descending index order", () => {
    const calls: string[][] = [];
    const runner: TmuxRunner = (args) => {
      calls.push(args);
      if (args[0] === "list-sessions") return ok("platform-alumia\tplatform-alumia\n");
      if (args[0] === "list-windows") {
        return ok([
          `1\tclaude-window\t0\t%10\t${projectPath}\tClaude`,
          `2\tcodex-window\t0\t%20\t${projectPath}\tCodex`,
        ].join("\n"));
      }
      if (args[0] === "capture-pane" && args.includes("%10")) {
        return ok(`claude --resume ${CLAUDE_ID_1}`);
      }
      if (args[0] === "capture-pane" && args.includes("%20")) {
        return ok(`codex resume ${CODEX_ID}`);
      }
      if (args[0] === "kill-window" || args[0] === "new-window") return ok("");
      return failResult();
    };

    const result = resumeGroup("platform-alumia", {
      runner,
      claudeProjectsDir,
      codexSessionsDir,
    });
    expect(result.summary.resumed).toBe(2);
    const mutations = calls.filter((args) => args[0] === "kill-window" || args[0] === "new-window");
    expect(mutations[0]).toEqual(["kill-window", "-t", "platform-alumia:2"]);
    expect(mutations[1].slice(0, 7)).toEqual([
      "new-window", "-d", "-t", "platform-alumia:2", "-n", "codex-window", "-c",
    ]);
    expect(mutations[1].at(-1)).toBe(`exec 'codex' 'resume' '${CODEX_ID}'`);
    expect(mutations[2]).toEqual(["kill-window", "-t", "platform-alumia:1"]);
    expect(mutations[3].at(-1)).toBe(`exec 'claude' '--resume' '${CLAUDE_ID_1}'`);
  });
});

function ok(stdout: string): TmuxCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function failResult(): TmuxCommandResult {
  return { exitCode: 1, stdout: "", stderr: "unexpected command" };
}
