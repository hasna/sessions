import { join } from "node:path";
import { homedir } from "node:os";
import { OpenAiRolloutParser } from "./openai-rollout.js";

function codexSessionsRoot(): string {
  return process.env.CODEX_PATH
    ? join(process.env.CODEX_PATH, "sessions")
    : join(homedir(), ".codex", "sessions");
}

export class CodexParser extends OpenAiRolloutParser {
  constructor() {
    super("codex", codexSessionsRoot);
  }
}
