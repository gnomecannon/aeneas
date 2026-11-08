import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { recordReading } from "../src/sensors.js";

test("tapping a sensor alert starts one chat where the assistant proposes a fix to approve", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("sensor", { name: "core.mnt_b.used_pct", unit: "%", location: "core", max: 90, alert: true });
    recordReading(t.hub, "core.mnt_b.used_pct", { value: 85 });
    assert.equal((await t.api("/sensors/core.mnt_b.used_pct/propose", { method: "POST" })).status, 409, "nothing to fix while it is ok");
    recordReading(t.hub, "core.mnt_b.used_pct", { value: 97 });
    const res = await t.api("/sensors/core.mnt_b.used_pct/propose", { method: "POST" });
    assert.equal(res.status, 200);
    const { session_id, started } = (await res.json()) as { session_id: string; started: boolean };
    assert.equal(started, true);
    assert.match(session_id, /^alert-[0-9a-f]{8}-high-\d{8}$/);
    // The chat exists at once, so the client can open it while the assistant works.
    const s = (await (await t.api(`/ai/sessions/${session_id}`)).json()) as { title: string };
    assert.equal(s.title, "Alert: core.mnt_b.used_pct high");
    for (let i = 0; i < 100 && t.hub.ai.working.has(session_id); i++) await new Promise((r) => setTimeout(r, 20));
    const done = t.hub.ai.sessions.get(session_id)!;
    assert.match(done.messages[0].content, /^core\.mnt_b\.used_pct on core is high: 97 % \(it alerts above 90\)\. Find the cause and propose a fix for me to approve\.$/);
    assert.equal(done.messages.at(-1)!.role, "assistant");
    // Tapping again the same day opens the same chat.
    const again = (await (await t.api("/sensors/core.mnt_b.used_pct/propose", { method: "POST" })).json()) as { session_id: string; started: boolean };
    assert.deepEqual(again, { session_id, started: false });
    assert.equal((await t.api("/sensors/nope/propose", { method: "POST" })).status, 404);
  } finally { t.cleanup(); }
});
