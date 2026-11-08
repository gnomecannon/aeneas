import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Each case was a finding of the 2026-11-05 review of the assistant (tools, chat loop, cloud residency); each fails on the code before the fix.
const R = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const { makeHub } = await import(`${R}/test/helpers.ts`);
const { setBackendOverride } = await import(`${R}/src/ai/backends.ts`);
const { runTool, TOOLS } = await import(`${R}/src/ai/tools.ts`);
const { closeSession } = await import(`${R}/src/memory.ts`);
const { harvestSnippets } = await import(`${R}/src/ai/harvest.ts`);
const { openLedger, recordFailure, appendPending } = await import(`${R}/src/ai/ledger.ts`);
const { saysWorked } = await import(`${R}/src/ai/harvest.ts`);

const tick = () => new Promise((r) => setTimeout(r, 5));
const api = (t: any) => (t.hub.ai as any).api;
const ctx = (t: any, extra: Record<string, unknown> = {}) => ({ sessionId: "probe", lastUser: "", topic: "probe", store: t.hub.store, cfg: t.hub.cfg, hosts: null, ...extra });

/** Plain local backend (no tools) whose reply for a message containing "SLOW" waits for release(). */
function gated() {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let started = 0;
  const reply = async (msgs: any[]) => {
    const last = [...msgs].reverse().find((m) => m.role === "user")?.content ?? "";
    if (/SLOW/.test(last)) { started++; await gate; return `answer to slow`; }
    return `answer to fast`;
  };
  const b: any = {
    name: "ollama", model: "gated",
    chat: async (m: any[]) => ({ text: await reply(m), usage: {} }),
    stream: async (m: any[], on: (t: string) => void) => { const x = await reply(m); on(x); return { text: x, usage: {} }; },
    started: () => started, release: () => release(),
  };
  return b;
}

