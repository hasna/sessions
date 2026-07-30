import { describe, expect, test } from "bun:test";
import { resolveSessionStore, sessionsCloudEnv } from "./session-store.js";

// -- Explicit mode pinning ---------------------------------------------------
//
// The client must hand `resolveStorageClient` an env whose mode is PINNED, never
// rely on the contracts resolver inferring cloud from the presence of an API URL
// (or of a credential it can find on disk).
//
// hasna/contracts#51 removes that inference under an owner ruling (2026-07-29):
// a local->network transition must be explicitly signalled, never inferred from a
// credential file appearing on disk. After it lands, a consumer that passes
// `process.env` straight through gets the local SQLite store for a fully
// configured cloud client -- silently, at exit 0.
//
// Measured 2026-07-30: of the 5 repos importing the contracts client at runtime,
// `domains`, `logs` and `todos` already pin. `sessions` and `files` did not, and
// were the two #51 would strand. This pins `sessions`.

describe("sessionsCloudEnv", () => {
  const URL_VAR = "HASNA_SESSIONS_API_URL";
  const KEY_VAR = "HASNA_SESSIONS_API_KEY";
  const MODE_VAR = "HASNA_SESSIONS_STORAGE_MODE";
  const API_URL = "https://sessions.hasna.xyz";
  /** Not a credential: a deliberately invalid stub. */
  const FAKE_KEY = ["sessions", "FAKE", "NOT", "A", "REAL", "KEY"].join("_");

  test("pins self_hosted when an API url and key are present and no mode is set", () => {
    expect(sessionsCloudEnv({ [URL_VAR]: API_URL, [KEY_VAR]: FAKE_KEY })[MODE_VAR]).toBe(
      "self_hosted",
    );
  });

  test("honours the unprefixed url/key aliases", () => {
    expect(
      sessionsCloudEnv({ SESSIONS_API_URL: API_URL, SESSIONS_API_KEY: FAKE_KEY })[MODE_VAR],
    ).toBe("self_hosted");
  });

  for (const modeKey of [
    "HASNA_SESSIONS_STORAGE_MODE",
    "HASNA_SESSIONS_MODE",
    "SESSIONS_STORAGE_MODE",
    "SESSIONS_MODE",
  ]) {
    test(`leaves an explicit ${modeKey} untouched`, () => {
      const out = sessionsCloudEnv({
        [modeKey]: "local",
        [URL_VAR]: API_URL,
        [KEY_VAR]: FAKE_KEY,
      });

      expect(out[modeKey]).toBe("local");
      expect(out[MODE_VAR]).toBe(modeKey === MODE_VAR ? "local" : undefined);
    });
  }

  test("does not invent a mode when only one of url/key is present", () => {
    expect(sessionsCloudEnv({ [URL_VAR]: API_URL })[MODE_VAR]).toBeUndefined();
    expect(sessionsCloudEnv({ [KEY_VAR]: FAKE_KEY })[MODE_VAR]).toBeUndefined();
  });

  test("does not invent a mode when nothing is configured", () => {
    expect(sessionsCloudEnv({})[MODE_VAR]).toBeUndefined();
  });

  test("blank values count as unset", () => {
    expect(sessionsCloudEnv({ [URL_VAR]: "  ", [KEY_VAR]: "  " })[MODE_VAR]).toBeUndefined();
  });

  test("the resolver is reached with a pinned mode, so cloud survives #51", () => {
    const store = resolveSessionStore(
      { [URL_VAR]: API_URL, [KEY_VAR]: FAKE_KEY },
      { fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch },
    );

    expect(store).toBeDefined();
    expect(typeof store.list).toBe("function");
  });
});
