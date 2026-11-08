import { test } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { installTailscaleLookup } from "../src/tsdns.ts";

test("tailscale lookup fallback leaves ordinary names alone and stays idempotent", async () => {
  installTailscaleLookup("127.0.0.1");
  installTailscaleLookup("127.0.0.1");
  const addr = await new Promise<string>((resolve, reject) => dns.lookup("localhost", { family: 4 }, (e, a) => (e ? reject(e) : resolve(String(a)))));
  assert.equal(addr, "127.0.0.1");
  const err = await new Promise<NodeJS.ErrnoException | null>((resolve) => dns.lookup("no-such-host.invalid", (e) => resolve(e)));
  assert.ok(err && (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN"));
});
