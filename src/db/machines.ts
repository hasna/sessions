import { getDatabase } from "./database.js";
import { getMachineInfo } from "../lib/machine.js";
import type { Machine } from "../types/index.js";

/** Register/refresh the current machine in the machines table. */
export function registerMachine(): void {
  const db = getDatabase();
  const info = getMachineInfo();
  db.prepare(
    `INSERT INTO machines (name, hostname, platform, first_seen_at, last_seen_at, session_count)
     VALUES (?, ?, ?, datetime('now'), datetime('now'), 0)
     ON CONFLICT(name) DO UPDATE SET
       hostname = excluded.hostname,
       platform = excluded.platform,
       last_seen_at = datetime('now')`
  ).run(info.name, info.hostname, info.platform);
}

/** Recompute per-machine session counts from the sessions table (incl. synced rows). */
export function recomputeMachineCounts(): void {
  const db = getDatabase();
  const rows = db
    .prepare("SELECT machine AS name, COUNT(*) AS n FROM sessions WHERE machine IS NOT NULL AND machine != '' GROUP BY machine")
    .all() as { name: string; n: number }[];
  for (const r of rows) {
    db.prepare(
      `INSERT INTO machines (name, session_count) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET session_count = excluded.session_count`
    ).run(r.name, Number(r.n));
  }
}

export function listMachines(): Machine[] {
  const db = getDatabase();
  const rows = db
    .prepare("SELECT * FROM machines ORDER BY session_count DESC, name ASC")
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    name: r.name as string,
    hostname: (r.hostname as string) ?? null,
    platform: (r.platform as string) ?? null,
    first_seen_at: r.first_seen_at as string,
    last_seen_at: r.last_seen_at as string,
    session_count: Number(r.session_count ?? 0),
  }));
}
