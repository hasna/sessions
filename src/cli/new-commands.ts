/**
 * New commands to inject into the existing sessions CLI.
 * This file is compiled separately and injected before program.parse().
 * It assumes `program` (Commander) is already defined in scope.
 */

// @ts-nocheck - this runs in the context of the existing compiled CLI

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, copyFileSync } from "fs";
import { join, basename } from "path";
import { homedir, hostname, userInfo } from "os";

// ─── Path utilities ────────────────────────────────────────────────────────

function _encodePath(fsPath: string): string {
  return fsPath.replace(/\//g, "-");
}

function _decodePath(encoded: string): string {
  if (encoded.startsWith("-")) return "/" + encoded.slice(1).replace(/-/g, "/");
  return encoded.replace(/-/g, "/");
}

function _getClaudeProjectsDir(): string {
  return process.env.CLAUDE_PATH
    ? join(process.env.CLAUDE_PATH, "projects")
    : join(homedir(), ".claude", "projects");
}

function _getSessionsDbPath(): string {
  if (process.env.HASNA_SESSIONS_DB_PATH) return process.env.HASNA_SESSIONS_DB_PATH;
  if (process.env.SESSIONS_DB_PATH) return process.env.SESSIONS_DB_PATH;

  const home = homedir();
  const newDbPath = join(home, ".hasna", "sessions", "sessions.db");
  const legacyDbPath = join(home, ".sessions", "sessions.db");

  // Use legacy DB if it exists and new one doesn't yet (backward compat)
  if (existsSync(newDbPath)) return newDbPath;
  if (existsSync(legacyDbPath)) return legacyDbPath;

  return newDbPath;
}

function _findMatchingProjectDirs(projectDirs: string[], fsPath: string): string[] {
  const encoded = _encodePath(fsPath);
  return projectDirs.filter((dir) => dir === encoded || dir.startsWith(encoded + "-"));
}

function _computeRelocatedDir(currentDir: string, oldPath: string, newPath: string): string {
  const oldEncoded = _encodePath(oldPath);
  const newEncoded = _encodePath(newPath);
  if (currentDir === oldEncoded) return newEncoded;
  if (currentDir.startsWith(oldEncoded + "-")) return newEncoded + currentDir.slice(oldEncoded.length);
  return currentDir;
}

function _resolveProjectPath(projectsDir: string, encodedDir: string): string {
  const dirPath = join(projectsDir, encodedDir);
  const indexPath = join(dirPath, "sessions-index.json");
  if (existsSync(indexPath)) {
    try {
      const data = JSON.parse(readFileSync(indexPath, "utf-8"));
      if (data.entries?.length > 0 && data.entries[0].projectPath) return data.entries[0].projectPath;
    } catch {}
  }
  try {
    const files = readdirSync(dirPath);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const content = readFileSync(join(dirPath, file), "utf-8");
      const firstLine = content.split("\n").find((l) => l.trim());
      if (firstLine) {
        try { const obj = JSON.parse(firstLine); if (obj.cwd) return obj.cwd; } catch {}
      }
      break;
    }
  } catch {}
  return _decodePath(encodedDir);
}

function _formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

// ─── Relocate ──────────────────────────────────────────────────────────────

