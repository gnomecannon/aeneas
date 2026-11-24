import { test } from "node:test";
import assert from "node:assert/strict";
import type { Entity } from "@everythingapp/shared";
import { makeHub } from "./helpers.js";
import { setDavFetch } from "../src/imports/caldav.js";
import { syncCalendarsNow, snapOf } from "../src/calendar-sync.js";
import { parseObject, updatedEventIcs, wallTime } from "../src/calendar-ics.js";
import { icloudSource } from "../src/imports/icloud.js";

const PASS = "abcd-efgh-ijkl-mnop";
const HOME = "https://p42-caldav.icloud.com/1234/calendars/";
const CAL = `${HOME}home/`;
const HOLIDAYS = `${HOME}holidays/`;

/** iCloud's calendar server, in memory: discovery, calendar-query, GET, PUT and DELETE with etags. */
function fakeICloud(opts: { refuse?: () => boolean; evilHref?: boolean } = {}) {
  const objects = new Map<string, { data: string; etag: string }>();
  let n = 0;
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  const put = (url: string, data: string) => { const etag = `"e${++n}"`; objects.set(url, { data, etag }); return etag; };
  const xml = (body: string) => new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">${body}</d:multistatus>`, { status: 207 });
  const ok = (href: string, props: string) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  setDavFetch(async (url, init) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const method = String(init.method);
    calls.push({ method, url, headers });
    if (headers.authorization !== `Basic ${Buffer.from(`you@icloud.com:${PASS}`).toString("base64")}` || opts.refuse?.()) return new Response("", { status: 401 });
    const body = String(init.body ?? "");
    if (method === "PROPFIND" && url === "https://caldav.icloud.com/") return xml(ok("/", "<d:current-user-principal><d:href>/1234/principal/</d:href></d:current-user-principal>"));
    if (method === "PROPFIND" && url === "https://caldav.icloud.com/1234/principal/") return xml(ok("/1234/principal/", `<c:calendar-home-set><d:href>${HOME}</d:href></c:calendar-home-set>`));
    if (method === "PROPFIND" && url === HOME) {
      const cal = (href: string, name: string, write: boolean) => ok(href, `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${name}</d:displayname><ic:calendar-color>#FF2968FF</ic:calendar-color><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><d:current-user-privilege-set><d:privilege><d:read/></d:privilege>${write ? "<d:privilege><d:write/></d:privilege>" : ""}</d:current-user-privilege-set>`);
      return xml(ok(HOME, "<d:resourcetype><d:collection/></d:resourcetype>") + cal("/1234/calendars/home/", "Home", true) + cal("/1234/calendars/holidays/", "Holidays", false)
        + ok("/1234/calendars/tasks/", "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Reminders</d:displayname><c:supported-calendar-component-set><c:comp name=\"VTODO\"/></c:supported-calendar-component-set>"));
    }
    if (method === "REPORT") {
      assert.match(body, /time-range start="\d{8}T\d{6}Z"/);
      const list = [...objects.entries()].filter(([u]) => u.startsWith(url));
      if (opts.evilHref) return xml(ok("https://evil.example/x.ics", `<d:getetag>"1"</d:getetag><c:calendar-data>x</c:calendar-data>`));
      return xml(list.map(([u, o]) => ok(new URL(u).pathname, `<d:getetag>${o.etag}</d:getetag><c:calendar-data>${esc(o.data)}</c:calendar-data>`)).join(""));
    }
    if (method === "GET") { const o = objects.get(url); return o ? new Response(o.data, { status: 200, headers: { etag: o.etag } }) : new Response("", { status: 404 }); }
    if (method === "PUT") {
      const o = objects.get(url);
      if (headers["if-none-match"] === "*" && o) return new Response("", { status: 412 });
      if (headers["if-match"] && (!o || o.etag !== headers["if-match"])) return new Response("", { status: 412 });
      return new Response(null, { status: o ? 204 : 201, headers: { etag: put(url, body) } });
    }
    if (method === "DELETE") {
      const o = objects.get(url);
      if (!o) return new Response("", { status: 404 });
      if (headers["if-match"] && o.etag !== headers["if-match"]) return new Response("", { status: 412 });
      objects.delete(url);
      return new Response(null, { status: 204 });
    }
    return new Response("", { status: 405 });
  });
  return { objects, calls, put };
}

