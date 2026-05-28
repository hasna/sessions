import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, join } from "path";
import { getClaudeProjectsDir, getSessionsDir, resolveProjectPath } from "./paths.js";

export type SessionStatus = "active" | "idle";

export interface SessionRecord {
  sessionId: string;
  friendlyName: string;
  friendlyNameSource: "auto" | "manual";
  projectPath: string;
  projectSlug: string;
  encodedDir: string;
  transcriptPath: string;
  provider: "claude";
  startedAt: string;
  lastActivityAt: string;
  lastModel: string | null;
  customTitle: string | null;
  agentName: string | null;
  status: SessionStatus;
}

export interface SessionSearchResult {
  session: SessionRecord;
  snippet: string;
}

interface SessionRegistry {
  version: 1;
  counters: Record<string, number>;
  sessions: Record<string, SessionRecord>;
}

interface ParsedSessionMetadata {
  startedAt: string;
  lastActivityAt: string;
  projectPath: string;
  lastModel: string | null;
  customTitle: string | null;
  agentName: string | null;
}

const REGISTRY_FILE = "session-registry.json";
const ACTIVE_WINDOW_MS = 15 * 60 * 1000;

function registryPath(): string {
  return join(getSessionsDir(), REGISTRY_FILE);
}

function defaultRegistry(): SessionRegistry {
  return {
    version: 1,
    counters: {},
    sessions: {},
  };
}

export function loadSessionRegistry(): SessionRegistry {
  const path = registryPath();
  if (!existsSync(path)) {
    return defaultRegistry();
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as SessionRegistry;
    return {
      version: 1,
      counters: parsed.counters ?? {},
      sessions: parsed.sessions ?? {},
    };
  } catch {
    return defaultRegistry();
  }
}

export function saveSessionRegistry(registry: SessionRegistry): void {
  const dir = getSessionsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(registryPath(), JSON.stringify(registry, null, 2), "utf-8");
}

function safeParse(line: string): Record<string, any> | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line) as Record<string, any>;
  } catch {
    return null;
  }
}

function normalizeTimestamp(value: string | undefined, fallbackMs: number): string {
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date(fallbackMs).toISOString();
}

function deriveProjectSlug(projectPath: string, encodedDir: string): string {
  const candidate = basename(projectPath || encodedDir) || "session";
  const normalized = candidate
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "session";
}

function sessionStatus(lastActivityAt: string): SessionStatus {
  const delta = Date.now() - new Date(lastActivityAt).getTime();
  return delta <= ACTIVE_WINDOW_MS ? "active" : "idle";
}

function allocateFriendlyName(
  registry: SessionRegistry,
  projectSlug: string,
  existing: SessionRecord | undefined
): { friendlyName: string; source: "auto" | "manual" } {
  if (existing?.friendlyName) {
    return {
      friendlyName: existing.friendlyName,
      source: existing.friendlyNameSource ?? "auto",
    };
  }

  const used = new Set(
    Object.values(registry.sessions).map((entry) => entry.friendlyName)
  );
  let counter = registry.counters[projectSlug] ?? 0;

  let friendlyName = "";
  do {
    counter += 1;
    friendlyName = `${projectSlug}-${String(counter).padStart(5, "0")}`;
  } while (used.has(friendlyName));

  registry.counters[projectSlug] = counter;
  return { friendlyName, source: "auto" };
}

