import type { Command } from "commander";
import chalk from "chalk";
import { writeSync } from "node:fs";
import { getStorageConnectionString } from "../db/storage-config.js";
import {
  getStorageStatus,
  parseStorageTables,
  pullStorageChanges,
  pushStorageChanges,
  syncStorageChanges,
} from "../db/storage-sync.js";

function printJson(value: unknown): void {
  writeStdoutFully(`${JSON.stringify(value, null, 2)}\n`);
}

function writeStdoutFully(text: string): void {
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

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printResults(results: Awaited<ReturnType<typeof pushStorageChanges>>): void {
  for (const result of results) {
    const line = result.skipped
      ? `${result.table}: skipped`
      : `${result.table}: ${result.rowsWritten}/${result.rowsRead} row(s)`;
    console.log(result.errors.length > 0 ? chalk.yellow(line) : chalk.green(line));
    for (const warning of result.warnings ?? []) {
      console.warn(chalk.yellow(`  ${warning}`));
    }
    for (const error of result.errors) {
      console.error(chalk.red(`  ${error}`));
    }
  }
}

export function registerStorageCommands(program: Command): void {
  const storage = program
    .command("storage")
    .description("Manage sessions local/remote storage sync");

  storage
    .command("status")
    .description("Show local database and storage sync status")
    .option("--json", "Output as JSON")
    .action((opts) => {
      try {
        const status = getStorageStatus();
        if (opts.json) {
          printJson(status);
          return;
        }
        console.log(`Mode: ${status.mode}`);
        console.log(`Enabled: ${status.enabled ? "yes" : "no"}`);
        console.log(`Database: ${status.db_path}`);
        console.log(`Remote payloads: ${status.privacy.allowed_remote_payloads.join(", ") || "metadata only"}`);
        for (const adapter of status.adapters) {
          console.log(`  ${adapter.id}: ${adapter.enabled ? "enabled" : "disabled"} (${adapter.role})`);
        }
        for (const table of status.tables) {
          console.log(`  ${table.table}: ${table.rows}`);
        }
      } catch (error) {
        if (opts.json) printJson({ error: errorMessage(error) });
        else console.error(chalk.red(errorMessage(error)));
        process.exitCode = 1;
      }
    });

  storage
    .command("push")
    .description("Push local sessions data to PostgreSQL")
    .option("--tables <tables>", "Comma-separated table names")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      try {
        const results = await pushStorageChanges(parseStorageTables(opts.tables));
        if (opts.json) printJson(results);
        else printResults(results);
      } catch (error) {
        if (opts.json) printJson({ error: errorMessage(error) });
        else console.error(chalk.red(errorMessage(error)));
        process.exitCode = 1;
      }
    });

  storage
    .command("pull")
    .description("Pull PostgreSQL sessions data into the local database")
    .option("--tables <tables>", "Comma-separated table names")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      try {
        const results = await pullStorageChanges(parseStorageTables(opts.tables));
        if (opts.json) printJson(results);
        else printResults(results);
      } catch (error) {
        if (opts.json) printJson({ error: errorMessage(error) });
        else console.error(chalk.red(errorMessage(error)));
        process.exitCode = 1;
      }
    });

  storage
    .command("sync")
    .description("Push local changes, then pull remote changes")
    .option("--tables <tables>", "Comma-separated table names")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      try {
        const result = await syncStorageChanges(parseStorageTables(opts.tables));
        if (opts.json) {
          printJson(result);
          return;
        }
        console.log(chalk.bold("Push"));
        printResults(result.push);
        console.log(chalk.bold("Pull"));
        printResults(result.pull);
      } catch (error) {
        if (opts.json) printJson({ error: errorMessage(error) });
        else console.error(chalk.red(errorMessage(error)));
        process.exitCode = 1;
      }
    });

  storage
    .command("migrate")
    .description("Apply PostgreSQL migrations")
    .option("--connection-string <url>", "PostgreSQL connection string")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      try {
        const { applyPgMigrations } = await import("../db/pg-migrate.js");
        const result = await applyPgMigrations(opts.connectionString || getStorageConnectionString("sessions"));
        if (opts.json) {
          printJson(result);
          return;
        }
        if (result.applied.length > 0) console.log(chalk.green(`Applied ${result.applied.length} migration(s): ${result.applied.join(", ")}`));
        if (result.alreadyApplied.length > 0) console.log(chalk.gray(`Already applied: ${result.alreadyApplied.length}`));
        if (result.errors.length > 0) {
          for (const error of result.errors) console.error(chalk.red(error));
          process.exitCode = 1;
        }
      } catch (error) {
        if (opts.json) printJson({ error: errorMessage(error) });
        else console.error(chalk.red(errorMessage(error)));
        process.exitCode = 1;
      }
    });
}
