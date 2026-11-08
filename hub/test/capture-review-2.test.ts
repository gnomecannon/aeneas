import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
// Each case was a finding of the 2026-11-05 review of capture filing, the calendar feed and the work space; each fails on the code before the fix.
const R = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const { makeHub } = await import(`${R}/test/helpers.ts`);
const { scripted } = await import(`${R}/test/ai-helpers.ts`);
const { setBackendOverride } = await import(`${R}/src/ai/backends.ts`);
const { queueFiling, nearbyEvents } = await import(`${R}/src/capture-filer.ts`);
const { calendarFeed } = await import(`${R}/src/calendar.ts`);
const { eventSpan } = await import(`${R}/src/planner.ts`);

const PHOTO = { name: "photo-1.jpg", mime: "image/jpeg", bytes_b64: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]).toString("base64") };

test("P5 a capture with a photo: the filer never sees it and what it files does not carry it", async () => {
  const t = makeHub();
  const b = scripted([
    () => ({ calls: [{ name: "create_item", arguments: { kind: "note", fields: { title: "Tire receipt", body: "Receipt for the new tires from Costco", path: "Home/Tire receipt.md" } } }] }),
    () => ({ text: "Saved a note." }),
  ]);
  setBackendOverride(b);
  try {
    const r = (await (await t.api("/capture", { method: "POST", json: { text: "Receipt for the new tires from Costco", source: "iphone", auto: true, attachments: [PHOTO] } })).json()) as any;
    await queueFiling(t.hub, "none");
    const cap = t.hub.store.get(r.capture.id)!;
    const sent = b.seen[0];
    const imagesSent = sent.reduce((n: number, m: any) => n + (m.images?.length ?? 0), 0);
    const promptMentions = sent.some((m: any) => /photo|attach|image/i.test(String(m.content).slice(-3000)));
    const made = ((cap.fields.converted_to as string[]) ?? []).map((id) => t.hub.store.get(id)!);
    assert.ok(imagesSent > 0 || made.some((e) => JSON.stringify(e.fields).includes(PHOTO.bytes_b64)), "the photo went nowhere");
  } finally { setBackendOverride(null); t.cleanup(); }
});

test("P6 work: capture with a photo: the work task has no photo, the personal capture keeps it", async () => {
  const t = makeHub();
  try {
    const r = (await (await t.api("/capture", { method: "POST", json: { text: "work: whiteboard from the ThreatLocker rollout meeting", source: "iphone", auto: true, attachments: [PHOTO] } })).json()) as any;
    const cap = t.hub.store.get(r.capture.id)!;
    const task = r.created[0];
    const personal = await (await t.api("/entities?kind=capture&space=personal")).json() as any[];
    assert.equal((cap.fields.attachments ?? []).length, 0, "work photo left in the personal space");
  } finally { t.cleanup(); }
});

test("P7 ICS all-day event written with the offset of before the clock change", () => {
  const t = makeHub();
  try {
    // Made on Oct 30 (EDT, -04:00) for Thursday Nov 5 (EST, -05:00), as the tool prompt asks: 00:00 to next 00:00 "with the local offset".
    const e = t.hub.store.create("event", { title: "Dentist", start: "2026-11-05T00:00:00-04:00", end: "2026-11-06T00:00:00-04:00", all_day: true });
    const ics = calendarFeed(t.hub, new Date(2026, 9, 30, 12));
    const block = ics.split("BEGIN:VEVENT").find((b: string) => b.includes("Dentist"))!;
    const span = eventSpan(e)!;
    assert.match(block, /DTSTART;VALUE=DATE:20261105/);
    assert.match(block, /DTEND;VALUE=DATE:20261106/);
  } finally { t.cleanup(); }
});

test("P7b ICS all-day event on the spring-forward day, same offset on both ends", () => {
  const t = makeHub();
  try {
    t.hub.store.create("event", { title: "Brunch", start: "2027-03-14T00:00:00-05:00", end: "2027-03-15T00:00:00-05:00", all_day: true });
    const ics = calendarFeed(t.hub, new Date(2027, 2, 1, 12));
    const block = ics.split("BEGIN:VEVENT").find((b: string) => b.includes("Brunch"))!;
    assert.match(block, /DTEND;VALUE=DATE:20270315/);
  } finally { t.cleanup(); }
});

test("P7c ICS all-day event stored as dates alone with the end date exclusive (as eventSpan reads it)", () => {
  const t = makeHub();
  try {
    const e = t.hub.store.create("event", { title: "Beach day", start: "2026-11-07", end: "2026-11-08", all_day: true });
    const ics = calendarFeed(t.hub, new Date(2026, 10, 1, 12));
    const block = ics.split("BEGIN:VEVENT").find((b: string) => b.includes("Beach"))!;
    const span = eventSpan(e)!;
    assert.match(block, /DTEND;VALUE=DATE:20261108/);
  } finally { t.cleanup(); }
});

test("P8 one event with a bad time breaks the whole ICS feed", async () => {
  const t = makeHub();
  try {
    t.hub.store.create("event", { title: "Good", start: "2026-11-07T19:00:00-05:00", end: "2026-11-07T20:00:00-05:00" });
    const bad = t.hub.store.create("event", { title: "Bad", start: "2026-11-08T19:00:00-05:00", end: "2026-11-08 evening" });
    const res = await t.api("/calendar.ics");
    assert.equal(res.status, 200);
  } finally { t.cleanup(); }
});

test("P9 nearbyEvents keeps only the 20 earliest: the plan on the capture's own day is cut", () => {
  const t = makeHub();
  try {
    const at = new Date(2026, 10, 5, 20, 0);
    // 21 events on the two days before (a repeating morning occurrence, meetings), then the outing itself tomorrow.
    for (let i = 0; i < 21; i++) {
      const d = new Date(2026, 10, 3 + (i % 2), 7 + Math.floor(i / 2) % 12, 0);
      t.hub.store.create("event", { title: `Earlier ${i}`, start: d.toISOString(), end: new Date(d.getTime() + 1800_000).toISOString() });
    }
    const outing = t.hub.store.create("event", { title: "Apple picking with Jen", start: "2026-11-06T00:00:00-05:00", end: "2026-11-07T00:00:00-05:00", all_day: true });
    const shown = nearbyEvents(t.hub.store, at);
    assert.ok(shown.some((s: string) => s.includes(outing.id)));
  } finally { t.cleanup(); }
});
