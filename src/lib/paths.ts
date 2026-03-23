/**
 * Path encoding/decoding for Claude Code session storage.
 *
 * Claude Code stores sessions in ~/.claude/projects/<encoded-path>/
 * where the encoded path replaces / with - (e.g., /Users/hasna/Workspace → -Users-hasna-Workspace)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

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

/** Get the sessions base directory, with auto-migration from legacy path. */
export function getSessionsDir(): string {
  const home = homedir();
  const newDir = join(home, ".hasna", "sessions");
  const legacyDir = join(home, ".sessions");

  // Auto-migrate: if legacy exists and new doesn't, copy config forward
  if (existsSync(legacyDir) && !existsSync(newDir)) {
    mkdirSync(newDir, { recursive: true });
  } else if (!existsSync(newDir)) {
    mkdirSync(newDir, { recursive: true });
  }

  return newDir;
}

/** Get the sessions database path. */
export function getSessionsDbPath(): string {
  if (process.env.HASNA_SESSIONS_DB_PATH) return process.env.HASNA_SESSIONS_DB_PATH;
  if (process.env.SESSIONS_DB_PATH) return process.env.SESSIONS_DB_PATH;

  const home = homedir();
  const newDbPath = join(home, ".hasna", "sessions", "sessions.db");
  const legacyDbPath = join(home, ".sessions", "sessions.db");

  // Use legacy DB if it exists and new one doesn't yet (backward compat)
  if (!existsSync(newDbPath) && existsSync(legacyDbPath)) {
    return legacyDbPath;
  }

  // Ensure directory exists
  const dir = join(home, ".hasna", "sessions");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  return newDbPath;
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

  // Try reading cwd from first .jsonl file
  try {
    const files = readdirSync(dirPath);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const content = readFileSync(join(dirPath, file), "utf-8");
      const firstLine = content.split("\n").find((l) => l.trim());
      if (firstLine) {
        try {
          const obj = JSON.parse(firstLine);
          if (obj.cwd) return obj.cwd;
        } catch {
          // Not valid JSON
        }
      }
      break; // Only check the first .jsonl
    }
  } catch {
    // Fall through
  }

  // Fall back to naive decode
  return decodePath(encodedDir);
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