function readSessionMetadata(
  transcriptPath: string,
  fallbackProjectPath: string
): ParsedSessionMetadata {
  const stat = statSync(transcriptPath);
  const lines = readFileSync(transcriptPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);

  let startedAt = normalizeTimestamp(undefined, stat.mtimeMs);
  let lastActivityAt = normalizeTimestamp(undefined, stat.mtimeMs);
  let projectPath = fallbackProjectPath;
  let lastModel: string | null = null;
  let customTitle: string | null = null;
  let agentName: string | null = null;

  for (const line of lines) {
    const parsed = safeParse(line);
    if (!parsed) continue;

    const timestamp = normalizeTimestamp(parsed.timestamp, stat.mtimeMs);
    if (timestamp < startedAt) startedAt = timestamp;
    if (timestamp > lastActivityAt) lastActivityAt = timestamp;

    if (typeof parsed.cwd === "string" && parsed.cwd.length > 0) {
      projectPath = parsed.cwd;
    }

    if (parsed.message && typeof parsed.message.model === "string") {
      lastModel = parsed.message.model;
    }

    if (parsed.type === "custom-title" && typeof parsed.customTitle === "string") {
      customTitle = parsed.customTitle;
    }

    if (parsed.type === "agent-name" && typeof parsed.agentName === "string") {
      agentName = parsed.agentName;
    }
  }

  return {
    startedAt,
    lastActivityAt,
    projectPath,
    lastModel,
    customTitle,
    agentName,
  };
}

