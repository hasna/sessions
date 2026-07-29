import { writeSync } from "fs";

export function printJson(value: unknown): void {
  writeStdoutFully(`${JSON.stringify(value, null, 2)}\n`);
}

export function failCli(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
}

export function writeStdoutFully(text: string): void {
  const buffer = Buffer.from(text, "utf-8");
  let offset = 0;
  while (offset < buffer.length) {
    try {
      const written = writeSync(1, buffer, offset, buffer.length - offset);
      if (written === 0) {
        sleepSync(10);
        continue;
      }
      offset += written;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") {
        sleepSync(10);
        continue;
      }
      throw error;
    }
  }
}

export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export async function writeStdout(text: string): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.write(text, () => resolve());
  });
}

export function parsePositiveIntOption(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`Error: ${name} must be a positive integer`);
    process.exit(1);
  }
  return value;
}

export function parseNonNegativeIntOption(raw: string | undefined, fallback: number, name: string): number {
  if (raw == null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    console.error(`Error: ${name} must be a non-negative integer`);
    process.exit(1);
  }
  return value;
}

export function parseOptionalNonNegativeNumberOption(raw: string | undefined, name: string): number | undefined {
  if (raw == null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`Error: ${name} must be a non-negative number`);
    process.exit(1);
  }
  return value;
}

export function preCloudSyncBackupRecord(): { artifact: null; created_at: string; note: string } {
  return {
    artifact: null,
    created_at: new Date().toISOString(),
    note: "user-supplied backup command completed before self_hosted content import push",
  };
}

export function collectRepeatableOption(value: string, previous: string[] = []): string[] {
  previous.push(value);
  return previous;
}

/** Format a table of Store sessions (LocalStore | ApiStore), never the registry. */

