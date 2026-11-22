import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    fs: {
      allow: [
        fileURLToPath(new URL(".", import.meta.url)),
        fileURLToPath(new URL("../../packages/physics", import.meta.url)),
        fileURLToPath(new URL("../../node_modules", import.meta.url)),
      ],
      deny: [
        ".env",
        ".env.*",
        "**/.dev.vars*",
        "**/.wrangler/**",
        "**/*.{crt,pem}",
        "**/.git/**",
      ],
    },
  },
});
