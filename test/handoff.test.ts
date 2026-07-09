import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  createExternalHandoffBundleV1,
  redactHandoffText,
  renderHandoffSkillWrapper,
} from "../src/lib/handoff";
import { encodePath } from "../src/lib/paths";

const repoRoot = join(import.meta.dir, "..");
const TEST_DIR = join(import.meta.dir, ".test-handoff");
const HOME_DIR = join(TEST_DIR, "home");
const SESSIONS_DIR = join(TEST_DIR, "sessions-home");
const CLAUDE_DIR = join(TEST_DIR, "claude");
const PROJECT_CWD = join(TEST_DIR, "work", "sample-project");

function testEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: HOME_DIR,
    HASNA_SESSIONS_DIR: SESSIONS_DIR,
    CLAUDE_PATH: CLAUDE_DIR,
    PWD: PROJECT_CWD,
    HASNA_SESSIONS_API_URL: "",
    HASNA_SESSIONS_API_KEY: "",
    HASNA_SESSIONS_MODE: "local",
    HASNA_SESSIONS_STORAGE_MODE: "local",
    SESSIONS_API_URL: "",
    SESSIONS_API_KEY: "",
    SESSIONS_MODE: "local",
    SESSIONS_STORAGE_MODE: "local",
  };
}

function runCli(args: string[]) {
  return Bun.spawnSync({
    cmd: ["bun", "run", "src/cli/index.tsx", ...args],
    cwd: repoRoot,
    env: testEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
}

function parseJsonOutput(result: ReturnType<typeof Bun.spawnSync>) {
  expect(Buffer.from(result.stderr).toString("utf-8")).toBe("");
  expect(result.exitCode).toBe(0);
  return JSON.parse(Buffer.from(result.stdout).toString("utf-8"));
}

function writeClaudeTranscript(sessionId: string, content: string): string {
  const projectDir = join(CLAUDE_DIR, "projects", encodePath(PROJECT_CWD));
  mkdirSync(projectDir, { recursive: true });
  const transcript = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(
    transcript,
    [
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-09T09:00:00.000Z",
        cwd: PROJECT_CWD,
        sessionId,
        message: { role: "user", content },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-09T09:01:00.000Z",
        cwd: PROJECT_CWD,
        sessionId,
        message: {
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Created the handoff bundle." }],
        },
      }),
    ].join("\n"),
    "utf-8",
  );
  return transcript;
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(PROJECT_CWD, { recursive: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("ExternalHandoffBundleV1", () => {
  it("redacts secret-like values from handoff text", () => {
    const npmToken = ["np", "m_", "abcdefghijklmnopqrstuvwxyz123456"].join("");
    const stripeKey = ["s", "k_live_", "abcdefghijklmnopqrstuvwxyz"].join("");
    const slackToken = ["xoxb-", "123456789012-abcdefghijkl"].join("");
    const jwt = ["eyJ", "abcdefghijklmnop", ".", "eyJ", "qrstuvwxyzabcdef", ".", "signature1234567890"].join("");
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "not-a-real-key-material",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const apiKeyAssignment = ["OPENAI", "_API", "_KEY", "=sample-secret-value-12345"].join("");
    const tokenizedUrl = "https://user:secret-value@example.com/repo.git";
    const singleTokenUrl = ["https://", "plain-token-value", "@example.com/repo.git"].join("");
    const redacted = redactHandoffText(
      [
        apiKeyAssignment,
        "token: sample-token-value-12345",
        "password=\"super-secret\"",
        "Authorization: Bearer sample-bearer-token-12345",
        npmToken,
        stripeKey,
        slackToken,
        jwt,
        privateKey,
        tokenizedUrl,
        singleTokenUrl,
      ].join(" "),
    );

    expect(redacted).toContain("[REDACTED_SECRET]");
    expect(redacted).not.toContain("sample-secret-value-12345");
    expect(redacted).not.toContain("sample-token-value-12345");
    expect(redacted).not.toContain("super-secret");
    expect(redacted).not.toContain("Bearer sample-bearer-token-12345");
    expect(redacted).not.toContain(npmToken);
    expect(redacted).not.toContain(stripeKey);
    expect(redacted).not.toContain(slackToken);
    expect(redacted).not.toContain(jwt);
    expect(redacted).not.toContain("not-a-real-key-material");
    expect(redacted).not.toContain("secret-value");
    expect(redacted).not.toContain("plain-token-value");
  });

  it("creates and writes a redacted bundle with an explicit Claude session", () => {
    const oldTranscript = writeClaudeTranscript(
      "session-old",
      "handoff this work token=sample-secret-value-12345",
    );
    const newTranscript = writeClaudeTranscript("session-new", "latest mtime but wrong session");
    utimesSync(oldTranscript, new Date("2026-07-09T09:00:00.000Z"), new Date("2026-07-09T09:00:00.000Z"));
    utimesSync(newTranscript, new Date("2026-07-09T10:00:00.000Z"), new Date("2026-07-09T10:00:00.000Z"));

    const result = createExternalHandoffBundleV1({
      target: "codewith",
      sourceAgent: "claude",
      sourceSession: "session-old",
      cwd: PROJECT_CWD,
      idempotencyKey: "handoff-test",
      authRefs: ["codewith:live-codewith"],
      verification: ["bun test handoff"],
      env: testEnv(),
      now: "2026-07-09T11:00:00.000Z",
    });

    expect(result.written).toBe(true);
    expect(existsSync(result.bundle_path)).toBe(true);
    expect(result.bundle.source.transcript_path).toBe(oldTranscript);
    expect(result.bundle.source.transcript_detected_by).toBe("explicit_session");
    expect(result.bundle.context.recent_turns.map((turn) => turn.text).join(" ")).not.toContain("sample-secret-value");
    expect(result.bundle.context.recent_turns.map((turn) => turn.text).join(" ")).toContain("[REDACTED_SECRET]");
    expect(result.bundle.auth_refs).toEqual([{ agent: "codewith", name: "live-codewith" }]);
    expect(result.bundle.verification.status).toBe("provided");
    expect(result.bundle.bundle_hash).toMatch(/^sha256:/);

    const stored = JSON.parse(readFileSync(result.bundle_path, "utf-8"));
    expect(stored.id).toBe(result.bundle.id);
    expect(stored.context.redacted).toBe(true);
  });

  it("redacts user-password git remotes before persisting bundle metadata", () => {
    writeClaudeTranscript("session-git", "git remote handoff");
    const secretRemote = "https://user:secret-value@example.com/hasna/example.git";
    Bun.spawnSync({ cmd: ["git", "init"], cwd: PROJECT_CWD, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["git", "remote", "add", "origin", secretRemote], cwd: PROJECT_CWD, stdout: "pipe", stderr: "pipe" });

    const result = createExternalHandoffBundleV1({
      target: "codewith",
      sourceAgent: "claude",
      sourceSession: "session-git",
      cwd: PROJECT_CWD,
      idempotencyKey: "git-redaction-test",
      env: testEnv(),
      now: "2026-07-09T11:00:00.000Z",
    });

    expect(result.bundle.git.origin_url).toBe("https://[REDACTED_CREDENTIALS]@example.com/hasna/example.git");
    expect(JSON.stringify(result.bundle)).not.toContain("secret-value");
  });

  it("redacts single-token git remotes before persisting bundle metadata", () => {
    writeClaudeTranscript("session-git-token", "git remote token handoff");
    const secretRemote = ["https://", "plain-token-value", "@example.com/hasna/example.git"].join("");
    Bun.spawnSync({ cmd: ["git", "init"], cwd: PROJECT_CWD, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync({ cmd: ["git", "remote", "add", "origin", secretRemote], cwd: PROJECT_CWD, stdout: "pipe", stderr: "pipe" });

    const result = createExternalHandoffBundleV1({
      target: "codewith",
      sourceAgent: "claude",
      sourceSession: "session-git-token",
      cwd: PROJECT_CWD,
      idempotencyKey: "git-single-token-redaction-test",
      env: testEnv(),
      now: "2026-07-09T11:00:00.000Z",
    });

    expect(result.bundle.git.origin_url).toBe("https://[REDACTED_CREDENTIALS]@example.com/hasna/example.git");
    expect(JSON.stringify(result.bundle)).not.toContain("plain-token-value");
  });

  it("bounds large transcript hashing while still reading recent tail turns", () => {
    const projectDir = join(CLAUDE_DIR, "projects", encodePath(PROJECT_CWD));
    mkdirSync(projectDir, { recursive: true });
    const transcript = join(projectDir, "session-large.jsonl");
    writeFileSync(transcript, `${"x".repeat(20_000_010)}\n`, "utf-8");
    writeFileSync(
      transcript,
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-09T09:00:00.000Z",
        cwd: PROJECT_CWD,
        sessionId: "session-large",
        message: { role: "user", content: "tail turn survived" },
      }),
      { flag: "a" },
    );
    expect(statSync(transcript).size).toBeGreaterThan(20_000_000);

    const result = createExternalHandoffBundleV1({
      target: "codewith",
      sourceAgent: "claude",
      sourceSession: "session-large",
      cwd: PROJECT_CWD,
      idempotencyKey: "large-transcript-test",
      env: testEnv(),
      now: "2026-07-09T11:00:00.000Z",
    });

    expect(result.bundle.context.transcript_sha256).toBeNull();
    expect(result.bundle.context.recent_turns.at(-1)?.text).toContain("tail turn survived");
    expect(result.bundle.warnings.join(" ")).toContain("transcript sha256 skipped");
  });

  it("supports dry-run JSON behavior without writing a bundle", () => {
    writeClaudeTranscript("session-dry", "dry run handoff");

    const result = createExternalHandoffBundleV1({
      target: "codewith",
      sourceAgent: "claude",
      sourceSession: "session-dry",
      cwd: PROJECT_CWD,
      idempotencyKey: "dry-run-test",
      dryRun: true,
      env: testEnv(),
      now: "2026-07-09T11:00:00.000Z",
    });

    expect(result.written).toBe(false);
    expect(result.bundle.status).toBe("dry_run");
    expect(existsSync(result.bundle_path)).toBe(false);
    expect(result.launch?.source_exit_automatic).toBe(false);
  });

  it("renders a Codewith continuation command and never marks source exit automatic", () => {
    writeClaudeTranscript("session-command", "continue in codewith");

    const result = createExternalHandoffBundleV1({
      target: "codewith",
      sourceAgent: "claude",
      sourceSession: "session-command",
      cwd: PROJECT_CWD,
      idempotencyKey: "command-test",
      dryRun: true,
      env: testEnv(),
      now: "2026-07-09T11:00:00.000Z",
    });

    expect(result.bundle.source_exit.automatic).toBe(false);
    expect(result.launch?.command[0]).toBe("codewith");
    expect(result.launch?.command).toContain("--cd");
    expect(result.launch?.command).toContain("--no-alt-screen");
    expect(result.launch?.shell_command).toContain(result.bundle_path);
    expect(result.launch?.prompt).toContain(result.bundle.bundle_hash);
    expect(result.launch?.prompt).toContain("source exit is not automatic");
  });

  it("emits handoff wrapper skill text for Claude and Codewith", () => {
    const claude = renderHandoffSkillWrapper("claude");
    const codewith = renderHandoffSkillWrapper("codewith");

    expect(claude).toContain("name: handoff");
    expect(claude).toContain("sessions handoff <agent-name>");
    expect(claude).toContain("--source-agent claude");
    expect(claude).toContain("--json");
    expect(claude).not.toContain("--print-command");
    expect(claude).toContain("launch.shell_command");
    expect(codewith).toContain("--source-agent codewith");
    expect(codewith).toContain("Source exit is not automatic");
  });
});

describe("sessions handoff CLI", () => {
  it("emits parseable dry-run JSON and does not write the bundle", () => {
    writeClaudeTranscript("session-cli-json", "handoff via cli json");

    const payload = parseJsonOutput(
      runCli([
        "handoff",
        "codewith",
        "--source-agent",
        "claude",
        "--source-session",
        "session-cli-json",
        "--cwd",
        PROJECT_CWD,
        "--idempotency-key",
        "cli-json-test",
        "--dry-run",
        "--json",
      ]),
    );

    expect(payload.written).toBe(false);
    expect(payload.bundle.status).toBe("dry_run");
    expect(payload.bundle.source_exit.automatic).toBe(false);
    expect(payload.launch.source_exit_automatic).toBe(false);
    expect(existsSync(payload.bundle_path)).toBe(false);
  });

  it("prints the rendered command without launching another agent", () => {
    writeClaudeTranscript("session-cli-command", "handoff print command");

    const result = runCli([
      "handoff",
      "codewith",
      "--source-agent",
      "claude",
      "--source-session",
      "session-cli-command",
      "--cwd",
      PROJECT_CWD,
      "--idempotency-key",
      "cli-command-test",
      "--dry-run",
      "--print-command",
    ]);

    expect(result.exitCode).toBe(0);
    const stdout = Buffer.from(result.stdout).toString("utf-8");
    expect(stdout).toContain("codewith --cd");
    expect(stdout).toContain("ExternalHandoffBundleV1 v1 has no target acknowledgement");
    expect(stdout).toContain("handoff_");
  });

  it("prints installable wrapper text instead of writing global files", () => {
    const result = runCli(["handoff", "--emit-skill", "claude"]);

    expect(result.exitCode).toBe(0);
    const stdout = Buffer.from(result.stdout).toString("utf-8");
    expect(stdout).toContain("name: handoff");
    expect(stdout).toContain("Do not manually copy transcripts");
    expect(stdout).toContain("sessions handoff <agent-name>");
    expect(stdout).not.toContain("--print-command");
  });

  it("rejects ambiguous print/json and print/launch combinations before writing", () => {
    writeClaudeTranscript("session-cli-conflict", "handoff conflict");

    for (const args of [
      ["handoff", "codewith", "--dry-run", "--print-command", "--json"],
      ["handoff", "codewith", "--print-command", "--launch"],
      ["handoff", "claude", "--launch"],
    ]) {
      const result = runCli(args);
      expect(result.exitCode).not.toBe(0);
    }
  });
});
