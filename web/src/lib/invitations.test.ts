import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Entity } from "@everythingapp/shared";
import { INVITE_TEXTS, inviteFace, inviteWhen, invitationList, invitationsNeed } from "./invitations";
import { isShown } from "./sources";
import { needsYou } from "./todayBoard";

// Invitations on the web, Windows and Android apps: the list's states (the cases EACore's InvitationsTests reads too),
// a row's words and buttons, Today's line, and declined events left out.

const here = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(fs.readFileSync(path.join(here, "../../../packages/shared/test/invitation-cases.json"), "utf8")) as {
  now: string; cases: { name: string; items: { id: string; deleted_at?: string; updated_at?: string; fields: Record<string, unknown> }[]; pending: string[]; answered: string[]; count: number }[];
};

const at = "2026-11-25T12:00:00.000Z";
const inv = (id: string, fields: Record<string, unknown>): Entity => ({
  id, kind: "invitation", space: "personal", created_at: at, updated_at: at, deleted_at: null, field_ts: {},
  fields: { title: "Dinner", uid: id, answer: "needs_action", answer_by: "mail", start: new Date(2026, 10, 27, 19).toISOString(), end: new Date(2026, 10, 27, 21).toISOString(), ...fields },
});

describe("invitations: the list", () => {
  for (const c of cases.cases) {
    it(c.name, () => {
      const out = invitationList(c.items, new Date(cases.now));
      expect(out.pending.map((e) => e.id)).toEqual(c.pending);
      expect(out.answered.map((e) => e.id)).toEqual(c.answered);
      expect(out.count).toBe(c.count);
    });
  }
});

describe("invitations: a row", () => {
  it("says when, in this device's words", () => {
    expect(inviteWhen(inv("a", {}).fields)).toMatch(/^Fri Nov 27, 7:00\s?PM to 9:00\s?PM$/);
    expect(inviteWhen(inv("b", { all_day: true, start: "2026-11-27T00:00:00.000Z", end: "2026-11-28T00:00:00.000Z" }).fields)).toBe("Fri Nov 27, all day");
    expect(inviteWhen(inv("c", { all_day: true, start: "2026-11-27T00:00:00.000Z", end: "2026-11-30T00:00:00.000Z" }).fields)).toBe("Fri Nov 27 to Sun Nov 29, all day");
    expect(inviteWhen(inv("d", { start: new Date(2026, 10, 27, 23).toISOString(), end: new Date(2026, 10, 28, 1).toISOString() }).fields)).toMatch(/^Fri Nov 27, 11:00\s?PM to Sat Nov 28, 1:00\s?AM$/);
  });
  it("offers Accept, Maybe and Decline with the answer chosen; Apple Calendar's only a line; a mail answer its Undo", () => {
    expect(inviteFace(inv("a", {}))).toEqual({ buttons: true, chosen: null, elsewhere: false, reply: null, locked: false });
    expect(inviteFace(inv("a", { answer: "tentative" })).chosen).toBe("tentative");
    expect(inviteFace(inv("a", { answer_by: "open_in_calendar" }))).toMatchObject({ buttons: false, elsewhere: true });
    const reply = (state: string, error?: string) => ({ outbox: "o", state, answer: "accepted", was: "needs_action", send_at: at, ...(error ? { error } : {}) });
    expect(inviteFace(inv("a", { answer: "accepted", organizer: { name: "Alex" }, reply: reply("waiting") }))).toMatchObject({ chosen: "accepted", locked: true, reply: { text: "Sending your answer to Alex.", undo: true, retry: false } });
    expect(inviteFace(inv("a", { answer: "accepted", reply: reply("failed", "The server could not be reached.") }))).toMatchObject({ locked: false, reply: { text: "Not sent: The server could not be reached.", undo: true, retry: true } });
    expect(inviteFace(inv("a", { answer: "accepted", reply: reply("sent") })).reply).toBeNull();
    expect(INVITE_TEXTS.none).toBe("No invitations need an answer.");
  });
});

describe("invitations: Today and Week", () => {
  it("Today's Needs you has one line for them, after the reminders", () => {
    const now = new Date(2026, 10, 25, 12);
    const rows = [inv("a", { organizer: { name: "Alex" } }), inv("b", { start: new Date(2026, 10, 29, 9).toISOString(), end: new Date(2026, 10, 29, 10).toISOString() })];
    const need = invitationsNeed(rows, now)!;
    expect(need).toEqual({ count: 2, title: "2 invitations", detail: "Dinner, Fri Nov 27, from Alex" });
    expect(invitationsNeed([inv("a", { answer: "accepted", answered_at: at })], now)).toBeNull();
    const out = needsYou({ reminders: [], watches: [], meds: [], unsorted: 1, now, invitations: need });
    expect(out.map((n) => n.kind)).toEqual(["invitations", "unsorted"]);
  });
  it("a declined event is left out, as Calendar hides it", () => {
    const ev = (fields: Record<string, unknown>): Entity => ({ id: "e", kind: "event", space: "personal", created_at: at, updated_at: at, deleted_at: null, field_ts: {}, fields: { title: "Standup", start: at, end: at, ...fields } });
    expect(isShown(ev({}))).toBe(true);
    expect(isShown(ev({ declined: true }))).toBe(false);
  });
});
