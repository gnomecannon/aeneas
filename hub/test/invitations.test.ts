import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { Entity } from "@everythingapp/shared";
import { makeHub, type TestHub } from "./helpers.js";
import { setDavFetch } from "../src/imports/caldav.js";
import { syncCalendarsNow } from "../src/calendar-sync.js";
import { fold, readInvite, replyIcs, withPartstat } from "../src/ical-invite.js";
import { icloudInviteId, mailInviteId } from "../src/invitations-take.js";
import { sweepInvitations } from "../src/invitations.js";
import { ago, EMAIL, fake, linked, PASSWORD, type Msg } from "./fake-icloud-mail.js";
import { smtp, type Fake } from "./fake-smtp.js";
import { setImapFactory, setMailLookup } from "../src/imports/icloud.js";
import { setSmtpTest } from "../src/imports/smtp.js";
import { setSendDelay } from "../src/mail-outbox.js";
import { refreshMail } from "../src/mail-inbox.js";
import { refuseToolCall } from "../src/ai/api-guard.js";
import { TOOLS, type ToolContext } from "../src/ai/tools.js";

// Invitations (CONTRACT.md section 3): reading and writing iCalendar invitations, answering in an iCloud calendar (a
// fake CalDAV server in memory), answering by mail (a fake IMAP mailbox and a local SMTP server), one per UID, and the
// assistant's yes. Every address is made up; nothing leaves this machine.

const CRLF = "\r\n";
const day = (offset: number) => { const d = new Date(Date.now() + offset * 86_400_000); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`; };
const dash = (ymd: string) => ymd.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
const NY = ["BEGIN:VTIMEZONE", "TZID:America/New_York", "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0500", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "DTSTART:20070311T020000", "TZNAME:EDT", "TZOFFSETTO:-0400", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:-0400", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "DTSTART:20071104T020000", "TZNAME:EST", "TZOFFSETTO:-0500", "END:STANDARD", "END:VTIMEZONE"];

/** An invitation as a calendar app writes one: METHOD, a time zone, the organizer, the owner and one more attendee. */
function request(o: { method?: string; uid?: string; seq?: number; stamp?: string; me?: string; partstat?: string; when?: string; summary?: string; extra?: string[]; noMethod?: boolean } = {}): string {
  const when = o.when ?? day(9);
  return [
    "BEGIN:VCALENDAR", "PRODID:-//Example Corp//Calendar 1.0//EN", "VERSION:2.0", "CALSCALE:GREGORIAN", ...(o.noMethod ? [] : [`METHOD:${o.method ?? "REQUEST"}`]), ...NY,
    "BEGIN:VEVENT",
    `DTSTART;TZID=America/New_York:${when}T190000`,
    `DTEND;TZID=America/New_York:${when}T210000`,
    `DTSTAMP:${o.stamp ?? "20261120T120000Z"}`,
    "ORGANIZER;CN=Alex:mailto:alex@example.com",
    `UID:${o.uid ?? "dinner-1@example.com"}`,
    // Folded, as servers write long lines: the owner's line runs past 75 octets.
    fold(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=${o.partstat ?? "NEEDS-ACTION"};RSVP=TRUE;CN="Robin Example, at home";X-NUM-GUESTS=0:mailto:${o.me ?? EMAIL}`),
    "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Alex:mailto:alex@example.com",
    `SEQUENCE:${o.seq ?? 0}`,
    `SUMMARY:${o.summary ?? "Dinner at Luigi's"}`,
    "LOCATION:Luigi's\\, Main Street",
    "DESCRIPTION:Bring the wine.",
    ...(o.extra ?? []),
    "STATUS:CONFIRMED",
    "BEGIN:VALARM", "TRIGGER:-PT30M", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR", "",
  ].join(CRLF);
}

// ---------------------------------------------------------------------------------------------------------------------
// iCalendar

test("iCalendar: an invitation is read with its time zone, folded lines, SEQUENCE and the owner's answer", () => {
  const inv = readInvite(request({ seq: 3 }))!;
  assert.equal(inv.method, "REQUEST");
  assert.equal(inv.uid, "dinner-1@example.com");
  assert.equal(inv.sequence, 3);
  assert.equal(inv.stamp, "2026-11-20T12:00:00.000Z");
  assert.deepEqual(inv.organizer, { address: "alex@example.com", name: "Alex" });
  const me = inv.attendees.find((a) => a.address === EMAIL)!;
  assert.deepEqual([me.partstat, me.rsvp, me.name], ["NEEDS-ACTION", true, "Robin Example, at home"], "the folded line is read whole");
  assert.equal(inv.times.title, "Dinner at Luigi's");
  assert.equal(inv.times.location, "Luigi's, Main Street");
  // 7 PM in New York, in December: UTC-5.
  assert.equal(inv.times.start, new Date(`${dash(day(9))}T19:00:00-05:00`).toISOString());
  assert.equal(inv.times.all_day, false);
  const allDay = readInvite(request().replace(/DTSTART;TZID=America\/New_York:(\d{8})T190000/, "DTSTART;VALUE=DATE:$1").replace(/DTEND;TZID=America\/New_York:(\d{8})T210000\r\n/, ""))!;
  assert.deepEqual([allDay.times.all_day, allDay.times.start.slice(10), allDay.times.end.slice(10)], [true, "T00:00:00.000Z", "T00:00:00.000Z"]);
  assert.equal(Date.parse(allDay.times.end) - Date.parse(allDay.times.start), 86_400_000, "an all-day event without an end is one day");
  // A repeating one: the next occurrence that has not ended.
  const weekly = readInvite(request({ when: day(-20), extra: ["RRULE:FREQ=WEEKLY;COUNT=10"] }))!;
  assert.equal(weekly.repeats, true);
  assert.ok(Date.parse(weekly.times.end) > Date.now() && Date.parse(weekly.times.start) < Date.now() + 8 * 86_400_000);
  assert.equal(readInvite(request({ method: "CANCEL" }))!.method, "CANCEL");
  assert.equal(readInvite("not a calendar"), null);
  assert.equal(readInvite("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"), null);
});

