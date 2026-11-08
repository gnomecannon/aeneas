import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { runSeed } from "../src/seed.js";
import { extractSteps } from "../src/ai/ledger.js";
import type { ChatOutput } from "../src/ai/index.js";

test("ai: style filter and redaction through the pipeline with the fake backend", async () => {
  const t = makeHub();
  try {
    const seeded = runSeed(t.hub.store, t.hub.cfg.seedDir);
    assert.ok(seeded.rules.created > 0);
    assert.ok(seeded.facts.created > 0);
    // The owner's edits in the Memory screen survive a redeploy: an edited fact keeps its value, a rule switched off stays off.
    const fact = t.hub.store.list({ kind: "fact" })[0];
    const rule = t.hub.store.list({ kind: "rule" })[0];
    t.hub.store.patch(fact.id, { value: "edited in the app" });
    t.hub.store.patch(rule.id, { active: false });
    assert.deepEqual(runSeed(t.hub.store, t.hub.cfg.seedDir), { facts: { created: 0, kept: seeded.facts.created }, rules: { created: 0, kept: seeded.rules.created }, plan_rules: { created: 0, kept: 2 }, runbooks: { created: 0, kept: seeded.runbooks.created }, food_options: { created: 0, kept: seeded.food_options.created }, music_notes: { created: 0, kept: seeded.music_notes.created }, snippets: { created: 0, kept: seeded.snippets.created }, monitors: { created: 0, kept: seeded.monitors.created }, checklists: { created: 0, kept: seeded.checklists.created, states_marked: 0 } });
    assert.equal(t.hub.store.get(fact.id)!.fields.value, "edited in the app");
    assert.equal(t.hub.store.get(rule.id)!.fields.active, false);
    t.hub.store.patch(rule.id, { active: true });
    t.hub.store.create("fact", { category: "host", key: "secret_host", value: "hidden-rack-name", private: true });

    const res = await t.api("/ai/chat", { method: "POST", json: {
      session_id: "s1", task_type: "general",
      messages: [{ role: "user", content: "config has password=hunter2 and the box is hidden-rack-name, mail me at robin@example.com" }],
    } });
    assert.equal(res.status, 200);
    const out = await res.json() as ChatOutput;
    assert.equal(out.backend, "ollama");
    assert.equal(out.model, "fake");
    assert.equal(out.redactions, 2, "password assignment and the private fact value");
    assert.ok(out.reply.includes("password=[REDACTED:password-assignment]"), out.reply);
    assert.ok(out.reply.includes("[REDACTED:private]"), out.reply);
    assert.ok(out.reply.includes("robin@example.com"), "emails stay in the personal space");
    assert.ok(!out.reply.includes("—"), "em dash removed");
    assert.ok(!/great question/i.test(out.reply), "opening platitude removed");
    assert.ok(!/let me know if/i.test(out.reply), "closing filler removed");
    assert.ok(out.rules_applied.includes("em-dash"));
    assert.ok(out.rules_applied.includes("opening-platitude"));
    assert.ok(out.rules_applied.some((r) => r.startsWith("rule:No disclaimers")), "a seeded rule pattern was applied");
    assert.ok(!/not a doctor/i.test(out.reply), "disclaimer removed by the seeded rule");

    // Work space redacts emails too.
    const work = await (await t.api("/ai/chat", { method: "POST", json: { session_id: "s2", space: "work", messages: [{ role: "user", content: "ping robin@example.com" }] } })).json() as ChatOutput;
    assert.ok(work.reply.includes("[REDACTED:email]"));
    assert.equal(work.redactions, 1);

    // Audit row written with token counts.
    const call = t.hub.chatDb.prepare("SELECT * FROM ai_calls WHERE session_id = 's1'").get() as any;
    assert.equal(call.backend, "ollama");
    assert.equal(call.redactions, 2);
    assert.equal(call.prompt_tokens, 10);
    assert.equal(call.completion_tokens, 20);
    assert.ok(call.ms >= 0);

    // Session persisted with the reply appended.
    const s = await (await t.api("/ai/sessions/s1")).json() as { messages: { role: string }[] };
    assert.equal(s.messages.length, 2);
    assert.equal(s.messages[1].role, "assistant");

    // Memory view: private facts drop out for cloud.
    const local = await (await t.api("/ai/memory")).json() as { facts: any[]; rules: any[] };
    const cloud = await (await t.api("/ai/memory?allow_cloud=true")).json() as { facts: any[] };
    assert.ok(local.facts.some((f) => f.fields.key === "secret_host"));
    assert.ok(!cloud.facts.some((f) => f.fields.key === "secret_host"));
    assert.ok(local.rules.length > 0);
  } finally { t.cleanup(); }
});

