import type { MessageInsert, SessionContentImport, SessionInsert, ToolCallInsert } from "../types/index.js";

const NUL_BYTE = /\u0000/g;

export function stripNulBytes(value: string): string {
  // Postgres text/json values cannot contain U+0000; drop only NULs.
  return value.replace(NUL_BYTE, "");
}

export function sanitizeImportJson<T>(value: T): T {
  if (typeof value === "string") return stripNulBytes(value) as T;
  if (Array.isArray(value)) return value.map((item) => sanitizeImportJson(item)) as T;
  if (!value || typeof value !== "object") return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    sanitized[stripNulBytes(key)] = sanitizeImportJson(item);
  }
  return sanitized as T;
}

export function sanitizeSessionInsert<T extends object>(input: T): T {
  return sanitizeImportJson(input);
}

export function sanitizeMessageInsert(input: MessageInsert): MessageInsert {
  return sanitizeImportJson(input);
}

export function sanitizeToolCallInsert(input: ToolCallInsert): ToolCallInsert {
  return sanitizeImportJson(input);
}

export function sanitizeSessionContentImport(input: SessionContentImport): SessionContentImport {
  return {
    ...sanitizeImportJson(input),
    session: sanitizeSessionInsert(input.session),
    messages: input.messages.map(sanitizeMessageInsert),
    toolCalls: input.toolCalls.map(sanitizeToolCallInsert),
    backup: input.backup ? sanitizeImportJson(input.backup) : input.backup,
    destructive: input.destructive ? sanitizeImportJson(input.destructive) : input.destructive,
  };
}
