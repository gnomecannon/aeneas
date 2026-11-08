import { test } from "node:test";
import assert from "node:assert/strict";
import { allowed } from "./check.mjs";

test("license expressions: OR needs one allowed side, AND needs both, unknown and missing fail", () => {
  for (const ok of ["MIT", "MIT OR Apache-2.0", "(MIT OR WTFPL)", "MIT/Apache-2.0", "Apache-2.0 / MIT", "(MIT OR Apache-2.0) AND Unicode-3.0", "Apache-2.0 WITH LLVM-exception", "MIT OR Apache-2.0 OR LGPL-2.1-or-later", "BSD-3-Clause AND MIT"]) assert.equal(allowed(ok), true, ok);
  for (const no of ["", undefined, "GPL-3.0-only", "WTFPL", "MIT AND GPL-2.0-only", "SEE LICENSE IN LICENSE", "UNLICENSED", "(MIT", "file:LICENSE"]) assert.equal(allowed(no), false, String(no));
});
