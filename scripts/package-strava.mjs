import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { syncOrigin } from "../apps/desktop/sync-origin.mjs";

const apiOrigin = syncOrigin(process.argv[2]);
const dir = resolve("dist/share");
await mkdir(dir, { recursive: true });
const temp = await mkdtemp(join(dir, "package-"));
try {
  const config = join(temp, "strava-sync.json");
  await writeFile(config, JSON.stringify({ apiOrigin }) + "\n");
  const zip = join(temp, "Graltitude-Strava.zip");
  execFileSync(
    "git",
    [
      "archive",
      "--format=zip",
      "--prefix=Graltitude/",
      "--add-file=" + config,
      "--output=" + zip,
      "HEAD",
    ],
    { stdio: "inherit" },
  );
  const destination = join(dir, "Graltitude-Strava.zip");
  await rename(zip, destination);
  console.log("Share this ZIP with the rider: " + destination);
} finally {
  await rm(temp, { recursive: true, force: true });
}