test("iCalendar: the owner's answer changes their ATTENDEE line and nothing else, byte for byte", () => {
  const ics = request({ me: "alias@me.example", extra: ["X-APPLE-NEEDS-REPLY:TRUE"] });
  const owner = new Set(["you@icloud.example", "alias@me.example"]);
  const out = withPartstat(ics, owner, "ACCEPTED")!;
  const before = ics.split(CRLF);
  const after = out.split(CRLF);
  const removed = before.filter((l) => !after.includes(l));
  const added = after.filter((l) => !before.includes(l));
  // The owner's folded line (two physical lines) and iCloud's mark went; one ATTENDEE line, folded again, came.
  assert.ok(removed.some((l) => l.startsWith("ATTENDEE;") && l.includes("NEEDS-ACTION")));
  assert.ok(removed.includes("X-APPLE-NEEDS-REPLY:TRUE"));
  const unfolded = out.replace(/\r\n[ \t]/g, "");
  assert.match(unfolded, /ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN="Robin Example, at home";X-NUM-GUESTS=0:mailto:alias@me\.example\r\n/);
  assert.doesNotMatch(unfolded, /RSVP=TRUE;CN="Robin/);
  for (const l of added) assert.ok(Buffer.byteLength(l) <= 75, `folded at 75 octets: ${l}`);
  // Everything else is as it was, in order: the other attendee, SEQUENCE, the alarm, the time zone.
  const keep = (lines: string[]) => lines.filter((l) => !/^(ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=(NEEDS-ACTION|ACCEPTED;CN=")|X-APPLE-NEEDS-REPLY| )/.test(l));
  assert.deepEqual(keep(after), keep(before));
  assert.ok(out.includes("SEQUENCE:0\r\n"), "only the organizer raises SEQUENCE");
  assert.ok(out.endsWith("END:VCALENDAR\r\n"));
  // LF-only text keeps its line ends; no attendee of the owner's: nothing to change.
  const lf = withPartstat(ics.replace(/\r\n/g, "\n"), owner, "DECLINED")!;
  assert.ok(!lf.includes("\r\n") && lf.includes("PARTSTAT=DECLINED"));
  assert.equal(withPartstat(ics, new Set(["someone@else.example"]), "ACCEPTED"), null);
  // An attendee named by another address, with the owner's in EMAIL=, is the owner too.
  const byEmail = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:e-1", "DTSTART:20261201T100000Z", "ATTENDEE;EMAIL=alias@me.example;PARTSTAT=NEEDS-ACTION:urn:uuid:0000", "END:VEVENT", "END:VCALENDAR", ""].join(CRLF);
  assert.ok(withPartstat(byEmail, owner, "TENTATIVE")!.includes("\r\nATTENDEE;EMAIL=alias@me.example;PARTSTAT=TENTATIVE:urn:uuid:0000\r\n"));
});

test("iCalendar: the REPLY holds the request's UID, SEQUENCE, times and organizer, and the one attendee's answer", () => {
  const out = replyIcs(request({ seq: 2 }), EMAIL, "TENTATIVE", new Date("2026-11-25T12:00:00Z"))!;
  const lines = out.split(CRLF);
  for (const l of lines) assert.ok(Buffer.byteLength(l) <= 75, `folded: ${l}`);
  const u = out.replace(/\r\n[ \t]/g, "");
  for (const want of ["METHOD:REPLY", "UID:dinner-1@example.com", "SEQUENCE:2", "DTSTAMP:20261125T120000Z", "ORGANIZER;CN=Alex:mailto:alex@example.com",
    `DTSTART;TZID=America/New_York:${day(9)}T190000`, "SUMMARY:Dinner at Luigi's", "TZID:America/New_York"]) assert.ok(u.split(CRLF).includes(want), want);
  const attendees = u.split(CRLF).filter((l) => l.startsWith("ATTENDEE"));
  assert.deepEqual(attendees, [`ATTENDEE;PARTSTAT=TENTATIVE;CN="Robin Example, at home":mailto:${EMAIL}`], "one attendee, the owner, with the CN the request gave");
  assert.ok(!/DESCRIPTION|VALARM|alex@example\.com.*PARTSTAT/.test(u.replace("ORGANIZER;CN=Alex:mailto:alex@example.com", "")), "nothing else of the request");
  assert.equal(replyIcs(request(), "other@example.com", "ACCEPTED"), null, "never an answer for someone not invited");
  assert.ok(readInvite(out), "the reply reads as iCalendar");
});

// ---------------------------------------------------------------------------------------------------------------------
// iCloud

const DAV_PASS = "abcd-efgh-ijkl-mnop";
const HOME = "https://p42-caldav.icloud.com/1234/calendars/";
const CAL = `${HOME}home/`;

/** iCloud's calendar server in memory: discovery (with the account's addresses), calendar-query, GET and PUT with etags. */
function fakeICloud() {
  const objects = new Map<string, { data: string; etag: string }>();
  let n = 0;
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  const state = { conflictOnce: false };
  const put = (url: string, data: string) => { const etag = `"e${++n}"`; objects.set(url, { data, etag }); return etag; };
  const xml = (body: string) => new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">${body}</d:multistatus>`, { status: 207 });
  const ok = (href: string, props: string) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  setDavFetch(async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const method = String(init.method);
    calls.push({ method, url, headers });
    if (headers.authorization !== `Basic ${Buffer.from(`you@icloud.example:${DAV_PASS}`).toString("base64")}`) return new Response("", { status: 401 });
    const body = String(init.body ?? "");
    if (method === "PROPFIND" && url === "https://caldav.icloud.com/") return xml(ok("/", "<d:current-user-principal><d:href>/1234/principal/</d:href></d:current-user-principal>"));
    if (method === "PROPFIND" && url === "https://caldav.icloud.com/1234/principal/") {
      return xml(ok("/1234/principal/", `<c:calendar-home-set><d:href>${HOME}</d:href></c:calendar-home-set><c:calendar-user-address-set><d:href>mailto:alias@me.example</d:href><d:href>/1234/principal/</d:href><d:href>mailto:you@icloud.example</d:href></c:calendar-user-address-set>`));
    }
    if (method === "PROPFIND" && url === HOME) {
      return xml(ok(HOME, "<d:resourcetype><d:collection/></d:resourcetype>") + ok("/1234/calendars/home/", `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Home</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>`));
    }
    if (method === "REPORT") {
      const list = [...objects.entries()].filter(([u]) => u.startsWith(url));
      return xml(list.map(([u, o]) => ok(new URL(u).pathname, `<d:getetag>${o.etag}</d:getetag><c:calendar-data>${esc(o.data)}</c:calendar-data>`)).join(""));
    }
    if (method === "GET") { const o = objects.get(url); return o ? new Response(o.data, { status: 200, headers: { etag: o.etag } }) : new Response("", { status: 404 }); }
    if (method === "PUT") {
      const o = objects.get(url);
      if (headers["if-match"] && (!o || o.etag !== headers["if-match"])) return new Response("", { status: 412 });
      if (headers["if-none-match"] === "*" && o) return new Response("", { status: 412 });
      if (state.conflictOnce && o) {
        // Someone changed the event between the hub's read and its write.
        state.conflictOnce = false;
        put(url, o.data.replace("DESCRIPTION:Bring the wine.", "DESCRIPTION:Bring the wine and bread."));
        return new Response("", { status: 412 });
      }
      return new Response(null, { status: o ? 204 : 201, headers: { etag: put(url, body) } });
    }
    return new Response("", { status: 405 });
  });
  return { objects, calls, put, state };
}

async function linkCalendar(t: TestHub) {
  const link = await t.api("/calendars/icloud", { method: "PUT", json: { email: "you@icloud.example", password: DAV_PASS } });
  assert.equal(link.status, 200, await link.clone().text());
  assert.equal((await t.api("/calendars/icloud/you%40icloud.example", { method: "PUT", json: { chosen: [CAL], target: null } })).status, 200);
}
const invitation = (t: TestHub, id: string) => t.hub.store.get(id) as Entity;
const answer = (t: TestHub, id: string, a: string) => t.api(`/invitations/${id}/answer`, { method: "POST", json: { answer: a } });

test("iCloud: an invitation in a synced calendar is listed; Accept changes only the owner's line, with If-Match, and the sync leaves it be", async () => {
  const t = makeHub();
  const s = fakeICloud();
  try {
    await linkCalendar(t);
    const url = `${CAL}dinner.ics`;
    // iCloud names the owner by an address of its own (calendar-user-address-set), not the account's.
    const original = request({ noMethod: true, me: "alias@me.example", extra: ["X-APPLE-NEEDS-REPLY:TRUE"] });
    s.put(url, original);
    s.put(`${CAL}mine.ics`, request({ noMethod: true, uid: "mine-1", me: "alias@me.example" }).replace("ORGANIZER;CN=Alex:mailto:alex@example.com", "ORGANIZER;CN=Me:mailto:you@icloud.example"));
    s.put(`${CAL}answered.ics`, request({ noMethod: true, uid: "answered-1", me: "alias@me.example", partstat: "ACCEPTED" }));
    const r1 = (await syncCalendarsNow(t.hub))[0];
    assert.equal(r1.error, undefined);
    const id = icloudInviteId("you@icloud.example", "dinner-1@example.com");
    const inv = invitation(t, id);
    assert.equal(inv.fields.answer, "needs_action");
    assert.equal(inv.fields.answer_by, "caldav");
    assert.deepEqual(inv.fields.from, { kind: "icloud", account: "you@icloud.example", calendar: CAL, href: url });
    assert.deepEqual(inv.fields.organizer, { name: "Alex", address: "alex@example.com" });
    const ev = t.hub.store.list({ kind: "event" }).find((e) => (e.fields.caldav as { uid?: string } | undefined)?.uid === "dinner-1@example.com")!;
    assert.equal(inv.fields.event_id, ev.id, "the event the sync keeps in step");
    assert.equal(t.hub.store.list({ kind: "invitation" }).length, 1, "not one the owner organizes, nor one answered before Aeneas saw it");
    const list = (await (await t.api("/invitations")).json()) as { pending: Entity[]; answered: Entity[] };
    assert.deepEqual(list.pending.map((e) => e.id), [id]);

    const etag = s.objects.get(url)!.etag;
    const puts = () => s.calls.filter((c) => c.method === "PUT").length;
    const before = puts();
    const r = await answer(t, id, "accepted");
    assert.equal(r.status, 200, await r.clone().text());
    const put = s.calls.filter((c) => c.method === "PUT").at(-1)!;
    assert.equal(put.headers["if-match"], etag, "written only over the version read");
    const now = s.objects.get(url)!.data;
    const was = original.split(CRLF);
    const is = now.split(CRLF);
    const removed = was.filter((l) => !is.includes(l));
    const added = is.filter((l) => !was.includes(l));
    assert.ok(removed.length >= 2 && removed.every((l) => l.startsWith("ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION") || l.startsWith(" ") || l === "X-APPLE-NEEDS-REPLY:TRUE"), `only the owner's line and iCloud's mark went: ${removed.join(" | ")}`);
    assert.ok(added.every((l) => l.startsWith("ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED") || l.startsWith(" ")), `only the owner's line came: ${added.join(" | ")}`);
    assert.ok(!now.includes("X-APPLE-NEEDS-REPLY"));
    assert.match(now.replace(/\r\n[ \t]/g, ""), /PARTSTAT=ACCEPTED;CN="Robin Example, at home";X-NUM-GUESTS=0:mailto:alias@me\.example/);
    assert.ok(now.includes("SEQUENCE:0\r\n") && now.includes("DESCRIPTION:Bring the wine.") && now.includes("TRIGGER:-PT30M"));
    assert.equal(invitation(t, id).fields.answer, "accepted");
    assert.ok(invitation(t, id).fields.answered_at);

    // The next sync takes the answered event as it is: nothing written again, the answer not undone.
    await syncCalendarsNow(t.hub);
    assert.equal(puts(), before + 1, "the sync writes nothing back");
    assert.equal(invitation(t, id).fields.answer, "accepted");
    const listed = (await (await t.api("/invitations")).json()) as { pending: Entity[]; answered: Entity[] };
    assert.deepEqual([listed.pending.length, listed.answered.map((e) => e.id)], [0, [id]], "listed under Answered");

    // Decline keeps the event, marked declined, as Calendar does; the planner leaves it out.
    s.state.conflictOnce = true;
    assert.equal((await answer(t, id, "declined")).status, 200, "read and changed once more when the event changed in between");
    assert.match(s.objects.get(url)!.data, /DESCRIPTION:Bring the wine and bread\./, "the other change is kept");
    assert.match(s.objects.get(url)!.data.replace(/\r\n[ \t]/g, ""), /PARTSTAT=DECLINED/);
    assert.equal(t.hub.store.get(ev.id)!.fields.declined, true);
    assert.ok(!t.hub.store.get(ev.id)!.deleted_at);
    await syncCalendarsNow(t.hub);
    assert.equal(t.hub.store.get(ev.id)!.fields.declined, true, "the sync reads the same answer back");
    const week = (await (await t.api(`/planner/week?start=${dash(day(9))}`)).json()) as { days: { events: Entity[] }[] };
    assert.ok(!week.days.flatMap((d) => d.events).some((e) => e.id === ev.id), "a declined event takes no time");

    // Answered in Calendar on another device: the next sync says so. Cancelled by the organizer: it leaves the list.
    s.put(`${CAL}lunch.ics`, request({ noMethod: true, uid: "lunch-1", me: "alias@me.example" }));
    await syncCalendarsNow(t.hub);
    const lunch = icloudInviteId("you@icloud.example", "lunch-1");
    assert.equal(invitation(t, lunch).fields.answer, "needs_action");
    s.put(`${CAL}lunch.ics`, request({ noMethod: true, uid: "lunch-1", me: "alias@me.example", partstat: "TENTATIVE" }));
    await syncCalendarsNow(t.hub);
    assert.equal(invitation(t, lunch).fields.answer, "tentative");
    s.put(`${CAL}lunch.ics`, request({ noMethod: true, uid: "lunch-1", me: "alias@me.example" }).replace("STATUS:CONFIRMED", "STATUS:CANCELLED"));
    await syncCalendarsNow(t.hub);
    assert.ok(invitation(t, lunch).deleted_at, "cancelled: gone");
    // Gone from iCloud before it was answered: the answer says so and sends nothing.
    s.put(`${CAL}gone.ics`, request({ noMethod: true, uid: "gone-1", me: "alias@me.example" }));
    await syncCalendarsNow(t.hub);
    s.objects.delete(`${CAL}gone.ics`);
    const gone = await answer(t, icloudInviteId("you@icloud.example", "gone-1"), "accepted");
    assert.equal(gone.status, 409);
    assert.match(((await gone.json()) as { error: string }).error, /no longer in your calendar, so nothing was sent/);
    assert.equal((await answer(t, id, "maybe")).status, 422, "Maybe is tentative");
  } finally { setDavFetch(null); t.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// Mail

const ALEX = { name: "Alex", address: "alex@example.com" };
const headersOf = (raw: string) => raw.split("\r\n\r\n")[0].replace(/\r\n(?=[ \t])/g, "").split("\r\n");

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ok()) return; await new Promise((r) => setTimeout(r, 25)); }
  assert.fail(`timed out waiting for: ${what}`);
}

/** Robin's iCloud mailbox, with Alex's invitation in it, refreshed; a sending server on this machine. */
async function mailbox(t: TestHub, more: Msg[] = [], delay = 20): Promise<{ msgs: Msg[]; server: Fake; id: string }> {
  linked(t);
  t.hub.profile.set({ name: "Robin" });
  setSendDelay(delay);
  const msgs: Msg[] = [{ uid: 1, folder: "INBOX", at: ago(1), subject: "Invitation: Dinner at Luigi's", from: ALEX, messageId: "inv1@example.com", plain: "Alex invited you.", calendar: request() }, ...more];
  fake(msgs);
  const server = await smtp({ secure: false, user: EMAIL, pass: PASSWORD });
  await t.api("/mail/refresh", { method: "POST" });
  return { msgs, server, id: mailInviteId(EMAIL, "dinner-1@example.com") };
}
async function finish(t: TestHub, server?: Fake) {
  await refreshMail(t.hub).catch(() => undefined);
  t.hub.close();
  setImapFactory(null);
  setSmtpTest(null);
  setSendDelay(null);
  setMailLookup(null);
  await server?.close();
  fs.rmSync(t.dir, { recursive: true, force: true });
}
const parts = (raw: string) => {
  const boundary = /boundary="([^"]+)"/.exec(raw)![1];
  return raw.split(`--${boundary}`).slice(1, -1).map((p) => {
    const [h, ...b] = p.replace(/^\r\n/, "").split("\r\n\r\n");
    return { headers: h, body: Buffer.from(b.join("\r\n\r\n").replace(/\r\n/g, ""), "base64").toString("utf8") };
  });
};

test("mail: an invitation to the mailbox is listed; Accept sends the standard REPLY through the outbox and puts the event on the calendar", async () => {
  const t = makeHub();
  const { server, id } = await mailbox(t, [
    // Not invitations to answer: one to another address, a REPLY, and the owner's own.
    { uid: 2, folder: "INBOX", at: ago(1), subject: "Fwd", from: ALEX, messageId: "x2@example.com", plain: "x", calendar: request({ uid: "other-1", me: "someone@example.com" }) },
    { uid: 3, folder: "INBOX", at: ago(1), subject: "Reply", from: ALEX, messageId: "x3@example.com", plain: "x", calendar: request({ uid: "reply-1", method: "REPLY" }) },
    { uid: 4, folder: "INBOX", at: ago(1), subject: "File", from: ALEX, messageId: "x4@example.com", plain: "x", calendar: request({ uid: "file-1", summary: "Picnic" }), calendarFile: true },
  ]);
  try {
    const inv = invitation(t, id);
    assert.ok(inv, "listed");
    assert.deepEqual([inv.fields.answer, inv.fields.answer_by, inv.fields.uid, inv.fields.title], ["needs_action", "mail", "dinner-1@example.com", "Dinner at Luigi's"]);
    assert.deepEqual(inv.fields.from, { kind: "mail", mailbox: EMAIL, message: (inv.fields.from as { message: string }).message });
    const all = t.hub.store.list({ kind: "invitation" }).map((e) => e.fields.uid).sort();
    assert.deepEqual(all, ["dinner-1@example.com", "file-1"], "an .ics file counts; another's invitation and a REPLY do not");

    const r = await answer(t, id, "accepted");
    assert.equal(r.status, 200, await r.clone().text());
    const out = (await r.json()) as { invitation: Entity; outbox: { id: string; state: string } };
    assert.equal(out.outbox.state, "waiting");
    assert.equal((out.invitation.fields.reply as { state: string }).state, "waiting");
    const ev = t.hub.store.get(String(out.invitation.fields.event_id))!;
    assert.deepEqual([ev.fields.title, ev.fields.start, ev.fields.location, ev.space], ["Dinner at Luigi's", inv.fields.start, "Luigi's, Main Street", "personal"], "on the calendar, as Calendar adds it");
    assert.equal(ev.fields.caldav, undefined);

    await until("sent", () => server.got.length === 1);
    const m = server.got[0];
    assert.deepEqual(m.to, ["alex@example.com"], "to the organizer only");
    const h = headersOf(m.raw);
    for (const want of ["To: alex@example.com", "Subject: Accepted: Dinner at Luigi's", "In-Reply-To: <inv1@example.com>", "References: <inv1@example.com>", `From: "Robin" <${EMAIL}>`]) assert.ok(h.includes(want), want);
    assert.ok(h.some((l) => /^Content-Type: multipart\/alternative; boundary="/.test(l)));
    const [text, cal] = parts(m.raw);
    assert.match(text.headers, /^Content-Type: text\/plain; charset=utf-8/);
    assert.equal(text.body, "Robin has accepted your invitation: Dinner at Luigi's");
    assert.match(cal.headers, /^Content-Type: text\/calendar; method=REPLY; charset=utf-8/);
    const u = cal.body.replace(/\r\n[ \t]/g, "");
    assert.ok(u.includes("METHOD:REPLY\r\n") && u.includes("UID:dinner-1@example.com\r\n") && u.includes("SEQUENCE:0\r\n"));
    assert.deepEqual(u.split("\r\n").filter((l) => l.startsWith("ATTENDEE")), [`ATTENDEE;PARTSTAT=ACCEPTED;CN="Robin Example, at home":mailto:${EMAIL}`]);
    await until("the invitation says sent", () => (invitation(t, id).fields.reply as { state: string }).state === "sent");
    const listed = (await (await t.api("/invitations")).json()) as { pending: Entity[]; answered: Entity[] };
    assert.deepEqual([listed.pending.length, listed.answered.map((e) => e.id).includes(id)], [1, true], "the .ics one waits; this one is answered");

    // Decline after Accept: the event Aeneas added is taken out again.
    assert.equal((await answer(t, id, "declined")).status, 200);
    assert.ok(t.hub.store.get(ev.id)!.deleted_at);
    await until("the decline sent", () => server.got.length === 2);
    assert.match(parts(server.got[1].raw)[1].body.replace(/\r\n[ \t]/g, ""), /PARTSTAT=DECLINED/);
    assert.ok(headersOf(server.got[1].raw).includes("Subject: Declined: Dinner at Luigi's"));
  } finally { await finish(t, server); }
});

test("mail: Undo takes the answer back before it goes, and the event with it; an event with the same UID is not added twice", async () => {
  const t = makeHub();
  const { server, id } = await mailbox(t, [], 60_000);
  try {
    const r = await answer(t, id, "tentative");
    assert.equal(r.status, 200);
    const evId = String(((await r.json()) as { invitation: Entity }).invitation.fields.event_id);
    assert.equal((await answer(t, id, "accepted")).status, 409, "one answer at a time");
    const undo = await t.api(`/invitations/${id}/undo`, { method: "POST" });
    assert.equal(undo.status, 200);
    const back = invitation(t, id);
    assert.deepEqual([back.fields.answer, back.fields.reply, back.fields.answered_at], ["needs_action", undefined, undefined]);
    assert.ok(t.hub.store.get(evId)!.deleted_at, "the event it added went too");
    assert.equal(((await (await t.api("/mail")).json()) as { outbox: unknown[] }).outbox.length, 0);
    assert.equal((await t.api(`/invitations/${id}/undo`, { method: "POST" })).status, 404, "nothing left to take back");
    // The same UID already on the calendar (Google put it in its calendar, which the iPhone brings in): not added again.
    const there = t.hub.store.create("event", { title: "Dinner at Luigi's", start: invitation(t, id).fields.start, end: invitation(t, id).fields.end, apple: { id: "dinner-1@example.com" } });
    const again = (await (await answer(t, id, "accepted")).json()) as { invitation: Entity };
    assert.equal(again.invitation.fields.event_id, there.id);
    assert.equal(t.hub.store.list({ kind: "event" }).filter((e) => e.fields.title === "Dinner at Luigi's").length, 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.got.length, 0, "nothing was sent while Undo stood");
  } finally { await finish(t, server); }
});

test("mail: a newer SEQUENCE replaces the invitation and asks again; an older one is passed over; CANCEL takes it and its event away", async () => {
  const t = makeHub();
  const { msgs, server, id } = await mailbox(t);
  try {
    const r = await answer(t, id, "accepted");
    const evId = String(((await r.json()) as { invitation: Entity }).invitation.fields.event_id);
    await until("sent", () => server.got.length === 1);
    // The organizer moves it a day later: a new request, SEQUENCE 1.
    msgs.push({ uid: 5, folder: "INBOX", at: ago(0), subject: "Updated invitation", from: ALEX, messageId: "inv2@example.com", plain: "Moved.", calendar: request({ seq: 1, when: day(10), stamp: "20261124T120000Z" }) });
    await t.api("/mail/refresh", { method: "POST" });
    const moved = invitation(t, id);
    assert.equal(moved.fields.sequence, 1);
    assert.equal(moved.fields.start, new Date(`${dash(day(10))}T19:00:00-05:00`).toISOString());
    assert.equal(moved.fields.answer, "needs_action", "asked again");
    assert.equal(t.hub.store.get(evId)!.fields.start, moved.fields.start, "the event Aeneas added moves with it");
    // An older copy arriving late changes nothing.
    msgs.push({ uid: 6, folder: "INBOX", at: ago(0), subject: "Old", from: ALEX, messageId: "inv0@example.com", plain: "x", calendar: request({ seq: 0, when: day(12) }) });
    await t.api("/mail/refresh", { method: "POST" });
    assert.equal(invitation(t, id).fields.start, moved.fields.start);
    // A cancellation from someone else is passed over; the organizer's takes the invitation and the event away.
    msgs.push({ uid: 7, folder: "INBOX", at: ago(0), subject: "Cancel", from: { address: "mallory@example.net" }, messageId: "c0@example.net", plain: "x", calendar: request({ method: "CANCEL", seq: 2 }).replace("ORGANIZER;CN=Alex:mailto:alex@example.com", "ORGANIZER:mailto:mallory@example.net") });
    await t.api("/mail/refresh", { method: "POST" });
    assert.ok(!invitation(t, id).deleted_at);
    msgs.push({ uid: 8, folder: "INBOX", at: ago(0), subject: "Cancelled", from: ALEX, messageId: "c1@example.com", plain: "x", calendar: request({ method: "CANCEL", seq: 2 }) });
    await t.api("/mail/refresh", { method: "POST" });
    assert.ok(invitation(t, id).deleted_at, "cancelled");
    assert.ok(t.hub.store.get(evId)!.deleted_at, "and the event Aeneas added for it");
    assert.equal(t.hub.mailDb.prepare("SELECT COUNT(*) AS n FROM mail_invites").get() !== undefined, true);
  } finally { await finish(t, server); }
});

test("mail: a Read only mailbox is refused and nothing is queued; switching Mail off sweeps its invitations", async () => {
  const t = makeHub();
  const { server, id } = await mailbox(t);
  try {
    t.hub.connections.update((c) => { c.icloud![0].read_only = true; });
    const r = await answer(t, id, "accepted");
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /Read only/);
    assert.equal(invitation(t, id).fields.answer, "needs_action");
    assert.equal(t.hub.store.list({ kind: "event" }).filter((e) => e.fields.title === "Dinner at Luigi's").length, 0, "no event without an answer");
    t.hub.modules.set({ mail_inbox: false });
    assert.ok(invitation(t, id).deleted_at, "gone with the mail");
  } finally { await finish(t, server); }
});

// ---------------------------------------------------------------------------------------------------------------------
// One list, Apple Calendar, the sweep and the assistant

test("one per UID across places; Apple Calendar's are answered there; a device may write them, in Work too; the sweep removes past ones", async () => {
  const t = makeHub();
  try {
    const base = { title: "Standup", start: new Date(Date.now() + 86_400_000).toISOString(), end: new Date(Date.now() + 90_000_000).toISOString(), answer: "needs_action", uid: "same-uid" };
    const mail = t.hub.store.create("invitation", { ...base, answer_by: "mail", from: { kind: "mail", mailbox: "robin@example.com", message: "m" } });
    const ts = new Date().toISOString();
    const push = await t.api("/sync/push", { method: "POST", json: { device_id: "iphone-1", patches: [
      { id: "7f1a2b3c-0000-4000-8000-000000000001", kind: "invitation", space: "work", ts, create: true, fields: { ...base, answer_by: "open_in_calendar", from: { kind: "device", device: "iphone-1", event: "EK1" } } },
      { id: "7f1a2b3c-0000-4000-8000-000000000002", kind: "invitation", ts, create: true, fields: { ...base, uid: "only-device", title: "Review", answer_by: "open_in_calendar", from: { kind: "device", device: "iphone-1", event: "EK2" } } },
    ] } });
    const pushed = (await push.json()) as { applied: unknown[]; rejected: unknown[] };
    assert.deepEqual([pushed.applied.length, pushed.rejected.length], [2, 0], "a work calendar's invitation is a work item");
    const list = (await (await t.api("/invitations")).json()) as { pending: Entity[] };
    assert.deepEqual(list.pending.map((e) => e.id).sort(), [mail.id, "7f1a2b3c-0000-4000-8000-000000000002"].sort(), "the mail one stands for its UID");
    const r = await answer(t, "7f1a2b3c-0000-4000-8000-000000000002", "accepted");
    assert.equal(r.status, 409);
    assert.match(((await r.json()) as { error: string }).error, /in your calendar app/);
    t.hub.store.patch(mail.id, { start: new Date(Date.now() - 3 * 86_400_000).toISOString(), end: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    assert.ok(sweepInvitations(t.hub) >= 1);
    assert.ok(t.hub.store.get(mail.id)!.deleted_at, "a day past its end, it goes");
  } finally { t.cleanup(); }
});

test("the sweep removes an invitation whose account is not linked, but keeps the demo hub's sample ones until they end", () => {
  const t = makeHub();
  try {
    const soon = { start: new Date(Date.now() + 86_400_000).toISOString(), end: new Date(Date.now() + 90_000_000).toISOString(), answer: "needs_action", answer_by: "caldav" };
    const from = { kind: "icloud", account: "alex@example.com", calendar: "https://caldav.example.com/a/", href: "https://caldav.example.com/a/x.ics" };
    const real = t.hub.store.create("invitation", { ...soon, title: "Real", uid: "real-uid", from });
    const sample = t.hub.store.create("invitation", { ...soon, title: "Sample", uid: "sample-uid", from, sample: true });
    sweepInvitations(t.hub);
    assert.ok(t.hub.store.get(real.id)!.deleted_at, "no iCloud account with calendars is linked: it goes");
    assert.equal(t.hub.store.get(sample.id)!.deleted_at, null, "a sample one stays");
    t.hub.store.patch(sample.id, { start: new Date(Date.now() - 3 * 86_400_000).toISOString(), end: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    sweepInvitations(t.hub);
    assert.ok(t.hub.store.get(sample.id)!.deleted_at, "a day past its end, a sample one goes too");
  } finally { t.cleanup(); }
});

test("assistant: invitations lists them; answer_invitation asks first, and answers only after a yes in a later reply", async () => {
  const t = makeHub();
  try {
    const inv = t.hub.store.create("invitation", { title: "Dinner", start: new Date(Date.now() + 86_400_000).toISOString(), end: new Date(Date.now() + 90_000_000).toISOString(), answer: "needs_action", answer_by: "mail", uid: "u-1", organizer: { name: "Alex", address: "alex@example.com" }, from: { kind: "mail", mailbox: "robin@example.com", message: "m" } });
    const device = t.hub.store.create("invitation", { title: "Review", start: new Date(Date.now() + 86_400_000).toISOString(), end: new Date(Date.now() + 90_000_000).toISOString(), answer: "needs_action", answer_by: "open_in_calendar", uid: "u-2", from: { kind: "device", device: "d", event: "e" } });
    const answered: [string, string][] = [];
    const tool = (name: string) => TOOLS.find((x) => x.name === name)!;
    const ctx = (lastUser: string, startedAt: string): ToolContext => ({
      sessionId: "chat-1", lastUser, topic: "", store: t.hub.store, cfg: t.hub.cfg, hosts: null, turn: { startedAt, proposed: new Set(), ran: [] },
      answerInvitation: async (id, a) => { answered.push([id, a]); return { invitation: { fields: {} } }; },
    });
    const listed = (await tool("invitations").run(null as never, {}, ctx("what invites do I have?", new Date().toISOString()))) as { pending: { id: string; how: string; organizer?: string }[] };
    assert.deepEqual(listed.pending.map((p) => p.id).sort(), [inv.id, device.id].sort());
    assert.match(listed.pending.find((p) => p.id === device.id)!.how, /cannot answer/);
    const first = (await tool("answer_invitation").run(null as never, { id: inv.id, answer: "accepted" }, ctx("accept Alex's dinner", new Date(Date.now() - 1000).toISOString()))) as { status: string; instruction: string };
    assert.equal(first.status, "waiting_for_owner");
    assert.match(first.instruction, /Alex will be told/);
    assert.deepEqual(answered, [], "nothing answered on the first call");
    const again = (await tool("answer_invitation").run(null as never, { id: inv.id, answer: "accepted" }, ctx("yes", new Date(Date.now() - 2000).toISOString()))) as { status: string };
    assert.equal(again.status, "waiting_for_owner", "asked in this same reply: no yes seen yet");
    await new Promise((r) => setTimeout(r, 5));
    const notYes = (await tool("answer_invitation").run(null as never, { id: inv.id, answer: "accepted" }, ctx("hmm, what time is it?", new Date().toISOString()))) as { status: string };
    assert.equal(notYes.status, "waiting_for_owner");
    assert.deepEqual(answered, []);
    await new Promise((r) => setTimeout(r, 5));
    const yes = (await tool("answer_invitation").run(null as never, { id: inv.id, answer: "accepted" }, ctx("yes", new Date().toISOString()))) as { status: string };
    assert.equal(yes.status, "answered");
    assert.deepEqual(answered, [[inv.id, "accepted"]]);
    const cant = (await tool("answer_invitation").run(null as never, { id: device.id, answer: "declined" }, ctx("decline it", new Date().toISOString()))) as { error: string };
    assert.match(cant.error, /calendar app/);
    // Its other tools cannot answer one: no writes under /invitations, and update_item and delete_item refuse the kind.
    assert.ok(refuseToolCall("POST", `/invitations/${inv.id}/answer`));
    assert.equal(refuseToolCall("GET", "/invitations"), null);
    const upd = (await tool("update_item").run(null as never, { id: inv.id, fields: { answer: "accepted" } }, ctx("x", new Date().toISOString()))) as { error: string };
    assert.match(upd.error, /answer_invitation/);
    const del = (await tool("delete_item").run(null as never, { id: inv.id }, ctx("x", new Date().toISOString()))) as { error: string };
    assert.match(del.error, /cannot be deleted/);
  } finally { t.cleanup(); }
});
