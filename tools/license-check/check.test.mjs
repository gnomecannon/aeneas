import { test } from "node:test";
import assert from "node:assert/strict";
import { allowed, swiftPinProblems } from "./check.mjs";

test("license expressions: OR needs one allowed side, AND needs both, unknown and missing fail", () => {
  for (const ok of ["MIT", "MIT OR Apache-2.0", "(MIT OR WTFPL)", "MIT/Apache-2.0", "Apache-2.0 / MIT", "(MIT OR Apache-2.0) AND Unicode-3.0", "Apache-2.0 WITH LLVM-exception", "MIT OR Apache-2.0 OR LGPL-2.1-or-later", "BSD-3-Clause AND MIT"]) assert.equal(allowed(ok), true, ok);
  for (const no of ["", undefined, "GPL-3.0-only", "WTFPL", "MIT AND GPL-2.0-only", "SEE LICENSE IN LICENSE", "UNLICENSED", "(MIT", "file:LICENSE"]) assert.equal(allowed(no), false, String(no));
});

test("data licenses on the list: root certificates (CDLA-Permissive-2.0)", () => {
  assert.equal(allowed("CDLA-Permissive-2.0"), true);
});

test("Swift pins: approved packages pass, any other remote package fails", () => {
  const pin = (location) => JSON.stringify({ pins: [{ identity: "x", location, state: { version: "1.0.0" } }] });
  assert.deepEqual(swiftPinProblems(pin("https://github.com/n0-computer/iroh-ffi"), "a/Package.resolved"), []);
  assert.deepEqual(swiftPinProblems(pin("https://github.com/n0-computer/iroh-ffi.git"), "a/Package.resolved"), []);
  assert.match(swiftPinProblems(pin("https://github.com/someone/other"), "a/Package.resolved")[0], /not an approved Swift package/);
  assert.deepEqual(swiftPinProblems(JSON.stringify({ pins: [] }), "a/Package.resolved"), []);
});