const ics = (uid: string, body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Apple Inc.//iCloud//EN\r\nBEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nBEGIN:DAYLIGHT\r\nTZOFFSETFROM:-0500\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r\nDTSTART:20070311T020000\r\nTZNAME:EDT\r\nTZOFFSETTO:-0400\r\nEND:DAYLIGHT\r\nBEGIN:STANDARD\r\nTZOFFSETFROM:-0400\r\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r\nDTSTART:20071104T020000\r\nTZNAME:EST\r\nTZOFFSETTO:-0500\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nUID:${uid}\r\n${body}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
const day = (offset: number) => { const d = new Date(Date.now() + offset * 86_400_000); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`; };

async function setup(t: ReturnType<typeof makeHub>) {
  const link = await t.api("/calendars/icloud", { method: "PUT", json: { email: "You@iCloud.com", password: PASS.replace(/-/g, "") } });
  assert.equal(link.status, 200, await link.clone().text());
  const v = await link.json() as { accounts: { calendars: { url: string; name: string; writable: boolean }[] }[] };
  return v;
}
const events = (t: ReturnType<typeof makeHub>) => t.hub.store.list({ kind: "event", space: "personal", includeDeleted: true });

test("calendar sync: links an iCloud address, finds its event calendars, and the Apple apps hear it is active once one is chosen", async () => {
  const t = makeHub();
  fakeICloud();
  try {
    const bad = await t.api("/calendars/icloud", { method: "PUT", json: { email: "you@icloud.com", password: "wxyz-wxyz-wxyz-wxyz" } });
    assert.equal(bad.status, 422);
    assert.match((await bad.json() as { error: string }).error, /did not accept/);
    const v = await setup(t);
    assert.deepEqual(v.accounts[0].calendars.map((c) => [c.name, c.writable]), [["Home", true], ["Holidays", false]], "the Reminders list holds no events");
    const mods = () => t.api("/modules").then((r) => r.json() as Promise<{ modules: { id: string; active?: boolean }[] }>).then((m) => m.modules.find((x) => x.id === "calendars")!);
    assert.equal((await mods()).active, false);
    const chosen = await t.api("/calendars/icloud/you%40icloud.com", { method: "PUT", json: { chosen: [CAL, HOLIDAYS], target: CAL } });
    assert.equal(chosen.status, 200);
    assert.equal((await mods()).active, true);
    assert.equal((await t.api("/calendars/icloud/you%40icloud.com", { method: "PUT", json: { target: HOLIDAYS } })).status, 422, "a read-only calendar takes no new events");
    // The address was linked for calendars only: Mail receipts does not read it, and the password never comes back.
    assert.deepEqual(icloudSource.accounts(t.hub), []);
    assert.doesNotMatch(JSON.stringify(await (await t.api("/calendars")).json()), /abcd|efgh/);
    assert.doesNotMatch(JSON.stringify(await (await t.api("/connections")).json()), /abcd-efgh/);
  } finally { setDavFetch(null); t.cleanup(); }
});

test("calendar sync: server events come in, app events go out, and edits and deletions travel both ways", async () => {
  const t = makeHub();
  const s = fakeICloud();
  try {
    await setup(t);
    await t.api("/calendars/icloud/you%40icloud.com", { method: "PUT", json: { chosen: [CAL, HOLIDAYS], target: CAL } });
    const dentist = `${CAL}dentist.ics`;
    s.put(dentist, ics("dentist-1", `DTSTART;TZID=America/New_York:${day(3)}T140000\r\nDTEND;TZID=America/New_York:${day(3)}T150000\r\nSUMMARY:Dentist\r\nDESCRIPTION:Bring the form\r\nBEGIN:VALARM\r\nTRIGGER:-PT30M\r\nACTION:DISPLAY\r\nEND:VALARM`));
    s.put(`${HOLIDAYS}h.ics`, ics("holiday-1", `DTSTART;VALUE=DATE:${day(5)}\r\nDTEND;VALUE=DATE:${day(6)}\r\nSUMMARY:Holiday`));
    s.put(`${CAL}standup.ics`, ics("standup-1", `DTSTART;TZID=America/New_York:${day(-1)}T090000\r\nDTEND;TZID=America/New_York:${day(-1)}T091500\r\nRRULE:FREQ=DAILY;COUNT=5\r\nSUMMARY:Standup`));
    // The phone imported the standup before the hub synced this calendar: its copies go.
    const phoneCopy = t.hub.store.create("event", { title: "Standup", start: snapOf({ start: new Date(Date.now() + 86_400_000).toISOString() })!.start, end: new Date(Date.now() + 86_400_000).toISOString(), source: "eventkit", external_id: "x|y" });
    const parsed = parseObject(s.objects.get(`${CAL}standup.ics`)!.data, new Date(Date.now() - 7 * 86_400_000), new Date(Date.now() + 90 * 86_400_000))!;
    t.hub.store.patch(phoneCopy.id, { start: parsed.occurrences![2].start, end: parsed.occurrences![2].end });
    // An event the iPhone already mirrored into this calendar is linked, not copied.
    const s2 = `${CAL}mirrored.ics`;
    s.put(s2, ics("apple-uid-9", `DTSTART:${day(2)}T200000Z\r\nDTEND:${day(2)}T210000Z\r\nSUMMARY:Dinner`));
    const mirrored = t.hub.store.create("event", { title: "Dinner", start: `${day(2).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")}T20:00:00.000Z`, end: `${day(2).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")}T21:00:00.000Z`, apple: { id: "apple-uid-9", calendar: "Home" } });
    // Made in the app: goes to the calendar chosen for new events. Work never leaves the hub.
    const mine = t.hub.store.create("event", { title: "Climbing", start: new Date(Date.now() + 4 * 86_400_000).toISOString(), end: new Date(Date.now() + 4 * 86_400_000 + 7_200_000).toISOString() });
    t.hub.store.create("event", { title: "Board meeting", start: new Date(Date.now() + 86_400_000).toISOString(), end: new Date(Date.now() + 90_000_000).toISOString() }, "work");

    const r1 = (await syncCalendarsNow(t.hub))[0];
    assert.equal(r1.error, undefined);
    // The chosen calendars' own colors are kept for Theme, Calendar colors, under the key their events name.
    const colors = t.hub.feel.get().calendars;
    assert.deepEqual(colors.map((c) => [c.key, c.account, c.color]).sort(), [[`icloud:${CAL}`, "you@icloud.com", "#FF2968"], [`icloud:${HOLIDAYS}`, "you@icloud.com", "#FF2968"]].sort());
    const all = events(t);
    const dentistE = all.find((e) => e.fields.title === "Dentist")!;
    assert.deepEqual(dentistE.fields.caldav, { account: "you@icloud.com", calendar: CAL, uid: "dentist-1", from_caldav: true });
    assert.equal(dentistE.fields.start, new Date(`${day(3).replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")}T14:00:00-05:00`).toISOString());
    const hol = all.find((e) => e.fields.title === "Holiday")!;
    assert.equal(hol.fields.all_day, true);
    assert.match(String(hol.fields.start), /T00:00:00\.000Z$/);
    const occ = all.filter((e) => e.fields.title === "Standup" && e.fields.source === "caldav" && !e.deleted_at);
    assert.equal(occ.length, 5);
    assert.ok(t.hub.store.get(phoneCopy.id)!.deleted_at, "the phone's copy of an occurrence is removed");
    assert.equal(all.filter((e) => e.fields.title === "Dinner").length, 1);
    assert.equal((t.hub.store.get(mirrored.id)!.fields.caldav as { uid: string }).uid, "apple-uid-9");
    const out = s.objects.get(`${CAL}${mine.id}.ics`);
    assert.ok(out, "the app event was added to the chosen calendar");
    assert.match(out.data, new RegExp(`UID:${mine.id}`));
    assert.match(out.data, /SUMMARY:Climbing/);
    assert.ok(![...s.objects.values()].some((o) => /Board meeting/.test(o.data)), "work events never leave the hub");
    assert.ok(!s.calls.some((c) => c.method !== "PROPFIND" && c.method !== "REPORT" && c.method !== "GET" && c.url.startsWith(HOLIDAYS)), "nothing is written to a read-only calendar");

    // A second run with nothing changed writes nothing.
    const writes = () => s.calls.filter((c) => c.method === "PUT" || c.method === "DELETE").length;
    const before = writes();
    await syncCalendarsNow(t.hub);
    assert.equal(writes(), before);
    assert.equal(events(t).filter((e) => !e.deleted_at && e.fields.title === "Standup" && e.fields.source === "caldav").length, 5);

    // Moved in the app: iCloud gets the new time in its own zone, and keeps the notes and the alert.
    const newStart = new Date(Date.parse(String(dentistE.fields.start)) + 3_600_000).toISOString();
    t.hub.store.patch(dentistE.id, { start: newStart, end: new Date(Date.parse(newStart) + 3_600_000).toISOString(), title: "Dentist (moved)" });
    await syncCalendarsNow(t.hub);
    const d = s.objects.get(dentist)!.data;
    assert.match(d, /SUMMARY:Dentist \(moved\)/);
    assert.match(d, new RegExp(`DTSTART;TZID=America/New_York:${day(3)}T150000`));
    assert.match(d, /DESCRIPTION:Bring the form/);
    assert.match(d, /BEGIN:VALARM/);
    assert.match(d, /SEQUENCE:1/);

    // Changed in iCloud: the app follows.
    s.put(dentist, d.replace("SUMMARY:Dentist (moved)", "SUMMARY:Dentist at 3"));
    await syncCalendarsNow(t.hub);
    assert.equal(t.hub.store.get(dentistE.id)!.fields.title, "Dentist at 3");

    // Deleted in iCloud: deleted in the app. Deleted in the app: deleted in iCloud.
    s.objects.delete(dentist);
    await syncCalendarsNow(t.hub);
    assert.ok(t.hub.store.get(dentistE.id)!.deleted_at);
    t.hub.store.patch(mine.id, { deleted_at: new Date().toISOString() });
    await syncCalendarsNow(t.hub);
    assert.equal(s.objects.has(`${CAL}${mine.id}.ics`), false);

    // A cancelled occurrence goes; a deleted app event is not brought back.
    const st = s.objects.get(`${CAL}standup.ics`)!;
    s.put(`${CAL}standup.ics`, st.data.replace("RRULE:FREQ=DAILY;COUNT=5", "RRULE:FREQ=DAILY;COUNT=4"));
    await syncCalendarsNow(t.hub);
    assert.equal(events(t).filter((e) => !e.deleted_at && e.fields.title === "Standup" && e.fields.source === "caldav").length, 4);

    // Stopping keeps the events (no longer linked) and removes the occurrences; the password goes.
    const stop = await t.api("/calendars/icloud/you%40icloud.com", { method: "DELETE" });
    assert.equal(stop.status, 200);
    assert.equal(t.hub.store.get(mirrored.id)!.deleted_at, null);
    assert.equal(t.hub.store.get(mirrored.id)!.fields.caldav, undefined);
    assert.equal(events(t).filter((e) => !e.deleted_at && e.fields.source === "caldav").length, 0);
    assert.deepEqual(t.hub.connections.get().icloud ?? [], []);
  } finally { setDavFetch(null); t.cleanup(); }
});

