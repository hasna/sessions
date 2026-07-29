import { join } from "node:path";
import { homedir } from "node:os";
import { OpenAiRolloutParser } from "./openai-rollout.js";

function codewithSessionsRoot(): string {
  return process.env.CODEWITH_PATH
    ? join(process.env.CODEWITH_PATH, "sessions")
    : join(homedir(), ".codewith", "sessions");
}

function codewithSessionIndex(): string {
  return process.env.CODEWITH_PATH
    ? join(process.env.CODEWITH_PATH, "session_index.jsonl")
    : join(homedir(), ".codewith", "session_index.jsonl");
}

export class CodewithParser extends OpenAiRolloutParser {
  constructor() {
    super("codewith", codewithSessionsRoot, codewithSessionIndex);
  }
}
