import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";
import { snippetAround } from "../src/ai/sessions.js";

// Search finds assistant chats too: by what was said (yours and the assistant's), newest first, with the line that matched.

test("chat search: what was said in chats comes back with search results, tool output and deleted chats do not", async () => {
  const t = makeHub();
  try {
    const s = t.hub.ai.sessions;
    s.save("older", "general", [
      { role: "user", content: "What filter does the furnace take?", at: "2026-11-01T10:00:00.000Z" },
      { role: "assistant", content: "The furnace takes a 16x25x1 MERV 8 filter.", at: "2026-11-01T10:00:05.000Z" },
    ]);
    s.save("newer", "general", [{ role: "user", content: "Remind me to change the furnace filter in March", at: "2026-11-10T09:00:00.000Z" }]);
    s.save("gone", "general", [{ role: "user", content: "furnace noise again" }]);
    t.hub.chatDb.prepare("UPDATE sessions SET deleted_at = ? WHERE session_id = 'gone'").run("2026-11-11T00:00:00.000Z");
    // A tool result in the stored JSON is not what was said.
    t.hub.chatDb.prepare("UPDATE sessions SET messages = ? WHERE session_id = 'older'").run(JSON.stringify([
      { role: "user", content: "What filter does the furnace take?" },
      { role: "tool", content: "ssh output: zebra-unicorn-42" },
      { role: "assistant", content: "The furnace takes a 16x25x1 MERV 8 filter." },
    ]));
    t.hub.chatDb.prepare("UPDATE sessions SET last_at = ? WHERE session_id = 'newer'").run("2026-11-12T00:00:00.000Z");
    t.hub.chatDb.prepare("UPDATE sessions SET last_at = ? WHERE session_id = 'older'").run("2026-11-01T10:00:05.000Z");

    const res = await t.api("/search?q=FURNACE");
    assert.equal(res.status, 200);
    const body = await res.json() as { hits: unknown[]; chats: { session_id: string; title: string; snippet: string; role: string }[] };
    assert.deepEqual(body.chats.map((c) => c.session_id), ["newer", "older"], "newest first, the deleted one left out");
    assert.equal(body.chats[0].snippet, "Remind me to change the furnace filter in March");
    assert.equal(body.chats[1].role, "user");

    const tool = await (await t.api("/search?q=zebra-unicorn")).json() as { chats: unknown[] };
    assert.deepEqual(tool.chats, [], "command output in a tool result is not searched");
    const merv = await (await t.api("/search?q=merv%208")).json() as { chats: { role: string; snippet: string }[] };
    assert.deepEqual(merv.chats.map((c) => [c.role, c.snippet]), [["assistant", "The furnace takes a 16x25x1 MERV 8 filter."]]);
    // Asking for item kinds only leaves chats out.
    const kinds = await (await t.api("/search?q=furnace&kinds=task")).json() as { chats: unknown[] };
    assert.deepEqual(kinds.chats, []);
    // % and _ are plain characters.
    assert.deepEqual((await (await t.api("/search?q=100%25")).json() as { chats: unknown[] }).chats, []);
  } finally { t.cleanup(); }
});

test("chat search: the snippet is the part around the match, on one line", () => {
  const long = `${"a ".repeat(80)}the router password was changed\non Tuesday ${"b ".repeat(80)}`;
  const s = snippetAround(long, "router password");
  assert.ok(s.startsWith("...") && s.endsWith("..."));
  assert.ok(s.includes("the router password was changed on Tuesday"));
  assert.ok(s.length <= 185, `${s.length} characters`);
});
