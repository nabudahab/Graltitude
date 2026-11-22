import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { build } from "vite";

const settings = resolve("apps/api/.dev.vars");
try {
  await writeFile(settings, [
    "STRAVA_CLIENT_ID=",
    "STRAVA_CLIENT_SECRET=",
    "TOKEN_KEY=" + randomBytes(32).toString("base64"),
    "",
  ].join("\n"), { flag: "wx", mode: 0o600 });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}

const vars = parseEnv(await readFile(settings, "utf8"));
if (!/^\d+$/.test(vars.STRAVA_CLIENT_ID ?? "") || !vars.STRAVA_CLIENT_SECRET?.trim()) {
  console.error("Open https://www.strava.com/settings/api and set Authorization Callback Domain to 127.0.0.1.");
  console.error("Paste your Client ID and Client Secret into the matching lines in this file:");
  console.error(settings);
  console.error("Save it, then run npm run ride-lab again.");
  process.exit(1);
}
if (Buffer.from(vars.TOKEN_KEY ?? "", "base64").length !== 32) {
  console.error("TOKEN_KEY must be a base64-encoded 32-byte key in " + settings);
  process.exit(1);
}

// Relative API requests use the same loopback server as the built web app.
await build({
  root: "apps/web",
  define: { "import.meta.env.VITE_API_URL": JSON.stringify(".") },
  build: { outDir: resolve("dist/ride-lab"), emptyOutDir: true },
});
console.log("When Wrangler is ready, open http://127.0.0.1:4176/ on this laptop.");
