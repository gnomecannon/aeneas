import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { feedStdin } from "../src/child.js";

/** A child's input pipe whose reader has gone: every write fails with EPIPE, as when the child exits first. */
function closedPipe(): Writable {
  return new Writable({ write(_chunk, _enc, cb) { cb(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })); } });
}

test("a child that exits before reading its input does not stop the hub (EPIPE, the 2026-11-03 vault test failure)", async () => {
  // Without a listener the pipe's error is thrown out of the event loop: that stopped the test, and would stop the hub.
  const bare = closedPipe();
  const seen = await new Promise<string>((resolve) => { bare.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "")); bare.end("password"); });
  assert.equal(seen, "EPIPE");
  // feedStdin listens, so the same failed write is just ignored (the child's exit code says what happened).
  let uncaught: unknown = null;
  const onUncaught = (e: unknown) => { uncaught = e; };
  process.once("uncaughtException", onUncaught);
  feedStdin({ stdin: closedPipe() } as unknown as ChildProcess, "password");
  await new Promise((r) => setTimeout(r, 20));
  process.removeListener("uncaughtException", onUncaught);
  assert.equal(uncaught, null);
  feedStdin({ stdin: null } as unknown as ChildProcess, "x");
});
