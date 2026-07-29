import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(repoRoot, "hasna.contract.json"), "utf-8"));
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));

describe("public service contract", () => {
  it("declares all shipped surfaces as supported", () => {
    expect(manifest.surfaces).toEqual({
      api: { status: "supported" },
      sdk: { status: "supported" },
      cli: { status: "supported" },
    });
  });

  it("declares SQLite and live-tested PostgreSQL storage", () => {
    expect(manifest.storage.engines).toEqual(["sqlite", "postgres"]);
    expect(manifest.storage.pgTestGate).toBe("bun run test:postgres");
    expect(pkg.scripts["test:postgres"]).toBe("bun run scripts/postgres-test-gate.ts");
  });

  it("does not publish secret or credential references", () => {
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toMatch(/databaseUrlSecretRef|credential|password|secret[-_/ ]?ref/i);
    expect(serialized).not.toMatch(/:\/\/[^\s:@]+:[^\s@]+@/);
  });
});