function _relocate(oldPath: string, newPath: string, options: any = {}) {
  const { dryRun = false, updateDb = true, verbose = false } = options;
  const projectsDir = _getClaudeProjectsDir();
  const result: any = { dirsRenamed: [], indexFilesUpdated: 0, jsonlFilesUpdated: 0, dbRowsUpdated: 0, errors: [] };

  oldPath = oldPath.replace(/\/+$/, "");
  newPath = newPath.replace(/\/+$/, "");

  if (!existsSync(projectsDir)) {
    result.errors.push({ file: projectsDir, error: "Claude projects directory not found" });
    return result;
  }

  const allDirs = readdirSync(projectsDir);
  const matchingDirs = _findMatchingProjectDirs(allDirs, oldPath);
  if (matchingDirs.length === 0) {
    result.errors.push({ file: oldPath, error: `No session directories found for path: ${oldPath}` });
    return result;
  }
  if (verbose) console.log(`Found ${matchingDirs.length} project directories to relocate`);

  for (const dir of matchingDirs) {
    const dirPath = join(projectsDir, dir);
    const newDir = _computeRelocatedDir(dir, oldPath, newPath);
    const newDirPath = join(projectsDir, newDir);

    // Update sessions-index.json
    const indexPath = join(dirPath, "sessions-index.json");
    if (existsSync(indexPath)) {
      try {
        const indexData = JSON.parse(readFileSync(indexPath, "utf-8"));
        let changed = false;
        if (indexData.entries) {
          for (const entry of indexData.entries) {
            if (entry.projectPath?.startsWith(oldPath)) {
              entry.projectPath = newPath + entry.projectPath.slice(oldPath.length);
              changed = true;
            }
            if (entry.fullPath) {
              const oldDirInPath = join(projectsDir, dir);
              const newDirInPath = join(projectsDir, newDir);
              if (entry.fullPath.startsWith(oldDirInPath)) {
                entry.fullPath = newDirInPath + entry.fullPath.slice(oldDirInPath.length);
                changed = true;
              }
            }
          }
        }
        if (changed) {
          if (verbose) console.log(`  Updating index: ${indexPath}`);
          if (!dryRun) writeFileSync(indexPath, JSON.stringify(indexData, null, 4), "utf-8");
          result.indexFilesUpdated++;
        }
      } catch (err: any) { result.errors.push({ file: indexPath, error: err.message }); }
    }

    // Update .jsonl files
    try {
      const updateJsonlInDir = (scanDir: string) => {
        const files = readdirSync(scanDir);
        for (const file of files) {
          const filePath = join(scanDir, file);
          if (file.endsWith(".jsonl")) {
            try {
              const content = readFileSync(filePath, "utf-8");
              let modified = false;
              const lines = content.split("\n").map((line) => {
                if (!line.trim()) return line;
                try {
                  const obj = JSON.parse(line);
                  if (obj.cwd && typeof obj.cwd === "string" && obj.cwd.startsWith(oldPath)) {
                    obj.cwd = newPath + obj.cwd.slice(oldPath.length);
                    modified = true;
                    return JSON.stringify(obj);
                  }
                } catch {}
                return line;
              });
              if (modified) {
                if (verbose) console.log(`  Updating jsonl: ${filePath}`);
                if (!dryRun) writeFileSync(filePath, lines.join("\n"), "utf-8");
                result.jsonlFilesUpdated++;
              }
            } catch (err: any) { result.errors.push({ file: filePath, error: err.message }); }
          } else {
            try {
              if (statSync(filePath).isDirectory()) updateJsonlInDir(filePath);
            } catch {}
          }
        }
      };
      updateJsonlInDir(dirPath);
    } catch (err: any) { result.errors.push({ file: dirPath, error: err.message }); }

    // Rename directory
    if (dir !== newDir) {
      if (existsSync(newDirPath)) {
        result.errors.push({ file: newDirPath, error: `Target directory already exists: ${newDir}` });
        continue;
      }
      if (verbose) console.log(`  Renaming dir: ${dir} → ${newDir}`);
      if (!dryRun) renameSync(dirPath, newDirPath);
      result.dirsRenamed.push({ from: dir, to: newDir });
    }
  }

  // Update DB
  if (updateDb) {
    const dbPath = _getSessionsDbPath();
    if (existsSync(dbPath)) {
      try {
        const { Database } = require("bun:sqlite");
        const db = new Database(dbPath);
        db.exec("PRAGMA journal_mode=WAL");
        const r = db.prepare("UPDATE sessions SET project_path = ? || substr(project_path, ?) WHERE project_path LIKE ? || '%'").run(newPath, oldPath.length + 1, oldPath);
        db.prepare("UPDATE sessions SET source_path = replace(source_path, ?, ?) WHERE source_path LIKE ? || '%'").run(oldPath, newPath, oldPath);
        db.prepare("UPDATE ingestion_state SET file_path = replace(file_path, ?, ?) WHERE file_path LIKE ? || '%'").run(_encodePath(oldPath), _encodePath(newPath), _encodePath(oldPath));
        result.dbRowsUpdated = (r as any).changes || 0;
        db.close();
        if (verbose) console.log(`  Updated ${result.dbRowsUpdated} DB rows`);
      } catch (err: any) { result.errors.push({ file: dbPath, error: err.message }); }
    }
  }

  return result;
}

// ─── Transfer Export ───────────────────────────────────────────────────────

