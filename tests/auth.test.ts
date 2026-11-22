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
  const desktopCallback = "http://127.0.0.1:4177/auth/callback";
  assert.equal(new URL(start.headers.get("location")!).searchParams.get("redirect_uri"), "https://api.example/auth/callback");
  const desktop = await worker.fetch(
    new Request("https://api.example" + loginPath),
    { ...env, STRAVA_CALLBACK_URL: desktopCallback } as unknown as Environment,
  );
  assert.equal(new URL(desktop.headers.get("location")!).searchParams.get("redirect_uri"), desktopCallback);
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
    if (u.endsWith("/activities/12"))
      return Response.json({
        athlete: { id: 7 },
        device_watts: true,
        laps: [
          {
            name: "Warm-up",
            lap_index: 1,
            start_index: 0,
            end_index: 73,
            device_watts: true,
          },
        ],
      });
    if (u.endsWith("/activities/13"))
      return Response.json({ athlete: { id: 7 }, device_watts: true });
    if (u.endsWith("/activities/13/laps")) return Response.json([]);
    if (/activities\/(12|13)\/streams\?/.test(u))
      return Response.json({ watts: { data: [200, 210] } });
    if (u.endsWith("/activities/14"))
      return Response.json({ athlete: { id: 7 }, device_watts: false });
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
  const streams = { watts: { data: [200, 210] } };
  assert.deepEqual(await (await call("/rides/12", { headers })).json(), {
    streams,
    laps: [{ name: "Warm-up", number: 1, start: 0, end: 73, measured: true }],
  });
  assert.deepEqual(await (await call("/rides/13", { headers })).json(), {
    streams,
    laps: [],
  });
  assert.deepEqual(await (await call("/rides/14", { headers })).json(), {
    eligible: false, issue: "No measured power",
  });
  assert.equal((await call("/rides/99", { headers })).status, 403);
  await t.test("ride history reads only owned activity metadata and returns usable powered efforts", async (t) => {
    const effort = {
      segment: { id: 21 },
      device_watts: true,
      average_watts: 240,
      elapsed_time: 250,
      moving_time: 249,
      start_date: "2026-11-01T08:00:00Z",
      start_index: 100,
      end_index: 350,
    };
    const paths: string[] = [];
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      assert.equal(url.search, "?include_all_efforts=true");
      return Response.json({
        athlete: { id: url.pathname.endsWith("/12") ? 7 : 99 },
        device_watts: true,
        segment_efforts: [
          effort,
          { ...effort, device_watts: false },
          { ...effort, moving_time: 200 },
          { ...effort, end_index: 99 },
          { ...effort, segment: undefined },
        ],
      });
    });
    assert.equal((await call("/rides/12/segment-efforts")).status, 401);
    assert.equal((await call("/rides/99/segment-efforts", { headers })).status, 403);
    assert.deepEqual(await (await call("/rides/12/segment-efforts", { headers })).json(), {
      efforts: [{ segment: "21", watts: 240, seconds: 250, date: effort.start_date, start: 100, end: 350 }],
    });
    assert.deepEqual(paths, ["/api/v3/activities/99", "/api/v3/activities/12"]);
  });
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
        return Response.json({ athlete: { id: 7 }, device_watts: powerFlag, average_watts: 200, laps: [] });
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

  await t.test("Pages sign-in returns to the project URL and syncs from the hosted origin", async () => {
    const pages = "https://owner.github.io/Graltitude/";
    const desktop = "http://127.0.0.1:4177/";
    const shared = {
      ...env, APP_URL: desktop, STRAVA_CALLBACK_URL: desktopCallback, PAGES_APP_URL: pages,
    } as unknown as Environment;
    const request = (path: string, init?: RequestInit) =>
      worker.fetch(new Request("https://api.example" + path, init), shared);
    const Origin = new URL(pages).origin;
    const preflight = await request("/pages/auth/exchange", { method: "OPTIONS", headers: { Origin } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), Origin);
    assert.equal((await request("/pages/rides", { headers: { Origin: new URL(desktop).origin } })).status, 403);
    assert.equal((await request("/rides", { headers: { Origin } })).status, 403);
    const begin = await request("/pages" + loginPath);
    const authorize = new URL(begin.headers.get("location")!);
    assert.equal(authorize.searchParams.get("redirect_uri"), "https://api.example/pages/auth/callback");
    const cookie = begin.headers.get("set-cookie")!;
    assert.match(cookie, /Path=\/pages\/auth;/);
    const withCookie = { headers: { Cookie: cookie.split(";")[0] } };
    const callbackPath = path + authorize.searchParams.get("state");
    assert.equal((await request(callbackPath, withCookie)).status, 400);
    const finish = await request("/pages" + callbackPath, withCookie);
    const back = new URL(finish.headers.get("location")!);
    assert.equal(back.origin + back.pathname, pages);
    const code = new URLSearchParams(back.hash.slice(1)).get("handoff");
    const exchanged = await request("/pages/auth/exchange", {
      method: "POST", headers: { Origin }, body: JSON.stringify({ code, verifier }),
    });
    assert.equal(exchanged.status, 200);
    const { session } = await exchanged.json() as { session: string };
    const rides = await request("/pages/rides", { headers: { Origin, Authorization: "Bearer " + session } });
    assert.equal(rides.status, 200);
    assert.equal((await rides.json() as { athlete: string }).athlete, "7");
    const portable = await request(loginPath);
    assert.equal(new URL(portable.headers.get("location")!).searchParams.get("redirect_uri"), desktopCallback);
  });
});
