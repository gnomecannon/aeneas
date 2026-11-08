import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub } from "./helpers.js";

// Each case was found by the 2026-11-05 audit of what the clients read against what the hub sends.

test("shapes: a stored chat's waiting command carries its risk and pre-flight lines", async () => {
  const t = makeHub();
  try {
    fs.writeFileSync(path.join(t.dir, "hosts.json"), JSON.stringify([{ name: "core", local: true }]));
    t.hub.cfg.hostsFile = path.join(t.dir, "hosts.json");
    t.hub.ai.sessions.save("s1", "troubleshoot", [{ role: "user", content: "clear the old logs on core" }]);
    const host = t.hub.ai.hosts.host("core")!;
    t.hub.ai.hosts.propose("s1", host, "rm -rf /var/log/old", "clear the old logs", null);
    const s = (await (await t.api("/ai/sessions/s1")).json()) as { pending_action: { risk: string; preflight?: { backup: string; verify: string; rollback: string } } };
    assert.equal(s.pending_action.risk, "high");
    assert.ok(s.pending_action.preflight?.backup && s.pending_action.preflight.rollback, "the card lost its back up and rollback lines");
  } finally { t.cleanup(); }
});

test("shapes: today sends preference and info rules, and the week sends info rules with the preferences", async () => {
  const t = makeHub();
  try {
    const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    t.hub.store.create("plan_rule", { title: "Focus", type: "preference", days, start: "09:00", end: "11:00" });
    t.hub.store.create("plan_rule", { title: "Pepper week", type: "info", days, start: "00:00", end: "24:00" });
    t.hub.store.create("plan_rule", { title: "Gym", type: "commitment", days, start: "18:00", end: "19:00" });
    const today = (await (await t.api("/planner/today")).json()) as { commitments: { title: string }[]; preferences: { title: string; type: string }[] };
    assert.deepEqual(today.commitments.map((c) => c.title), ["Gym"]);
    assert.deepEqual(today.preferences.map((c) => c.title).sort(), ["Focus", "Pepper week"]);
    const week = (await (await t.api("/planner/week")).json()) as { days: { preferences: { type: string }[] }[] };
    assert.ok(week.days.every((d) => d.preferences.some((p) => p.type === "info")));
  } finally { t.cleanup(); }
});

test("shapes: a project's part rows say which inventory item they match", async () => {
  const t = makeHub();
  try {
    const inv = t.hub.store.create("inventory", { name: "ESP32 board", category: "component", qty: 2 });
    const p = t.hub.store.create("project", { name: "Fan controller", status: "active", definition_of_done: "quiet", parts: [{ name: "ESP32 board", qty: 1, inventory_id: inv.id }, { name: "Noctua fan", qty: 2 }] });
    const sum = (await (await t.api(`/projects/${p.id}/summary`)).json()) as { parts: { name: string; inventory_id?: string }[] };
    const esp = sum.parts.find((x) => x.name === "ESP32 board");
    assert.equal(esp?.inventory_id, inv.id);
    assert.equal(sum.parts.find((x) => x.name === "Noctua fan")?.inventory_id, undefined);
  } finally { t.cleanup(); }
});
