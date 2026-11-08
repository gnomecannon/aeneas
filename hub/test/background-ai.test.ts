import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHub } from "./helpers.js";

test("background AI waits to be asked: notes are tagged and mail is read only on request, and the quiz is made when opened", async () => {
  const t = makeHub();
  try {
    assert.equal(t.hub.cfg.backgroundAi, "ask", "the default keeps the GPU free for games on the same machine");
    t.hub.store.create("note", { title: "Robot choir", body: "Vacuums keep joining.", tags: [], path: "Inbox/Robot choir.md" });
    let link = (await (await t.api("/notes/link")).json()) as { waiting: number; running: boolean };
    assert.deepEqual(link, { waiting: 1, running: false });
    link = (await (await t.api("/notes/link", { method: "POST" })).json()) as typeof link;
    assert.deepEqual(link, { waiting: 1, running: true });
    const conns = (await (await t.api("/connections")).json()) as { google: { reading: boolean } };
    assert.equal(conns.google.reading, false, "mail waits until Read now");
    const quiz = await t.api("/quiz/build", { method: "POST" });
    assert.equal(quiz.status, 200, "no chats today: nothing to make, and no error");
  } finally { t.cleanup(); }
  const auto = makeHub({ backgroundAi: "auto" });
  try {
    assert.equal(((await (await auto.api("/notes/link")).json()) as { running: boolean }).running, true, "on a machine nobody plays on it runs by itself");
  } finally { auto.cleanup(); }
});
