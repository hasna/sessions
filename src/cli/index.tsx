#!/usr/bin/env bun

/**
 * sessions CLI — Universal AI coding session search and management.
 */

import { Command } from "commander";
import { registerEventsCommands } from "@hasna/events/commander";
import { getPackageVersion } from "../lib/package.js";
import { registerFilesystemCommands } from "./filesystem-commands.js";
import { registerStoreCommands } from "./store-commands.js";
import { registerSyncCommands } from "./sync-commands.js";
import { registerIndexedCommands } from "./indexed-commands.js";

const program = new Command();

program
  .name("sessions")
  .version(getPackageVersion())
  .description("Universal AI coding session search and management");

registerEventsCommands(program, { source: "sessions" });
registerFilesystemCommands(program);
registerStoreCommands(program);
registerSyncCommands(program);
registerIndexedCommands(program);

// Use parseAsync + a single top-level catch so async command actions that throw
// surface a clean one-line message and a non-zero exit.
program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  process.exit(1);
});