function _copyDirRecursive(src: string, dest: string, dryRun: boolean): { count: number; size: number; jsonlCount: number } {
  let count = 0, size = 0, jsonlCount = 0;
  try {
    const files = readdirSync(src);
    if (!dryRun) mkdirSync(dest, { recursive: true });
    for (const file of files) {
      const srcFile = join(src, file);
      const destFile = join(dest, file);
      try {
        const stat = statSync(srcFile);
        if (stat.isFile()) {
          if (!dryRun) copyFileSync(srcFile, destFile);
          count++; size += stat.size;
          if (file.endsWith(".jsonl")) jsonlCount++;
        } else if (stat.isDirectory()) {
          const sub = _copyDirRecursive(srcFile, destFile, dryRun);
          count += sub.count; size += sub.size; jsonlCount += sub.jsonlCount;
        }
      } catch {}
    }
  } catch {}
  return { count, size, jsonlCount };
}

function _exportSessions(options: any = {}) {
  const { projectPath, verbose = false, dryRun = false } = options;
  const projectsDir = _getClaudeProjectsDir();
  const outputDir = options.outputDir || process.cwd();
  const datestamp = new Date().toISOString().slice(0, 10);
  const exportName = options.outputName || `sessions-export-${datestamp}`;
  const stagingDir = join(outputDir, exportName);

  const manifest: any = {
    version: 1, createdAt: new Date().toISOString(),
    sourceComputer: hostname(), sourceUser: userInfo().username,
    sourceClaudePath: _getClaudeProjectsDir(),
    projects: [], totalFiles: 0, totalSize: 0,
  };
  const errors: any[] = [];

  if (!existsSync(projectsDir)) {
    errors.push({ file: projectsDir, error: "Claude projects directory not found" });
    return { archivePath: stagingDir, manifest, errors };
  }

  const allDirs = readdirSync(projectsDir);
  let targetDirs: string[];
  if (projectPath) {
    targetDirs = _findMatchingProjectDirs(allDirs, projectPath);
    if (targetDirs.length === 0) {
      errors.push({ file: projectPath, error: `No session directories found for path: ${projectPath}` });
      return { archivePath: stagingDir, manifest, errors };
    }
  } else {
    targetDirs = allDirs;
  }

  if (verbose) console.log(`Exporting ${targetDirs.length} project directories`);
  if (!dryRun) mkdirSync(stagingDir, { recursive: true });

  for (const dir of targetDirs) {
    const srcDir = join(projectsDir, dir);
    try { if (!statSync(srcDir).isDirectory()) continue; } catch { continue; }

    const project: any = {
      originalPath: _resolveProjectPath(projectsDir, dir),
      encodedDir: dir,
      sessionCount: 0,
      jsonlCount: 0,
    };
    const destDir = join(stagingDir, "projects", dir);

    try {
      const files = readdirSync(srcDir);
      for (const file of files) {
        const srcFile = join(srcDir, file);
        try {
          const stat = statSync(srcFile);
          if (stat.isFile() && (file.endsWith(".jsonl") || file === "sessions-index.json")) {
            if (!dryRun) { mkdirSync(destDir, { recursive: true }); copyFileSync(srcFile, join(destDir, file)); }
            manifest.totalFiles++; manifest.totalSize += stat.size;
            if (file.endsWith(".jsonl")) { project.jsonlCount++; project.sessionCount++; }
          } else if (stat.isDirectory()) {
            const sub = _copyDirRecursive(srcFile, join(destDir, file), dryRun);
            manifest.totalFiles += sub.count; manifest.totalSize += sub.size; project.jsonlCount += sub.jsonlCount;
          }
        } catch (err: any) { errors.push({ file: srcFile, error: err.message }); }
      }
      manifest.projects.push(project);
    } catch (err: any) { errors.push({ file: srcDir, error: err.message }); }
  }

  if (!dryRun) writeFileSync(join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  return { archivePath: stagingDir, manifest, errors };
}

// ─── Transfer Import ───────────────────────────────────────────────────────

function _importDirRecursive(src: string, dest: string, opts: any): { imported: number; skipped: number } {
  let imported = 0, skipped = 0;
  try {
    const files = readdirSync(src);
    if (!opts.dryRun) mkdirSync(dest, { recursive: true });
    for (const file of files) {
      const srcFile = join(src, file);
      const destFile = join(dest, file);
      try {
        const stat = statSync(srcFile);
        if (stat.isFile()) {
          if (existsSync(destFile) && !opts.overwrite) { skipped++; continue; }
          if (file.endsWith(".jsonl") && opts.pathFrom && opts.pathTo) {
            if (!opts.dryRun) {
              const content = readFileSync(srcFile, "utf-8").replaceAll(opts.pathFrom, opts.pathTo);
              writeFileSync(destFile, content, "utf-8");
            }
          } else { if (!opts.dryRun) copyFileSync(srcFile, destFile); }
          imported++;
        } else if (stat.isDirectory()) {
          const sub = _importDirRecursive(srcFile, join(dest, file), opts);
          imported += sub.imported; skipped += sub.skipped;
        }
      } catch { skipped++; }
    }
  } catch {}
  return { imported, skipped };
}

function _importSessions(importPath: string, options: any = {}) {
  const { remapHome, remapPath, verbose = false, dryRun = false, overwrite = false } = options;
  const projectsDir = _getClaudeProjectsDir();
  const result: any = { projectsImported: 0, filesImported: 0, filesSkipped: 0, pathsRemapped: 0, errors: [] };

  const manifestPath = join(importPath, "manifest.json");
  if (!existsSync(manifestPath)) {
    result.errors.push({ file: manifestPath, error: "manifest.json not found" });
    return result;
  }

  let manifest: any;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf-8")); }
  catch (err: any) { result.errors.push({ file: manifestPath, error: err.message }); return result; }

  let pathFrom: string | null = null, pathTo: string | null = null;
  if (remapPath) { pathFrom = remapPath.from; pathTo = remapPath.to; }
  else if (remapHome) { pathFrom = `/Users/${manifest.sourceUser}`; pathTo = remapHome; }
  else {
    const currentUser = userInfo().username;
    if (manifest.sourceUser !== currentUser) {
      pathFrom = `/Users/${manifest.sourceUser}`;
      pathTo = homedir();
      if (verbose) console.log(`Auto-remapping: ${pathFrom} → ${pathTo}`);
    }
  }

  const srcProjectsDir = join(importPath, "projects");
  if (!existsSync(srcProjectsDir)) {
    result.errors.push({ file: srcProjectsDir, error: "projects/ directory not found" });
    return result;
  }

  for (const dir of readdirSync(srcProjectsDir)) {
    const srcDir = join(srcProjectsDir, dir);
    try { if (!statSync(srcDir).isDirectory()) continue; } catch { continue; }

    let targetDir = dir;
    if (pathFrom && pathTo) {
      const oldEnc = _encodePath(pathFrom), newEnc = _encodePath(pathTo);
      if (targetDir.startsWith(oldEnc)) { targetDir = newEnc + targetDir.slice(oldEnc.length); result.pathsRemapped++; }
    }

    const destDir = join(projectsDir, targetDir);
    if (verbose) console.log(targetDir !== dir ? `  Importing: ${dir} → ${targetDir}` : `  Importing: ${dir}`);
    if (!dryRun) mkdirSync(destDir, { recursive: true });

    try {
      for (const file of readdirSync(srcDir)) {
        const srcFile = join(srcDir, file);
        const destFile = join(destDir, file);
        try {
          const stat = statSync(srcFile);
          if (stat.isFile()) {
            if (existsSync(destFile) && !overwrite) { result.filesSkipped++; continue; }
            if ((file.endsWith(".jsonl") || file === "sessions-index.json") && pathFrom && pathTo) {
              if (!dryRun) {
                let content = readFileSync(srcFile, "utf-8").replaceAll(pathFrom, pathTo);
                if (file === "sessions-index.json") {
                  content = content.replaceAll(join(_getClaudeProjectsDir().replace(homedir(), `/Users/${manifest.sourceUser}`), dir), join(projectsDir, targetDir));
                }
                writeFileSync(destFile, content, "utf-8");
              }
            } else { if (!dryRun) copyFileSync(srcFile, destFile); }
            result.filesImported++;
          } else if (stat.isDirectory()) {
            const sub = _importDirRecursive(srcFile, join(destDir, file), { pathFrom, pathTo, dryRun, overwrite });
            result.filesImported += sub.imported; result.filesSkipped += sub.skipped;
          }
        } catch (err: any) { result.errors.push({ file: srcFile, error: err.message }); }
      }
      result.projectsImported++;
    } catch (err: any) { result.errors.push({ file: srcDir, error: err.message }); }
  }

  return result;
}

// ─── Register CLI commands ─────────────────────────────────────────────────

program.command("relocate <old-path> <new-path>")
  .description("Relocate sessions after moving a project directory to a new path")
  .option("-n, --dry-run", "Show what would change without modifying anything")
  .option("--no-db", "Skip updating the sessions SQLite database")
  .option("-v, --verbose", "Print detailed progress")
  .action((oldPath: string, newPath: string, opts: any) => {
    if (oldPath.startsWith("~")) oldPath = join(homedir(), oldPath.slice(1));
    if (newPath.startsWith("~")) newPath = join(homedir(), newPath.slice(1));
    console.log(`Relocating sessions: ${oldPath} → ${newPath}`);
    if (opts.dryRun) console.log("(dry run — no changes will be made)\n");
    const result = _relocate(oldPath, newPath, { dryRun: opts.dryRun, updateDb: opts.db !== false, verbose: opts.verbose });
    console.log("\nRelocate Summary:");
    console.log(`  Directories renamed: ${result.dirsRenamed.length}`);
    for (const { from, to } of result.dirsRenamed) console.log(`    ${from} → ${to}`);
    console.log(`  Index files updated: ${result.indexFilesUpdated}`);
    console.log(`  JSONL files updated: ${result.jsonlFilesUpdated}`);
    console.log(`  DB rows updated:     ${result.dbRowsUpdated}`);
    if (result.errors.length > 0) {
      console.log(`\n  Errors (${result.errors.length}):`);
      for (const { file, error } of result.errors) console.log(`    ${file}: ${error}`);
      process.exit(1);
    }
    if (!opts.dryRun && result.dirsRenamed.length > 0) console.log("\nDone. Sessions are now accessible from the new path.");
  });

const _transfer = program.command("transfer").description("Transfer sessions between computers");

_transfer.command("export")
  .description("Export raw session files to a portable directory")
  .option("-p, --project <path>", "Only export sessions for this project path")
  .option("-o, --output <dir>", "Output directory (default: current directory)")
  .option("--name <name>", "Custom export directory name")
  .option("-n, --dry-run", "Show what would be exported without writing")
  .option("-v, --verbose", "Print detailed progress")
  .action((opts: any) => {
    let projectPath = opts.project;
    if (projectPath?.startsWith("~")) projectPath = join(homedir(), projectPath.slice(1));
    console.log("Exporting sessions...");
    if (opts.dryRun) console.log("(dry run — no files will be written)\n");
    const result = _exportSessions({ projectPath, outputDir: opts.output, outputName: opts.name, verbose: opts.verbose, dryRun: opts.dryRun });
    const m = result.manifest;
    console.log("\nExport Summary:");
    console.log(`  Projects:    ${m.projects.length}`);
    console.log(`  Total files: ${m.totalFiles}`);
    console.log(`  Total size:  ${_formatBytes(m.totalSize)}`);
    console.log(`  Output:      ${result.archivePath}`);
    if (m.projects.length > 0 && opts.verbose) {
      console.log("\n  Projects:");
      for (const p of m.projects) console.log(`    ${p.originalPath} (${p.sessionCount} sessions, ${p.jsonlCount} .jsonl files)`);
    }
    if (result.errors.length > 0) {
      console.log(`\n  Errors (${result.errors.length}):`);
      for (const { file, error } of result.errors) console.log(`    ${file}: ${error}`);
    }
    if (!opts.dryRun && m.totalFiles > 0) {
      console.log("\nTo transfer to another computer:");
      console.log(`  1. Copy ${result.archivePath}/ to the target machine`);
      console.log(`  2. Run: sessions transfer import ${result.archivePath}/`);
      console.log("     (paths will be auto-remapped if the username differs)");
    }
  });

_transfer.command("import <path>")
  .description("Import sessions from an export directory")
  .option("--remap-home <path>", "Remap the source home directory to this path")
  .option("--remap <from:to>", "Remap arbitrary path prefix (e.g., /Users/old:/Users/new)")
  .option("--reingest", "Re-ingest imported sessions into the sessions DB")
  .option("--overwrite", "Overwrite existing session files")
  .option("-n, --dry-run", "Show what would be imported without writing")
  .option("-v, --verbose", "Print detailed progress")
  .action((importPath: string, opts: any) => {
    let remapPath: any;
    if (opts.remap) {
      const parts = opts.remap.split(":");
      if (parts.length !== 2) { console.error("Error: --remap must be 'from:to'"); process.exit(1); }
      remapPath = { from: parts[0], to: parts[1] };
    }
    let remapHome = opts.remapHome;
    if (remapHome?.startsWith("~")) remapHome = join(homedir(), remapHome.slice(1));
    console.log(`Importing sessions from: ${importPath}`);
    if (opts.dryRun) console.log("(dry run — no files will be written)\n");
    const result = _importSessions(importPath, { remapHome, remapPath, reingest: opts.reingest, verbose: opts.verbose, dryRun: opts.dryRun, overwrite: opts.overwrite });
    console.log("\nImport Summary:");
    console.log(`  Projects imported: ${result.projectsImported}`);
    console.log(`  Files imported:    ${result.filesImported}`);
    console.log(`  Files skipped:     ${result.filesSkipped}`);
    console.log(`  Paths remapped:    ${result.pathsRemapped}`);
    if (result.errors.length > 0) {
      console.log(`\n  Errors (${result.errors.length}):`);
      for (const { file, error } of result.errors) console.log(`    ${file}: ${error}`);
    }
    if (!opts.dryRun && result.filesImported > 0) {
      console.log("\nDone. Sessions imported successfully.");
      if (!opts.reingest) console.log("Run 'sessions ingest --force' to index imported sessions in the search DB.");
    }
  });

program.command("migrate <source-project> <target-project>")
  .description("Move sessions from one project to another (e.g., merge after repo rename)")
  .option("-n, --dry-run", "Show what would change without modifying anything")
  .option("-v, --verbose", "Print detailed progress")
  .action((sourcePath: string, targetPath: string, opts: any) => {
    if (sourcePath.startsWith("~")) sourcePath = join(homedir(), sourcePath.slice(1));
    if (targetPath.startsWith("~")) targetPath = join(homedir(), targetPath.slice(1));
    const projectsDir = _getClaudeProjectsDir();
    const sourceEncoded = _encodePath(sourcePath);
    const targetEncoded = _encodePath(targetPath);
    const sourceDir = join(projectsDir, sourceEncoded);
    const targetDir = join(projectsDir, targetEncoded);

    if (!existsSync(sourceDir)) {
      console.error(`Source project not found: ${sourceDir}`);
      console.error(`\nUse 'sessions paths' to see available project directories.`);
      process.exit(1);
    }

    console.log(`Migrating sessions: ${sourcePath} → ${targetPath}`);
    if (opts.dryRun) console.log("(dry run — no changes will be made)\n");

    const sourceFiles = readdirSync(sourceDir);
    const sourceJsonl = sourceFiles.filter((f) => f.endsWith(".jsonl"));
    const sourceDirsArr = sourceFiles.filter((f) => {
      try { return statSync(join(sourceDir, f)).isDirectory() && f !== "subagents"; } catch { return false; }
    });

    console.log(`  Source sessions: ${sourceJsonl.length} .jsonl files`);
    console.log(`  Source session dirs: ${sourceDirsArr.length}`);

    if (!opts.dryRun) {
      mkdirSync(targetDir, { recursive: true });
      let moved = 0, errors = 0;

      for (const file of sourceJsonl) {
        const src = join(sourceDir, file);
        const dest = join(targetDir, file);
        if (existsSync(dest)) { if (opts.verbose) console.log(`  Skipping (exists): ${file}`); continue; }
        try {
          const content = readFileSync(src, "utf-8");
          const lines = content.split("\n").map((line) => {
            if (!line.trim()) return line;
            try { const obj = JSON.parse(line); if (obj.cwd?.startsWith(sourcePath)) { obj.cwd = targetPath + obj.cwd.slice(sourcePath.length); return JSON.stringify(obj); } } catch {}
            return line;
          });
          writeFileSync(dest, lines.join("\n"), "utf-8");
          unlinkSync(src);
          moved++;
          if (opts.verbose) console.log(`  Moved: ${file}`);
        } catch (err: any) { console.error(`  Error: ${file}: ${err.message}`); errors++; }
      }

      for (const dir of sourceDirsArr) {
        const src = join(sourceDir, dir);
        const dest = join(targetDir, dir);
        if (existsSync(dest)) { if (opts.verbose) console.log(`  Skipping dir: ${dir}`); continue; }
        try { renameSync(src, dest); moved++; if (opts.verbose) console.log(`  Moved dir: ${dir}`); }
        catch (err: any) { console.error(`  Error dir: ${dir}: ${err.message}`); errors++; }
      }

      // Merge sessions-index.json
      const srcIndex = join(sourceDir, "sessions-index.json");
      const destIndex = join(targetDir, "sessions-index.json");
      if (existsSync(srcIndex)) {
        try {
          const srcData = JSON.parse(readFileSync(srcIndex, "utf-8"));
          if (srcData.entries) {
            for (const e of srcData.entries) {
              if (e.projectPath?.startsWith(sourcePath)) e.projectPath = targetPath + e.projectPath.slice(sourcePath.length);
              if (e.fullPath) e.fullPath = e.fullPath.replace(sourceEncoded, targetEncoded);
            }
          }
          if (existsSync(destIndex)) {
            const destData = JSON.parse(readFileSync(destIndex, "utf-8"));
            const ids = new Set((destData.entries || []).map((e: any) => e.sessionId));
            const newEntries = (srcData.entries || []).filter((e: any) => !ids.has(e.sessionId));
            destData.entries = [...(destData.entries || []), ...newEntries];
            writeFileSync(destIndex, JSON.stringify(destData, null, 4), "utf-8");
            if (opts.verbose) console.log(`  Merged ${newEntries.length} entries into target index`);
          } else {
            writeFileSync(destIndex, JSON.stringify(srcData, null, 4), "utf-8");
          }
          unlinkSync(srcIndex);
        } catch (err: any) { console.error(`  Error merging index: ${err.message}`); errors++; }
      }

      try {
        const remaining = readdirSync(sourceDir);
        if (remaining.length === 0) { rmdirSync(sourceDir); console.log(`  Removed empty source directory`); }
        else if (remaining.length === 1 && remaining[0] === "memory") console.log(`  Note: source still has 'memory/' dir (not moved)`);
      } catch {}

      console.log(`\nMigrate Summary:\n  Files moved:  ${moved}\n  Errors:       ${errors}`);
    } else {
      console.log(`\nWould move ${sourceJsonl.length} .jsonl files and ${sourceDirsArr.length} session directories`);
    }
  });

program.command("paths")
  .description("List all project paths with session counts")
  .option("--json", "Output as JSON")
  .action((opts: any) => {
    const projectsDir = _getClaudeProjectsDir();
    if (!existsSync(projectsDir)) { console.error("Claude projects directory not found:", projectsDir); process.exit(1); }
    const dirs = readdirSync(projectsDir);
    const projects: any[] = [];
    for (const dir of dirs) {
      const dirPath = join(projectsDir, dir);
      try { if (!statSync(dirPath).isDirectory()) continue; } catch { continue; }
      const resolvedPath = _resolveProjectPath(projectsDir, dir);
      const files = readdirSync(dirPath);
      const sessionCount = files.filter((f) => f.endsWith(".jsonl")).length;
      projects.push({ path: resolvedPath, encodedDir: dir, sessions: sessionCount, exists: existsSync(resolvedPath) });
    }
    projects.sort((a, b) => b.sessions - a.sessions);
    if (opts.json) { console.log(JSON.stringify(projects, null, 2)); return; }
    console.log("Claude Code Session Paths\n");
    const maxPath = Math.max(60, ...projects.map((p) => p.path.length));
    for (const p of projects) {
      const marker = p.exists ? " " : "!";
      console.log(`${marker} ${p.path.padEnd(maxPath)} ${String(p.sessions).padStart(4)} sessions`);
    }
    const orphaned = projects.filter((p) => !p.exists);
    if (orphaned.length > 0) console.log(`\n! = path no longer exists (${orphaned.length} orphaned, use 'sessions relocate' to fix)`);
    console.log(`\nTotal: ${projects.length} projects, ${projects.reduce((s, p) => s + p.sessions, 0)} sessions`);
  });