test("calendar sync: a Read only account is read and never written (gnomecannon/aeneas#10)", async () => {
  const t = makeHub();
  const s = fakeICloud();
  try {
    await setup(t);
    await t.api("/calendars/icloud/you%40icloud.com", { method: "PUT", json: { chosen: [CAL], target: CAL } });
    const key = encodeURIComponent("icloud:you@icloud.com");
    const ro = await t.api(`/connections/accounts/${key}`, { method: "PUT", json: { read_only: true } });
    assert.equal(ro.status, 200, await ro.clone().text());
    s.put(`${CAL}dentist.ics`, ics("dentist-1", `DTSTART;TZID=America/New_York:${day(3)}T140000\r\nDTEND;TZID=America/New_York:${day(3)}T150000\r\nSUMMARY:Dentist`));
    const mine = t.hub.store.create("event", { title: "Climbing", start: new Date(Date.now() + 4 * 86_400_000).toISOString(), end: new Date(Date.now() + 4 * 86_400_000 + 7_200_000).toISOString() });
    const writes = () => s.calls.filter((c) => c.method === "PUT" || c.method === "DELETE");
    await syncCalendarsNow(t.hub);
    const dentist = events(t).find((e) => e.fields.title === "Dentist");
    assert.ok(dentist, "its events still come in");
    assert.equal(s.objects.has(`${CAL}${mine.id}.ics`), false, "an event made in the app stays in the app");
    // Changed and deleted in the app: iCloud keeps its own, and the app follows iCloud again.
    t.hub.store.patch(dentist!.id, { title: "Dentist (moved)" });
    await syncCalendarsNow(t.hub);
    assert.equal(t.hub.store.get(dentist!.id)!.fields.title, "Dentist");
    t.hub.store.patch(dentist!.id, { deleted_at: new Date().toISOString() });
    await syncCalendarsNow(t.hub);
    assert.ok(s.objects.has(`${CAL}dentist.ics`), "not deleted in iCloud");
    assert.deepEqual(writes(), [], "nothing was written to iCloud");
    // The view says so, new events have nowhere to go, and choosing a calendar for them is refused.
    const v = await (await t.api("/calendars")).json() as { accounts: { read_only: boolean; target: string | null }[] };
    assert.deepEqual([v.accounts[0].read_only, v.accounts[0].target], [true, null]);
    assert.equal((await t.api("/calendars/icloud/you%40icloud.com", { method: "PUT", json: { target: CAL } })).status, 422);
    // Switched off, the calendar chosen before takes new events again: nothing to set up again.
    await t.api(`/connections/accounts/${key}`, { method: "PUT", json: { read_only: false } });
    await syncCalendarsNow(t.hub);
    assert.ok(s.objects.has(`${CAL}${mine.id}.ics`));
  } finally { setDavFetch(null); t.cleanup(); }
});

