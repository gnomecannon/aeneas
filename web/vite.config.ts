import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Tauri sets TAURI_ENV_PLATFORM during `tauri dev` / `tauri build`.
const isTauri = !!process.env.TAURI_ENV_PLATFORM;

/**
 * Writes dist/sw.js from sw/sw.js with the precache list filled in: index.html, every emitted
 * asset, the manifest and the icons. The version is a hash of the template and that list, so a
 * rebuild with identical output installs no new worker.
 */
function serviceWorker(): Plugin {
  return {
    name: "ea-service-worker",
    apply: "build",
    writeBundle(options, bundle) {
      const outDir = options.dir ?? "dist";
      const emitted = Object.keys(bundle).filter((f) => !f.endsWith(".map") && f !== "index.html");
      const icons = readdirSync("public/icons").map((f) => `icons/${f}`);
      const files = ["index.html", "manifest.webmanifest", "favicon.svg", ...icons, ...emitted];
      const list = files.map((f) => `./${f}`);
      const template = readFileSync("sw/sw.js", "utf8");
      const html = bundle["index.html"];
      const htmlSource = html && html.type === "asset" ? String(html.source) : "";
      const version = createHash("sha256").update(template).update(list.join("\n")).update(htmlSource).digest("hex").slice(0, 12);
      const out = template.replaceAll("__VERSION__", version).replaceAll("__PRECACHE__", JSON.stringify(list));
      if (/__(VERSION|PRECACHE)__/.test(out)) this.error("sw.js placeholders not filled");
      writeFileSync(join(outDir, "sw.js"), out);
      this.info(`sw.js version ${version}, ${list.length} precached files`);
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), serviceWorker()],
  clearScreen: false,
  server: { port: 5173, strictPort: true, host: isTauri ? "0.0.0.0" : "localhost" },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
