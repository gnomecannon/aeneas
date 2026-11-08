import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeHub } from "./helpers.js";
import { refuseToolCall } from "../src/ai/api-guard.js";

// Settings, People on this machine (hub/src/hubs.ts): the owner's hub asks deploy/people.sh's root service to add a
// person by dropping a request; the service writes progress and the result beside it.

function machine(owner: string | null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ea-people-"));
  fs.mkdirSync(path.join(root, "etc/aeneas"), { recursive: true });
  fs.mkdirSync(path.join(root, "var/lib/aeneas/requests"), { recursive: true });
  fs.mkdirSync(path.join(root, "var/lib/aeneas/results"), { recursive: true });
  if (owner !== null) fs.writeFileSync(path.join(root, "etc/aeneas/owner"), `${owner}\n`);
  fs.writeFileSync(path.join(root, "etc/aeneas/people.json"), JSON.stringify([
    { name: "Sam", user: os.userInfo().username, port: 1, color: "#2f8f83", owner: true, address: "https://hub.example.ts.net:8787" },
    { name: "Jamie", user: "aeneas-jamie", port: 2, color: "#c27c2c", owner: false, address: "https://hub.example.ts.net:8788" },
  ]));
  process.env.EA_PEOPLE_ROOT = root;
  return root;
}

test("people: a machine not set up says how; another account's hub is not offered it", async () => {
  const t = makeHub();
  try {
    process.env.EA_PEOPLE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ea-people-"));
    const none = await (await t.api("/hubs")).json() as any;
    assert.equal(none.available, false);
    assert.equal(none.reason, "not_set_up");
    assert.match(none.setup_command, /people\.sh setup/);
    assert.match(none.admin_note, /admin/);
    machine("someone-else");
    const other = await (await t.api("/hubs")).json() as any;
    assert.equal(other.reason, "not_owner");
    assert.deepEqual(other.hubs, []);
    assert.equal((await t.api("/hubs", { method: "POST", json: { name: "Alex" } })).status, 409);
  } finally { delete process.env.EA_PEOPLE_ROOT; t.cleanup(); }
});

test("people: the owner's hub lists the hubs and drops a checked request to add one", async () => {
  const t = makeHub();
  try {
    const root = machine(os.userInfo().username);
    const list = await (await t.api("/hubs")).json() as any;
    assert.equal(list.available, true);
    assert.deepEqual(list.hubs.map((h: any) => [h.name, h.account, h.owner, h.up]), [["Sam", os.userInfo().username, true, false], ["Jamie", "aeneas-jamie", false, false]]);

    assert.equal((await t.api("/hubs", { method: "POST", json: { name: "Robert'); rm -rf /" } })).status, 422);
    assert.equal((await t.api("/hubs", { method: "POST", json: { name: "jamie" } })).status, 409);
    assert.equal((await t.api("/hubs", { method: "POST", json: { name: "Alex", color: "red" } })).status, 422);

    const res = await t.api("/hubs", { method: "POST", json: { name: "Alex  Kim" } });
    assert.equal(res.status, 202);
    const { request_id } = await res.json() as any;
    const reqDir = path.join(root, "var/lib/aeneas/requests");
    const files = fs.readdirSync(reqDir);
    assert.deepEqual(files, [`${request_id}.json`]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(reqDir, files[0]), "utf8")), { id: request_id, op: "add", name: "Alex Kim", color: "" });
    assert.deepEqual(await (await t.api(`/hubs/requests/${request_id}`)).json(), { state: "queued" });

    // The root service takes it and reports back.
    fs.rmSync(path.join(reqDir, files[0]));
    fs.writeFileSync(path.join(root, "var/lib/aeneas/results", `${request_id}.json`), JSON.stringify({ state: "done", name: "Alex Kim", address: "https://hub.example.ts.net:8789", pairing: { code: "ABCD-EFGH" } }));
    const done = await (await t.api(`/hubs/requests/${request_id}`)).json() as any;
    assert.equal(done.state, "done");
    assert.equal(done.pairing.code, "ABCD-EFGH");
    assert.equal((await t.api("/hubs/requests/../../etc")).status, 404);

    // A new code for, or stopping, someone named by account; never the owner's own hub.
    assert.equal((await t.api("/hubs/aeneas-jamie/pair", { method: "POST" })).status, 202);
    assert.equal((await t.api("/hubs/aeneas-nobody/stop", { method: "POST" })).status, 404);
    assert.equal((await t.api(`/hubs/${os.userInfo().username}/stop`, { method: "POST" })).status, 404);
    const ops = fs.readdirSync(reqDir).map((f) => JSON.parse(fs.readFileSync(path.join(reqDir, f), "utf8")).op);
    assert.deepEqual(ops, ["pair"]);
  } finally { delete process.env.EA_PEOPLE_ROOT; t.cleanup(); }
});

test("people: the assistant's tools cannot read or change other people's hubs", () => {
  assert.notEqual(refuseToolCall("GET", "/hubs"), null);
  assert.notEqual(refuseToolCall("GET", "/hubs/requests/abc12345"), null);
  assert.notEqual(refuseToolCall("POST", "/hubs"), null);
});
