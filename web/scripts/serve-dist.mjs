// Serves dist/ under /app/ the way the hub does, for checking the production build on a subpath.
//   node scripts/serve-dist.mjs            http://localhost:8788/app/
//   EA_STATIC_PORT=9000 node scripts/serve-dist.mjs
// Unknown paths under /app/ fall back to index.html, like the hub. No caching headers, so the
// service worker's own cache is the only one in play.
import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.EA_STATIC_PORT ?? 8788);
const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

function send(res, file) {
  const type = MIME[extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
  createReadStream(file).pipe(res);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    if (url.pathname === "/" || url.pathname === "/app") {
      res.writeHead(302, { Location: "/app/" });
      return res.end();
    }
    if (!url.pathname.startsWith("/app/")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("not found (the client is mounted at /app/)");
    }
    const rel = normalize(decodeURIComponent(url.pathname.slice("/app/".length))).replace(/^(\.\.[/\\])+/, "");
    const file = join(DIST, rel || "index.html");
    if (file.startsWith(DIST) && existsSync(file) && statSync(file).isFile()) return send(res, file);
    return send(res, join(DIST, "index.html"));
  })
  .listen(PORT, () => console.log(`dist served at http://localhost:${PORT}/app/`));
