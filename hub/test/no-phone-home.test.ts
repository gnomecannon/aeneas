import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeHub } from "./helpers.js";

/*
 * Nothing phones home (docs/05-public-release.md, rule 6; docs/privacy-network.md). Every outside address in the code
 * is listed in docs/privacy-network.md with what causes the contact, devices load no picture, script or font from
 * another site, and Steam's game pictures reach devices through the hub.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHIPPED = ["hub/src", "web/src", "web/sw", "web/public", "web/index.html", "web/src-tauri/tauri.conf.json", "web/src-tauri/src", "packages/shared/src", "tools/vault-mirror/src"];

function files(rel: string): string[] {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [rel];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(`${rel}/${e.name}`) : /\.(ts|tsx|mjs|js|json|html|rs|webmanifest|svg)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [`${rel}/${e.name}`] : []));
}

/** Hosts written in the code that are not this machine, a private network or a documentation placeholder. */
function outsideHosts(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of SHIPPED.flatMap(files)) {
    const src = fs.readFileSync(path.join(REPO, f), "utf8");
    for (const m of src.matchAll(/https?:\/\/([A-Za-z0-9][A-Za-z0-9.-]*)/g)) {
      const h = m[1].toLowerCase().replace(/\.$/, "");
      if (!h.includes(".") || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === "host.docker.internal") continue;
      if (/(^|\.)(example|invalid|test|localhost)$|(^|\.)example\.(com|org|net)$|(^|\.)example\./.test(h) || /^(core|host)\.tailnet(\.ts\.net)?$/.test(h)) continue;
      out.set(h, [...(out.get(h) ?? []), f]);
    }
  }
  return out;
}

test("no phone home: every outside address in the shipped code is in docs/privacy-network.md", () => {
  const doc = fs.readFileSync(path.join(REPO, "docs", "privacy-network.md"), "utf8").toLowerCase();
  const hosts = outsideHosts();
  assert.ok(hosts.size >= 10, `found only ${hosts.size} outside hosts; the scan is broken`);
  const missing = [...hosts].filter(([h]) => !doc.includes(h)).map(([h, fs_]) => `${h} (${[...new Set(fs_)].join(", ")})`);
  assert.deepEqual(missing, [], "outside addresses in the code that docs/privacy-network.md does not list: add each with what causes the contact and what is sent");
});

test("no phone home: the web app loads no script, style, font or picture from another site", () => {
  const html = fs.readFileSync(path.join(REPO, "web", "index.html"), "utf8");
  assert.doesNotMatch(html, /(src|href)\s*=\s*["']?(https?:)?\/\//i, "index.html links only its own files");
  const bad: string[] = [];
  for (const f of files("web/src")) {
    const src = fs.readFileSync(path.join(REPO, f), "utf8");
    for (const m of src.matchAll(/\b(src|srcSet|poster|data)\s*=\s*\{?\s*[`"']https?:\/\//g)) bad.push(`${f}: ${m[0]}`);
    for (const m of src.matchAll(/@import\s+url\(|@font-face[^}]*url\(\s*["']?https?:/g)) bad.push(`${f}: ${m[0]}`);
  }
  assert.deepEqual(bad, [], "pictures and fonts come from the app's own files or the hub");
  const tauri = JSON.parse(fs.readFileSync(path.join(REPO, "web", "src-tauri", "tauri.conf.json"), "utf8")) as { plugins?: Record<string, unknown> };
  assert.equal(tauri.plugins?.updater, undefined, "the Windows app has no update check");
});

test("no phone home: a Steam game's picture comes from the hub, fetched from Steam once", async () => {
  const t = makeHub();
  try {
    const calls: string[] = [];
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    t.hub.fetch = (async (url: string) => {
      calls.push(String(url));
      if (String(url).includes("/440/")) return new Response(jpeg, { headers: { "content-type": "image/jpeg" } });
      if (String(url).includes("/570/")) return new Response("<html>login</html>", { headers: { "content-type": "text/html" } });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    for (const appid of [440, 570, 999]) t.hub.store.create("game", { name: `Game ${appid}`, source: "steam", steam_appid: appid });
    // Not linked to Steam: the hub fetches nothing.
    assert.equal((await t.api("/games/art/440")).status, 404);
    assert.equal(calls.length, 0);
    t.hub.connections.update((c) => { c.steam = { steam_id: "76561198000000000", persona: "p", profile_url: "" }; });
    const first = await t.api("/games/art/440");
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), jpeg);
    assert.equal((await t.api("/games/art/440")).status, 200);
    assert.equal(calls.length, 1, "fetched from Steam once, then served from the hub's copy");
    assert.match(calls[0], /^https:\/\/cdn\.cloudflare\.steamstatic\.com\/steam\/apps\/440\/header\.jpg$/);
    // A game not in the library, or an id that is not digits, is never fetched.
    assert.equal((await t.api("/games/art/12345")).status, 404);
    assert.equal((await t.api("/games/art/..%2F..%2Fhub.env")).status, 400);
    assert.equal(calls.length, 1);
    // Something other than a picture is refused; a picture Steam does not have is not asked for again soon.
    assert.equal((await t.api("/games/art/570")).status, 502);
    assert.equal((await t.api("/games/art/999")).status, 404);
    assert.equal((await t.api("/games/art/999")).status, 404);
    assert.equal(calls.filter((u) => u.includes("/999/")).length, 1);
    assert.equal(fs.statSync(path.join(t.dir, "game-art", "440.jpg")).mode & 0o077, 0, "the hub's copy is private to its user");
  } finally { t.cleanup(); }
});
