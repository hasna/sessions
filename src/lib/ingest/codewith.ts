import { join } from "node:path";
import { homedir } from "node:os";
import { OpenAiRolloutParser } from "./openai-rollout.js";

function codewithSessionsRoot(): string {
  return process.env.CODEWITH_PATH
    ? join(process.env.CODEWITH_PATH, "sessions")
    : join(homedir(), ".codewith", "sessions");
}

export class CodewithParser extends OpenAiRolloutParser {
  constructor() {
    super("codewith", codewithSessionsRoot);
  }
}
