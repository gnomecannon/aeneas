import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeHub } from "./helpers.js";
import { browserAddresses, changeLink, readLinkFile } from "../src/link.js";
import { doorView, refusal, setTailscaleRunner } from "../src/tsdoor.js";

const STATUS = JSON.stringify({ BackendState: "Running", Self: { DNSName: "core.tail1234.ts.net." } });

/** A pretend `tailscale` command: what it was asked, and what it answers. */
function fakeTailscale(serve: (args: string[]) => string | Error = () => "") {
  const calls: string[][] = [];
  setTailscaleRunner(async (args) => {
    calls.push(args);
    if (args[0] === "status") return STATUS;
    const r = serve(args);
    if (r instanceof Error) throw r;
    return r;
  });
  return calls;
}

test("tailscale door: offered only to a Direct link hub on a computer that runs Tailscale", async () => {
  try {
    setTailscaleRunner(async () => { throw new Error("tailscale: command not found"); });
    assert.match((await doorView("direct", false, 8787)).how ?? "", /Tailscale is not running on this computer/);
    fakeTailscale();
    assert.deepEqual(await doorView("tailscale", false, 8787), { available: false, on: false, url: null, how: "Only for a hub on Direct link. A hub on Tailscale already answers browsers at its Tailscale address." });
    assert.deepEqual(await doorView("direct", false, 8787), { available: true, on: false, url: null });
    assert.deepEqual(await doorView("direct", true, 8787), { available: true, on: true, url: "https://core.tail1234.ts.net:8787" });
  } finally { setTailscaleRunner(null); }
});

test("tailscale door: switching it on serves the hub's port, says where browsers go, and another method closes it", async () => {
  const t = makeHub();
  fs.writeFileSync(path.join(t.dir, "link.json"), JSON.stringify({ method: "direct", home_route: false }));
  try {
    const calls = fakeTailscale();
    const port = t.hub.cfg.port;
    const on = await t.api("/setup/link", { method: "PUT", json: { tailscale_door: true } });
    assert.equal(on.status, 200);
    const view = (await on.json()) as { tailscale_door: { on: boolean; url: string }; browser: string[] };
    assert.deepEqual(calls.find((c) => c[0] === "serve"), ["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${port}`]);
    assert.equal(view.tailscale_door.on, true);
    assert.deepEqual(view.browser, [`https://core.tail1234.ts.net:${port}/app/`]);
    assert.equal(readLinkFile(t.dir).tailscale_door, true);
    // Home Wi-Fi only has no use for it: the door is closed with the change.
    t.hub.cfg.bindHost = "0.0.0.0";
    t.hub.cfg.tlsCert = path.join(t.dir, "cert.pem");
    calls.length = 0;
    assert.deepEqual(await changeLink(t.hub.cfg, { method: "home" }), { ok: true });
    assert.deepEqual(calls.find((c) => c[0] === "serve"), ["serve", `--https=${port}`, "off"]);
    assert.equal(readLinkFile(t.dir).tailscale_door, false);
  } finally { setTailscaleRunner(null); t.cleanup(); }
});

test("tailscale door: a refusal is a 409 that says what to do, and nothing is kept", async () => {
  const t = makeHub();
  fs.writeFileSync(path.join(t.dir, "link.json"), JSON.stringify({ method: "direct", home_route: false }));
  try {
    fakeTailscale(() => new Error("Access denied: serve config denied\nUse 'sudo tailscale serve' or set an operator"));
    const r = await t.api("/setup/link", { method: "PUT", json: { tailscale_door: true } });
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /Tailscale did not let the hub serve/);
    assert.equal(readLinkFile(t.dir).tailscale_door, undefined);
    assert.equal((await t.api("/setup/link", { method: "PUT", json: { tailscale_door: "yes" } })).status, 422);
    // Tailscale Serve not turned on for the tailnet: its own link is passed on.
    assert.match(refusal("Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc\n"), /Open https:\/\/login\.tailscale\.com\/f\/serve\?node=abc , turn it on/);
  } finally { setTailscaleRunner(null); t.cleanup(); }
});

test("browser addresses: each method lists where a web browser opens the web app", () => {
  const t = makeHub({ publicUrl: "https://core.tail1234.ts.net:8787" });
  try {
    const home = { on: true, announce: true, port: 9787, urls: ["https://192.168.1.20:9787"], fp: null };
    const shut = { available: true, on: false, url: null };
    assert.deepEqual(browserAddresses(t.hub.cfg, "direct", home, shut), ["https://192.168.1.20:9787/app/"]);
    assert.deepEqual(browserAddresses(t.hub.cfg, "direct", { ...home, on: false }, { available: true, on: true, url: "https://core.tail1234.ts.net:8787" }), ["https://core.tail1234.ts.net:8787/app/"]);
    assert.deepEqual(browserAddresses(t.hub.cfg, "tailscale", home, shut), ["https://core.tail1234.ts.net:8787/app/"]);
    assert.deepEqual(browserAddresses(t.hub.cfg, "home", { ...home, port: 8787, urls: ["https://192.168.1.20:8787"] }, shut), ["https://192.168.1.20:8787/app/"]);
  } finally { t.cleanup(); }
});
