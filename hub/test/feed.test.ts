import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";

// Newer than the project's resume card, which the test writes just now.
const soon = new Date(Date.now() + 60_000).toISOString();
const body = (over: Record<string, unknown> = {}) => ({
  project: "starfall",
  source: "codex@desk-pc",
  repo: { branch: "main", last_commit_at: "2026-10-07T18:45:02Z", last_commit: "Update model library organization", uncommitted: 23, last_edit_at: soon, commits: [{ at: "2026-10-07T18:45:02Z", subject: "Update model library organization" }] },
  doc: { path: "Docs/Development/CurrentState.md", updated_at: soon, sections: [{ title: "Snow cap movement review", text: "A moving camera no longer prevents every finished cap from becoming visible. More detail follows." }] },
  threads: [
    { title: "Leaf Vein Material", updated_at: "2026-10-27T20:25:04Z", last_message: "The vein material is ready for review." },
    { title: "Create realistic frozen lake ice", updated_at: "2026-10-28T04:33:01Z", last_message: "The installed ice update is being preserved while the coordinator continues the snow fixes." },
  ],
  ...over,
});

test("project feed: Codex and repo activity lands on the project and rewrites a stale resume card", async () => {
  const t = makeHub();
  try {
    const p = t.hub.store.create("project", { name: "Starfall", status: "active", definition_of_done: "a playable demo", resume_card: "Where I left off: inventory restarted five times." });
    const r = await (await t.api("/projects/feed", { method: "POST", json: body() })).json() as any;
    assert.deepEqual(r, { project_id: p.id, changed: true, resume_card_written: true });
    const f = t.hub.store.get(p.id)!.fields as any;
    assert.equal(f.activity_at, soon, "the newest of threads, doc and repo");
    assert.equal(f.activity.threads[0].title, "Create realistic frozen lake ice", "newest thread first");
    assert.match(f.resume_card, /Latest Codex threads/);
    assert.match(f.resume_card, /Snow cap movement review: A moving camera no longer prevents every finished cap from becoming visible\./);
    assert.match(f.resume_card, /23 files changed since the last commit/);

    // The same feed again writes nothing (no sync churn every 15 minutes).
    const seq = t.hub.store.list({ kind: "project" }).length;
    assert.deepEqual(await (await t.api("/projects/feed", { method: "POST", json: body() })).json(), { project_id: p.id, changed: false, resume_card_written: false });
    assert.equal(t.hub.store.list({ kind: "project" }).length, seq);

    // A session closed after the latest Codex activity keeps its card; activity is still recorded.
    t.hub.store.patch(p.id, { resume_card: "Closed a chat just now." });
    const old = "2026-10-28T05:00:00Z";
    const newer = body({ threads: [{ title: "Pumpkin Variants", updated_at: old }], doc: { path: "x.md", updated_at: old, sections: [{ title: "a", text: "b" }] }, repo: { last_commit_at: old } });
    const r2 = await (await t.api("/projects/feed", { method: "POST", json: newer })).json() as any;
    assert.equal(r2.changed, true);
    assert.equal(r2.resume_card_written, false);
    assert.equal(t.hub.store.get(p.id)!.fields.resume_card, "Closed a chat just now.");

    assert.equal((await t.api("/projects/feed", { method: "POST", json: body({ project: "nope" }) })).status, 404);
  } finally { t.cleanup(); }
});

test("project feed: the feed token can post activity and nothing else", async () => {
  const t = makeHub({ feedToken: "feed-only-test-token" });
  try {
    t.hub.store.create("project", { name: "Starfall", status: "active", definition_of_done: "x" });
    const as = (path: string, init: RequestInit = {}) => t.app.request(path, { ...init, headers: { authorization: "Bearer feed-only-test-token", "content-type": "application/json" } });
    assert.equal((await as("/projects/feed", { method: "POST", body: JSON.stringify(body()) })).status, 200);
    assert.equal((await as("/entities?kind=project")).status, 401);
    assert.equal((await as("/entities", { method: "POST", body: JSON.stringify({ kind: "task", fields: { title: "x", status: "next", order: 1 } }) })).status, 401);
  } finally { t.cleanup(); }
});
