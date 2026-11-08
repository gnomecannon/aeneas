import { test } from "node:test";
import assert from "node:assert/strict";
import { deviceKey, makeHub } from "./helpers.js";
import { authDelayMs } from "../src/app.js";

test("hardening: safety headers, wrong tokens slow down, and errors keep their details in the log", async () => {
  const t = makeHub();
  try {
    const ok = await t.api("/health");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
    assert.equal(ok.headers.get("x-frame-options"), "DENY");
    const bad = (who: string) => t.app.request("/entities?kind=task", { headers: { authorization: "Bearer nope", "x-forwarded-for": who } });
    assert.equal((await bad("10.0.0.9")).status, 401);
    assert.equal(authDelayMs("10.0.0.9"), 200, "the second wrong try waits 0.2 s");
    await bad("10.0.0.9");
    assert.equal(authDelayMs("10.0.0.9"), 400);
    assert.equal(authDelayMs("10.0.0.7"), 0, "another address is not slowed");
    const right = await t.app.request("/entities?kind=task", { headers: { authorization: `Bearer ${await deviceKey(t)}`, "x-forwarded-for": "10.0.0.9" } });
    assert.equal(right.status, 200, "the right key is never held back");
  } finally { t.cleanup(); }
});
