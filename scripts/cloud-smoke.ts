#!/usr/bin/env bun
// In-process cloud smoke: boots sessions-serve on an ephemeral port, mints a
// real API key, and runs an authenticated /v1 CRUD roundtrip against the cloud
// Postgres. Short-lived (no long-running daemon). Exits non-zero on failure.

import { mintApiKey } from "@hasna/contracts/auth";
import { createSessionsServer } from "../src/server/app.ts";
import { closeCloudClient } from "../src/db/cloud/client.ts";

const signingSecret = process.env.HASNA_SESSIONS_API_SIGNING_KEY;
if (!signingSecret) throw new Error("HASNA_SESSIONS_API_SIGNING_KEY required");

const server = createSessionsServer({ hostname: "127.0.0.1", port: 0 });
const base = `http://127.0.0.1:${server.port}`;
const token = mintApiKey({
  app: "sessions",
  scopes: ["sessions:read", "sessions:write"],
  signingSecret,
  ttlSeconds: 600,
}).token;
const H = { "x-api-key": token, "content-type": "application/json" };

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

const sourceId = `cloud-smoke-${Date.now()}`;
try {
  const health = await (await fetch(`${base}/health`)).json();
  assert(health.mode === "cloud", `mode is cloud (got ${health.mode})`);

  const ready = await fetch(`${base}/ready`);
  assert(ready.status === 200, `/ready 200 (got ${ready.status})`);

  const noauth = await fetch(`${base}/v1/sessions`);
  assert(noauth.status === 401, `unauthenticated -> 401 (got ${noauth.status})`);

  const created = await fetch(`${base}/v1/sessions`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ source: "claude", source_id: sourceId, title: "Cloud Smoke", project_name: "smoke" }),
  });
  assert(created.status === 201, `create -> 201 (got ${created.status})`);
  const id = (await created.json()).session.id as string;
  assert(Boolean(id), "created id present");

  const read = await (await fetch(`${base}/v1/sessions/${id}`, { headers: H })).json();
  assert(read.session.source_id === sourceId, "read back source_id");

  const search = await (await fetch(`${base}/v1/search?q=Cloud%20Smoke`, { headers: H })).json();
  assert(search.count >= 1, `search finds session (count ${search.count})`);

  const del = await (await fetch(`${base}/v1/sessions/${id}`, { method: "DELETE", headers: H })).json();
  assert(del.deleted === true, "deleted");

  const gone = await fetch(`${base}/v1/sessions/${id}`, { headers: H });
  assert(gone.status === 404, `deleted -> 404 (got ${gone.status})`);

  console.log(JSON.stringify({ ok: true, mode: health.mode, id, sourceId, crud: "create/read/search/delete OK" }, null, 2));
} finally {
  server.stop(true);
  await closeCloudClient();
}