test("C1 two turns on one chat at once: one of them is lost from the stored chat", async () => {
  const t = makeHub({ aiTools: false });
  const b = gated();
  setBackendOverride(b);
  try {
    const p1 = t.hub.ai.chat({ session_id: "c1", message: "SLOW question from the phone", task_type: "general" } as any);
    while (!b.started()) await tick();
    // The second turn waits for the first (they run one after the other), so it is not awaited before the release.
    const p2 = t.hub.ai.chat({ session_id: "c1", message: "quick question from the Watch", task_type: "general" } as any);
    await tick();
    b.release();
    const [r1, r2] = await Promise.all([p1, p2]);
    const stored = t.hub.ai.sessions.get("c1")!.messages.map((m: any) => `${m.role}: ${m.content}`);
    assert.ok(stored.some((s: string) => s.includes("quick question")) && stored.some((s: string) => s.includes("answer to fast")), "the second turn and its answer are lost");
    assert.ok(stored.some((s: string) => s.includes("SLOW question")) && stored.some((s: string) => s.includes("answer to slow")), "the first turn and its answer are lost");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("C2 a chat deleted while its reply is being worked on comes back whole", async () => {
  const t = makeHub({ aiTools: false });
  const b = gated();
  setBackendOverride(b);
  try {
    t.hub.ai.sessions.save("c2", "general", [{ role: "user", content: "PRIVATE earlier turn about my divorce lawyer" }, { role: "assistant", content: "earlier answer" }] as any);
    const p1 = t.hub.ai.chat({ session_id: "c2", message: "SLOW follow up", task_type: "general" } as any);
    while (!b.started()) await tick();
    const del = await t.api("/ai/sessions/c2", { method: "DELETE" });
    b.release();
    await p1;
    const back = t.hub.ai.sessions.get("c2");
    const list = t.hub.ai.sessions.list().map((s: any) => s.session_id);
    assert.equal(back, null, "the erased chat was written back with its whole history");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("C3 closing a session deletes the snippets saved when the owner said it worked, and the journal of commands the hub ran", async () => {
  const t = makeHub();
  try {
    fs.writeFileSync(path.join(t.dir, "hosts.json"), JSON.stringify([{ name: "core", local: true }]));
    t.hub.cfg.hostsFile = path.join(t.dir, "hosts.json");
    t.hub.cfg.hostActions = true;
    t.hub.ai.hosts.runner = async () => ({ exit_code: 1, output: "Job for nginx.service failed", timed_out: false, ms: 5 });
    const sid = "c3";
    t.hub.ai.sessions.save(sid, "troubleshoot", [
      { role: "user", content: "nginx on core will not start" },
      { role: "assistant", content: "Run this on core:\n```bash\nsudo nginx -t && sudo systemctl restart nginx\n```" },
      { role: "user", content: "that fixed it" },
    ] as any);
    // The approved change the hub ran (it failed): journaled by hosts.approve with its rollback.
    const host = t.hub.ai.hosts.host("core");
    const a = t.hub.ai.hosts.propose(sid, host, "systemctl restart php-fpm", "restart php-fpm", "systemctl stop php-fpm");
    const ran = await t.hub.ai.hosts.approve(a.id);
    // What the chat saves when the owner says it worked.
    const saved = harvestSnippets(t.hub.store, { sessionId: sid, topic: "nginx on core will not start", previousReply: "Run this on core:\n```bash\nsudo nginx -t && sudo systemctl restart nginx\n```", actions: [], hosts: t.hub.ai.hosts.hosts(), privateLiterals: [] });
    const res = await closeSession(t.hub.store, t.hub.ai, sid, { outcome: "fixed" });
    const snippetAfter = t.hub.store.get(saved[0].id);
    const journalAfter = t.hub.store.get(ran.journal.id);
    const live = t.hub.store.list({ kind: "journal", where: { session_id: sid } }).map((j: any) => `${j.fields.what} [${j.fields.outcome}]`);
    assert.ok(!snippetAfter?.deleted_at && !journalAfter?.deleted_at, "close deleted records the chat had saved");
  } finally { t.cleanup(); }
});

test("C4 remember with a key another category already uses overwrites that fact", async () => {
  const t = makeHub();
  try {
    const pref = t.hub.store.create("fact", { category: "preference", key: "coffee", value: "oat milk flat white, no sugar", source: "user" });
    const out = await runTool(api(t), { name: "remember", arguments: { category: "health", key: "coffee", value: "cardiologist says at most two cups a day" } }, ctx(t) as any, TOOLS);
    const facts = t.hub.store.list({ kind: "fact" }).filter((f: any) => f.fields.key === "coffee").map((f: any) => `${f.fields.category}: ${f.fields.value}`);
    assert.equal(facts.length, 2, "the preference fact was overwritten by a health fact");
  } finally { t.cleanup(); }
});

test("C5 a fix that worked lands in ruled out when the message also says still or same", () => {
  const t = makeHub();
  try {
    let l = openLedger(t.hub.store, "c5", "plex will not stream");
    l = appendPending(t.hub.store, l, "1. Restart the plex container on core.\n2. Check the transcoder log.");
    const said = "That fixed it, thanks! Still not sure why it broke.";
    l = recordFailure(t.hub.store, l, said);
    assert.equal((l.fields.ruled_out as string[]).length, 0, "the step that worked is now 'never suggest again'");
  } finally { t.cleanup(); }
});

test("C6 update_item moving a timed event's start alone leaves its end before its start", async () => {
  const t = makeHub();
  try {
    const e = t.hub.store.create("event", { title: "Dentist", start: "2026-11-10T15:00:00-05:00", end: "2026-11-10T16:00:00-05:00", all_day: false, source: "manual" });
    const out = await runTool(api(t), { name: "update_item", arguments: { id: e.id, fields: { start: "2026-11-10T17:00:00-05:00" } } }, ctx(t) as any, TOOLS);
    const f = t.hub.store.get(e.id)!.fields;
    assert.ok(Date.parse(String(f.end)) > Date.parse(String(f.start)), "event ends before it starts");
  } finally { t.cleanup(); }
});

test("C7 draft_in_my_voice in a chat sent with allow_cloud:false still goes to the cloud when the local draft fails", async () => {
  const t = makeHub({ aiFake: false, ollamaUrl: "", anthropicApiKey: "", allowCloudDefault: true });
  try {
    const cloudSeen: string[] = [];
    let round = 0;
    const local: any = {
      name: "ollama", model: "local",
      chat: async () => { throw new Error("timeout after 120000 ms"); },
      stream: async () => ({ text: "", usage: {} }),
      streamTools: async () => (round++ === 0
        ? { text: "", usage: {}, tool_calls: [{ function: { name: "draft_in_my_voice", arguments: { request: "Email to my boss Dana: I'm resigning, the Acme Q4 numbers are wrong" } } }] }
        : { text: "Here is the draft.", usage: {} }),
    };
    const cloud: any = { name: "anthropic", model: "claude", cloud: true, chat: async (m: any[]) => { cloudSeen.push(m.map((x) => x.content).join("\n")); return { text: "cloud draft", usage: {} }; }, stream: async () => ({ text: "", usage: {} }) };
    (t.hub.ai as any).backends = { ollama: local, ollamaFallback: null, anthropic: cloud, adapter: null, openai: null };
    const out = await t.hub.ai.chat({ session_id: "c7", message: "draft my resignation email", task_type: "general", allow_cloud: false } as any);
    assert.equal(cloudSeen.length, 0, "a chat that said no cloud sent its draft request to the cloud");
  } finally { t.cleanup(); }
});

test("C8 update_item and get_item on a deleted item: success with no sign it is deleted", async () => {
  const t = makeHub();
  try {
    const e = t.hub.store.create("event", { title: "Dentist", start: "2026-11-10T15:00:00-05:00", end: "2026-11-10T16:00:00-05:00", all_day: false, source: "manual" });
    await runTool(api(t), { name: "delete_item", arguments: { id: e.id } }, ctx(t) as any, TOOLS);
    const up = await runTool(api(t), { name: "update_item", arguments: { id: e.id, fields: { start: "2026-11-10T17:00:00-05:00", end: "2026-11-10T18:00:00-05:00" } } }, ctx(t) as any, TOOLS);
    const got = await runTool(api(t), { name: "get_item", arguments: { id: e.id } }, ctx(t) as any, TOOLS);
    assert.ok(!up.ok || /deleted/.test(up.text), "the change is reported as made on an item the owner no longer sees");
  } finally { t.cleanup(); }
});
