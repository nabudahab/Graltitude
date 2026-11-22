import { writeFile } from "node:fs/promises";
import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const result = await build({
  root: "apps/web",
  mode: "portable",
  define: { "import.meta.env.VITE_API_URL": '""' },
  plugins: [viteSingleFile()],
  build: { write: false, license: { fileName: "licenses.md" } },
});
const html = result.output.find((item) => item.fileName === "index.html");
const licenses = result.output.find((item) => item.fileName === "licenses.md");
if (
  result.output.length !== 2 ||
  html?.type !== "asset" ||
  licenses?.type !== "asset"
)
  throw Error("The portable build must contain one self-contained HTML file.");
const notices = String(licenses.source).replaceAll("--", "—");
await writeFile(
  "Graltitude.html",
  html.source + "\n<!--\n" + notices + "\n-->\n",
);
