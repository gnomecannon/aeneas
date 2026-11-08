import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";

type Guide = { service: string; done: boolean; warning: string | null; steps: { title: string; text: string; copy?: { label: string; value: string }[]; link?: { url: string }; fields?: { id: string; secret: boolean }[]; save?: { path: string }; test?: { path: string } }[] };

test("guides: each one fills in this hub's own return address and permissions, and ends with what to paste", async () => {
  const t = makeHub();
  try {
    t.hub.cfg.publicUrl = "https://hub.example.ts.net:8787";
    const g = (await (await t.api("/connections/guides/google")).json()) as Guide;
    const copies = g.steps.flatMap((s) => s.copy ?? []).map((c) => c.value);
    assert.ok(copies.includes("https://hub.example.ts.net:8787/connections/google/return"));
    assert.ok(copies.includes("https://www.googleapis.com/auth/gmail.readonly"));
    const last = g.steps[g.steps.length - 1];
    assert.deepEqual(last.fields?.map((f) => [f.id, f.secret]), [["client_id", false], ["client_secret", true]]);
    assert.equal(last.save?.path, "/connections/google/app");
    assert.equal(last.test?.path, "/connections/google/app/test");
    assert.equal(g.warning, null);
    assert.ok(g.steps.some((s) => /In production/.test(s.text)), "the step that stops the 7-day sign-in");
    const a = (await (await t.api("/connections/guides/atlassian")).json()) as Guide;
    assert.ok(a.steps.flatMap((s) => s.copy ?? []).some((c) => c.value === "https://hub.example.ts.net:8787/connections/atlassian/return"));
    assert.ok(a.steps.flatMap((s) => s.copy ?? []).some((c) => c.value === "read:space:confluence read:page:confluence read:attachment:confluence"));
    const s = (await (await t.api("/connections/guides/steam")).json()) as Guide;
    assert.ok(s.steps.flatMap((x) => x.copy ?? []).some((c) => c.value === "hub.example.ts.net"));
    assert.equal(s.steps[s.steps.length - 1].save?.path, "/connections/steam/key");
    // Every link is the service's own page, over https; no dashes in what people read.
    for (const x of [g, a, s]) {
      for (const st of x.steps) {
        if (st.link) assert.match(st.link.url, /^https:\/\/(console\.cloud\.google\.com|developer\.atlassian\.com|steamcommunity\.com)\//);
        assert.ok(!/[–—]/.test(st.title + st.text), st.title);
      }
    }
    assert.equal((await t.api("/connections/guides/spotify")).status, 404);
    // Over plain http or an IP address, Google cannot send people back: the guide says so first.
    t.hub.cfg.publicUrl = "http://192.168.1.20:8787";
    assert.match(((await (await t.api("/connections/guides/google")).json()) as Guide).warning ?? "", /https/);
    t.hub.cfg.publicUrl = "https://192.168.1.20:8787";
    assert.match(((await (await t.api("/connections/guides/google")).json()) as Guide).warning ?? "", /IP address/);
  } finally { t.cleanup(); }
});

test("guides: the Google check tells a good app from a wrong secret without signing in", async () => {
  const t = makeHub();
  try {
    assert.equal((await t.api("/connections/google/app/test", { method: "POST" })).status, 409, "nothing saved yet");
    await t.api("/connections/google/app", { method: "PUT", json: { client_id: "1234-abc.apps.googleusercontent.com", client_secret: "GOCSPX-test-not-a-secret-0001" } });
    let answer = { error: "invalid_grant" };
    const sent: string[] = [];
    t.hub.fetch = (async (_u: string | URL | Request, init?: RequestInit) => { sent.push(String(init?.body ?? "")); return new Response(JSON.stringify(answer), { status: answer.error === "invalid_grant" ? 400 : 401 }); }) as typeof fetch;
    let r = (await (await t.api("/connections/google/app/test", { method: "POST" })).json()) as { ok: boolean; message: string };
    assert.deepEqual([r.ok, /knows this app/.test(r.message)], [true, true]);
    assert.ok(sent[0].includes("client_id=1234-abc.apps.googleusercontent.com") && sent[0].includes("code=4%2Feverythingapp-check"));
    answer = { error: "invalid_client" };
    r = (await (await t.api("/connections/google/app/test", { method: "POST" })).json()) as typeof r;
    assert.deepEqual([r.ok, /does not know this Client ID and secret/.test(r.message)], [false, true]);
    t.hub.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
    r = (await (await t.api("/connections/google/app/test", { method: "POST" })).json()) as typeof r;
    assert.deepEqual([r.ok, /could not be reached/.test(r.message)], [false, true]);
  } finally { t.cleanup(); }
});
