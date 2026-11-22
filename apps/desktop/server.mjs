import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { parseEnv } from "node:util";
import worker from "../api/src/index.ts";
import { syncOrigin } from "./sync-origin.mjs";

const port = 4177;
const host = "127.0.0.1:" + port;
const origin = "http://" + host;
const root = new URL("../../", import.meta.url);
const sharedConfig = await readOptional(new URL("strava-sync.json", root));
const sharedApi = sharedConfig ? syncOrigin(JSON.parse(sharedConfig).apiOrigin) : "";
const html = (await readFile(new URL("Graltitude.html", root), "utf8")).replace(
  "<head>",
  `<head><meta name="graltitude-api" content="${sharedApi || "."}">`,
);
const settingsDir = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "graltitude",
);
const settingsFile = join(settingsDir, "strava.json");
async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    return "";
  }
}
const saved = sharedApi ? {} : JSON.parse((await readOptional(settingsFile)) || "{}");
const dev = sharedApi ? {} : parseEnv(await readOptional(new URL("apps/api/.dev.vars", root)));
const db = new DatabaseSync(":memory:");
db.exec(
  await readFile(
    new URL("apps/api/migrations/0001_sessions.sql", root),
    "utf8",
  ),
);
const env = {
  APP_URL: origin + "/",
  STRAVA_CLIENT_ID: saved.id || dev.STRAVA_CLIENT_ID || "",
  STRAVA_CLIENT_SECRET: saved.secret || dev.STRAVA_CLIENT_SECRET || "",
  TOKEN_KEY: randomBytes(32).toString("base64"),
  WEBHOOK_SECRET: "",
  DB: {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        bind: (...values) => ({
          first: () => statement.get(...values),
          run: () => statement.run(...values),
        }),
      };
    },
    batch(ops) {
      db.exec("BEGIN");
      try {
        const results = ops.map((op) => op.run());
        db.exec("COMMIT");
        return results;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  },
};
const setupToken = randomBytes(32).toString("hex");
function setup(challenge) {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect Graltitude to Strava</title>
    <style>body{max-width:32rem;margin:8vh auto;padding:1rem;font:1rem/1.5 system-ui;color:#153d34}label,input{display:block}input,button{padding:.65rem;margin:.25rem 0 1rem}input{width:90%}</style>
    <h1>Connect to Strava</h1><p>Open <a href="https://www.strava.com/settings/api" target="_blank" rel="noreferrer">your Strava API settings</a>.
    Create or use your own app and set its Authorization Callback Domain to <b>127.0.0.1</b>. Strava requires a subscription to create an app.</p>
    <form method="post" action="/desktop/setup"><input type="hidden" name="token" value="${setupToken}"><input type="hidden" name="challenge" value="${challenge}">
    <label>Client ID<input name="id" inputmode="numeric" pattern="[0-9]+" required></label>
    <label>Client Secret<input name="secret" type="password" required></label>
    <p>Graltitude saves these app credentials in your user folder on this laptop.</p>
    <button>${challenge ? "Save and connect with Strava" : "Save settings"}</button></form><a href="/">Back to Ride Lab</a></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://www.strava.com; frame-ancestors 'none'",
      },
    },
  );
}
async function route(req) {
  if (
    req.headers.host !== host ||
    (req.headers.origin && req.headers.origin !== origin)
  )
    return new Response("Local requests only.", { status: 403 });
  const url = new URL(req.url, origin);
  if (url.origin !== origin)
    return new Response("Invalid origin.", { status: 400 });
  if (req.method === "GET" && url.pathname === "/")
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  if (sharedApi) {
    if (req.method === "GET" && url.pathname === "/auth/callback") {
      const callback = new URL("/auth/callback", sharedApi);
      for (const key of ["code", "scope", "state", "error"]) {
        const value = url.searchParams.get(key);
        if (value !== null) callback.searchParams.set(key, value);
      }
      return new Response(null, {
        status: 302,
        headers: { Location: callback.href, "Referrer-Policy": "no-referrer" },
      });
    }
    return new Response("Unknown endpoint.", { status: 404 });
  }
  const challenge = url.searchParams.get("challenge") ?? "";
  if (req.method === "GET" && url.pathname === "/desktop/settings")
    return setup("");
  if (
    req.method === "GET" &&
    url.pathname === "/auth/start" &&
    /^[a-f0-9]{64}$/.test(challenge) &&
    (!env.STRAVA_CLIENT_ID || !env.STRAVA_CLIENT_SECRET)
  )
    return setup(challenge);

  let body = "";
  if (req.method === "POST") {
    for await (const chunk of req) {
      body += chunk.toString("utf8");
      if (body.length > 8192)
        return new Response("Request too large.", { status: 413 });
    }
  }
  if (req.method === "POST" && url.pathname === "/desktop/setup") {
    const form = new URLSearchParams(body);
    const next = form.get("challenge") ?? "",
      id = form.get("id")?.trim(),
      secret = form.get("secret")?.trim();
    if (req.headers.origin !== origin || form.get("token") !== setupToken)
      return new Response("Reopen Graltitude to connect.", { status: 403 });
    if (
      !/^\d+$/.test(id ?? "") ||
      !secret ||
      (next && !/^[a-f0-9]{64}$/.test(next))
    )
      return new Response(
        "Go back and enter your numeric Client ID and Client Secret.",
        { status: 400 },
      );
    await mkdir(settingsDir, { recursive: true, mode: 0o700 });
    const temp = settingsFile + "." + randomBytes(8).toString("hex");
    await writeFile(temp, JSON.stringify({ id, secret }), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temp, settingsFile);
    env.STRAVA_CLIENT_ID = id;
    env.STRAVA_CLIENT_SECRET = secret;
    return Response.redirect(
      next ? origin + "/auth/start?challenge=" + next : origin + "/",
      303,
    );
  }
  return worker.fetch(
    new Request(url, {
      method: req.method,
      headers: req.headers,
      body: req.method === "POST" ? body : undefined,
    }),
    env,
  );
}
const server = createServer(async (req, res) => {
  try {
    const result = await route(req);
    const headers = Object.fromEntries(result.headers);
    // WebKit requires this for an HTTP loopback callback. Keep HttpOnly and SameSite.
    if (headers["set-cookie"])
      headers["set-cookie"] = headers["set-cookie"].replace(/; Secure(?=;|$)/gi, "");
    res.writeHead(result.status, {
      ...headers,
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
    });
    res.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    res
      .writeHead(500)
      .end(
        "Graltitude could not complete the request. Reopen the app and try again.",
      );
  }
});
server.on("error", (e) => {
  console.error(
    e.code === "EADDRINUSE"
      ? "Port 4177 is busy. Close the other instance of Graltitude and reopen this launcher."
      : e.message,
  );
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  console.log(
    "Open " +
      origin +
      "/ in your browser. Keep this window open while using Ride Lab.",
  );
  if (process.argv.includes("--no-browser")) return;
  const [command, ...args] =
    process.platform === "win32"
      ? ["rundll32.exe", "url.dll,FileProtocolHandler"]
      : [process.platform === "darwin" ? "open" : "xdg-open"];
  const child = spawn(command, [...args, origin + "/"], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () =>
    console.log("Open the address above in your browser."),
  );
  child.unref();
});
