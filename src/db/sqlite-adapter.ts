import { Database as BunDatabase } from "bun:sqlite";

export class SqliteAdapter {
  readonly raw: BunDatabase;

  constructor(path: string) {
    this.raw = new BunDatabase(path);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare(sql: string) {
    return this.raw.prepare(sql);
  }

  run(sql: string, params?: unknown[]): unknown {
    return Array.isArray(params) ? this.raw.prepare(sql).run(...(params as any[])) : this.raw.run(sql);
  }

  all(sql: string, params?: unknown[]): unknown[] {
    return Array.isArray(params) ? this.raw.prepare(sql).all(...(params as any[])) : this.raw.prepare(sql).all();
  }

  get(sql: string, params?: unknown[]): unknown {
    return Array.isArray(params) ? this.raw.prepare(sql).get(...(params as any[])) : this.raw.prepare(sql).get();
  }

  transaction<T>(fn: () => T): T {
    return this.raw.transaction(fn)();
  }

  close(): void {
    this.raw.close();
  }
}
