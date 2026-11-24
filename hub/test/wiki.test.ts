import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { storageToMarkdown, attachmentsShown, parseStorage, MAX_DEPTH } from "../src/wiki-storage.js";
import { convert, refreshRetry, SIGNIN_ENDED, syncConfluence } from "../src/imports/confluence.js";
import { titleOf } from "../src/wiki.js";

test("wiki: Confluence storage becomes readable markdown", () => {
  const xhtml = `<h1>Combat &amp; stamina</h1><p>Read <strong>this</strong> first.<br/>Then <em>that</em> &mdash; <code>x|y</code>.</p>
<ac:structured-macro ac:name="toc"/>
<ul><li><p>One</p><ul><li>Nested</li></ul></li><li>Two <ac:link><ri:page ri:content-title="Current state"/><ac:plain-text-link-body><![CDATA[the state]]></ac:plain-text-link-body></ac:link></li></ul>
<ol><li>First</li><li>Second</li></ol>
<table><tbody><tr><th>Stat</th><th>Value</th></tr><tr><td><p>Pneuma</p></td><td>12 | 14</td></tr></tbody></table>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">cpp</ac:parameter><ac:plain-text-body><![CDATA[int a = 1 < 2;]]></ac:plain-text-body></ac:structured-macro>
<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Gate</ac:parameter><ac:rich-text-body><p>HIT-01 stays open.</p></ac:rich-text-body></ac:structured-macro>
<p>Status: <ac:structured-macro ac:name="status"><ac:parameter ac:name="title">Open</ac:parameter></ac:structured-macro></p>
<ac:image ac:alt="Helmet"><ri:attachment ri:filename="helmet preview.png"/></ac:image>
<ac:image><ri:attachment ri:filename="elsewhere.png"><ri:page ri:content-title="Art library"/></ri:attachment></ac:image>
<ac:task-list><ac:task><ac:task-status>complete</ac:task-status><ac:task-body>Bake normals</ac:task-body></ac:task><ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>Retopo</ac:task-body></ac:task></ac:task-list>
<ac:layout><ac:layout-section><ac:layout-cell><p>Left</p></ac:layout-cell><ac:layout-cell><p>Right</p></ac:layout-cell></ac:layout-section></ac:layout>`;
  const md = storageToMarkdown(xhtml, "42", "STARFALL");
  assert.match(md, /^# Combat & stamina$/m);
  assert.match(md, /Read \*\*this\*\* first\. {2}\nThen \*that\* — `x\|y`\./);
  assert.match(md, /^- One\n {2}- Nested\n- Two \[the state\]\(wiki-title:STARFALL\/Current%20state\)$/m);
  assert.match(md, /^1\. First\n2\. Second$/m);
  assert.match(md, /^\| Stat \| Value \|\n\| --- \| --- \|\n\| Pneuma \| 12 \\\| 14 \|$/m);
  assert.match(md, /^```cpp\nint a = 1 < 2;\n```$/m);
  assert.match(md, /^> \*\*Info: Gate\*\*\n>\n> HIT-01 stays open\.$/m);
  assert.match(md, /Status: \*\*\[Open\]\*\*/);
  assert.match(md, /!\[Helmet\]\(wiki-media:42\/helmet%20preview\.png\)/);
  assert.match(md, /^- \[x\] Bake normals\n- \[ \] Retopo$/m);
  assert.match(md, /^Left\n\nRight$/m);
  assert.doesNotMatch(md, /toc|elsewhere\.png\]\(/);
  assert.deepEqual(attachmentsShown(xhtml), ["helmet preview.png"]);
});

test("wiki: titles come from the first heading, else the file name", () => {
  assert.equal(titleOf("Docs/FeatureHub/Roads.md", "intro\n# Roads and paths\n"), "Roads and paths");
  assert.equal(titleOf("Docs/Development/CurrentState.md", "no heading"), "Current State");
  assert.equal(titleOf("Docs/FeatureHub/README.md", "x"), "FeatureHub");
});

test("wiki: the repo feed sends changed docs in batches, removes deleted ones, and the feed token cannot read", async () => {
  const t = makeHub({ feedToken: "feed-token-for-tests-0001" });
  try {
    const feed = (json: unknown, token?: string) => t.api("/wiki/feed", { method: "POST", json, headers: token ? { authorization: `Bearer ${token}` } : {} });
    const manifest = [{ path: "README.md", sha: "a1" }, { path: "Docs/Development/CurrentState.md", sha: "b1" }, { path: "Docs/FeatureHub/Roads.md", sha: "c1" }];
    const first = await (await feed({ project: "Starfall", web_base: "https://github.com/gnomecannon/example-game", manifest }, "feed-token-for-tests-0001")).json() as any;
    assert.deepEqual(first.need.sort(), ["Docs/Development/CurrentState.md", "Docs/FeatureHub/Roads.md", "README.md"]);
    const pages = [
      { path: "README.md", sha: "a1", markdown: "# Starfall\n\nSee [current state](Docs/Development/CurrentState.md) and [the build script](Build/run.ps1).\n" },
      { path: "Docs/Development/CurrentState.md", sha: "b1", updated_at: "2026-10-29T10:00:00.000Z", markdown: "# Current state\n\n[Roads](../FeatureHub/Roads.md#ice) and [handbook](https://example-studio.atlassian.net/wiki/spaces/STARFALL/pages/819201/Current+state).\n" },
    ];
    const second = await (await feed({ project: "Starfall", web_base: "https://github.com/gnomecannon/example-game", manifest, pages }, "feed-token-for-tests-0001")).json() as any;
    assert.deepEqual(second, { pages: 3, updated: 2, removed: 0, need: ["Docs/FeatureHub/Roads.md"] });
    await feed({ project: "Starfall", manifest, pages: [{ path: "Docs/FeatureHub/Roads.md", sha: "c1", markdown: "# Roads\n\nSnow ruts. Back to [README](../../README.md).\n" }] }, "feed-token-for-tests-0001");

    // The feed token posts and nothing else.
    assert.equal((await t.app.request("/wiki", { headers: { authorization: "Bearer feed-token-for-tests-0001" } })).status, 401);
    // A path outside the repo or not markdown is ignored.
    assert.equal((await feed({ project: "Starfall", manifest: [{ path: "../etc/passwd", sha: "x" }] })).status, 422);

    const index = await (await t.api("/wiki")).json() as any;
    assert.equal(index.sources.length, 1);
    assert.equal(index.sources[0].pages, 3);
    assert.deepEqual(index.pages.map((p: any) => [p.title, p.crumbs.join("/")]), [["Starfall", ""], ["Current state", "Development"], ["Roads", "FeatureHub"]]);

    const page = await (await t.api(`/wiki/page?id=${encodeURIComponent("repo:Starfall:README.md")}`)).json() as any;
    assert.match(page.markdown, /\[current state\]\(everythingapp:\/\/wiki\?id=repo%3AStarfall%3ADocs%2FDevelopment%2FCurrentState\.md\)/);
    assert.match(page.markdown, /\[the build script\]\(https:\/\/github\.com\/gnomecannon\/example-game\/blob\/HEAD\/Build\/run\.ps1\)/);
    const cs = await (await t.api(`/wiki/page?id=${encodeURIComponent("repo:Starfall:Docs/Development/CurrentState.md")}`)).json() as any;
    assert.match(cs.markdown, /\[Roads\]\(everythingapp:\/\/wiki\?id=repo%3AStarfall%3ADocs%2FFeatureHub%2FRoads\.md\)/);
    assert.equal(cs.updated_at, "2026-10-29T10:00:00.000Z");
    assert.equal((await t.api("/wiki/page?id=nope")).status, 404);

    const s = await (await t.api("/wiki/search?q=snow%20ruts")).json() as any;
    assert.deepEqual(s.results.map((r: any) => r.title), ["Roads"]);
    assert.match(s.results[0].snippet, /Snow ruts/);
    await t.api("/wiki/feed", { method: "POST", json: { project: "Starfall", manifest: [...manifest, { path: "Docs/Todo.md", sha: "t1" }], pages: [{ path: "Docs/Todo.md", sha: "t1", markdown: "# Todo\n\n- [x] bake the parry curve\n1. tune\n" }] } });
    const todo = await (await t.api("/wiki/search?q=parry")).json() as any;
    assert.equal(todo.results[0].snippet, "Todo bake the parry curve tune");

    // A doc deleted from the repo leaves the wiki; an unchanged one is not rewritten.
    const third = await (await feed({ project: "Starfall", manifest: manifest.filter((m) => m.path !== "Docs/FeatureHub/Roads.md"), pages }, "feed-token-for-tests-0001")).json() as any;
    assert.deepEqual(third, { pages: 2, updated: 0, removed: 2, need: [] });
  } finally {
    t.cleanup();
  }
});

test("wiki: Confluence links through Sign in with Atlassian, mirrors chosen spaces with images, refreshes, unlinks", async () => {
  const t = makeHub();
  try {
    const calls: string[] = [];
    let tokenN = 0;
    let homeVersion = 3;
    const pages = () => [
      { id: "819201", title: "Current state", parentId: "688306", parentType: "page", position: 1, version: { number: homeVersion, createdAt: "2026-10-28T13:05:00.000Z" }, _links: { webui: "/spaces/STARFALL/pages/819201/Current+state" },
        body: { storage: { value: `<p>See <ac:link><ri:page ri:content-title="Art library"/></ac:link> and <a href="https://github.com/gnomecannon/example-game/blob/abc123/Docs/FeatureHub/Roads.md">roads</a>.</p><ac:image><ri:attachment ri:filename="snow.png"/></ac:image>` } } },
      { id: "688306", title: "Starfall", parentId: null, position: 0, version: { number: 1, createdAt: "2026-09-21T00:00:00.000Z" }, _links: { webui: "/spaces/STARFALL/overview" }, body: { storage: { value: "<p>Home</p>" } } },
      { id: "196825", title: "Art library", parentId: "688306", parentType: "page", position: 2, version: { number: 1 }, _links: { webui: "/spaces/STARFALL/pages/196825" }, body: { storage: { value: "<p>Art</p>" } } },
    ];
    t.hub.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
      const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status });
      if (u.pathname === "/oauth/token") {
        const b = JSON.parse(String(init?.body));
        if (b.grant_type === "authorization_code" && b.code !== "good-code") return json({ error: "invalid_grant" }, 403);
        tokenN++;
        return json({ access_token: `access-${tokenN}`, refresh_token: `refresh-${tokenN}`, expires_in: 3600 });
      }
      if (u.pathname === "/oauth/token/accessible-resources") return json([{ id: "cloud-1", url: "https://example-studio.atlassian.net", name: "example-studio", scopes: ["read:page:confluence"] }]);
      assert.match(String((init?.headers as any)?.authorization), /^Bearer access-\d+$/);
      const p = u.pathname.replace("/ex/confluence/cloud-1/wiki", "");
      if (p === "/api/v2/spaces" && u.searchParams.get("keys") === "STARFALL") return json({ results: [{ id: "688130", key: "STARFALL", name: "Starfall" }] });
      if (p === "/api/v2/spaces" && u.searchParams.get("cursor")) return json({ results: [{ id: "688130", key: "STARFALL", name: "Starfall" }] });
      if (p === "/api/v2/spaces") return json({ results: [{ id: "1", key: "OTHER", name: "Other" }], _links: { next: "/api/v2/spaces?cursor=2" } });
      if (p === "/api/v2/spaces/688130/pages") {
        if (!u.searchParams.get("cursor")) return json({ results: pages().slice(0, 2), _links: { next: "/wiki/api/v2/spaces/688130/pages?cursor=b" } });
        return json({ results: pages().slice(2) });
      }
      if (p === "/api/v2/pages/819201/attachments") return json({ results: [{ title: "snow.png", fileSize: 4, downloadLink: "/download/attachments/819201/snow.png?version=1&api=v2" }, { title: "unused.png", downloadLink: "/download/x" }] });
      if (p === "/download/attachments/819201/snow.png") return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      return json({ results: [] }, 404);
    }) as typeof fetch;
    const hubUrl = "https://core.example.ts.net:8787";

    assert.equal((await t.api("/connections/atlassian/signin", { method: "POST", json: { hub: hubUrl, client: "web" } })).status, 409);
    assert.equal((await t.api("/connections/atlassian/app", { method: "PUT", json: { client_id: "short", client_secret: "x" } })).status, 422);
    const app = await (await t.api("/connections/atlassian/app", { method: "PUT", json: { client_id: "AbCdEf0123456789AbCdEf0123456789", client_secret: "ATOA-secret-value-0123456789abcdef" } })).json() as any;
    assert.deepEqual(app, { connected: false, app: true });
    assert.equal((await t.api("/connections/atlassian/signin", { method: "POST", json: { hub: "http://core:8787", client: "web" } })).status, 422);

    const start = async (client: string) => {
      const { url } = await (await t.api("/connections/atlassian/signin", { method: "POST", json: { hub: hubUrl, client } })).json() as any;
      const q = new URL(url).searchParams;
      assert.equal(q.get("redirect_uri"), `${hubUrl}/connections/atlassian/return`);
      assert.match(q.get("scope")!, /read:page:confluence/);
      assert.match(q.get("scope")!, /offline_access/);
      assert.doesNotMatch(q.get("scope")!, /write/);
      return q.get("state")!;
    };
    // A refused code, then a replayed state, then a good one; the return needs no bearer token.
    let state = await start("web");
    let res = await t.app.request(`/connections/atlassian/return?state=${state}&code=bad`);
    assert.match(await res.text(), /Confluence not linked/);
    res = await t.app.request(`/connections/atlassian/return?state=${state}&code=good-code`);
    assert.match(await res.text(), /expired/);
    state = await start("apple");
    res = await t.app.request(`/connections/atlassian/return?state=${state}&code=good-code`);
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location")!, /^everythingapp:\/\/atlassian\?linked=1&message=.*Choose/);

    const view = await (await t.api("/connections")).json() as any;
    assert.equal(view.atlassian.connected, true);
    assert.equal(view.atlassian.site_name, "example-studio");
    assert.equal(JSON.stringify(view).includes("access-"), false);
    assert.equal(JSON.stringify(view).includes("ATOA-secret"), false);

    const spaces = await (await t.api("/connections/atlassian/spaces")).json() as any;
    assert.deepEqual(spaces.spaces.map((s: any) => s.key), ["OTHER", "STARFALL"], "sorted by name");

    const set = await (await t.api("/connections/atlassian/spaces", { method: "PUT", json: { keys: ["STARFALL"] } })).json() as any;
    assert.deepEqual(set.sync, { spaces: 1, pages: 3, updated: 3, removed: 0, images: 1 });
    assert.equal(set.connection.pages, 3);

    // The repo's docs, for links from the handbook to GitHub.
    await t.api("/wiki/feed", { method: "POST", json: { project: "Starfall", web_base: "https://github.com/gnomecannon/example-game", manifest: [{ path: "Docs/FeatureHub/Roads.md", sha: "1" }], pages: [{ path: "Docs/FeatureHub/Roads.md", sha: "1", markdown: "# Roads\n\n[The handbook](https://example-studio.atlassian.net/wiki/spaces/STARFALL) and [its overview](https://example-studio.atlassian.net/wiki/spaces/STARFALL/overview?mode=global).\n" }] } });

    const index = await (await t.api("/wiki")).json() as any;
    assert.deepEqual(index.sources.map((s: any) => [s.kind, s.name, s.pages]), [["confluence", "Starfall handbook", 3], ["repo", "Starfall repo docs", 1]]);
    assert.deepEqual(index.pages.filter((p: any) => p.source === "confluence").map((p: any) => [p.title, p.depth]), [["Starfall", 0], ["Current state", 1], ["Art library", 1]]);
    const cs = await (await t.api("/wiki/page?id=confluence%3A819201")).json() as any;
    assert.equal(cs.url, "https://example-studio.atlassian.net/wiki/spaces/STARFALL/pages/819201/Current+state");
    assert.deepEqual(cs.crumbs, ["Starfall"]);
    assert.match(cs.markdown, /\[Art library\]\(everythingapp:\/\/wiki\?id=confluence%3A196825\)/);
    assert.match(cs.markdown, /\[roads\]\(everythingapp:\/\/wiki\?id=repo%3AStarfall%3ADocs%2FFeatureHub%2FRoads\.md\)/);
    // A link to the space itself opens the handbook's home page.
    const roads = await (await t.api("/wiki/page?id=repo%3AStarfall%3ADocs%2FFeatureHub%2FRoads.md")).json() as any;
    assert.match(roads.markdown, /\[The handbook\]\(everythingapp:\/\/wiki\?id=confluence%3A688306\) and \[its overview\]\(everythingapp:\/\/wiki\?id=confluence%3A688306\)/);
    assert.match(cs.markdown, /!\[snow\.png\]\(\/wiki\/media\/819201\/snow\.png\)/);
    const img = await t.api("/wiki/media/819201/snow.png");
    assert.equal(img.headers.get("content-type"), "image/png");
    assert.equal((await img.arrayBuffer()).byteLength, 4);
    assert.equal((await t.api("/wiki/media/819201/unused.png")).status, 404);

    // Unchanged pages are not converted again; an expired token is refreshed first.
    t.hub.connections.update((c) => { c.atlassian!.expires_at = new Date(Date.now() - 1000).toISOString(); });
    calls.length = 0;
    homeVersion = 4;
    const again = await (await t.api("/connections/atlassian/sync", { method: "POST" })).json() as any;
    assert.deepEqual(again, { spaces: 1, pages: 3, updated: 1, removed: 0, images: 1 });
    assert.equal(calls[0], "POST /oauth/token");
    assert.equal(t.hub.connections.get().atlassian!.refresh_token, `refresh-${tokenN}`);

    // Unlinking removes the handbook pages and keeps the repo docs.
    await t.api("/connections/atlassian", { method: "DELETE" });
    const after = await (await t.api("/wiki")).json() as any;
    assert.deepEqual(after.sources.map((s: any) => s.kind), ["repo"]);
    assert.equal((await t.api("/wiki/media/819201/snow.png")).status, 404);
  } finally {
    t.cleanup();
  }
});

