import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { setBackendOverride, type AiMessage, type Backend } from "../src/ai/backends.js";
import { personalBackend, personalize } from "../src/profile.js";

test("profile: the owner's name goes into system messages and tool descriptions, never into what they typed", async () => {
  const t = makeHub();
  try {
    assert.deepEqual((await (await t.api("/profile")).json()), { name: "the owner", pet: "", named: false });
    assert.equal((await t.api("/profile", { method: "PUT", json: { name: " " } })).status, 422);
    assert.deepEqual((await (await t.api("/profile", { method: "PUT", json: { name: "Alex" } })).json()), { name: "Alex", pet: "" });
    assert.deepEqual((await (await t.api("/profile", { method: "PUT", json: { pet: "Biscuit" } })).json()), { name: "Alex", pet: "Biscuit" }, "the pet alone keeps the name");
    let sent: { messages: AiMessage[]; tools: unknown[] } | null = null;
    const inner: Backend = { name: "ollama", model: "m", chat: async () => ({ text: "", usage: {} }), stream: async () => ({ text: "", usage: {} }),
      streamTools: async (messages, tools) => { sent = { messages, tools }; return { text: "ok", usage: {} }; } };
    const b = personalBackend(inner, () => ({ owner: t.hub.profile.get().name, pet: t.hub.profile.get().pet }));
    await b.streamTools!([
      { role: "system", content: "You help {{owner}}. {{owner}}'s dog {{pet}}." },
      { role: "user", content: "my friend Jordan called about Pepper" },
      { role: "tool", content: "{\"error\":\"ask {{owner}} for the amount\"}" },
      { role: "user", content: "[Context from EverythingApp, not typed by {{owner}}]" },
    ], [{ function: { description: "Save a fact about {{owner}}" } }], () => {});
    assert.equal(sent!.messages[0].content, "You help Alex. Alex's dog Biscuit.");
    assert.equal(sent!.messages[1].content, "my friend Jordan called about Pepper", "the owner's own words stay as typed");
    assert.equal(sent!.messages[2].content, "{\"error\":\"ask Alex for the amount\"}", "the hub's words in a tool result name the owner");
    assert.equal(sent!.messages[3].content, "[Context from EverythingApp, not typed by Alex]");
    assert.match(JSON.stringify(sent!.tools), /about Alex/);
    assert.equal(personalize("{{owner}} wrote", "Robin"), "Robin wrote");
    assert.equal(personalize("Jordan wrote", "Alex"), "Jordan wrote", "a name in text is not where the owner's name goes");
    assert.equal(personalize("Log it for {{pet}}", "Jamie", ""), "Log it for the pet", "no pet set");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("profile: what the owner wrote, and mail, reach the model as written; only the hub's own words name the owner", async () => {
  const t = makeHub();
  try {
    t.hub.profile.set({ name: "Alex", pet: "Biscuit" });
    const sent: AiMessage[][] = [];
    setBackendOverride({ name: "ollama", model: "m", chat: async (m: AiMessage[]) => { sent.push(m); return { text: "{}", usage: {} }; }, stream: async () => ({ text: "", usage: {} }) } as Backend);
    await t.hub.ai.backgroundJson("mail:x", "You read {{owner}}'s mail.", "From: Jordan Lee\nPepper's vet bill");
    assert.equal(sent[0][0].content, "You read Alex's mail.");
    assert.equal(sent[0][1].content, "From: Jordan Lee\nPepper's vet bill", "the email is not rewritten");
    const { filingPrompt } = await import("../src/capture-filer.js");
    const p = filingPrompt("Lunch with Jordan tomorrow", new Date("2026-11-03T12:00:00"), undefined, ["Coffee with Jordan"], [], ["Writing"], { owner: "Alex", pet: "Biscuit" });
    assert.match(p, /Alex wrote this quick note to self/);
    assert.match(p, /"Lunch with Jordan tomorrow"/);
    assert.match(p, /Coffee with Jordan/);
    assert.match(p, /Alex's note folders: Writing/);
    assert.ok(!/Jordan's Reminders/.test(p) && /Alex's Reminders/.test(p));
  } finally { setBackendOverride(null); t.cleanup(); }
});
