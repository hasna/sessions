/**
 * Path encoding/decoding for Claude Code session storage.
 *
 * Claude Code stores sessions in ~/.claude/projects/<encoded-path>/
 * where the encoded path replaces / with - (e.g., /Users/alice/Workspace → -Users-alice-Workspace)
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

/** Encode a filesystem path to a Claude Code project directory name. */
export function encodePath(fsPath: string): string {
  return fsPath.replace(/\//g, "-");
}

/** Decode a Claude Code project directory name back to a filesystem path. */
export function decodePath(encoded: string): string {
  // The leading - represents the root /
  if (encoded.startsWith("-")) {
    return "/" + encoded.slice(1).replace(/-/g, "/");
  }
  return encoded.replace(/-/g, "/");
}

/** Get the Claude Code projects directory. */
export function getClaudeProjectsDir(): string {
  return process.env.CLAUDE_PATH
    ? join(process.env.CLAUDE_PATH, "projects")
    : join(homedir(), ".claude", "projects");
}

/** Get the Claude base directory. */
export function getClaudeBaseDir(): string {
  return process.env.CLAUDE_PATH || join(homedir(), ".claude");
}

/** Get the Codex sessions directory (date-foldered rollout JSONL files). */
export function getCodexSessionsDir(): string {
  return process.env.CODEX_PATH
    ? join(process.env.CODEX_PATH, "sessions")
    : join(homedir(), ".codex", "sessions");
}

/** Get the sessions base directory, with auto-migration from legacy path. */
export function getSessionsDir(): string {
  if (process.env.HASNA_SESSIONS_DIR) {
    const dir = process.env.HASNA_SESSIONS_DIR;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  const home = getHomeDir();
  const newDir = join(home, ".hasna", "sessions");

  if (!existsSync(newDir)) {
    mkdirSync(newDir, { recursive: true });
  }
  migrateLegacySessionsDb(home);

  return newDir;
}

function ensureExplicitDbPath(dbPath: string): string {
  if (dbPath === ":memory:") return dbPath;
  const dir = dirname(dbPath);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dbPath;
}

/** Get the sessions database path. */
export function getSessionsDbPath(): string {
  if (process.env.HASNA_SESSIONS_DB_PATH) return ensureExplicitDbPath(process.env.HASNA_SESSIONS_DB_PATH);
  if (process.env.SESSIONS_DB_PATH) return ensureExplicitDbPath(process.env.SESSIONS_DB_PATH);

  if (process.env.HASNA_SESSIONS_DIR) {
    const dir = getSessionsDir();
    return join(dir, "sessions.db");
  }

  const home = getHomeDir();
  const newDbPath = join(home, ".hasna", "sessions", "sessions.db");

  migrateLegacySessionsDb(home);

  return newDbPath;
}

function migrateLegacySessionsDb(home: string): void {
  const newDir = join(home, ".hasna", "sessions");
  const newDbPath = join(newDir, "sessions.db");
  const legacyDbPath = join(home, ".sessions", "sessions.db");

  if (!existsSync(newDir)) {
    mkdirSync(newDir, { recursive: true });
  }
  if (!existsSync(newDbPath) && existsSync(legacyDbPath)) {
    copyFileSync(legacyDbPath, newDbPath);
  }
}

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

/**
 * Find all Claude project directories that match a given filesystem path.
 * A project dir matches if it IS the encoded path or is a CHILD of it.
 */
export function findMatchingProjectDirs(
  projectDirs: string[],
  fsPath: string
): string[] {
  const encoded = encodePath(fsPath);
  return projectDirs.filter(
    (dir) => dir === encoded || dir.startsWith(encoded + "-")
  );
}

/**
 * Resolve the actual filesystem path for an encoded project directory.
 *
 * Since the encoding is lossy (both / and - become -), we can't reliably
 * decode back. Instead we look at:
 * 1. sessions-index.json projectPath field
 * 2. cwd field from the first .jsonl line
 * 3. Fall back to naive decode
 */
export function resolveProjectPath(projectsDir: string, encodedDir: string): string {
  const dirPath = join(projectsDir, encodedDir);

  // Try sessions-index.json first
  const indexPath = join(dirPath, "sessions-index.json");
  if (existsSync(indexPath)) {
    try {
      const data = JSON.parse(readFileSync(indexPath, "utf-8"));
      if (data.entries?.length > 0 && data.entries[0].projectPath) {
        return data.entries[0].projectPath;
      }
    } catch {
      // Fall through
    }
  }

  // Try reading cwd from Claude transcript files. Do not rely on the first
  // line or first file: many sessions start with command/meta records that do
  // not include cwd, and the encoded directory name is lossy for hyphenated
  // project names.
  try {
    const files = readdirSync(dirPath).filter((file) => file.endsWith(".jsonl")).sort();
    for (const file of files) {
      const cwd = findCwdInJsonl(join(dirPath, file));
      if (cwd) return cwd;
    }
  } catch {
    // Fall through
  }

  // Fall back to naive decode
  return decodePath(encodedDir);
}

function findCwdInJsonl(filePath: string): string | null {
  const maxLines = 200;
  const content = readFileSync(filePath, "utf-8");
  let checked = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    checked++;
    try {
      const obj = JSON.parse(line);
      if (typeof obj.cwd === "string" && obj.cwd.length > 0) return obj.cwd;
    } catch {
      // Ignore malformed transcript lines.
    }
    if (checked >= maxLines) break;
  }
  return null;
}

/**
 * Compute the new encoded directory name after relocating a path.
 */
export function computeRelocatedDir(
  currentDir: string,
  oldPath: string,
  newPath: string
): string {
  const oldEncoded = encodePath(oldPath);
  const newEncoded = encodePath(newPath);

  if (currentDir === oldEncoded) {
    return newEncoded;
  }

  if (currentDir.startsWith(oldEncoded + "-")) {
    return newEncoded + currentDir.slice(oldEncoded.length);
  }

  return currentDir;
}