test("wiki: a Confluence page nested 100,000 deep is read to a depth of MAX_DEPTH, its deeper text kept in the element at the limit", () => {
  // It overflowed the stack and failed the whole space's sync (2026-11-22).
  for (const open of ["<p>", "<ac:x>", "<b>", "<ul><li>", "<table><tr><td>"]) {
    const page = `${open.repeat(100_000)}deep words ${"<em>more</em>".repeat(3)}`;
    const t0 = Date.now();
    const md = storageToMarkdown(page);
    assert.ok(Date.now() - t0 < 5000, `${open} took ${Date.now() - t0} ms`);
    // Its text goes into the element at the limit, shown where that one shows text: a table row shows only its
    // cells, so text that lands straight in a row is dropped.
    if (!open.startsWith("<table>")) { assert.match(md, /deep words/, open); assert.match(md, /more/, open); }
    assert.doesNotThrow(() => attachmentsShown(page));
  }
  let depth = 0;
  for (let n = parseStorage("<p>".repeat(1000)); n.kids.length; n = n.kids[0] as typeof n) depth++;
  assert.equal(depth, MAX_DEPTH);
  // A page within the limit is read as before.
  assert.equal(storageToMarkdown(`${"<div>".repeat(50)}<p>Hi <b>there</b></p>${"</div>".repeat(50)}`), "Hi **there**\n");
});

