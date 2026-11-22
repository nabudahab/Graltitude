import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker from "../apps/api/src/index.ts";

// Exercise OAuth state, one-time handoff, athlete isolation and revocation
// against real SQLite semantics, without using an athlete's account.
test("Strava session lifecycle", async (t) => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      new URL("../apps/api/migrations/0001_sessions.sql", import.meta.url),
      "utf8",
    ),
  );
  t.after(() => db.close());
  const binding = {
    prepare(sql: string) {
      return {
        bind(...args: (string | number)[]) {
          const q = db.prepare(sql);
          return {
            first: async () => q.get(...args),
            run: async () => q.run(...args),
          };
        },
      };
    },
    async batch(ops: { run: () => Promise<unknown> }[]) {
      for (const op of ops) await op.run();
    },
  };
  const env = {
    DB: binding,
    APP_URL: "https://site.example/Graltitude/",
    STRAVA_CLIENT_ID: "test",
    STRAVA_CLIENT_SECRET: "fixture",
    TOKEN_KEY: Buffer.alloc(32, 1).toString("base64"),
    WEBHOOK_SECRET: "hook-test",
  };
  type Environment = Parameters<typeof worker.fetch>[1];
  const call = (path: string, init: RequestInit = {}) =>
    worker.fetch(
      new Request("https://api.example" + path, init),
      env as unknown as Environment,
    );
  const verifier = "random browser value for this test";
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("hex");
  const start = await call("/auth/start?challenge=" + challenge);
  const state = new URL(start.headers.get("location")!).searchParams.get(
    "state",
  );
  const Cookie = start.headers.get("set-cookie")!.split(";")[0];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const u = String(input);
    if (u.endsWith("/oauth/token"))
      return Response.json({
        access_token: "access-fixture",
        refresh_token: "refresh-fixture",
        expires_at: Math.floor(Date.now() / 1000) + 1000,
        athlete: { id: 7 },
      });
    if (u.endsWith("/gear/b2")) return Response.json({ name: "Road" });
    if (u.includes("/athlete/activities"))
      return Response.json([
        {
          id: 12,
          name: "Solo climb",
          sport_type: "Ride",
          gear_id: "b2",
          athlete_count: 1,
          distance: 5000,
        },
      ]);
    if (u.endsWith("/activities/99"))
      return Response.json({ athlete: { id: 99 }, device_watts: true });
    throw Error("Unexpected upstream call");
  });
  const path = "/auth/callback?code=test&scope=read,activity:read&state=";
  assert.equal(
    (await call(path + "wrong", { headers: { Cookie } })).status,
    400,
  );
  const callback = await call(path + state, { headers: { Cookie } });
  assert.equal(callback.status, 302);
  const code = new URLSearchParams(
    new URL(callback.headers.get("location")!).hash.slice(1),
  ).get("handoff");
  const exchange = (v: string) =>
    call("/auth/exchange", {
      method: "POST",
      body: JSON.stringify({ code, verifier: v }),
    });
  assert.equal((await exchange("incorrect")).status, 401);
  const { session } = (await (await exchange(verifier)).json()) as {
    session: string;
  };
  assert.equal((await exchange(verifier)).status, 401);
  const headers = { Authorization: "Bearer " + session };
  const rides = (await (await call("/rides", { headers })).json()) as {
    athlete: string;
    rides: { bike: string }[];
  };
  assert.equal(rides.athlete, "7");
  assert.equal(rides.rides[0].bike, "b2");
  assert.equal((await call("/rides/99", { headers })).status, 403);
  assert.ok(
    !JSON.stringify(db.prepare("SELECT * FROM sessions").all()).includes(
      "refresh-fixture",
    ),
  );
  assert.equal(
    (
      await call("/events/hook-test", {
        method: "POST",
        body: JSON.stringify({
          object_type: "athlete",
          owner_id: 7,
          updates: { authorized: "false" },
        }),
      })
    ).status,
    200,
  );
  assert.equal((await call("/rides", { headers })).status, 401);
});
