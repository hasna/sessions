import type { StorageConfig } from "./storage-config.js";
import { getStorageConfig } from "./storage-config.js";

export type RemotePayloadClass = "transcripts" | "tool_payloads" | "embeddings" | "feedback";
export type RemotePayloadToken = RemotePayloadClass | "all" | "messages" | "tool_calls";

export const REMOTE_PAYLOAD_ENV = {
  canonical: "HASNA_SESSIONS_REMOTE_PAYLOADS",
  fallback: "SESSIONS_REMOTE_PAYLOADS",
} as const;

export const REMOTE_METADATA_TABLES = [
  "sessions",
  "machines",
  "ingestion_state",
  "ingestion_stats",
] as const;

export const REMOTE_PAYLOAD_TABLES: Record<string, { payloadClass: RemotePayloadClass; description: string }> = {
  messages: {
    payloadClass: "transcripts",
    description: "full message transcript content",
  },
  tool_calls: {
    payloadClass: "tool_payloads",
    description: "tool input and output payloads",
  },
  embeddings: {
    payloadClass: "embeddings",
    description: "embedding chunks and vectors derived from transcripts",
  },
  feedback: {
    payloadClass: "feedback",
    description: "operator feedback messages and optional email addresses",
  },
};

export interface RemoteTableGate {
  table: string;
  payloadClass: RemotePayloadClass | "metadata" | "unknown";
  allowed: boolean;
  reason: string | null;
}

export interface RemotePrivacyStatus {
  default_remote_push: "metadata_only";
  opt_in_env: string;
  fallback_opt_in_env: string;
  allowed_remote_payloads: RemotePayloadToken[];
  metadata_tables: string[];
  gated_tables: Array<{
    table: string;
    payload_class: RemotePayloadClass;
    default_action: "skipped";
    description: string;
  }>;
}

function splitTokens(raw: string | undefined): string[] {
  return raw?.split(",").map((token) => token.trim()).filter(Boolean) ?? [];
}

function normalizePayloadToken(token: string): RemotePayloadToken | null {
  const normalized = token.toLowerCase().replace(/-/g, "_");
  if (
    normalized === "all" ||
    normalized === "transcripts" ||
    normalized === "tool_payloads" ||
    normalized === "embeddings" ||
    normalized === "feedback" ||
    normalized === "messages" ||
    normalized === "tool_calls"
  ) {
    return normalized;
  }
  if (normalized === "tools") return "tool_payloads";
  return null;
}

export function getRemotePayloadTokens(config: StorageConfig = getStorageConfig()): RemotePayloadToken[] {
  const tokens = new Set<RemotePayloadToken>();
  const configured = Array.isArray(config.privacy?.remote_payloads)
    ? config.privacy.remote_payloads
    : [];
  for (const raw of configured) {
    const token = normalizePayloadToken(String(raw));
    if (token) tokens.add(token);
  }

  for (const envName of [REMOTE_PAYLOAD_ENV.canonical, REMOTE_PAYLOAD_ENV.fallback]) {
    for (const raw of splitTokens(process.env[envName])) {
      const token = normalizePayloadToken(raw);
      if (token) tokens.add(token);
    }
  }
  return [...tokens].sort();
}

export function getRemoteTableGate(
  table: string,
  config: StorageConfig = getStorageConfig()
): RemoteTableGate {
  if ((REMOTE_METADATA_TABLES as readonly string[]).includes(table)) {
    return { table, payloadClass: "metadata", allowed: true, reason: null };
  }

  const policy = REMOTE_PAYLOAD_TABLES[table];
  if (!policy) {
    return {
      table,
      payloadClass: "unknown",
      allowed: false,
      reason: `${table} is not in the sessions remote sync table allowlist; refusing remote sync for unknown table.`,
    };
  }

  const tokens = getRemotePayloadTokens(config);
  const allowed =
    tokens.includes("all") ||
    tokens.includes(policy.payloadClass) ||
    tokens.includes(table as RemotePayloadToken);

  return {
    table,
    payloadClass: policy.payloadClass,
    allowed,
    reason: allowed
      ? null
      : `${table} contains ${policy.description}; set ${REMOTE_PAYLOAD_ENV.canonical}=${policy.payloadClass} or add privacy.remote_payloads in the sessions storage config before remote sync.`,
  };
}

export function getRemotePrivacyStatus(config: StorageConfig = getStorageConfig()): RemotePrivacyStatus {
  return {
    default_remote_push: "metadata_only",
    opt_in_env: REMOTE_PAYLOAD_ENV.canonical,
    fallback_opt_in_env: REMOTE_PAYLOAD_ENV.fallback,
    allowed_remote_payloads: getRemotePayloadTokens(config),
    metadata_tables: [...REMOTE_METADATA_TABLES],
    gated_tables: Object.entries(REMOTE_PAYLOAD_TABLES).map(([table, policy]) => ({
      table,
      payload_class: policy.payloadClass,
      default_action: "skipped",
      description: policy.description,
    })),
  };
}
