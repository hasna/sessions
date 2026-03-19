#!/usr/bin/env bun
/**
 * Patches the existing compiled CLI to inject new commands (relocate, migrate, transfer, paths).
 * Reads the existing dist/cli/index.js, injects the new command code before program.parse().
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const cliPath = join(ROOT, "dist", "cli", "index.js");

const existingCli = readFileSync(cliPath, "utf-8");

const parseIdx = existingCli.lastIndexOf("program.parse();");
if (parseIdx === -1) {
  console.error("Could not find program.parse() in existing CLI");
  process.exit(1);
}

// Read the new compiled CLI and extract the command registration code
const newCli = readFileSync(join(ROOT, "dist", "new-commands.js"), "utf-8");

// Inject before program.parse()
const patched = existingCli.slice(0, parseIdx) + "\n" + newCli + "\n" + existingCli.slice(parseIdx);

writeFileSync(cliPath, patched, "utf-8");
console.log(`Patched CLI: injected new commands before program.parse()`);
console.log(`Original size: ${existingCli.length}, Patched size: ${patched.length}`);
