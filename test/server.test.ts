import { describe, expect, it } from "bun:test";
import { createSessionsServer } from "../src/server/app";
import { getPackageInfo } from "../src/lib/package";

describe("createSessionsServer", () => {
  it("serves health and info endpoints", async () => {
    const pkg = getPackageInfo();
    const server = createSessionsServer({ hostname: "127.0.0.1", port: 0 });

    try {
      const baseUrl = `http://127.0.0.1:${server.port}`;

      const healthResponse = await fetch(`${baseUrl}/health`);
      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.json()).toEqual({
        ok: true,
        service: pkg.name,
        version: pkg.version,
      });

      const infoResponse = await fetch(`${baseUrl}/info`);
      expect(infoResponse.status).toBe(200);
      const info = await infoResponse.json();
      expect(info.ok).toBe(true);
      expect(info.name).toBe(pkg.name);
      expect(info.version).toBe(pkg.version);
      expect(info.endpoints).toContain("/health");

      const notFoundResponse = await fetch(`${baseUrl}/missing`);
      expect(notFoundResponse.status).toBe(404);
    } finally {
      server.stop(true);
    }
  });
});
