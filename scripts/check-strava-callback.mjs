import { randomBytes } from "node:crypto";

// Follow the same hosted sign-in request as a new rider, up to Strava's login page.
const api = process.argv[2] ?? "https://graltitude-desktop-sync.graltitude.workers.dev/pages";
const base = new URL(api.replace(/\/$/, "") + "/");
const start = new URL("auth/start", base);
start.searchParams.set("challenge", randomBytes(32).toString("hex"));
const get = (url) => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000) });

const response = await get(start);
const location = response.headers.get("location");
if (response.status !== 302 || !location) throw Error("Graltitude did not start Strava sign-in.");
const authorize = new URL(location);
if (authorize.origin !== "https://www.strava.com" || authorize.pathname !== "/oauth/authorize")
  throw Error("Graltitude returned an unexpected authorization endpoint.");
const callback = new URL("auth/callback", base);
if (authorize.searchParams.get("redirect_uri") !== callback.href)
  throw Error("The hosted Worker must send Strava the callback " + callback.href);

const strava = await get(authorize);
const login = strava.headers.get("location");
if (strava.status === 400) {
  const body = await strava.json();
  if (body.errors?.some((e) => e.field === "redirect_uri" && e.code === "invalid"))
    throw Error("In Strava's My API Application settings for app " +
      authorize.searchParams.get("client_id") + ", set Authorization Callback Domain to " + callback.hostname);
}
const destination = login && new URL(login, authorize);
if (strava.status !== 302 || !destination || destination.origin !== authorize.origin || destination.pathname !== "/login")
  throw Error("Expected Strava's rider login page. Authorization returned HTTP " + strava.status);
console.log("Strava accepted " + callback.href + " and opened rider login.");
