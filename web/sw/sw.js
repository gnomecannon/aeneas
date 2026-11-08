/*
 * EverythingApp service worker. Built into dist/sw.js by the plugin in vite.config.ts, which fills in
 * the VERSION placeholder (a hash of the shell) and the PRECACHE placeholder (index.html, hashed
 * assets, manifest, icons).
 *
 * Strategy:
 *   navigations and index.html   network first, cached copy when offline
 *   hashed assets under assets/  cache first (the name changes when the content does)
 *   manifest, icons, favicon     cache first, refreshed in the background
 *   everything else              not intercepted: API routes (/sync, /live, /health, ...) live outside
 *                                the scope and must never be cached
 * Updates: the new worker installs and waits; the page shows "Update available" and posts
 * SKIP_WAITING when the user picks Reload, then reloads on controllerchange.
 */
const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;
const CACHE = `ea-shell-${VERSION}`;
const BASE = new URL("./", self.location.href);
const INDEX = new URL("index.html", BASE).href;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        PRECACHE.map(async (p) => {
          const url = new URL(p, BASE).href;
          try {
            const res = await fetch(url, { cache: "reload" });
            if (res.ok) await cache.put(url, res);
          } catch {
            /* offline during install: the asset is fetched on first use */
          }
        }),
      );
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("ea-shell-") && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") self.skipWaiting();
  if (data.type === "VERSION" && event.ports && event.ports[0]) event.ports[0].postMessage({ version: VERSION, precache: PRECACHE.length });
});

async function networkFirstIndex(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) await cache.put(INDEX, res.clone());
    return res;
  } catch {
    const cached = await cache.match(INDEX);
    if (cached) return cached;
    throw new Error("offline and no cached shell");
  }
}

async function cacheFirst(request, revalidate) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) {
    if (revalidate) {
      fetch(request)
        .then((res) => res.ok && cache.put(request, res))
        .catch(() => {});
    }
    return cached;
  }
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (!url.href.startsWith(BASE.href)) return;
  if (req.mode === "navigate" || url.href === INDEX || url.href === BASE.href) {
    event.respondWith(networkFirstIndex(req));
    return;
  }
  if (url.pathname.includes("/assets/")) {
    event.respondWith(cacheFirst(req, false));
    return;
  }
  if (/\.(webmanifest|png|svg|ico)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(req, true));
  }
});