test("wiki: a Confluence page that cannot be converted is skipped; the rest of the space is mirrored", async () => {
  const t = makeHub();
  const real = convert.storageToMarkdown;
  try {
    t.hub.connections.update((c) => { c.atlassian = { access_token: "access-1", refresh_token: "refresh-1", expires_at: new Date(Date.now() + 3_600_000).toISOString(), cloud_id: "cloud-1", site_url: "https://example-studio.atlassian.net", site_name: "example-studio", spaces: ["STARFALL"] }; });
    const page = (id: string, value: string) => ({ id, title: `Page ${id}`, parentId: null, position: 0, version: { number: 1 }, _links: { webui: `/spaces/STARFALL/pages/${id}` }, body: { storage: { value } } });
    t.hub.fetch = (async (input: string | URL | Request) => {
      const p = new URL(String(input)).pathname.replace("/ex/confluence/cloud-1/wiki", "");
      const json = (j: unknown) => new Response(JSON.stringify(j));
      if (p === "/api/v2/spaces") return json({ results: [{ id: "1", key: "STARFALL", name: "Starfall" }] });
      if (p === "/api/v2/spaces/1/pages") return json({ results: [page("1", "<p>One</p>"), page("2", `${"<p>".repeat(100_000)}deep`), page("3", "<p>breaks</p>"), page("4", "<p>Four</p>")] });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    convert.storageToMarkdown = (xhtml, id, key) => { if (id === "3") throw new RangeError("Maximum call stack size exceeded"); return real(xhtml, id, key); };
    const r = await syncConfluence(t.hub);
    assert.deepEqual(r, { spaces: 1, pages: 4, updated: 3, removed: 0, images: 0 });
    const index = await (await t.api("/wiki")).json() as any;
    assert.deepEqual(index.pages.filter((p: any) => p.source === "confluence").map((p: any) => p.title).sort(), ["Page 1", "Page 2", "Page 4"]);
    const deep = await (await t.api("/wiki/page?id=confluence%3A2")).json() as any;
    assert.match(deep.markdown, /deep/);
    assert.match(t.hub.connections.get().atlassian!.last_error!, /STARFALL: page 3 could not be read and was skipped/);
    // Once it can be read, the next sync takes it in.
    convert.storageToMarkdown = real;
    const again = await syncConfluence(t.hub);
    assert.equal(again.updated, 1);
    assert.equal(t.hub.connections.get().atlassian!.last_error, null);
  } finally { convert.storageToMarkdown = real; t.cleanup(); }
});

test("wiki: Confluence keeps its sign-in through a refused access token, a lost refresh answer and two refreshes at once; one Atlassian ended waits for Reconnect, which keeps the chosen spaces (gnomecannon/aeneas#24)", async () => {
  const t = makeHub();
  const waits = refreshRetry.waitsMs;
  refreshRetry.waitsMs = [0, 0];
  try {
    const soon = () => new Date(Date.now() + 3_600_000).toISOString();
    t.hub.connections.update((c) => {
      c.atlassian_app = { client_id: "AbCdEf0123456789AbCdEf0123456789", client_secret: "ATOA-secret-value-0123456789abcdef" };
      c.atlassian = { access_token: "access-0", refresh_token: "refresh-0", expires_at: soon(), cloud_id: "cloud-1", site_url: "https://example-studio.atlassian.net", site_name: "example-studio", spaces: ["STARFALL"] };
    });
    const token: { n: number; mode: "ok" | "refuse" | "unreachable-once"; traded: string[] } = { n: 0, mode: "ok", traded: [] };
    // Access tokens Atlassian no longer takes, whatever their time says.
    const revoked = new Set<string>();
    let site = { id: "cloud-1", url: "https://example-studio.atlassian.net", name: "example-studio" };
    t.hub.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      const json = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status });
      if (u.pathname === "/oauth/token") {
        const b = JSON.parse(String(init?.body));
        if (b.grant_type === "refresh_token") token.traded.push(b.refresh_token);
        if (token.mode === "unreachable-once") { token.mode = "ok"; throw new Error("socket hang up"); }
        if (token.mode === "refuse" && b.grant_type === "refresh_token") return json({ error: "invalid_grant", error_description: "Unknown or invalid refresh token." }, 403);
        await new Promise((r) => setTimeout(r, 5));
        token.n++;
        return json({ access_token: `access-${token.n}`, refresh_token: `refresh-${token.n}`, expires_in: 3600 });
      }
      if (u.pathname === "/oauth/token/accessible-resources") return json([{ ...site, scopes: ["read:page:confluence"] }]);
      if (revoked.has(String((init?.headers as Record<string, string>)?.authorization).replace("Bearer ", ""))) return json({ message: "Unauthorized" }, 401);
      const p = u.pathname.replace("/ex/confluence/cloud-1/wiki", "");
      if (p === "/api/v2/spaces" && u.searchParams.get("keys")) return json({ results: [{ id: "688130", key: "STARFALL", name: "Starfall" }] });
      if (p === "/api/v2/spaces") return json({ results: [{ id: "688130", key: "STARFALL", name: "Starfall" }] });
      if (p === "/api/v2/spaces/688130/pages") return json({ results: [{ id: "688306", title: "Starfall", parentId: null, position: 0, version: { number: 1 }, _links: { webui: "/spaces/STARFALL/overview" }, body: { storage: { value: "<p>Home</p>" } } }] });
      return json({ results: [] }, 404);
    }) as typeof fetch;
    const link = () => t.hub.connections.get().atlassian!;
    const view = async () => ((await (await t.api("/connections")).json()) as { atlassian: { connected: boolean; expired?: boolean; spaces?: string[]; last_error?: string | null } }).atlassian;

    // An access token refused before its time is up: one refresh and the same request again. It said "sign in again"
    // and stopped, though the refresh token still worked.
    revoked.add("access-0");
    let r = await t.api("/connections/atlassian/sync", { method: "POST" });
    assert.equal(r.status, 200);
    assert.deepEqual(token.traded, ["refresh-0"]);
    assert.deepEqual([link().access_token, link().refresh_token, link().expired, link().last_error], ["access-1", "refresh-1", undefined, null]);

    // Two callers at once with a token due: one refresh between them. Each traded the same refresh token.
    t.hub.connections.update((c) => { c.atlassian!.expires_at = new Date(Date.now() - 1000).toISOString(); });
    token.traded = [];
    const both = await Promise.all([t.api("/connections/atlassian/spaces"), t.api("/connections/atlassian/sync", { method: "POST" })]);
    assert.deepEqual(both.map((x) => x.status), [200, 200]);
    assert.deepEqual(token.traded, ["refresh-1"]);
    assert.equal(link().refresh_token, "refresh-2");

    // Atlassian not reached for a moment: the refresh is tried again at once with the same token (inside Atlassian's
    // reuse interval), not left for the next hourly sync, when the token kept would be refused for good.
    t.hub.connections.update((c) => { c.atlassian!.expires_at = new Date(Date.now() - 1000).toISOString(); });
    token.traded = [];
    token.mode = "unreachable-once";
    assert.equal((await t.api("/connections/atlassian/sync", { method: "POST" })).status, 200);
    assert.deepEqual(token.traded, ["refresh-2", "refresh-2"]);
    assert.equal(link().refresh_token, "refresh-3");

    // Atlassian refuses the refresh token: the link stays, with its spaces and pages, marked for Reconnect.
    t.hub.connections.update((c) => { c.atlassian!.expires_at = new Date(Date.now() - 1000).toISOString(); });
    token.mode = "refuse";
    r = await t.api("/connections/atlassian/sync", { method: "POST" });
    assert.equal(r.status, 409);
    assert.equal(((await r.json()) as { error: string }).error, SIGNIN_ENDED);
    let v = await view();
    assert.deepEqual([v.connected, v.expired, v.spaces, v.last_error], [true, true, ["STARFALL"], SIGNIN_ENDED]);
    assert.equal(((await (await t.api("/wiki")).json()) as { sources: { kind: string; pages: number }[] }).sources.find((x) => x.kind === "confluence")?.pages, 1, "the mirrored pages stay");

    // Reconnect with an account on another site: refused, and the link is as it was.
    token.mode = "ok";
    const start = async () => new URL(((await (await t.api("/connections/atlassian/signin", { method: "POST", json: { hub: "https://core.example.ts.net:8787", client: "apple" } })).json()) as { url: string }).url).searchParams.get("state")!;
    site = { id: "cloud-9", url: "https://other-team.atlassian.net", name: "other-team" };
    let back = await t.app.request(`/connections/atlassian/return?state=${await start()}&code=good-code`);
    assert.match(decodeURIComponent(back.headers.get("location")!.replace(/\+/g, " ")), /error=That account's Confluence site is other-team, not example-studio/);
    v = await view();
    assert.deepEqual([v.expired, v.spaces], [true, ["STARFALL"]]);

    // Reconnect with the right account: the same spaces, read again at once, and the mark gone.
    site = { id: "cloud-1", url: "https://example-studio.atlassian.net", name: "example-studio" };
    back = await t.app.request(`/connections/atlassian/return?state=${await start()}&code=good-code`);
    assert.match(decodeURIComponent(back.headers.get("location")!.replace(/\+/g, " ")), /linked=1&message=Confluence reconnected: example-studio, 1 pages/);
    v = await view();
    assert.deepEqual([v.connected, v.expired, v.spaces, v.last_error], [true, false, ["STARFALL"], null]);
  } finally {
    refreshRetry.waitsMs = waits;
    t.cleanup();
  }
});
