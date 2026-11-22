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
    STRAVA_CLIENT_ID: "12345",
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
  const loginPath = "/auth/start?challenge=" + challenge;
  for (const overrides of [{ STRAVA_CLIENT_ID: "" }, { STRAVA_CLIENT_ID: "undefined" }, { STRAVA_CLIENT_SECRET: "" }]) {
    const response = await worker.fetch(new Request("https://api.example" + loginPath), { ...env, ...overrides } as unknown as Environment);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("location"), null);
  }
  const start = await call(loginPath);
  assert.equal(new URL(start.headers.get("location")!).searchParams.get("client_id"), env.STRAVA_CLIENT_ID);
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
    if (u.includes("/segments/starred?"))
      return Response.json([
        { id: 21, name: "Starred climb", activity_type: "Ride" },
        { id: 23, name: "Trail run", activity_type: "Run" },
      ]);
    if (u.endsWith("/segments/21"))
      return Response.json({ name: "Starred climb" });
    if (u.includes("/segments/21/streams?"))
      return Response.json({ altitude: { data: [300, 400] } });
    if (u.endsWith("/gear/b2")) return Response.json({ name: "Road" });
    if (u.includes("/athlete/activities"))
      return Response.json([
        {
          id: 12,
          name: "Solo climb",
          sport_type: "Ride",
          device_watts: true,
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
  assert.equal((await call("/segments/21")).status, 401);
  assert.deepEqual(
    await (await call("/segments/starred?page=1", { headers })).json(),
    { segments: [{ id: "21", name: "Starred climb" }], more: false },
  );
  assert.deepEqual(await (await call("/segments/21", { headers })).json(), {
    name: "Starred climb",
    altitude: { data: [300, 400] },
  });
  assert.equal(rides.athlete, "7");
  assert.equal(rides.rides[0].bike, "b2");
  assert.equal((await call("/rides/99", { headers })).status, 403);
  await t.test("ride pages filter before gear lookups and paginate raw activities", async (t) => {
    const activity = { id: 1, sport_type: "Ride", gear_id: "b3", average_watts: 190 };
    const calls: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname.endsWith("/gear/b2")) return Response.json({ name: "Road" });
      assert.equal(url.pathname, "/api/v3/athlete/activities");
      assert.equal(url.searchParams.get("per_page"), "50");
      return Response.json(url.searchParams.get("page") === "2" ? [
        activity,
        { ...activity, device_watts: false },
        { ...activity, device_watts: "true" },
        { ...activity, device_watts: true, sport_type: "Run" },
        { ...activity, id: 5, device_watts: true, sport_type: "GravelRide", gear_id: "b2" },
      ] : Array(50).fill(activity));
    });
    for (const page of [1, 10]) {
      const response = await call("/rides?page=" + page, { headers });
      assert.deepEqual(await response.json(), {
        athlete: "7", rides: [], more: page === 1, gear: {},
      });
    }
    const response = await call("/rides?page=2", { headers });
    const data = await response.json() as {
      more: boolean;
      gear: Record<string, string>;
      rides: { id: string; deviceWatts: boolean }[];
    };
    assert.deepEqual(data.rides.map((r) => [r.id, r.deviceWatts]), [["5", true]]);
    assert.deepEqual(data.gear, { b2: "Road" });
    assert.equal(data.more, false);
    assert.deepEqual(calls, [
      ...Array(3).fill("/api/v3/athlete/activities"), "/api/v3/gear/b2",
    ]);
  });
  await t.test("analysis requires confirmed device power and a numeric watts stream", async (t) => {
    let powerFlag: unknown;
    let upstream = Response.json({});
    let streamCalls = 0;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v3/activities/12")
        return Response.json({ athlete: { id: 7 }, device_watts: powerFlag, average_watts: 200 });
      assert.equal(url.pathname, "/api/v3/activities/12/streams");
      streamCalls++;
      return upstream.clone();
    });
    const analyze = () => call("/rides/12", { headers });
    for (powerFlag of [undefined, null, false, "true", 1]) {
      assert.deepEqual(await (await analyze()).json(), {
        eligible: false, issue: "No measured power",
      });
    }
    assert.equal(streamCalls, 0);
    powerFlag = true;
    for (upstream of [
      new Response(null, { status: 404 }), Response.json({}),
      Response.json({ watts: { data: [] } }), Response.json({ watts: { data: [null, "200"] } }),
    ]) {
      assert.deepEqual(await (await analyze()).json(), {
        eligible: false, issue: "No measured power stream",
      });
    }
    upstream = new Response(null, { status: 429 });
    assert.equal((await analyze()).status, 429);
    const streams = { watts: { data: [0, 200] } };
    upstream = Response.json(streams);
    const result = await (await analyze()).json() as { streams: unknown };
    assert.deepEqual(result.streams, streams);
  });
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