export function refreshSessionRegistry(): SessionRecord[] {
  const projectsDir = getClaudeProjectsDir();
  const registry = loadSessionRegistry();
  const discovered = new Set<string>();

  if (!existsSync(projectsDir)) {
    saveSessionRegistry(registry);
    return Object.values(registry.sessions).sort(sortSessionsNewestFirst);
  }

  const projectDirs = readdirSync(projectsDir);
  for (const encodedDir of projectDirs) {
    const absoluteDir = join(projectsDir, encodedDir);

    try {
      if (!statSync(absoluteDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const fallbackProjectPath = resolveProjectPath(projectsDir, encodedDir);
    const files = readdirSync(absoluteDir).filter((file) => file.endsWith(".jsonl"));

    for (const file of files) {
      const transcriptPath = join(absoluteDir, file);
      const sessionId = file.replace(/\.jsonl$/u, "");
      const existing = registry.sessions[sessionId];
      const metadata = readSessionMetadata(transcriptPath, fallbackProjectPath);
      const projectSlug = deriveProjectSlug(metadata.projectPath, encodedDir);
      const { friendlyName, source } = allocateFriendlyName(
        registry,
        projectSlug,
        existing
      );

      registry.sessions[sessionId] = {
        sessionId,
        friendlyName,
        friendlyNameSource: source,
        projectPath: metadata.projectPath,
        projectSlug,
        encodedDir,
        transcriptPath,
        provider: "claude",
        startedAt: metadata.startedAt,
        lastActivityAt: metadata.lastActivityAt,
        lastModel: metadata.lastModel,
        customTitle: metadata.customTitle,
        agentName: metadata.agentName,
        status: sessionStatus(metadata.lastActivityAt),
      };
      discovered.add(sessionId);
    }
  }

  for (const sessionId of Object.keys(registry.sessions)) {
    if (!discovered.has(sessionId)) {
      delete registry.sessions[sessionId];
    }
  }

  saveSessionRegistry(registry);
  return Object.values(registry.sessions).sort(sortSessionsNewestFirst);
}

function matchesProject(session: SessionRecord, selector: string): boolean {
  const value = selector.toLowerCase();
  return (
    session.projectSlug.toLowerCase() === value ||
    session.projectSlug.toLowerCase().includes(value) ||
    session.projectPath.toLowerCase().includes(value)
  );
}

export function listSessions(options: { project?: string } = {}): SessionRecord[] {
  const sessions = refreshSessionRegistry();
  if (!options.project) {
    return sessions;
  }
  return sessions.filter((session) => matchesProject(session, options.project!));
}

export function findSession(identifier: string): SessionRecord | null {
  const sessions = refreshSessionRegistry();
  const exact = sessions.find(
    (session) =>
      session.friendlyName === identifier || session.sessionId === identifier
  );
  if (exact) return exact;

  const prefixMatches = sessions.filter((session) =>
    session.sessionId.startsWith(identifier)
  );
  if (prefixMatches.length === 1) return prefixMatches[0];
  if (prefixMatches.length > 1) {
    throw new Error(
      `Ambiguous session identifier "${identifier}" matched ${prefixMatches.length} sessions`
    );
  }

  return null;
}

export function latestSessionForProject(selector: string): SessionRecord | null {
  const sessions = listSessions({ project: selector });
  return sessions[0] ?? null;
}

export function latestSession(): SessionRecord | null {
  return listSessions()[0] ?? null;
}

export function renameSession(
  identifier: string,
  friendlyName: string
): SessionRecord {
  const normalized = friendlyName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw new Error("Friendly name cannot be empty");
  }

  refreshSessionRegistry();
  const registry = loadSessionRegistry();
  const existingNames = new Set(
    Object.values(registry.sessions).map((entry) => entry.friendlyName)
  );
  const target = findSession(identifier);

  if (!target) {
    throw new Error(`Session not found: ${identifier}`);
  }

  if (normalized !== target.friendlyName && existingNames.has(normalized)) {
    throw new Error(`Friendly name already exists: ${normalized}`);
  }

  const stored = registry.sessions[target.sessionId];
  if (!stored) {
    throw new Error(`Registry entry missing for session: ${target.sessionId}`);
  }

  stored.friendlyName = normalized;
  stored.friendlyNameSource = "manual";
  saveSessionRegistry(registry);
  return stored;
}

export function buildClaudeResumeCommand(session: SessionRecord): string[] {
  return ["claude", "--resume", session.sessionId];
}

export function formatSessionTable(sessions: SessionRecord[]): string {
  if (sessions.length === 0) {
    return "No sessions found.";
  }

  const headers = ["NAME", "STATUS", "PROJECT", "MODEL", "SESSION"];
  const rows = sessions.map((session) => [
    session.friendlyName,
    session.status,
    session.projectSlug,
    session.lastModel ?? "-",
    session.sessionId.slice(0, 12),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length))
  );

  const render = (cols: string[]) =>
    cols
      .map((value, index) => value.padEnd(widths[index]))
      .join("  ")
      .trimEnd();

  return [render(headers), ...rows.map(render)].join("\n");
}

function sortSessionsNewestFirst(a: SessionRecord, b: SessionRecord): number {
  return (
    new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()
  );
}

function matchesAgent(session: SessionRecord, selector: string): boolean {
  const value = selector.toLowerCase();
  return (
    session.provider.toLowerCase().includes(value) ||
    session.agentName?.toLowerCase().includes(value) === true ||
    session.customTitle?.toLowerCase().includes(value) === true
  );
}

export function historySessions(options: {
  project?: string;
  today?: boolean;
  agent?: string;
} = {}): SessionRecord[] {
  let sessions = listSessions({ project: options.project });

  if (options.today) {
    const today = new Date().toISOString().slice(0, 10);
    sessions = sessions.filter((session) =>
      session.lastActivityAt.startsWith(today)
    );
  }

  if (options.agent) {
    sessions = sessions.filter((session) => matchesAgent(session, options.agent!));
  }

  return sessions;
}

function createSnippet(content: string, query: string): string {
  const lowered = content.toLowerCase();
  const matchIndex = lowered.indexOf(query.toLowerCase());
  if (matchIndex === -1) {
    return "";
  }

  const start = Math.max(0, matchIndex - 40);
  const end = Math.min(content.length, matchIndex + query.length + 80);
  return content
    .slice(start, end)
    .replace(/\s+/g, " ")
    .trim();
}

export function searchSessions(
  query: string,
  options: { project?: string; limit?: number } = {}
): SessionSearchResult[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [];
  }

  const sessions = listSessions({ project: options.project });
  const matches: SessionSearchResult[] = [];

  for (const session of sessions) {
    const content = readFileSync(session.transcriptPath, "utf-8");
    if (!content.toLowerCase().includes(needle)) {
      continue;
    }

    matches.push({
      session,
      snippet: createSnippet(content, query),
    });

    if (options.limit && matches.length >= options.limit) {
      break;
    }
  }

  return matches;
}
