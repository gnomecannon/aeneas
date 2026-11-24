import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub, type TestHub } from "./helpers.js";
import { referenceFor, startReference } from "../src/reference/index.js";
import { book, fakeReader, seedReference, waitFor } from "./reference-helpers.js";

/** A hub with ArchWiki (English, pictures) and the Spanish Wikipedia (text only) ready, read by the stand-in reader. */
async function withReader(extra: ReturnType<typeof book>[] = []): Promise<{ t: TestHub; stop: () => Promise<void>; log: string }> {
  const t = makeHub();
  seedReference(t, [
    book("archlinux_en_all", "archlinux_en_all_maxi_2026-10.zim"),
    book("wikipedia_es_all", "wikipedia_es_all_nopic_2026-08.zim", { source: "wikipedia", title: "Wikipedia", lang: "spa", langs: ["spa"], flavour: "nopic", images: false, date: "2026-08-20" }),
    ...extra,
  ], { settings: { sources: ["archwiki", "wikipedia", "devdocs"], languages: ["eng", "spa"] } });
  const log = path.join(t.dir, "reader-args.log");
  process.env.FAKE_KIWIX_LOG = log;
  const stopBg = startReference(t.hub, { reader: fakeReader(), gameRunning: async () => null, fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
  await waitFor(() => referenceFor(t.hub).reader.state === "ready", 15_000, "the reader");
  return { t, log, stop: async () => { stopBg(); await referenceFor(t.hub).stop(); delete process.env.FAKE_KIWIX_LOG; t.cleanup(); } };
}

const json = async (t: TestHub, p: string) => { const r = await t.api(p); return { status: r.status, body: (await r.json()) as any }; };

test("reference reader: run on 127.0.0.1 at a free port, tied to the hub, outside links blocked; started again after it stops", async () => {
  const { t, stop, log } = await withReader();
  try {
    const args = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n")[0]) as string[];
    assert.equal(args[0], "--address=127.0.0.1");
    assert.match(args[1], /^--port=\d+$/);
    assert.deepEqual(args.slice(2, 5), [`--attachToProcess=${process.pid}`, "--blockexternal", "--skipInvalid"]);
    assert.deepEqual(args.slice(5).map((f) => path.basename(f)).sort(), ["archlinux_en_all_maxi_2026-10.zim", "wikipedia_es_all_nopic_2026-08.zim"]);
    assert.ok(args.slice(5).every((f) => f.startsWith(path.join(t.hub.cfg.referenceDir, "files"))));
    const svc = referenceFor(t.hub);
    const before = svc.reader.base!;
    // It stops on its own: failed for a moment, then started again (after 2 s).
    await fetch(`${before}/__exit`).catch(() => {});
    await waitFor(() => svc.reader.state === "failed", 5000, "the stop to be seen");
    assert.equal((await json(t, "/reference/status")).body.reader.state, "failed");
    assert.equal((await t.api("/reference/suggest?q=bluetooth")).status, 503, "search says the reader is starting");
    // The restart waits the reader's back-off (2 s, doubling after a slow start) and then its start; on a busy CI runner,
    // with every test file running beside it, that has taken more than 10 s, so it gets 30.
    await waitFor(() => svc.reader.state === "ready", 30_000, "the restart");
    assert.notEqual(svc.reader.base, before);
    assert.equal((await t.api("/reference/suggest?q=bluetooth")).status, 200);
  } finally { await stop(); }
});

test("reference suggest and search: titles as one types, then full text; first language first, other languages' copies last", async () => {
  const { t, stop } = await withReader();
  try {
    const s = await json(t, "/reference/suggest?q=bluetooth&limit=8");
    assert.equal(s.status, 200);
    assert.equal(s.body.q, "bluetooth");
    assert.equal(s.body.partial, false);
    const titles = (s.body.results as { book: string; title: string }[]).map((r) => `${r.book}:${r.title}`);
    assert.deepEqual(titles.slice(0, 2), ["archlinux_en_all:Bluetooth", "wikipedia_es_all:Bluetooth"], "the title asked for, English book first");
    assert.equal(titles.at(-1)?.endsWith("(Русский)") || titles.at(-1)?.endsWith("(Español)"), true, "copies in other languages last");
    assert.deepEqual(Object.keys(s.body.results[0]).sort(), ["book", "lang", "path", "source", "title"]);
    assert.equal(s.body.results.length <= 8, true);

    const r = await json(t, "/reference/search?q=bluetooth%20headset&limit=20");
    assert.equal(r.status, 200);
    const hits = r.body.results as { book: string; title: string; path: string; kind: string; snippet: string; words?: number; source: string; lang: string }[];
    assert.deepEqual([hits[0].book, hits[0].title, hits[0].path, hits[0].kind], ["archlinux_en_all", "Bluetooth headset", "Bluetooth_headset", "title"], "the page itself first, not its Russian copy the reader ranked first");
    assert.match(hits[0].snippet, /<b>[Bb]luetooth<\/b>/);
    assert.doesNotMatch(hits.map((h) => h.snippet).join(""), /<(?!\/?b>)/, "snippets keep only <b>");
    const copy = (h: { title: string }) => /\((Русский|Español)\)$/.test(h.title);
    const firstCopy = hits.findIndex(copy);
    assert.ok(firstCopy > 0 && hits.slice(firstCopy).every(copy), "copies in other languages after everything else");
    assert.equal(new Set(hits.map((h) => `${h.book}|${h.title.toLowerCase()}`)).size, hits.length, "one result per title and book");
    assert.ok(hits.some((h) => h.kind === "text" && typeof h.words === "number"));
    assert.ok(r.body.total >= hits.length && typeof r.body.took_ms === "number" && r.body.partial === false);
    // Narrowed by source and language; paged.
    const es = await json(t, "/reference/search?q=bluetooth&sources=wikipedia");
    assert.ok(es.body.results.length > 0 && es.body.results.every((h: { book: string }) => h.book === "wikipedia_es_all"));
    assert.deepEqual((await json(t, "/reference/search?q=bluetooth&langs=spa")).body.results.map((h: { book: string }) => h.book).filter((b: string) => b !== "wikipedia_es_all"), []);
    const page2 = await json(t, "/reference/search?q=bluetooth&limit=2&offset=2");
    const all = await json(t, "/reference/search?q=bluetooth&limit=20");
    assert.deepEqual(page2.body.results, all.body.results.slice(2, 4));
    // Bad input is 422; an empty query is no results.
    for (const q of ["q=x&sources=nope", "q=x&langs=xx", "q=x&limit=0", "q=x&limit=500", "q=x&offset=-1", `q=${"x".repeat(201)}`]) assert.equal((await t.api(`/reference/search?${q}`)).status, 422, q);
    assert.deepEqual((await json(t, "/reference/search?q=%20")).body.results, []);
    assert.deepEqual((await json(t, "/reference/suggest?q=")).body.results, []);
  } finally { await stop(); }
});

test("reference search: a book that does not answer in 2 seconds is left out and the answer says partial", async () => {
  const { t, stop } = await withReader([book("devdocs_en_bash", "devdocs_en_bash_slow_2026-10.zim", { source: "devdocs", title: "Bash Docs", flavour: "" })]);
  try {
    const t0 = Date.now();
    const r = await json(t, "/reference/search?q=bash");
    assert.equal(r.body.partial, true);
    assert.ok(Date.now() - t0 < 2900, "the slow book was not waited for");
    assert.deepEqual(r.body.results.map((h: { book: string; title: string; kind: string }) => [h.book, h.title, h.kind]), [["devdocs_en_bash", "Bash", "title"]], "its title index answered in time");
    const fast = await json(t, "/reference/search?q=bluetooth&sources=archwiki");
    assert.equal(fast.body.partial, false, "a search the slow book is not part of is whole");
  } finally { await stop(); }
});

test("reference article: the page sanitized with its table of contents, date, original address and license; redirects followed", async () => {
  const { t, stop } = await withReader();
  try {
    const a = await json(t, "/reference/article?book=archlinux_en_all&path=Bluetooth_Headset");
    assert.equal(a.status, 200);
    const { html, ...rest } = a.body;
    assert.deepEqual(rest, {
      book: "archlinux_en_all", source: "archwiki", lang: "eng", title: "Bluetooth headset", path: "Bluetooth_headset",
      toc: [{ level: 2, id: "ref-Headset_via_PipeWire", text: "Headset via PipeWire" }, { level: 3, id: "ref-Troubleshooting", text: "Troubleshooting" }, { level: 2, id: "ref-Headset_via_PulseAudio", text: "Headset via PulseAudio" }],
      date: "2026-10-21", url: "https://wiki.archlinux.org/title/Bluetooth_headset", license: "GFDL 1.3 or later",
    });
    assert.match(html, /<a title="Bluetooth" href="#\/reference\/archlinux_en_all\/Bluetooth" data-book="archlinux_en_all" data-path="Bluetooth">Bluetooth<\/a>/);
    assert.match(html, /data-path="PipeWire" data-fragment="ref-Bluetooth_devices"/);
    assert.match(html, /<h4 id="ref-High_audio_volume">High audio volume<\/h4>/);
    assert.doesNotMatch(html, /<script|\[edit\]|Categories:/);
    // Hostile markup comes out inert.
    const h = await json(t, "/reference/article?book=archlinux_en_all&path=Hostile");
    assert.equal(h.status, 200);
    assert.doesNotMatch(h.body.html, /<(script|style|iframe|object|embed|form|input|button|svg|math|noscript)\b|\son\w+=|javascript:|data:|\ssrc=|\sstyle=/i);
    assert.match(h.body.html, /<a href="#\/reference\/archlinux_en_all\/Bluetooth" data-book="archlinux_en_all" data-path="Bluetooth">fine<\/a>/);
    assert.match(h.body.html, /<img data-media="x\.png">/);
    assert.match(h.body.html, /<td colspan="2">cell<\/td>/);
    // A book without pictures has none; links in a nested page are read from where it is.
    const es = await json(t, "/reference/article?book=wikipedia_es_all&path=Bluetooth");
    assert.equal(es.body.lang, "spa");
    assert.equal(es.body.license, "CC BY-SA 4.0");
    const sys = await json(t, "/reference/article?book=archlinux_en_all&path=Systemd%2FUser");
    assert.match(sys.body.html, /data-path="Systemd">systemd<\/a>/);
    assert.match(sys.body.html, /<img alt="Logo" width="120" height="40" data-media="_res_\/logo\.png">/);
    assert.match(sys.body.html, /href="https:\/\/plain\.example\.org\/x\?y=1&amp;z=2" rel="noopener noreferrer" data-external=""/);
    // What is not there, or not a page, or not a path.
    assert.equal((await t.api("/reference/article?book=nope&path=X")).status, 404);
    assert.equal((await t.api("/reference/article?book=archlinux_en_all&path=Nope")).status, 404);
    assert.equal((await t.api("/reference/article?book=archlinux_en_all&path=_res_%2Fstyle.css")).status, 404);
    for (const q of ["book=archlinux_en_all&path=..%2Fx", "book=archlinux_en_all&path=", "book=..&path=X", "book=archlinux_en_all&path=a%2F%2Fb", "book=archlinux_en_all&path=a%00b"]) assert.equal((await t.api(`/reference/article?${q}`)).status, 422, q);
  } finally { await stop(); }
});

test("reference summary, media and random: previews, pictures with a strict policy, a page by chance", async () => {
  const { t, stop } = await withReader();
  try {
    assert.deepEqual((await json(t, "/reference/summary?book=archlinux_en_all&path=Systemd%2FUser")).body, {
      title: "systemd/User",
      text: "systemd can manage services under the user's control with a per-user instance, enabling them to start and stop their own user units.",
      media: "_res_/logo.png",
    });
    const plain = await json(t, "/reference/summary?book=wikipedia_es_all&path=Bluetooth");
    assert.equal(plain.body.media, undefined, "no picture in a book without them");
    const png = await t.api("/reference/media?book=archlinux_en_all&path=_res_%2Flogo.png");
    assert.equal(png.status, 200);
    assert.equal(png.headers.get("content-type"), "image/png");
    assert.equal(png.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    assert.equal(png.headers.get("x-content-type-options"), "nosniff");
    assert.equal(png.headers.get("cache-control"), "private, max-age=604800");
    assert.equal(Buffer.from(await png.arrayBuffer()).subarray(1, 4).toString(), "PNG");
    const svg = await t.api("/reference/media?book=archlinux_en_all&path=_res_%2Fdrawing.svg");
    assert.equal(svg.status, 200);
    assert.equal(svg.headers.get("content-type"), "image/svg+xml");
    assert.match(svg.headers.get("content-security-policy") ?? "", /sandbox/, "an SVG's script cannot run");
    assert.equal((await t.api("/reference/media?book=archlinux_en_all&path=_res_%2Fstyle.css")).status, 404, "only pictures");
    assert.equal((await t.api("/reference/media?book=archlinux_en_all&path=_res_%2Ffake.png")).status, 404, "named a picture, but not one");
    assert.equal((await t.api("/reference/media?book=archlinux_en_all&path=Bluetooth")).status, 404);
    assert.equal((await t.api("/reference/media?book=wikipedia_es_all&path=Bluetooth")).status, 404);
    const r = await json(t, "/reference/random");
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ["book", "path", "title"]);
    const es = await json(t, "/reference/random?sources=wikipedia&langs=spa");
    assert.deepEqual(es.body, { book: "wikipedia_es_all", path: "Bluetooth", title: "Bluetooth" });
    // ArchWiki's random page here is its Spanish copy or the English page: the copy is passed over when it can be.
    const picks = new Set<string>();
    for (let i = 0; i < 5; i++) picks.add((await json(t, "/reference/random?sources=archwiki")).body.path);
    assert.ok(picks.has("Bluetooth_headset"));
    assert.equal((await t.api("/reference/random?sources=ifixit")).status, 404);
    assert.equal((await t.api("/reference/random?sources=nope")).status, 422);
  } finally { await stop(); }
});
