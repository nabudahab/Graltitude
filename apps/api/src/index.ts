interface Env {
  DB: D1Database;
  APP_URL: string;
  PAGES_APP_URL?: string;
  STRAVA_CALLBACK_URL?: string;
  STRAVA_CLIENT_ID: string;
  STRAVA_CLIENT_SECRET: string;
  TOKEN_KEY: string;
  WEBHOOK_SECRET: string;
}
type Tokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete?: { id: number };
};
type Session = {
  id: string;
  athlete: string;
  credentials: string;
  expires: number;
  session_until: number;
};
const now = () => Math.floor(Date.now() / 1000);
const random = () =>
  crypto.randomUUID().replaceAll("-", "") +
  crypto.randomUUID().replaceAll("-", "");
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
function fail(status: number, message: string): never {
  throw json({ error: message }, status);
}
const bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const encode = (b: Uint8Array) =>
  btoa(Array.from(b, (c) => String.fromCharCode(c)).join(""));
async function hash(s: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
async function key(env: Env) {
  return crypto.subtle.importKey(
    "raw",
    bytes(env.TOKEN_KEY),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}
async function seal(env: Env, value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(env),
    new TextEncoder().encode(value),
  );
  return encode(iv) + "." + encode(new Uint8Array(cipher));
}
async function open(env: Env, value: string) {
  const [iv, cipher] = value.split(".");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes(iv) },
      await key(env),
      bytes(cipher),
    ),
  );
}
async function tokens(
  env: Env,
  params: Record<string, string>,
): Promise<Tokens> {
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.STRAVA_CLIENT_ID,
      client_secret: env.STRAVA_CLIENT_SECRET,
      ...params,
    }),
  });
  if (!r.ok)
    fail(401, "Strava authorization expired or was declined. Connect again.");
  return r.json();
}
async function route(req: Request, e: Env, appUrl: string, basePath: string): Promise<Response> {
  const u = new URL(req.url),
    path = u.pathname.slice(basePath.length);
  const expected = new URL(appUrl).origin;
  if (req.headers.get("Origin") && req.headers.get("Origin") !== expected)
    fail(403, "Origin denied.");
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (path === "/auth/start" && req.method === "GET") {
    const challenge = u.searchParams.get("challenge") ?? "";
    if (!/^[0-9a-f]{64}$/.test(challenge))
      fail(400, "Invalid login challenge.");
    if (!/^\d+$/.test(e.STRAVA_CLIENT_ID) || !e.STRAVA_CLIENT_SECRET?.trim())
      fail(503, "Strava sign-in needs the app's numeric Client ID and Client Secret. After updating local settings, restart the API and connect again.");
    const nonce = random();
    const redirect = new URL("https://www.strava.com/oauth/authorize");
    redirect.search = new URLSearchParams({
      client_id: e.STRAVA_CLIENT_ID,
      redirect_uri: (!basePath && e.STRAVA_CALLBACK_URL) || u.origin + basePath + "/auth/callback",
      response_type: "code",
      scope: "read,activity:read,activity:read_all",
      state: nonce,
    }).toString();
    const cookie = await seal(
      e,
      JSON.stringify({ nonce, challenge, basePath, exp: now() + 600 }),
    );
    return new Response(null, {
      status: 302,
      headers: {
        Location: redirect.href,
        "Set-Cookie":
          "login=" +
          cookie +
          `; HttpOnly; Secure; SameSite=Lax; Path=${basePath}/auth; Max-Age=600`,
      },
    });
  }
  if (path === "/auth/callback" && req.method === "GET") {
    const cookie = req.headers
      .get("Cookie")
      ?.match(/(?:^|; )login=([^;]+)/)?.[1];
    if (!cookie)
      fail(400, "Login timed out. Return to Graltitude and reconnect.");
    const login = JSON.parse(await open(e, cookie));
    if (login.nonce !== u.searchParams.get("state") || login.exp < now() || (login.basePath ?? "") !== basePath)
      fail(400, "Login timed out.");
    const back = new URL(appUrl);
    if (
      !u.searchParams.get("code") ||
      !u.searchParams
        .get("scope")
        ?.split(",")
        .some((s) => s === "activity:read" || s === "activity:read_all")
    ) {
      back.hash = "auth=declined";
    } else {
      const token = await tokens(e, {
        grant_type: "authorization_code",
        code: u.searchParams.get("code")!,
      });
      const session = random(),
        handoff = random(),
        athlete = String(token.athlete!.id);
      const encrypted = await seal(
        e,
        JSON.stringify({
          access: token.access_token,
          refresh: token.refresh_token,
        }),
      );
      await e.DB.batch([
        e.DB.prepare("DELETE FROM handoffs WHERE expires < ?").bind(now()),
        e.DB.prepare("INSERT OR REPLACE INTO sessions VALUES (?,?,?,?,?)").bind(
          await hash(session),
          athlete,
          encrypted,
          token.expires_at,
          now() + 86400 * 7,
        ),
        e.DB.prepare("INSERT INTO handoffs VALUES (?,?,?,?)").bind(
          await hash(handoff),
          login.challenge,
          await seal(e, session),
          now() + 120,
        ),
      ]);
      back.hash = "handoff=" + handoff;
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: back.href,
        "Set-Cookie":
          `login=; Max-Age=0; Path=${basePath}/auth; HttpOnly; Secure; SameSite=Lax`,
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  if (path === "/auth/exchange" && req.method === "POST") {
    const { code, verifier } = await req.json<{
      code: string;
      verifier: string;
    }>();
    const row = await e.DB.prepare(
      "DELETE FROM handoffs WHERE id=? AND challenge=? AND expires>=? RETURNING session",
    )
      .bind(await hash(code), await hash(verifier), now())
      .first<{ session: string }>();
    if (!row) fail(401, "Login handoff expired. Connect again.");
    return json({ session: await open(e, row.session) });
  }
  if (e.WEBHOOK_SECRET && u.pathname === "/events/" + e.WEBHOOK_SECRET) {
    if (
      req.method === "GET" &&
      u.searchParams.get("hub.verify_token") === e.WEBHOOK_SECRET
    )
      return json({ "hub.challenge": u.searchParams.get("hub.challenge") });
    if (req.method === "POST") {
      const v = await req.json<{
        object_type: string;
        owner_id: number;
        updates?: { authorized?: string };
      }>();
      if (v.object_type === "athlete" && v.updates?.authorized === "false")
        await e.DB.prepare("DELETE FROM sessions WHERE athlete=?")
          .bind(String(v.owner_id))
          .run();
      return json({ ok: true });
    }
    fail(400, "Invalid event.");
  }
  const bearer = req.headers
    .get("Authorization")
    ?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!bearer) fail(401, "Connect Strava to continue.");
  const id = await hash(bearer);
  const session = await e.DB.prepare(
    "SELECT * FROM sessions WHERE id=? AND session_until>?",
  )
    .bind(id, now())
    .first<Session>();
  if (!session) fail(401, "Session expired. Connect again.");
  if (path === "/logout" && req.method === "POST") {
    await e.DB.prepare("DELETE FROM sessions WHERE id=?").bind(id).run();
    return json({ ok: true });
  }
  if (req.method !== "GET") fail(405, "Unsupported method.");
  let creds = JSON.parse(await open(e, session.credentials)) as {
    access: string;
    refresh: string;
  };
  if (session.expires < now() + 60) {
    const token = await tokens(e, {
      grant_type: "refresh_token",
      refresh_token: creds.refresh,
    });
    creds = { access: token.access_token, refresh: token.refresh_token };
    await e.DB.prepare(
      "UPDATE sessions SET credentials=?,expires=? WHERE id=? AND credentials=?",
    )
      .bind(
        await seal(e, JSON.stringify(creds)),
        token.expires_at,
        id,
        session.credentials,
      )
      .run();
  }
  async function strava<T>(suffix: string): Promise<T> {
    const r = await fetch("https://www.strava.com/api/v3" + suffix, {
      headers: { Authorization: "Bearer " + creds.access },
    });
    if (!r.ok)
      fail(
        r.status,
        r.status === 429
          ? "Strava rate limit reached. Try syncing later."
          : "Strava could not return this resource (" + r.status + ").",
      );
    return r.json();
  }
  if (path === "/rides") {
    type Summary = {
      id: number;
      id_str?: string;
      name: string;
      gear_id: string;
      start_date: string;
      distance: number;
      athlete_count: number;
      sport_type: string;
      device_watts?: boolean;
    };
    const page = Number(u.searchParams.get("page") ?? 1);
    if (!Number.isInteger(page) || page < 1 || page > 10)
      fail(400, "Invalid page.");
    const all = await strava<Summary[]>(
      "/athlete/activities?per_page=50&page=" +
        page +
        "&after=" +
        (now() - 90 * 86400),
    );
    const rides = all
      .filter(
        (a) =>
          a.device_watts === true &&
          [
            "Ride",
            "GravelRide",
            "MountainBikeRide",
            "Handcycle",
            "Velomobile",
          ].includes(a.sport_type),
      )
      .map((a) => ({
        id: a.id_str ?? String(a.id),
        name: a.name,
        bike: a.gear_id || "",
        date: a.start_date,
        distance: a.distance,
        group: a.athlete_count > 1,
        deviceWatts: true,
        windows: [],
      }));
    // Resolve equipment observed on this athlete's own rides. Keep ID labels
    // when a page contains more gear than we can look up within the request budget.
    const gear: Record<string, string> = {};
    const ids = [
      ...new Set(rides.map((r) => r.bike).filter((id) => /^b\d+$/.test(id))),
    ].slice(0, 15);
    for (const gearId of ids) {
      try {
        gear[gearId] = (await strava<{ name: string }>("/gear/" + gearId)).name;
      } catch (err) {
        if (err instanceof Response && err.status === 429) break;
      }
    }
    return json({
      athlete: session.athlete,
      more: page < 10 && all.length === 50,
      rides,
      gear,
    });
  }
  const ride = path.match(/^\/rides\/(\d+)$/);
  if (ride) {
    const prefix = "/activities/" + ride[1];
    type StravaLap = {
      name?: string;
      lap_index?: number;
      start_index: number;
      end_index: number;
      device_watts?: boolean;
    };
    const meta = await strava<{
      athlete: { id: number };
      device_watts?: boolean;
      laps?: StravaLap[];
    }>(prefix);
    if (String(meta.athlete.id) !== session.athlete)
      fail(403, "Select one of your own rides.");
    if (meta.device_watts !== true)
      return json({ eligible: false, issue: "No measured power" });
    const streams = await strava<{ watts?: { data?: unknown } }>(
      prefix +
        "/streams?keys=time,distance,altitude,watts,latlng,velocity_smooth,moving&key_by_type=true",
    ).catch((err: unknown) => {
      if (err instanceof Response && err.status === 404) return null;
      throw err;
    });
    const watts = streams?.watts?.data;
    if (
      !Array.isArray(watts) ||
      !watts.some((w) => Number.isFinite(w) && w >= 0)
    )
      return json({ eligible: false, issue: "No measured power stream" });
    const laps = meta.laps ?? (await strava<StravaLap[]>(prefix + "/laps"));
    if (!Array.isArray(laps)) fail(502, "Strava returned unreadable lap data.");
    return json({
      streams,
      laps: laps.map((lap) => ({
        name: lap?.name,
        number: lap?.lap_index,
        start: lap?.start_index,
        end: lap?.end_index,
        measured: lap?.device_watts,
      })),
    });
  }
  if (path === "/segments/starred") {
    const page = Number(u.searchParams.get("page") ?? 1);
    if (!Number.isSafeInteger(page) || page < 1)
      fail(400, "Invalid segment page.");
    const items = await strava<
      { id: number; name: string; activity_type: string }[]
    >("/segments/starred?per_page=30&page=" + page);
    return json({
      segments: items
        .filter((s) => s.activity_type === "Ride")
        .map((s) => ({ id: String(s.id), name: s.name })),
      more: items.length === 30,
    });
  }
  const segment = path.match(/^\/segments\/(\d+)$/);
  if (segment) {
    const prefix = "/segments/" + segment[1];
    const metadata = await strava<{ name: string }>(prefix);
    const streams = await strava<Record<string, unknown>>(
      prefix + "/streams?keys=distance,altitude,latlng&key_by_type=true",
    );
    return json({ ...streams, name: metadata.name });
  }
  fail(404, "Unknown endpoint.");
}
export default {
  async fetch(req: Request, env: Env) {
    // Each frontend has a fixed return URL, CORS origin and OAuth cookie path.
    const pagesApp = new URL(req.url).pathname.startsWith("/pages/") && env.PAGES_APP_URL;
    const appUrl = pagesApp || env.APP_URL;
    let res: Response;
    try {
      res = await route(req, env, appUrl, pagesApp ? "/pages" : "");
    } catch (err) {
      res =
        err instanceof Response
          ? err
          : json(
              {
                error:
                  "API request failed. Check the Worker configuration and retry.",
              },
              500,
            );
    }
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("Access-Control-Allow-Origin", new URL(appUrl).origin);
    headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Authorization,Content-Type");
    return new Response(res.body, { status: res.status, headers });
  },
  async scheduled(_event: ScheduledController, env: Env) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE session_until<=?").bind(now()),
      env.DB.prepare("DELETE FROM handoffs WHERE expires<=?").bind(now()),
    ]);
  },
};
