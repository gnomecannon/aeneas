import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { withoutWork } from "../src/ai/tools.js";

test("a cloud OpenAI-compatible server is never in a chain that may not use the cloud", () => {
  const t = makeHub({ aiFake: false, ollamaUrl: "http://127.0.0.1:9", openaiUrl: "https://api.example.com/v1", openaiModel: "m", openaiKey: "sk-test-not-real-0000000000" });
  try {
    const names = (cloud: boolean) => t.hub.ai.route("general", cloud).map((b) => `${b.name}${b.cloud ? ":cloud" : ""}`);
    assert.ok(!names(false).some((n) => n.endsWith(":cloud")), `no cloud without consent: ${names(false)}`);
    assert.ok(names(true).includes("openai:cloud"));
    assert.ok(!t.hub.ai.route("classify", false).some((b) => b.cloud));
    assert.ok(!t.hub.ai.route("draft", false).some((b) => b.cloud));
    assert.equal(t.hub.ai.capabilities().cloud, true, "clients offer the cloud switch when any cloud model is set up");
  } finally { t.cleanup(); }
});

test("an OpenAI-compatible server on this network is not a cloud one and stays in every chain", () => {
  const t = makeHub({ aiFake: false, ollamaUrl: "", openaiUrl: "http://127.0.0.1:1234/v1", openaiModel: "m", openaiKey: "" });
  try {
    assert.ok(t.hub.ai.route("general", false).some((b) => b.name === "openai" && !b.cloud));
  } finally { t.cleanup(); }
});

test("work items are cut from tool results for a cloud model", () => {
  const out = withoutWork({ days: [{ date: "2026-11-04", events: [{ id: "a", title: "Dentist" }, { id: "b", title: "Standup", work: true }] }], items: [{ id: "c", space: "work" }, { id: "d" }] });
  assert.deepEqual(out, { days: [{ date: "2026-11-04", events: [{ id: "a", title: "Dentist" }] }], items: [{ id: "d" }] });
  assert.match(JSON.stringify(withoutWork({ item_id: "x", space: "work", title: "Secret plan" })), /never sent to a cloud model/);
});
