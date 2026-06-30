const INSTRUCTION_PREAMBLE_RE = /#?\s*(?:AGENTS|CODEWITH|CLAUDE)\.md instructions for\b/i;

export function normalizeSessionTitle(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 120);
}

export function isInstructionPreamble(content: string | null | undefined): boolean {
  if (!content) return false;
  const normalized = content.replace(/[\[\]]/g, "").replace(/\s+/g, " ").trim();
  return INSTRUCTION_PREAMBLE_RE.test(normalized);
}

export function titleFromUserContent(content: string): string | null {
  const normalized = normalizeSessionTitle(content);
  if (!normalized || isInstructionPreamble(normalized)) return null;
  return normalized;
}