test("calendar sync: a refused password stops it until the owner asks again, and a server's address elsewhere is never followed", async () => {
  const t = makeHub();
  let refuse = false;
  const s = fakeICloud({ refuse: () => refuse });
  try {
    await setup(t);
    await t.api("/calendars/icloud/you%40icloud.com", { method: "PUT", json: { chosen: [CAL], target: CAL } });
    refuse = true;
    const r = (await syncCalendarsNow(t.hub))[0];
    assert.match(String(r.error), /refused/);
    assert.ok(t.hub.connections.get().icloud![0].refused_at);
    const calls = s.calls.length;
    await syncCalendarsNow(t.hub);
    assert.equal(s.calls.length, calls, "no more sign-ins on its own");
    refuse = false;
    const again = await (await t.api("/calendars/sync", { method: "POST" })).json() as { results: { error?: string }[] };
    assert.equal(again.results[0].error, undefined);
  } finally { setDavFetch(null); t.cleanup(); }
  const t2 = makeHub();
  fakeICloud({ evilHref: true });
  try {
    await setup(t2);
    await t2.api("/calendars/icloud/you%40icloud.com", { method: "PUT", json: { chosen: [CAL] } });
    const r = (await syncCalendarsNow(t2.hub))[0];
    assert.match(String(r.error), /another address/);
  } finally { setDavFetch(null); t2.cleanup(); }
});