test("ai: troubleshoot sessions keep a ledger of pending steps and rule out failures", async () => {
  const t = makeHub();
  try {
    const first = await (await t.api("/ai/chat", { method: "POST", json: { session_id: "ts1", task_type: "troubleshoot", messages: [{ role: "user", content: "hub service will not start on core" }] } })).json() as ChatOutput;
    assert.ok(first.ledger_id);
    let ledger = t.hub.store.get(first.ledger_id!)!;
    assert.equal(ledger.fields.session_id, "ts1");
    assert.equal(ledger.fields.tried.length, 1);
    assert.equal(ledger.fields.tried[0].result, "pending");
    assert.match(ledger.fields.tried[0].what, /systemctl status hub/);
    assert.match(ledger.fields.tried[0].what, /journalctl/);

    const second = await (await t.api("/ai/chat", { method: "POST", json: { session_id: "ts1", task_type: "troubleshoot", messages: [
      { role: "user", content: "hub service will not start on core" },
      { role: "assistant", content: first.reply },
      { role: "user", content: "that didn't work, same error" },
    ] } })).json() as ChatOutput;
    assert.equal(second.ledger_id, first.ledger_id);
    ledger = t.hub.store.get(first.ledger_id!)!;
    assert.equal(ledger.fields.tried.length, 2);
    assert.equal(ledger.fields.tried[0].result, "didn't work");
    assert.equal(ledger.fields.tried[1].result, "pending");
    assert.deepEqual(ledger.fields.ruled_out, [ledger.fields.tried[0].what]);

    // Step extraction falls back to sentences when nothing is numbered.
    assert.equal(extractSteps("Check the cable. Then reboot the switch. Finally call me."), "Check the cable. Then reboot the switch.");
  } finally { t.cleanup(); }
});

test("ai: streaming returns token events then done, and resume-card writes the project", async () => {
  const t = makeHub();
  try {
    const res = await t.api("/ai/chat/stream", { method: "POST", json: { session_id: "st1", messages: [{ role: "user", content: "hello" }] } });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes("event: token"));
    assert.ok(text.includes("event: done"));
    const done = JSON.parse(text.split("event: done")[1].split("data: ")[1].split("\n")[0]) as ChatOutput;
    assert.ok(!/great question/i.test(done.reply));

    const project = t.hub.store.create("project", { name: "Hub", status: "active", definition_of_done: "all tests pass" });
    const rc = await t.api("/ai/resume-card", { method: "POST", json: { project_id: project.id, session_id: "st1" } });
    assert.equal(rc.status, 200);
    assert.ok(String(t.hub.store.get(project.id)!.fields.resume_card).length > 0);
  } finally { t.cleanup(); }
});

test("ai: when no model answers, the stream ends with a plain error event and the JSON route returns 503", async () => {
  const t = makeHub();
  const { setBackendOverride } = await import("../src/ai/backends.js");
  const down = async (): Promise<never> => { throw new Error("fetch failed"); };
  setBackendOverride({ name: "ollama", model: "m", chat: down, stream: down });
  try {
    const body = { session_id: "s-down", task_type: "general", messages: [{ role: "user", content: "hello" }] };
    const json = await t.api("/ai/chat", { method: "POST", json: body });
    assert.equal(json.status, 503);
    const text = await (await t.api("/ai/chat/stream", { method: "POST", json: body })).text();
    assert.match(text, /event: error/);
    assert.match(text, /no model answered/);
  } finally { setBackendOverride(null); t.cleanup(); }
});