test("calendar ics: an edit keeps the event's time zone and other parts; wall times follow the clock change", () => {
  assert.equal(wallTime("2026-11-02T14:00:00.000Z", "America/New_York"), "20261102T090000");
  assert.equal(wallTime("2026-10-26T13:00:00.000Z", "America/New_York"), "20261026T090000");
  const src = ics("a", "DTSTART;TZID=America/New_York:20261102T090000\r\nDURATION:PT1H\r\nSUMMARY:Call\r\nATTENDEE:mailto:sam@example.com");
  const out = updatedEventIcs(src, { title: "Call", start: "2026-11-03T15:00:00.000Z", end: "2026-11-03T16:00:00.000Z", all_day: false }, new Date("2026-11-01T00:00:00Z"))!;
  assert.match(out, /DTSTART;TZID=America\/New_York:20261103T100000/);
  assert.match(out, /DTEND;TZID=America\/New_York:20261103T110000/);
  assert.doesNotMatch(out, /DURATION/);
  assert.match(out, /ATTENDEE/);
  const p = parseObject(out, new Date(0), new Date(0))!;
  assert.equal(p.master.start, "2026-11-03T15:00:00.000Z");
  const e = { title: "Trip", start: "2026-11-20", end: "2026-11-22", all_day: true } as Entity["fields"];
  assert.deepEqual(snapOf(e), { title: "Trip", start: "2026-11-20T00:00:00.000Z", end: "2026-11-22T00:00:00.000Z", all_day: true });
});

test("calendar ics: an object that is no event, or several, is passed over instead of stopping the sync", () => {
  const f = { title: "Call", start: "2026-11-03T15:00:00.000Z", end: "2026-11-03T16:00:00.000Z", all_day: false };
  // ical.js reads these without a complaint, as nothing or as two calendars; reading on from there threw.
  for (const data of ["", "\r\n", "\r\n \r\n", "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", "X:1\r\n"]) {
    assert.equal(parseObject(data, new Date("2026-01-01"), new Date("2027-01-01")), null, JSON.stringify(data));
    assert.equal(updatedEventIcs(data, f), null, JSON.stringify(data));
  }
});
