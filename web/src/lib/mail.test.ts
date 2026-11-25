import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { BUNDLES, SHORT_LIVED_BUNDLE_IDS, dayGrouper, listAsSent, CARD_ICON, blockUndo, draftRequest, flatScreen, folderActs, folderRow, fromChoice, givesFocusBack, hitRow, inboxPlace, inboxScreen, inProvider, keyFocus, keyTarget, mailApp, mailboxOf, moveFolders, reminderRow, rowKind, rowTakes, screenRows, threadToFollow, triageRow, WRITING_BOX, type MailKey, type MailMailbox, backLaterToday, selectAll, foldedLines, needsYou, whereLabel, fileSize, previewSrc, riskyFile, MAIL_KEYS, folderCount, folderGroups, askBeforeLeaving, folderLabel, folderWho, type FolderMail, type MailFolder, tripDates, tripsOf, type MailCard, swipeAction, swipeLock, cardLine, cardLink, cardTime, bundleClass, bundleOf, dueReminders, mailKeyAction, deliveryAt, inboxAt, QUOTE_SELECTOR, threadRows, frameLink, initials, logoSrc, shownAt, snoozeChoices, httpsLink, dayGroup, inboxSections, initial, matches, messageLines, nameHidesAddress, replyToWarning, sendersLine, shownBundles, textParts, viewMessages, whenLabel, type MailSummary, frameClick, checkFrameLinks, type KeyFocus } from "./mail";
import { SCREEN_MODULE, moduleOfScreen } from "./modules";

const ALEX = { name: "Alex", address: "alex@example.com" };
const NOW = new Date(2026, 10, 19, 15, 0);
const at = (daysAgo: number, h = 9) => new Date(2026, 10, 19 - daysAgo, h).toISOString();
let n = 0;
const mail = (over: Partial<MailSummary> = {}): MailSummary => ({ id: `m${++n}`, at: at(0), from: ALEX, subject: `Mail ${n}`, preview: "Hello", automated: false, bundle: null, state: "inbox", pinned: false, ...over });
const allOn = () => true;

describe("mail screen rules", () => {
  it("groups by day: Today, Yesterday, This week, This month, then months", () => {
    expect(dayGroup(at(0, 8), NOW)).toBe("Today");
    expect(dayGroup(at(1, 23), NOW)).toBe("Yesterday");
    expect(dayGroup(at(5), NOW)).toBe("This week");
    expect(dayGroup(at(12), NOW)).toBe("This month");
    expect(dayGroup(new Date(2026, 9, 3).toISOString(), NOW)).toBe(new Date(2026, 9, 3).toLocaleDateString([], { month: "long", year: "numeric" }));
    expect(dayGroup("nonsense", NOW)).toBe("Earlier");
    expect(whenLabel(at(0, 9), NOW)).toBe(new Date(2026, 10, 19, 9).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    expect(whenLabel(at(3), NOW)).toBe(new Date(2026, 10, 16, 9).toLocaleDateString([], { weekday: "short" }));
  });

  it("shows module bundles only while their module is on; other mail in an unknown or hidden bundle stands alone", () => {
    const off = (id: string) => id !== "pet";
    expect(shownBundles(allOn).map((b) => b.id)).toEqual(BUNDLES.map((b) => b.id));
    expect(shownBundles(off).map((b) => b.id)).not.toContain("pet");
    expect(shownBundles(off).map((b) => b.id)).toContain("promos");
    expect(bundleOf({ bundle: "pet" }, shownBundles(off))).toBeNull();
    expect(bundleOf({ bundle: "made-up" }, shownBundles(allOn))).toBeNull();
    expect(bundleOf({ bundle: "promos" }, shownBundles(allOn))?.name).toBe("Promotions");
  });

  it("reads a hub's short-lived bundle ids (a build of the renaming) as the bundles they stood for (gnomecannon/aeneas#7)", () => {
    const l = listAsSent({
      messages: [mail({ bundle: "updates", automated: true }), mail({ bundle: "updates", automated: true }), mail({ bundle: "transactions", automated: true }), mail({ bundle: "promotions", automated: true }), mail({ bundle: "trips", automated: true })],
      mailboxes: [],
      bundle_delivery: { promotions: { mode: "never" }, updates: { mode: "daily", time: "07:00" }, other: { mode: "weekly", time: "08:00", day: 1 } },
      mail_notify: { people: true, bundles: ["updates", "other", "transactions"], detail: "full" },
    });
    expect(l.messages.map((m) => m.bundle)).toEqual(["other", "other", "purchases", "promos", "trips"]);
    expect(l.bundle_delivery).toEqual({ promos: { mode: "never" }, other: { mode: "weekly", time: "08:00", day: 1 } });
    expect(l.mail_notify?.bundles).toEqual(["other", "purchases"]);
    expect(Object.keys(SHORT_LIVED_BUNDLE_IDS).every((id) => !BUNDLES.some((b) => b.id === id))).toBe(true);
  });

  it("lists the Inbox newest first under day headings, a bundle as one row per day, pinned mail on its own", () => {
    const shown = shownBundles(allOn);
    const ms = [
      mail({ at: at(0, 10), subject: "Hike?" }),
      mail({ at: at(0, 9), bundle: "purchases", from: { name: "Northwind", address: "o@northwind.example" } }),
      mail({ at: at(0, 8), bundle: "purchases", from: { name: "Larkspur Books", address: "r@larkspur.example" } }),
      mail({ at: at(0, 7), bundle: "purchases", pinned: true, subject: "Pinned receipt" }),
      mail({ at: at(1), bundle: "purchases" }),
      mail({ at: at(0, 6), state: "done", subject: "Done one" }),
      mail({ at: at(0, 5), state: "snoozed", subject: "Snoozed one" }),
    ];
    const s = inboxSections(ms, shown, { now: NOW });
    expect(s.map((x) => x.title)).toEqual(["Today", "Yesterday"]);
    expect(s[0].rows.map((r) => (r.kind === "mail" ? r.mail.subject : `[${r.bundle.name} ${r.mails.length}]`))).toEqual(["Hike?", "[Transactions 2]", "Pinned receipt"]);
    const bundle = s[0].rows[1];
    expect(bundle.kind === "bundle" && sendersLine(bundle.mails)).toBe("Northwind, Larkspur Books");
    expect(s[1].rows.map((r) => r.kind)).toEqual(["bundle"]);
    expect(inboxSections(ms, shown, { now: NOW, pinnedOnly: true }).flatMap((x) => x.rows).map((r) => r.kind === "mail" && r.mail.subject)).toEqual(["Pinned receipt"]);
    expect(viewMessages(ms, "done", shown).map((m) => m.subject)).toEqual(["Done one"]);
    expect(viewMessages(ms, "snoozed", shown).map((m) => m.subject)).toEqual(["Snoozed one"]);
    expect(viewMessages(ms, "b:purchases", shown)).toHaveLength(4);
  });

  it("searches sender, subject and first words, every word", () => {
    const m = mail({ subject: "Gutters this weekend", preview: "Bring the ladder" });
    expect(matches(m, "")).toBe(true);
    expect(matches(m, "alex LADDER")).toBe(true);
    expect(matches(m, "alex roof")).toBe(false);
  });

  it("gives each sender a letter", () => {
    expect(initial(ALEX)).toBe("A");
    expect(initial({ name: "", address: "sam@example.com" })).toBe("S");
    expect(initial({ name: "\"Ölund\"", address: "x@y" })).toBe("Ö");
    expect(initial({ name: "", address: "" })).toBe("?");
    expect(initials({ name: "Alumni Relations Team", address: "a@x" })).toBe("AT");
    expect(initials({ name: "jordan avery", address: "j@x" })).toBe("JA");
    expect(initials(ALEX)).toBe("A");
    expect(initials({ name: "", address: "sam@example.com" })).toBe("S");
  });

  it("offers the snooze times: later today, tomorrow, the weekend, next week", () => {
    const thu = new Date(2026, 10, 19, 15, 0); // a Thursday, 3 PM
    expect(snoozeChoices(thu).map((c) => [c.id, c.label, c.at.getTime()])).toEqual([
      ["later", "Later today", new Date(2026, 10, 19, 18).getTime()],
      ["tomorrow", "Tomorrow", new Date(2026, 10, 20, 8).getTime()],
      ["weekend", "This weekend", new Date(2026, 10, 21, 9).getTime()],
      ["nextweek", "Next week", new Date(2026, 10, 23, 8).getTime()],
    ]);
    expect(snoozeChoices(new Date(2026, 10, 19, 19, 0)).map((c) => c.id)).not.toContain("later");
    const sat = snoozeChoices(new Date(2026, 10, 21, 10, 0));
    expect(sat.find((c) => c.id === "weekend")).toMatchObject({ label: "Next weekend", at: new Date(2026, 10, 28, 9) });
    expect(sat.find((c) => c.id === "nextweek")!.at).toEqual(new Date(2026, 10, 23, 8));
  });

  it("adds the owner's own bundles after the built-in ones, in their own colors", () => {
    const school = { id: "c-0123456789", name: "School", color: 2, addresses: [], domains: ["school.example"], words: [] };
    const shown = shownBundles(allOn, [school]);
    expect(shown.map((b) => b.id)).toEqual([...BUNDLES.map((b) => b.id), "c-0123456789"]);
    expect(bundleClass(shown[shown.length - 1])).toBe("b-custom cc2");
    expect(bundleClass(BUNDLES[0])).toBe("b-purchases");
    expect(bundleOf({ bundle: "c-0123456789" }, shown)?.name).toBe("School");
  });

  it("maps the Mail screen's keys: arrows to move, letters to act, nothing while typing but Escape", () => {
    const k = (key: string, more: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}, focus: KeyFocus = "list") =>
      mailKeyAction({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...more }, focus);
    expect([k("ArrowDown"), k("ArrowUp"), k("ArrowDown", { shiftKey: true }), k("Enter"), k(" "), k("Escape")]).toEqual(["down", "up", "extend-down", "open", "select", "escape"]);
    expect([k("d"), k("D", { shiftKey: true }), k("s"), k("p"), k("u"), k("r"), k("/"), k("?")]).toEqual(["done", "done", "snooze", "pin", "unread", "read", "search", "help"]);
    expect(k("d", {}, "field")).toBeNull();
    expect(k("Escape", {}, "field")).toBe("escape");
    expect(k("p", { ctrlKey: true })).toBeNull();
    expect(k("r", { metaKey: true })).toBeNull();
    expect(k("t")).toBeNull();
  });

  it("shows the reminders that are due among the mail, never a mail's own snooze task", () => {
    const now = new Date(2026, 10, 20, 12);
    const iso = (h: number, d = 20) => new Date(2026, 10, d, h).toISOString();
    const t = (id: string, fields: Record<string, unknown>) => ({ id, fields: { title: id, status: "scheduled", ...fields } });
    const due = dueReminders([
      t("dentist", { remind_at: iso(9) }),
      t("overdue", { remind_at: iso(9, 18), friction: "reason" }),
      t("later", { remind_at: iso(15) }),
      t("snoozed", { remind_at: iso(8), snoozed_until: iso(14) }),
      t("woke", { remind_at: iso(7), snoozed_until: iso(11) }),
      t("finished", { remind_at: iso(9), status: "done" }),
      t("mailsnooze", { remind_at: iso(9), mail: "abc" }),
      t("notime", {}),
    ], now);
    expect(due.map((r) => r.id)).toEqual(["overdue", "dentist", "woke"]);
    expect(due[0].friction).toBe("reason");
    expect(due[2].at).toBe(iso(11));
  });

  it("folds the same quoted history the hub's page folds", () => {
    const hub = fs.readFileSync(path.join(__dirname, "../../../hub/src/mail-html.ts"), "utf8");
    expect(hub).toContain(`export const QUOTE_SELECTOR = '${QUOTE_SELECTOR}';`);
  });

  it("shows a thread as one row: its people, newest time, state, unread and the ids each action takes", () => {
    const g1 = mail({ thread: "t1", at: at(3), subject: "Gutters", seen: true, preview: "Saturday?" });
    const me = mail({ thread: "t1", at: at(2), subject: "Re: Gutters", mine: true, state: "sent", from: { name: "Robin", address: "robin@icloud.example" }, preview: "Yes, 10 AM." });
    const g2 = mail({ thread: "t1", at: at(1), subject: "Re: Gutters", seen: false, preview: "Bring the ladder." });
    const shop = mail({ thread: "t2", at: at(0, 8), automated: true, bundle: "purchases", from: { name: "Northwind", address: "o@northwind.example" } });
    const lonely = mail({ thread: "t3", mine: true, state: "sent" });
    const rows = threadRows([g1, me, g2, shop, lonely]);
    expect(rows).toHaveLength(2);
    const t = rows.find((r) => r.thread === "t1")!;
    expect([t.id, t.subject, t.people, t.state, t.seen, t.at]).toEqual([g2.id, "Gutters", "Alex, me (3)", "inbox", false, g2.at]);
    expect(t.members.map((m) => m.id)).toEqual([g1.id, me.id, g2.id]);
    expect(t.ids).toEqual({ open: [g1.id, g2.id], done: [], unread: [g2.id] });
    expect(t.bundle).toBeNull();
    expect(rows.find((r) => r.thread === "t2")!.people).toBe("Northwind");
    // Done with one message, the other still in the Inbox: the thread stays in the Inbox.
    expect(threadRows([{ ...g1, state: "done" }, g2])[0].state).toBe("inbox");
    expect(threadRows([{ ...g1, state: "done" }, { ...g2, state: "done" }])[0].ids.done).toEqual([g1.id, g2.id]);
    expect(threadRows([me, { ...g2, preview: "x" }, { ...me, id: "m-late", at: at(0, 9), preview: "See you" }])[0].preview).toBe("You: See you");
  });

  it("uses the owner's own snooze times", () => {
    const thu = new Date(2026, 10, 19, 15, 0); // a Thursday, 3 PM
    const mine = snoozeChoices(thu, { later_hours: 2, tomorrow: "07:30", weekend_day: 0, weekend_time: "10:15", week_day: 2, week_time: "09:00" });
    expect(mine.map((c) => c.at.getTime())).toEqual([
      new Date(2026, 10, 19, 17).getTime(),
      new Date(2026, 10, 20, 7, 30).getTime(),
      new Date(2026, 10, 22, 10, 15).getTime(), // Sunday
      new Date(2026, 10, 24, 9).getTime(), // Tuesday
    ]);
  });

  it("holds a bundle's mail until its time, or keeps it out of the Inbox; pinned mail always shows", () => {
    const iso = (d: Date) => d.toISOString();
    // Arrived Thursday 10:30 AM.
    const arrived = iso(new Date(2026, 10, 19, 10, 30));
    expect(deliveryAt(arrived, { mode: "daily", time: "07:00" })).toEqual(new Date(2026, 10, 20, 7));
    expect(deliveryAt(arrived, { mode: "daily", time: "18:00" })).toEqual(new Date(2026, 10, 19, 18));
    expect(deliveryAt(arrived, { mode: "weekly", day: 0, time: "18:00" })).toEqual(new Date(2026, 10, 22, 18));
    expect(deliveryAt(arrived, { mode: "weekly", day: 4, time: "09:00" })).toEqual(new Date(2026, 10, 26, 9)); // Thursday 9 AM had passed: next week's
    expect(deliveryAt(arrived, { mode: "never" })).toBeNull();
    expect(deliveryAt(arrived, undefined)).toEqual(new Date(arrived));

    const delivery = { promos: { mode: "daily" as const, time: "07:00" }, other: { mode: "never" as const } };
    const promo = mail({ at: arrived, bundle: "promos", automated: true });
    const pinned = mail({ at: arrived, bundle: "promos", automated: true, pinned: true });
    const update = mail({ at: arrived, bundle: "other", automated: true });
    const person = mail({ at: arrived });
    const thuNoon = new Date(2026, 10, 19, 12);
    const shown = shownBundles(allOn);
    expect(inboxAt(promo, shown, delivery, thuNoon)).toBeNull();
    expect(inboxAt(promo, shown, delivery, new Date(2026, 10, 20, 8))).toBe(iso(new Date(2026, 10, 20, 7))); // listed by when it showed
    expect(inboxAt(pinned, shown, delivery, thuNoon)).toBe(arrived);
    expect(inboxAt(update, shown, delivery, new Date(2027, 0, 1))).toBeNull();
    expect(inboxAt(person, shown, delivery, thuNoon)).toBe(arrived);
    const rows = inboxSections([promo, pinned, update, person], shown, { now: thuNoon, delivery }).flatMap((s) => s.rows);
    expect(rows.map((r) => (r.kind === "mail" ? r.mail.id : r.bundle.id))).toEqual([pinned.id, person.id]);
  });

  it("never holds back mail of a bundle the app does not show: it stands on its own in the Inbox", () => {
    const arrived = new Date(2026, 10, 19, 10, 30).toISOString();
    const now = new Date(2026, 10, 19, 12);
    // A hub newer than the app sorts into a bundle this app has no view for; the pet module is off on this device.
    const delivery = { "made-up": { mode: "never" as const }, pet: { mode: "never" as const }, promos: { mode: "never" as const } };
    const unknown = mail({ at: arrived, bundle: "made-up", automated: true, triage: { urgency: "today", needs_reply: false } });
    const pet = mail({ at: arrived, bundle: "pet", automated: true, triage: { urgency: "soon", needs_reply: true } });
    const promo = mail({ at: arrived, bundle: "promos", automated: true, triage: { urgency: "today", needs_reply: false } });
    const noPet = shownBundles((id) => id !== "pet");
    expect(inboxAt(unknown, noPet, delivery, now)).toBe(arrived);
    expect(inboxAt(pet, noPet, delivery, now)).toBe(arrived);
    expect(inboxAt(promo, noPet, delivery, now), "a bundle the app shows still holds its mail back").toBeNull();
    // With the pet module on, its bundle has a view of its own, and its setting counts again.
    expect(inboxAt(pet, shownBundles(allOn), delivery, now)).toBeNull();
    const rows = inboxSections([unknown, pet, promo], noPet, { now, delivery }).flatMap((s) => s.rows);
    expect(rows.map((r) => r.kind === "mail" && r.mail.id)).toEqual([unknown.id, pet.id]);
    expect(needsYou([unknown, pet, promo], noPet, { delivery, now }).map((m) => m.id)).toEqual([unknown.id, pet.id]);
  });

  it("lists a mail back from a snooze by when it came back, at the top", () => {
    const old = mail({ at: at(5), subject: "Back from snooze", back_at: at(0, 14) });
    const fresh = mail({ at: at(0, 10), subject: "Fresh" });
    expect(shownAt(old)).toBe(at(0, 14));
    const s = inboxSections([fresh, old], shownBundles(allOn), { now: NOW });
    expect(s[0].title).toBe("Today");
    expect(s[0].rows.map((r) => r.kind === "mail" && r.mail.subject)).toEqual(["Back from snooze", "Fresh"]);
  });

  it("shows a logo only as the hub sends it: a data: SVG picture", () => {
    const svg = `data:image/svg+xml;base64,${btoa("<svg xmlns='http://www.w3.org/2000/svg'/>")}`;
    expect(logoSrc(svg)).toBe(svg);
    expect(logoSrc("https://cdn.shop.example/logo.svg")).toBeNull();
    expect(logoSrc("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(logoSrc(`${svg}" onerror="alert(1)`)).toBeNull();
    expect(logoSrc(undefined)).toBeNull();
    const src = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");
    // The verified logo, and an attachment's preview (previewSrc: a data: picture, checked): no other picture.
    expect(src.match(/<img [^>]*>/g)).toEqual([`<img src={logo} alt="" />`, `<img src={src} alt={a.name} />`]);
    expect(src).toMatch(/const src = previewSrc\(a\.preview\)/);
    expect(src).toMatch(/const logo = m\.logo_domain \? logoSrc\(logos\[m\.logo_domain\]\) : null;/);
  });

  it("shows a button line as a link to its https host, and only then", () => {
    const m = { text: "Out for delivery.\n\nTrack my shipment\nTrack at fedex.com\nPay now", links: [
      { text: "Track my shipment", url: "https://store.shop.example/orders/1?key=x" },
      { text: "Track at fedex.com", url: "https://evil.example/fedex" },
      { text: "Pay now", url: "http://shop.example/pay" },
      { text: "Not a line here", url: "https://shop.example/x" },
    ] };
    const lines = messageLines(m);
    expect(lines.map((l) => l.text)).toEqual(["Out for delivery.", "", "Track my shipment", "Track at fedex.com", "Pay now"]);
    expect(lines[2].link).toEqual({ href: "https://store.shop.example/orders/1?key=x", host: "store.shop.example" });
    expect(lines[3].link, "the label names another site").toBeUndefined();
    expect(lines[4].link, "not https").toBeUndefined();
    expect(messageLines({ text: "Track at fedex.com", links: [{ text: "Track at fedex.com", url: "https://www.fedex.com/t" }] })[0].link?.host).toBe("www.fedex.com");
    for (const bad of ["javascript:alert(1)", "https://user:pw@shop.example/", "data:text/html,x", "not a url"]) expect(httpsLink(bad), bad).toBeNull();
  });

  it("makes a link's label inside a line a link, with its host beside it", () => {
    const m = { text: "Elm Hall TICKETS HERE\nTake the Band Quiz CLICK HERE and see https://band.example/faq.\nTrack at fedex.com today", links: [
      { text: "TICKETS HERE", url: "https://tickets.example/e/1" },
      { text: "Band Quiz CLICK HERE", url: "https://quiz.example/" },
      { text: "Track at fedex.com", url: "https://evil.example/t" },
      { text: "x", url: "https://too-short.example/" },
    ] };
    const lines = messageLines(m);
    expect(lines[0].parts).toEqual([{ text: "Elm Hall " }, { text: "TICKETS HERE", href: "https://tickets.example/e/1", host: "tickets.example" }]);
    expect(lines[1].parts).toEqual([
      { text: "Take the " }, { text: "Band Quiz CLICK HERE", href: "https://quiz.example/", host: "quiz.example" },
      { text: " and see " }, { text: "https://band.example/faq", href: "https://band.example/faq" }, { text: "." },
    ]);
    expect(lines[2].parts?.some((p) => p.href), "a label naming another site than its link is no link").toBe(false);
    expect(lines.flatMap((l) => l.parts ?? []).some((p) => p.href?.includes("too-short")), "a one-letter label is no link").toBe(false);
  });

  it("makes the https addresses written in a message links, the address itself as their text", () => {
    expect(textParts("See https://example.com/a?b=1. Thanks")).toEqual([
      { text: "See " }, { text: "https://example.com/a?b=1", href: "https://example.com/a?b=1" }, { text: ". Thanks" },
    ]);
    expect(textParts("Visit www.shop.example, or not")[1]).toEqual({ text: "www.shop.example", href: "https://www.shop.example/" });
    expect(textParts("(https://en.wikipedia.example/wiki/Tea_(drink))")[1].text, "a bracket the address opened stays").toBe("https://en.wikipedia.example/wiki/Tea_(drink)");
    expect(textParts("(see https://example.com/x)")[1].text, "a bracket it did not open goes").toBe("https://example.com/x");
    expect(textParts("Plain text, no address.")).toEqual([{ text: "Plain text, no address." }]);
    for (const bad of ["http://example.com", "http://www.example.com", "javascript:alert(1)", "https://user:pw@example.com/", "mailto:a@b.example", "me@www.example.com", "https://localhost/x", "data:text/html,x"]) {
      expect(textParts(`x ${bad} y`).some((p) => p.href), bad).toBe(false);
    }
    // Letters from another alphabet that look like Latin ones: the real host is shown beside it.
    expect(textParts("https://\u0430pple.example/login")[0].warnHost).toBe("xn--pple-43d.example");
    expect(textParts("https://apple.example/")[0].warnHost).toBeUndefined();
  });

  it("warns when replies would go somewhere other than the sender", () => {
    expect(replyToWarning({ from: ALEX })).toBeNull();
    expect(replyToWarning({ from: ALEX, reply_to: "ALEX@example.com" })).toBeNull();
    expect(replyToWarning({ from: { name: "Your Bank", address: "alerts@bank.example" }, reply_to: "help@b4nk-support.example" }))
      .toBe("Replies go to help@b4nk-support.example, not to alerts@bank.example.");
  });

  it("notices a display name that shows another address", () => {
    expect(nameHidesAddress({ name: "support@bank.example", address: "x@evil.example" })).toBe(true);
    expect(nameHidesAddress({ name: "Alex (alex@example.com)", address: "alex@example.com" })).toBe(false);
    expect(nameHidesAddress(ALEX)).toBe(false);
  });

  it("routes", () => {
    expect(SCREEN_MODULE["/mail"]).toBe("mail_inbox");
    expect(moduleOfScreen("/mail")).toBe("mail_inbox");
  });

  it("the Mail screen shows mail HTML only in a frame where nothing runs, and links only what textParts checked", () => {
    const src = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");
    expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML|renderMarkdown|insertAdjacentHTML|document\.write/);
    // The hub's cleaned page goes in one iframe, sandboxed without scripts, forms or navigation of the app. Popups are
    // allowed (and leave the sandbox) only so that WebKit, which runs none of the screen's listeners in the frame, can
    // open a link the user clicks; every link is checked first (checkFrameLinks), so only http, https and mailto open.
    expect(src.match(/<iframe[^>]*>/g)).toEqual([`<iframe ref={ref} className="mailx-frame" title={title} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={doc} />`]);
    expect(src).not.toMatch(/allow-scripts|allow-forms|allow-top-navigation|allow-modals|allow-downloads|allow-pointer-lock|allow-presentation|\.src\s*=/);
    // The links are checked on every load, before anything else reads the page.
    expect(src).toMatch(/const ready = \(\) => \{\n\s+const d = frame\.contentDocument;\n\s+if \(!d\) return;[\s\S]{0,1200}checkFrameLinks\(d\.querySelectorAll\("a\[href\], area\[href\]"\)\);/);
    // The only href from outside the app's own screens (#/...) is a piece textParts made and checked.
    expect((src.match(/href=\{[^}]+\}/g) ?? []).filter((h) => !h.startsWith("href={`#")).sort()).toEqual(["href={p.href}"]);
    expect(src.match(/<Parts parts=\{[^}]+\}/g)).toEqual(["<Parts parts={textParts(line)}"]);
  });

  it("opens a link from inside a mail only when it is http, https or mailto", () => {
    expect(frameLink("https://shop.example/a")).toBe("https://shop.example/a");
    expect(frameLink("mailto:help@shop.example")).toBe("mailto:help@shop.example");
    expect(frameLink("javascript:alert(1)")).toBeNull();
    expect(frameLink("file:///c:/x")).toBeNull();
    expect(frameLink(null)).toBeNull();
  });

  it("keeps only the links frameLink accepts, each opening in a new tab with no opener, no referrer and its real address shown", () => {
    const link = (attrs: Record<string, string>) => {
      const a = { attrs: { ...attrs } as Record<string, string>, getAttribute: (n: string) => a.attrs[n] ?? null, setAttribute: (n: string, v: string) => { a.attrs[n] = v; }, removeAttribute: (n: string) => { delete a.attrs[n]; } };
      return a;
    };
    const ok = link({ href: "https://shop.example/a b", title: "https://other.example/", ping: "https://track.example/", target: "_top", referrerpolicy: "unsafe-url", download: "x" });
    const mail = link({ href: "mailto:help@shop.example" });
    const bad = ["javascript:alert(1)", "data:text/html,hi", "file:///etc/hosts", "/relative", "relative", "//shop.example/x", "vbscript:x", " JAVASCRIPT:alert(1)"].map((href) => link({ href, target: "_self", title: "https://shop.example/", rel: "opener" }));
    checkFrameLinks([ok, mail, ...bad]);
    expect(ok.attrs).toEqual({ href: "https://shop.example/a%20b", title: "https://shop.example/a%20b", target: "_blank", rel: "noopener noreferrer" });
    expect(mail.attrs).toEqual({ href: "mailto:help@shop.example", title: "mailto:help@shop.example", target: "_blank", rel: "noopener noreferrer" });
    for (const b of bad) expect(b.attrs).toEqual({});
  });

  it("takes a click and a middle click on a link inside a mail, so the page never follows one itself", () => {
    const on = (href: string | null) => ({ closest: (sel: string) => (sel === "a" ? { getAttribute: () => href } : null) });
    const off = { closest: () => null };
    expect(frameClick({ type: "click", button: 0, target: on("https://shop.example/a") })).toEqual({ open: "https://shop.example/a" });
    // Firefox opens a middle-clicked link in a new tab by itself (an auxclick, not a click) unless the screen takes it.
    expect(frameClick({ type: "auxclick", button: 1, target: on("https://shop.example/a") })).toEqual({ open: "https://shop.example/a" });
    // A link frameLink refuses is still taken, and opens nothing.
    expect(frameClick({ type: "auxclick", button: 1, target: on("javascript:alert(1)") })).toEqual({ open: null });
    expect(frameClick({ type: "click", button: 0, target: on(null) })).toEqual({ open: null });
    // Not a link, or the right button (its menu stays the browser's): left alone.
    expect(frameClick({ type: "click", button: 0, target: off })).toBeNull();
    expect(frameClick({ type: "auxclick", button: 2, target: on("https://shop.example/a") })).toBeNull();
    expect(frameClick({ type: "click", button: 0, target: null })).toBeNull();
    const src = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");
    expect(src).toMatch(/d\.addEventListener\("auxclick", onClick\)/);
  });
});

describe("mail batches", () => {
  it("a selection of any size goes to the hub 500 at a time", async () => {
    const { batches, BATCH_MAX } = await import("./mail");
    const ids = Array.from({ length: 1201 }, (_, i) => String(i));
    const parts = batches(ids);
    expect(parts.map((p) => p.length)).toEqual([BATCH_MAX, BATCH_MAX, 201]);
    expect(parts.flat()).toEqual(ids);
    expect(batches([])).toEqual([]);
  });
});

describe("mail cards", () => {
  it("says a card's facts in one line, in the order a person looks for them", () => {
    expect(cardLine({ kind: "package", source: "text", title: "UPS", number: "1Z999AA10123456784" })).toBe("UPS · 1Z999AA10123456784");
    expect(cardLine({ kind: "flight", source: "sender", title: "Example Air", number: "EA 110", from: "SFO", to: "JFK" })).toBe("EA 110 · SFO → JFK");
    expect(cardLine({ kind: "bill", source: "text", title: "City Water", amount: "$61.50", at: "2026-12-15" })).toBe(`City Water · $61.50 due · By ${cardTime("2026-12-15")}`);
    expect(cardLine({ kind: "order", source: "sender" })).toBe("");
  });

  it("shows a day without a time as that day wherever the device is", () => {
    // A day is read as the device's own midnight, never as UTC's (which is the day before in the Americas).
    expect(cardTime("2026-12-15")).toBe(new Date(2026, 11, 15).toLocaleString([], { weekday: "short", month: "short", day: "numeric" }));
    expect(cardTime("2026-12-03T16:00:00.000Z")).toMatch(/\d:\d\d/);
    expect(cardTime("soon")).toBe("");
  });

  it("opens a card's link only when it is https", () => {
    expect(cardLink({ kind: "package", source: "sender", url: "https://track.example/1" })).toBe("https://track.example/1");
    expect(cardLink({ kind: "package", source: "sender", url: "http://track.example/1" })).toBeNull();
    expect(cardLink({ kind: "package", source: "sender", url: "javascript:alert(1)" })).toBeNull();
    expect(cardLink({ kind: "package", source: "sender", url: "https://a:b@track.example/1" })).toBeNull();
    expect(cardLink({ kind: "package", source: "text" })).toBeNull();
  });
});

describe("mail swipes", () => {
  it("is a swipe only once it moves clearly sideways, so scrolling never swipes", () => {
    expect(swipeLock(6, 2)).toBeNull();
    expect(swipeLock(30, 5)).toBe("h");
    expect(swipeLock(-30, 5)).toBe("h");
    expect(swipeLock(20, 18)).toBe("v");
    expect(swipeLock(2, 40)).toBe("v");
  });

  it("acts only when let go far enough: right is Done, left is Snooze", () => {
    expect(swipeAction(130, 375)).toBe("done");
    expect(swipeAction(-130, 375)).toBe("snooze");
    expect(swipeAction(80, 375)).toBeNull();
    expect(swipeAction(-80, 375)).toBeNull();
    expect(swipeAction(75, 200)).toBe("done");
    expect(swipeAction(60, 200)).toBeNull();
  });
});

describe("mail trips", () => {
  const mail = (id: string, cards: MailCard[]): MailSummary => ({ id, at: "2026-11-20T12:00:00Z", from: { name: "", address: "x@air.example" }, subject: id, preview: "", automated: true, bundle: "trips", state: "inbox", pinned: false, seen: true, cards });
  // Flight times in this machine's own time zone: a date-only stay is placed at 3 PM local, so a fixed UTC time would sort
  // differently on a machine in UTC than on one in the Americas.
  const local = (d: number, h: number, m = 0) => new Date(2026, 11, d, h, m).toISOString();
  const out = mail("out", [{ kind: "flight", source: "sender", number: "EA 110", from: "SFO", to: "JFK", at: local(3, 8), until: local(3, 13, 30) }]);
  const hotel = mail("hotel", [{ kind: "stay", source: "sender", title: "Harbor Inn", at: "2026-12-03", until: "2026-12-06" }]);
  const back = mail("back", [{ kind: "flight", source: "sender", number: "EA 111", from: "JFK", to: "SFO", at: local(6, 10) }]);
  const now = Date.parse("2026-11-20T12:00:00Z");

  it("groups the flight out, the hotel and the flight back as one trip, named by where the first flight lands", () => {
    const [t, ...others] = tripsOf([back, hotel, out], now);
    expect(others).toEqual([]);
    expect(t.name).toBe("Trip to JFK");
    expect(t.parts.map((p) => p.mail.id)).toEqual(["out", "hotel", "back"]);
    expect(tripDates(t)).toBe(`${new Date(2026, 11, 3).toLocaleDateString([], { month: "short", day: "numeric" })} to 6`);
  });

  it("needs two mails, never starts with a booking, and keeps trips weeks apart separate", () => {
    expect(tripsOf([out], now)).toEqual([]);
    const dinner = mail("dinner", [{ kind: "table", source: "sender", title: "Bistro", at: "2026-11-28T19:00:00Z" }]);
    const show = mail("show", [{ kind: "event", source: "sender", title: "Concert", at: "2026-11-28T21:00:00Z" }]);
    expect(tripsOf([dinner, show], now)).toEqual([]); // a dinner and a show at home are no trip
    const later = mail("later", [{ kind: "stay", source: "sender", title: "Lake Lodge", at: "2027-01-10", until: "2027-01-12" }]);
    const car = mail("car", [{ kind: "booking", source: "sender", title: "Car hire", at: "2027-01-10T15:00:00Z" }]);
    expect(tripsOf([out, hotel, back, later, car], now).map((t) => t.name)).toEqual(["Trip to JFK", "Stay at Lake Lodge"]);
  });

  it("lists trips not over yet first, the soonest first, then past ones", () => {
    const old1 = mail("o1", [{ kind: "flight", source: "sender", to: "LAX", at: "2026-10-01T10:00:00Z" }]);
    const old2 = mail("o2", [{ kind: "stay", source: "sender", title: "Beach Hotel", at: "2026-10-01", until: "2026-10-04" }]);
    expect(tripsOf([old1, old2, out, hotel], now).map((t) => t.name)).toEqual(["Trip to JFK", "Trip to LAX"]);
  });

  it("ignores cards without a date, and cards read from text", () => {
    const conf = mail("conf", [{ kind: "booking", source: "text", number: "X7K2PQ" }]);
    expect(tripsOf([out, conf], now)).toEqual([]);
  });
});

describe("mail folders", () => {
  const f = (role: MailFolder["role"], name = "x", count = 3, unread = 2): MailFolder => ({ key: "k", email: "robin@icloud.example", role, name, count, unread, more: false });
  it("names iCloud's folders as the screen does (Junk is Spam), and the owner's by their own name", () => {
    expect([f("drafts"), f("sent"), f("junk"), f("trash"), f("own", "Taxes")].map((x) => folderLabel(x))).toEqual(["Drafts", "Sent", "Spam", "Trash", "Taxes"]);
    expect(folderLabel(f("sent"), true)).toBe("Sent (robin@icloud.example)");
    // With several mailboxes the side list heads each one's folders with its address, each mailbox once, in order.
    const other = (role: MailFolder["role"]) => ({ ...f(role), email: "Robin@Larkspur.example" });
    const groups = folderGroups([f("drafts"), other("drafts"), f("sent"), { ...other("sent"), email: "robin@larkspur.example" }, f("own", "Taxes")]);
    expect(groups.map((g) => [g.email, g.folders.map((x) => folderLabel(x))])).toEqual([["robin@icloud.example", ["Drafts", "Sent", "Taxes"]], ["Robin@Larkspur.example", ["Drafts", "Sent"]]]);
    expect(folderGroups([])).toEqual([]);
    // In the order the mailboxes are listed everywhere else, whatever order the folders come in.
    const mixed = [other("drafts"), f("drafts"), other("sent"), f("sent")];
    expect(folderGroups(mixed, [{ email: "robin@icloud.example" }, { email: "robin@larkspur.example" }]).map((g) => g.email)).toEqual(["robin@icloud.example", "Robin@Larkspur.example"]);
    expect(folderGroups(mixed).map((g) => g.email)).toEqual(["Robin@Larkspur.example", "robin@icloud.example"]);
  });
  it("counts drafts, and unread mail where it matters (not in Sent or Trash)", () => {
    expect([f("drafts"), f("sent"), f("junk"), f("trash"), f("own")].map(folderCount)).toEqual([3, 0, 2, 0, 2]);
  });
  it("names who the owner wrote to for Sent and Drafts, else the sender", () => {
    const m = (folder_role: MailFolder["role"]): FolderMail => ({ id: "1", at: "2026-11-20T10:00:00Z", from: { name: "Robin", address: "robin@icloud.example" }, to: [{ name: "Alex", address: "alex@example.com" }, { name: "", address: "sam@example.com" }], subject: "Hi", preview: "", automated: false, bundle: null, state: "folder", pinned: false, folder_role });
    expect(folderWho(m("sent"))).toBe("To: Alex, sam@example.com");
    expect(folderWho(m("junk"))).toBe("Robin");
  });
});

describe("mail move keys", () => {
  const k = (key: string) => mailKeyAction({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }, "list");
  it("Delete and Backspace delete, ! is spam, never while typing", () => {
    expect([k("Delete"), k("Backspace"), k("!")]).toEqual(["delete", "delete", "spam"]);
    expect(mailKeyAction({ key: "Backspace", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false }, "field")).toBeNull();
    expect(MAIL_KEYS.some((x) => x.keys === "Delete") && MAIL_KEYS.some((x) => x.keys === "!")).toBe(true);
  });
});

describe("mail attachments", () => {
  it("shows a preview only for a data: JPEG, PNG, GIF or WebP", () => {
    expect(previewSrc("data:image/png;base64,iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
    for (const bad of ["data:image/svg+xml;base64,PHN2Zz4=", "https://evil.example/x.png", "data:text/html;base64,PHNjcmlwdD4=", "javascript:alert(1)", undefined]) expect(previewSrc(bad)).toBeNull();
  });
  it("warns before files that can run a program, or hide one", () => {
    const risky = [
      "setup.exe", "invoice.pdf.exe", "run.JS", "report.xlsm", "photo.lnk", "disk.iso",
      // Old Office files and their macro forms.
      "letter.doc", "letter.dot", "budget.xls", "budget.xlt", "slides.ppt", "slides.pps", "letter.docm", "budget.xlsb", "budget.xlam", "slides.pptm", "notes.one",
      // Scripts.
      "a.js", "a.mjs", "a.jse", "a.vbs", "a.vbe", "a.wsf", "a.hta", "a.ps1", "a.psm1", "a.bat", "a.cmd", "a.sh", "a.zsh", "a.py", "a.pyw", "a.rb", "a.pl", "a.php", "a.scpt", "a.reg",
      // Pages a browser runs scripts in.
      "drawing.svg", "page.html", "page.htm", "page.xhtml", "page.mht", "help.chm",
      // Shortcuts.
      "site.url", "site.webloc", "app.desktop", "find.search-ms",
      // Installers, programs and disk images.
      "a.msi", "a.msix", "a.appx", "a.pkg", "a.dmg", "a.apk", "a.deb", "a.rpm", "a.img", "a.vhd", "a.scr", "a.com", "a.jar", "a.dll", "a.app", "a.command",
      // Archives, which hide what is in them.
      "a.zip", "a.rar", "a.7z", "a.tar", "a.tgz", "a.gz", "a.bz2", "a.xz", "a.cab",
      // The name's real ending: capitals, and dots and spaces after it, change nothing.
      "SETUP.EXE", "setup.exe.", "setup.exe . ", " setup.exe ",
    ];
    for (const n of risky) expect(riskyFile(n), n).toBe(true);
    // A name written with a character that turns the text around shows another ending than it has ("invoicetxt.pdf").
    expect(riskyFile("invoice\u202efdp.txt")).toBe(true);
    expect(riskyFile("notes\u2066.txt")).toBe(true);
    for (const n of ["photo.jpg", "photo.heic", "tickets.pdf", "notes.txt", "budget.xlsx", "letter.docx", "slides.pptx", "table.csv", "song.mp3", "invite.ics", "exe", "zip file", "my.exercises.txt"]) expect(riskyFile(n), n).toBe(false);
  });
  it("says sizes as people read them", () => {
    expect([fileSize(512), fileSize(840_000), fileSize(2_500_000), fileSize(25_000_000)]).toEqual(["512 B", "820 KB", "2.4 MB", "24 MB"]);
  });
});

describe("mail search hits", () => {
  it("names where a hit is", () => {
    expect(whereLabel({ where: "inbox", state: "inbox" })).toBe("Inbox");
    expect(whereLabel({ where: "junk", state: "folder" })).toBe("Spam");
    expect(whereLabel({ where: "sent", state: "sent" })).toBe("Your reply");
    expect(whereLabel({ where: "sent", state: "folder" })).toBe("Sent");
    expect(whereLabel({ where: "own", folder_name: "Taxes", state: "folder" })).toBe("Taxes");
  });
});

describe("mail triage digest", () => {
  const m = (id: string, at: string, triage?: MailSummary["triage"], state: MailSummary["state"] = "inbox"): MailSummary => ({ id, at, from: { name: "", address: "a@x.example" }, subject: id, preview: "", automated: false, bundle: null, state, pinned: false, ...(triage ? { triage } : {}) });
  it("today's first, then those needing a reply, never done or untriaged mail, at most 5", () => {
    const list = [
      m("reply-old", "2026-11-19T10:00:00Z", { urgency: "soon", needs_reply: true }),
      m("today", "2026-11-18T10:00:00Z", { urgency: "today", needs_reply: false }),
      m("reply-new", "2026-11-20T10:00:00Z", { urgency: "fyi", needs_reply: true }),
      m("low", "2026-11-20T11:00:00Z", { urgency: "low", needs_reply: false }),
      m("done", "2026-11-20T12:00:00Z", { urgency: "today", needs_reply: true }, "done"),
      m("plain", "2026-11-20T13:00:00Z"),
    ];
    expect(needsYou(list, shownBundles(allOn)).map((x) => x.id)).toEqual(["today", "reply-new", "reply-old"]);
    expect(needsYou(Array.from({ length: 9 }, (_, i) => m(`t${i}`, `2026-11-2${i % 9}T10:00:00Z`, { urgency: "today", needs_reply: false })), shownBundles(allOn))).toHaveLength(5);
  });
  it("names only mail the Inbox lists: not mail a bundle holds back for later, or keeps out of the Inbox", () => {
    const shown = shownBundles(allOn);
    const now = new Date(2026, 10, 19, 12);
    const at = new Date(2026, 10, 19, 10, 30).toISOString();
    const t = { urgency: "today" as const, needs_reply: false };
    const never = { ...m("never", at, t), bundle: "other", automated: true };
    const later = { ...m("later", at, t), bundle: "promos", automated: true };
    const pinned = { ...m("pinned", at, t), bundle: "promos", automated: true, pinned: true };
    const bundled = { ...m("bundled", at, t), bundle: "purchases", automated: true };
    const delivery = { other: { mode: "never" as const }, promos: { mode: "daily" as const, time: "18:00" } };
    expect(needsYou([never, later, pinned, bundled], shown, { delivery, now }).map((x) => x.id).sort()).toEqual(["bundled", "pinned"]);
    // Once the bundle's time has come, its mail is in the Inbox and in the digest.
    expect(needsYou([later], shown, { delivery, now: new Date(2026, 10, 19, 19) }).map((x) => x.id)).toEqual(["later"]);
  });
  it("opens a mail that is inside a bundle's row by opening that row first", () => {
    const shown = shownBundles(allOn);
    const now = new Date(2026, 10, 19, 15);
    const day = (h: number) => new Date(2026, 10, 19, h).toISOString();
    const [order, person, held] = threadRows([
      { ...m("order", day(9), { urgency: "today", needs_reply: false }), bundle: "purchases", automated: true },
      m("person", day(10), { urgency: "soon", needs_reply: true }),
      { ...m("held", day(11), { urgency: "today", needs_reply: false }), bundle: "other", automated: true },
    ]);
    const screen = inboxScreen([order, person, held], shown, { now, delivery: { other: { mode: "never" } } });
    expect(screen.needs.map((x) => x.id)).toEqual(["order", "person"]);
    // The bundled one is not on the screen until its row is open: the place says which row to open.
    expect(inboxPlace(screen.sections, order.key)).toEqual({ row: "Today:purchases" });
    expect(inboxPlace(screen.sections, person.key)).toEqual({ row: null });
    expect(inboxPlace(screen.sections, held.key)).toBeNull();
    const closed = screenRows({ kind: "inbox", inbox: screen, openBundles: new Set() });
    expect(closed).not.toContain(order.key);
    expect(screenRows({ kind: "inbox", inbox: screen, openBundles: new Set(["Today:purchases"]) })).toContain(order.key);
    const src = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");
    expect(src).toMatch(/className="mailx-need" onClick=\{\(\) => show\(m\)\}/);
    expect(src).toMatch(/const place = inboxPlace\(inboxSections\(threads, shown, \{ delivery \}\), t\.key\);\n\s+if \(place\?\.row\) \{ const row = place\.row; setOpenBundles\(\(s\) => new Set\(s\)\.add\(row\)\); \}/);
  });
});

describe("mail folding notes", () => {
  it("offers the first lines the fold hides", () => {
    const text = "Sounds good.\n\nOn Monday Alex wrote:\n\n  The pipe must go.  \n> a\n> b\n> c\n> d\n> e\n> f\n> g";
    expect(foldedLines(text, text.indexOf("On Monday"))).toEqual(["On Monday Alex wrote:", "The pipe must go.", "> a", "> b", "> c", "> d", "> e", "> f"]);
    expect(foldedLines(text, undefined)).toEqual([]);
  });
});

describe("mail select all", () => {
  it("selects every shown mail, or none when all are; never one out of sight", () => {
    const shown = ["a", "b", "c"];
    expect(selectAll(shown, new Set(["a"]))).toEqual({ next: new Set(["a", "b", "c"]), state: "some" });
    expect(selectAll(shown, new Set(["a", "b", "c"]))).toEqual({ next: new Set(), state: "all" });
    expect(selectAll(shown, new Set(["x"])).next).toEqual(new Set(["a", "b", "c"])); // one no longer shown is dropped
    expect(selectAll([], new Set()).state).toBe("none");
  });
});

describe("mail snooze review", () => {
  it("lists snoozed mail coming back later today, soonest first", () => {
    const now = new Date(2026, 10, 22, 9, 0);
    const m = (id: string, until: Date | null, state: MailSummary["state"] = "snoozed"): MailSummary => ({ id, at: "2026-11-20T10:00:00Z", from: { name: "", address: "a@x.example" }, subject: id, preview: "", automated: false, bundle: null, state, pinned: false, ...(until ? { snooze_until: until.toISOString() } : {}) });
    const list = [m("evening", new Date(2026, 10, 22, 18, 0)), m("noon", new Date(2026, 10, 22, 12, 0)), m("tomorrow", new Date(2026, 10, 23, 8, 0)), m("passed", new Date(2026, 10, 22, 8, 0)), m("inbox", new Date(2026, 10, 22, 12, 0), "inbox")];
    expect(backLaterToday(list, now).map((x) => x.id)).toEqual(["noon", "evening"]);
  });
});

describe("mail bundle ids", () => {
  const css = fs.readFileSync(path.join(__dirname, "../styles.css"), "utf8");
  const screen = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");
  it("keeps the ids the apps already on people's devices know, under the new names and in the new order", () => {
    expect(BUNDLES.map((b) => [b.id, b.name])).toEqual([["purchases", "Transactions"], ["other", "Updates"], ["promos", "Promotions"], ["trips", "Trips"], ["bills", "Bills"], ["pet", "Pet"]]);
    expect(new Set(Object.values(CARD_ICON))).toEqual(new Set(["purchases", "trips", "bills"]));
  });
  it("has a color, a bar, a side list entry and an icon for every bundle id, and nothing under the renamed ids", () => {
    for (const { id } of BUNDLES) {
      expect(css, id).toContain(`--b-${id}: #`);
      expect(css, id).toContain(`--bt-${id}: #`);
      expect(css, id).toContain(`.mailx-bar.b-${id} { --barc: var(--b-${id}); }`);
      expect(css, id).toContain(`.mailx-nav.b-${id},`);
      expect(screen, id).toMatch(new RegExp(`\\n  ${id}: "M`));
    }
    // Social went on 2026-11-22, Jobs with Job search on 2026-11-25.
    for (const gone of ["transactions", "updates", "promotions", "social", "jobs"]) {
      expect(css, gone).not.toMatch(new RegExp(`b-${gone}|bt-${gone}`));
      expect(screen, gone).not.toMatch(new RegExp(`\\n  ${gone}: "M`));
    }
  });
});

describe("mail keys act only on what is on the screen", () => {
  const shown = shownBundles(allOn);
  const now = new Date(2026, 10, 19, 15);
  const day = (h: number) => new Date(2026, 10, 19, h).toISOString();
  const s = (id: string, over: Partial<MailSummary> = {}): MailSummary => ({ id, at: day(9), from: ALEX, subject: id, preview: "", automated: false, bundle: null, state: "inbox", pinned: false, ...over });
  const threads = threadRows([
    s("alex", { at: day(10) }),
    s("order", { at: day(9), automated: true, bundle: "purchases" }),
    s("receipt", { at: day(8), automated: true, bundle: "purchases" }),
    s("snoozed", { state: "snoozed", snooze_until: new Date(2026, 10, 19, 18).toISOString() }),
    s("done", { state: "done" }),
  ]);
  const reminders = [{ id: "task1", title: "Call the plumber", at: day(8), friction: "none" }];
  const inbox = (open: string[] = [], searching = false) => ({ kind: "inbox" as const, inbox: inboxScreen(threads, shown, { now, searching, reminders }), openBundles: new Set(open) });
  const src = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");

  it("a folder's view lists none of the Inbox's threads: the keys walked them there, and Delete moved one to Trash", () => {
    expect(viewMessages(threads, "f:abc", shown)).toEqual([]);
    expect(viewMessages(threads, "inbox", shown).map((m) => m.key)).toEqual(["alex", "order", "receipt"]);
    const rows = screenRows({ kind: "folder", mails: [{ id: "f1" }, { id: "f2" }] });
    expect(rows).toEqual([folderRow("f1"), folderRow("f2")]);
    for (const t of threads) expect(rows).not.toContain(t.key);
  });

  it("walks the Inbox as it is drawn: back later today, the reminders, each mail, a bundle's row, and its mail only while it is open", () => {
    expect(screenRows(inbox())).toEqual(["snoozed", reminderRow("task1"), "alex", "bundle:Today:purchases"]);
    expect(screenRows(inbox(["Today:purchases"]))).toEqual(["snoozed", reminderRow("task1"), "alex", "bundle:Today:purchases", "order", "receipt"]);
    // While searching (or showing pinned mail only) there is the mail itself and nothing else; the search's hits follow it.
    expect(screenRows(inbox([], true), [{ id: "alex" }, { id: "h2" }])).toEqual(["alex", "bundle:Today:purchases", hitRow("alex"), hitRow("h2")]);
  });

  it("walks a flat view as it is drawn, and a trip's mail once, where its first piece is", () => {
    expect(screenRows({ kind: "flat", flat: flatScreen(viewMessages(threads, "done", shown), null) })).toEqual(["done"]);
    expect(screenRows({ kind: "flat", flat: flatScreen(viewMessages(threads, "snoozed", shown), null) })).toEqual(["snoozed"]);
    const trip = (id: string, cards: MailCard[]) => s(id, { automated: true, bundle: "trips", cards });
    const local = (d: number, h: number) => new Date(2026, 11, d, h).toISOString();
    const [both, hotel, other] = threadRows([
      trip("both", [{ kind: "flight", source: "sender", to: "JFK", at: local(3, 8) }, { kind: "flight", source: "sender", to: "SFO", at: local(6, 10) }]),
      trip("hotel", [{ kind: "stay", source: "sender", title: "Harbor Inn", at: "2026-12-03", until: "2026-12-06" }]),
      trip("other", []),
    ]);
    const flat = flatScreen([other, hotel, both], "trips", now.getTime());
    expect(flat.trips.map((t) => t.parts.map((p) => p.mail.key))).toEqual([["both", "hotel", "both"]]);
    expect(screenRows({ kind: "flat", flat })).toEqual(["both", "hotel", "other"]);
  });

  it("acts on the selection, else the open mail, else the highlighted row, and never on one that is not on the screen", () => {
    const rows = screenRows(inbox());
    const none = new Set<string>();
    expect(keyTarget(rows, { selected: new Set(["alex", "order"]), open: "snoozed", cursor: "snoozed" })).toEqual(["alex"]);
    expect(keyTarget(rows, { selected: none, open: "alex", cursor: "snoozed" })).toEqual(["alex"]);
    expect(keyTarget(rows, { selected: none, open: null, cursor: "snoozed" })).toEqual(["snoozed"]);
    expect(keyTarget(rows, { selected: none, open: null, cursor: null })).toEqual([]);
    // The review's case: an Inbox thread was highlighted, opened or selected, then a folder took the list's place.
    const folder = screenRows({ kind: "folder", mails: [{ id: "f1" }] });
    expect(keyTarget(folder, { selected: new Set(["alex"]), open: "alex", cursor: "alex" })).toEqual([]);
    expect(keyTarget(folder, { selected: none, open: null, cursor: folderRow("f1") })).toEqual([folderRow("f1")]);
    // The same with all mail with a person: only its hits are there, and a hit is not the thread of the same mail.
    const person = screenRows({ kind: "none" }, [{ id: "alex" }, { id: "h2" }]);
    expect(person).toEqual([hitRow("alex"), hitRow("h2")]);
    expect(keyTarget(person, { selected: new Set(["alex"]), open: "alex", cursor: "alex" })).toEqual([]);
    expect(keyTarget(person, { selected: none, open: null, cursor: hitRow("alex") })).toEqual([hitRow("alex")]);
    // And a mail in a bundle that was closed again: it is out of sight, so it is not acted on.
    expect(keyTarget(rows, { selected: new Set(["order"]), open: "order", cursor: "order" })).toEqual([]);
    expect(keyTarget(screenRows(inbox(["Today:purchases"])), { selected: new Set(["order"]), open: null, cursor: null })).toEqual(["order"]);
  });

  it("does only what applies to the row: everything on a thread, and nothing on a search hit or a bundle's row", () => {
    const acts: MailKey[] = ["done", "snooze", "pin", "unread", "read", "delete", "spam"];
    expect([rowKind("alex"), rowKind("bundle:Today:purchases"), rowKind(reminderRow("task1")), rowKind(folderRow("f1")), rowKind(hitRow("alex"))]).toEqual(["thread", "bundle", "reminder", "folder", "hit"]);
    expect(acts.filter((a) => rowTakes("thread", a))).toEqual(acts);
    expect(acts.filter((a) => rowTakes("hit", a))).toEqual([]);
    expect(acts.filter((a) => rowTakes("bundle", a))).toEqual([]);
    expect(acts.filter((a) => rowTakes("reminder", a))).toEqual(["done", "snooze"]);
    // A folder's mail: Delete, and only where the folder's own Delete button has an Undo.
    const inFolder = (role: MailFolder["role"]) => acts.filter((a) => rowTakes("folder", a, role));
    expect([inFolder("junk"), inFolder("own")]).toEqual([["delete"], ["delete"]]);
    expect([inFolder("trash"), inFolder("sent"), inFolder("drafts")]).toEqual([[], [], []]);
    expect(rowTakes("folder", "delete")).toBe(false);
    expect([folderActs("junk"), folderActs("trash"), folderActs("own"), folderActs("sent"), folderActs("drafts")]).toEqual([
      { inbox: true, trash: true, undo: true, move: false },
      { inbox: true, trash: false, undo: true, move: false },
      { inbox: true, trash: true, undo: true, move: true },
      { inbox: false, trash: true, undo: false, move: false },
      { inbox: false, trash: true, undo: false, move: false },
    ]);
  });

  it("the screen draws its lists from the same value its keys' rows come from, and takes the keys' target from those rows", () => {
    expect(src).toContain("const rows = screenRows(shownList, found.err ? [] : found.hits ?? []);");
    expect(src).toContain("const ids = keyTarget(rows, { selected, open, cursor });");
    expect(src).toContain("<InboxList screen={shownList.inbox}");
    expect(src).toContain("<Flat flat={shownList.flat}");
    expect(src).toContain('{ kind: "folder", mails: folderList }');
    expect(src).toContain("<FolderView f={folder} mails={folderList}");
    // The hits listed are the hits walked: both come from `found`.
    expect(src.match(/<HitList [^>]*found=\{found\}/g)).toHaveLength(2);
  });

  it("Undo of Delete, Spam or Move asks the hub to move the mail back and loads the list again: where it lands is the hub's to say", () => {
    const fn = src.slice(src.indexOf('const relocate: LookValue["relocate"]'), src.indexOf('const unsnooze: LookValue["unsnooze"]'));
    // Said to the hub as an Undo (the last argument), so it puts the mail back as it was; a plain move does not.
    expect(fn).toContain('run: () => relocate(kept, back, "Moved back", null, true) });');
    expect(fn.trimEnd().endsWith("await list.reload();\n  };")).toBe(true);
    expect(fn).not.toMatch(/setView|setOpen\(|mailUndo|mailDone|state ===/);
  });
});

describe("mail keys and the focus", () => {
  /** A stand-in for the element with the focus: it is, or is inside, whatever `inside` names. */
  const el = (...inside: string[]) => ({ closest: (selector: string) => (selector.split(", ").some((x) => inside.includes(x)) ? {} : null) });
  const press = (key: string, focus: KeyFocus, more: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
    mailKeyAction({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...more }, focus);
  const keys = ["Backspace", "Delete", "d", "D", "s", "p", "u", "r", "!", "/", "?", "ArrowDown", "ArrowUp", "Enter", " "];

  it("knows where the focus is: in a writing box (on any part of it), in a field, on another control, or on the list", () => {
    expect(WRITING_BOX).toBe("[data-writing]");
    expect([keyFocus(el(WRITING_BOX, "textarea")), keyFocus(el(WRITING_BOX, "button")), keyFocus(el(WRITING_BOX))]).toEqual(["writing", "writing", "writing"]);
    expect([keyFocus(el("input")), keyFocus(el("textarea")), keyFocus(el("select"))]).toEqual(["field", "field", "field"]);
    expect([keyFocus(el("button")), keyFocus(el("a[href]")), keyFocus(el("summary")), keyFocus(el("[role='checkbox']"))]).toEqual(["control", "control", "control", "control"]);
    // The screen's title takes the focus when the screen opens: that is the list's, like the page itself.
    expect([keyFocus(el("h1")), keyFocus(el("div")), keyFocus(null), keyFocus({})]).toEqual(["list", "list", "list", "list"]);
  });

  it("fires no shortcut while the focus is in a writing box, in a field, or on a button, link or menu: only Escape", () => {
    // The review's case: a suggested reply (a button of the writing box) was pressed, then Backspace, d and u were typed.
    for (const focus of ["writing", "field", "control"] as const) {
      for (const key of keys) expect(press(key, focus), `${key} with the focus on ${focus}`).toBeNull();
      expect(press("ArrowDown", focus, { shiftKey: true })).toBeNull();
      expect(press("Escape", focus)).toBe("escape");
    }
    for (const key of keys) expect(press(key, "list"), key).not.toBeNull();
  });

  it("fires none with Ctrl, Cmd or Alt held, wherever the focus is", () => {
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      for (const key of [...keys, "Escape"]) expect(press(key, "list", mod), key).toBeNull();
    }
  });

  it("a button clicked with the mouse gives the focus back to the list; one pressed with a key, or one in a writing box, does not", () => {
    expect(givesFocusBack(1, el("button"))).toBe(true);
    expect(givesFocusBack(2, el("button"))).toBe(true);
    expect(givesFocusBack(0, el("button"))).toBe(false);
    expect(givesFocusBack(1, el(WRITING_BOX, "button"))).toBe(false);
  });

  it("the writing box is marked in each of its faces, sends the focus back to its text after any of its buttons, and the keys ask where the focus is", () => {
    const src = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");
    // Writing, the preview and Saved; since 2026-11-24 also Sent, Sending (with Undo) and Not sent.
    expect(src.match(/data-writing=\{key\}/g)).toHaveLength(6);
    expect(src).toContain(`onClick={(e) => { if (e.target instanceof Element && e.target.closest("button[type='button'], .mailx-attach")) toText(); }}`);
    expect(src).toContain("const a = mailKeyAction(e, keyFocus(e.target));");
    expect(src).toContain("if (b && b === document.activeElement && givesFocusBack(e.detail, b)) b.blur();");
    // Every button in the screen's file says its type, so the writing box's handler misses none of its own.
    expect(src.match(/<button(?![^>]*\btype=)[^>]*>/g) ?? []).toEqual([]);
  });
});

describe("mail drafts", () => {
  const typed = { to: "alex@example.com", subject: "Gutters", text: "Saturday works.", greeting: "", signoff: null, withTheirs: false, kept: [] as { part: string }[] };
  const src = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");

  it("a changed draft always says which of its old attachments stay, an empty list too", () => {
    expect(draftRequest({ draft: "d1", from: "robin@northwind.example" }, { ...typed, kept: [{ part: "2" }, { part: "3.1" }] }, [], true))
      .toEqual({ to: "alex@example.com", subject: "Gutters", replaces: "d1", keep_parts: ["2", "3.1"], from: "robin@northwind.example", text: "Saturday works.", preview: true });
    const none = draftRequest({ draft: "d1", from: "robin@northwind.example" }, typed, [], false);
    expect(none).toMatchObject({ replaces: "d1", keep_parts: [] });
    expect("preview" in none).toBe(false);
  });

  it("asks for a reply, a forward and a new mail as the hub takes them", () => {
    expect(draftRequest({ reply: "m1", all: false }, { ...typed, greeting: "Hi Alex,", signoff: "  " }, [], true)).toEqual({ reply_to: "m1", text: "Saturday works.", greeting: "Hi Alex,", preview: true });
    expect(draftRequest({ reply: "m1", all: true }, typed, [], false)).toEqual({ reply_to: "m1", reply_all: true, text: "Saturday works." });
    const file = { name: "plan.pdf", type: "application/pdf", data: "AA==" };
    expect(draftRequest({ forward: "m1" }, { ...typed, withTheirs: true }, [file], false)).toEqual({ forward: "m1", to: "alex@example.com", forward_attachments: true, text: "Saturday works.", files: [file] });
    expect(draftRequest({ fresh: true }, typed, [], false)).toEqual({ to: "alex@example.com", subject: "Gutters", text: "Saturday works." });
    expect(draftRequest({ fresh: true }, { ...typed, from: "robin@northwind.example" }, [], false)).toMatchObject({ from: "robin@northwind.example" });
    // Only a changed draft names old attachments.
    for (const what of [{ reply: "m1", all: false }, { forward: "m1" }, { fresh: true as const }]) expect("keep_parts" in draftRequest(what, { ...typed, kept: [{ part: "2" }] }, [], false)).toBe(false);
  });

  it("the writing box reads a draft whole before it can be saved, shows its kept files with Remove, Bcc like Cc, and says when only the words are kept", () => {
    expect(src).toContain('const FORMATTED_DRAFT = "This draft has formatting from another mail app. Saving it here keeps its words only. The old version goes to Trash.";');
    expect(src).toContain("{draft && typed.ready && <div className=\"muted small\">{typed.html ? FORMATTED_DRAFT :");
    expect(src).toContain('{!!preview.bcc?.length && <><dt>Bcc</dt><dd>{preview.bcc.join(", ")}</dd></>}');
    expect(src).toContain("onClick={() => set({ kept: kept.filter((x) => x.part !== a.part) }, false)}>Remove</button>");
    // Nothing is previewed or saved before the draft's words and attachments are read: half of it would drop the rest.
    expect(src).toMatch(/onSubmit=\{\(e\) => \{ e\.preventDefault\(\); if \(typed\.ready\) void ask\(true\); \}\}/);
    expect(src).toMatch(/<button type="submit" className="primary" disabled=\{busy \|\| !typed\.ready \|\|/);
    expect(src).toContain("Promise.all([c.mailMessage(draft.m.id), draft.m.attachments === undefined ? { attachments: [] as MailAttachment[] } : c.mailAttachments(draft.m.id)])");
  });
});

describe("mail writing is kept", () => {
  const src = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");

  it("keeps what is typed with the screen, not with the box: Reply and Reply all are one box, and a box opens again as it was", () => {
    expect(src).toContain('<Composer key="reply" reply={m} all={w === "all"} close={() => setW(null)} />');
    expect(src).toContain("useState<Typed>(() => WRITING.typed.get(key) ?? {");
    expect(src).toContain("WRITING.typed.set(key, next);");
    expect(src).toContain("const [composing, setComposing] = useState(() => WRITING.open.has(NEW_MAIL));");
    expect(src).toContain("const [open, setOpen] = useState(startOpen || WRITING.open.has(m.id));");
  });

  it("asks before typed words are thrown away, by Discard or by moving the mail they were written on", () => {
    expect(src).toContain('if (now.current.dirty && !window.confirm("Discard what you wrote? It is not saved to Drafts.")) return;');
    expect(src).toContain('if (written.length && !window.confirm("What you wrote here is not saved to Drafts. Move the mail and discard what you wrote?")) return;');
    // Only these let typed words go: Save draft, Discard, the mail they were written on moving away, and since
    // 2026-11-24 the mail sent, or saved as a draft after it was not sent.
    expect(src.match(/WRITING\.typed\.delete\(/g)).toHaveLength(5);
  });

  it("a thread that left the list while a reply was being typed in it is shown where it is now", () => {
    const threads = new Map(threadRows([mail({ id: "a1", thread: "ta" }), mail({ id: "b1", thread: "tb" })]).map((t) => [t.key, t]));
    const lost = { id: "a1", at: 10_000 };
    // New mail woke it from Snoozed: it is not among the rows any more, and its writing box went away a moment ago.
    expect(threadToFollow("ta", ["tb"], lost, threads, 10_200)?.key).toBe("ta");
    // Still on the screen (it only moved in the list), no box lost, a box lost long ago, or a box under another mail: not followed.
    expect(threadToFollow("ta", ["tb", "ta"], lost, threads, 10_200)).toBeNull();
    expect(threadToFollow("ta", ["tb"], null, threads, 10_200)).toBeNull();
    expect(threadToFollow("ta", ["tb"], lost, threads, 12_000)).toBeNull();
    expect(threadToFollow("ta", ["tb"], { id: "b1", at: 10_000 }, threads, 10_200)).toBeNull();
    // A thread that is gone altogether (deleted on another device) has nowhere to be shown.
    expect(threadToFollow("gone", ["tb"], lost, threads, 10_200)).toBeNull();
    expect(threadToFollow(null, ["tb"], lost, threads, 10_200)).toBeNull();
    expect(src).toContain("const follow = threadToFollow(open, rows, WRITING.lost, byKey);");
  });

  it("an open thread is the same card when new mail arrives in it: it is known by its thread, not by its newest mail", () => {
    const first = mail({ thread: "t1", at: at(2), subject: "Gutters" });
    const before = threadRows([first])[0];
    const after = threadRows([first, mail({ thread: "t1", at: at(1), subject: "Re: Gutters" })])[0];
    expect(after.id).not.toBe(before.id);
    expect(after.key).toBe(before.key);
    expect(threadRows([mail({ id: "solo" })])[0].key).toBe("solo");
    expect(src).toContain("<Row key={r.mail.key} m={r.mail} open={open === r.mail.key} setOpen={setOpen} />");
    // One mail or many, each is drawn the same way, so the first one (and a reply being written under it) stays when a second arrives.
    expect(src).toContain("<ThreadMessage key={x.id} m={x} single={single}");
  });
});

describe("mail from several mailboxes", () => {
  const box = (email: string, more: Partial<MailMailbox> = {}): MailMailbox => ({ email, last_refresh: null, last_error: null, more: false, ...more });
  const boxes = [box("robin@northwind.example", { provider: "iCloud", kind: "icloud" }), box("robin@larkspur.example", { provider: "Gmail", kind: "gmail" }), box("robin@fabrikam.example")];
  const f = (key: string, email: string, role: MailFolder["role"] = "own"): MailFolder => ({ key, email, role, name: key, count: 0, unread: 0, more: false });
  const folders = [f("taxes", "robin@northwind.example"), f("trash1", "robin@northwind.example", "trash"), f("school", "robin@northwind.example"), f("work", "robin@larkspur.example")];

  it("offers Move to only folders of the mail's own mailbox, and none for mail from several mailboxes", () => {
    expect(moveFolders(folders, ["robin@northwind.example"]).map((x) => x.key)).toEqual(["taxes", "school"]);
    expect(moveFolders(folders, ["Robin@Northwind.example"], "taxes").map((x) => x.key)).toEqual(["school"]);
    expect(moveFolders(folders, ["robin@larkspur.example"]).map((x) => x.key)).toEqual(["work"]);
    expect(moveFolders(folders, ["robin@northwind.example", "robin@northwind.example"]).map((x) => x.key)).toEqual(["taxes", "school"]);
    expect(moveFolders(folders, ["robin@northwind.example", "robin@larkspur.example"])).toEqual([]);
    expect(moveFolders(folders, [undefined])).toEqual([]);
    expect(moveFolders(folders, [])).toEqual([]);
  });

  it("knows a mail's mailbox: the one it names, else the only one linked", () => {
    expect(mailboxOf(boxes, "ROBIN@larkspur.example")?.kind).toBe("gmail");
    expect(mailboxOf(boxes, undefined)).toBeUndefined();
    expect(mailboxOf([boxes[0]], undefined)?.email).toBe("robin@northwind.example");
    expect(mailboxOf(boxes, "sam@fourthcoffee.example")).toBeUndefined();
  });

  it("names the provider and the mail app only as far as they are known", () => {
    expect([inProvider(boxes[0]), inProvider(boxes[1]), inProvider(boxes[2]), inProvider(undefined)]).toEqual(["in iCloud", "in Gmail", "in your mailbox", "in your mailbox"]);
    expect([mailApp(boxes[0]), mailApp(boxes[1]), mailApp(boxes[2]), mailApp(undefined)]).toEqual(["Apple Mail", "your mail app", "your mail app", "your mail app"]);
    // The screen names Apple Mail only through mailApp, and iCloud's Mail Drop only for an iCloud mailbox.
    const src = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");
    expect(src.match(/Apple Mail/g)).toHaveLength(1);
    expect(src).toContain('box?.kind === "icloud" ? "The files are more than 15 MB together. Send big files from Apple Mail (Mail Drop)."');
  });

  it("a new mail goes from the mailbox used last time while it is still linked, else from the first", () => {
    expect(fromChoice(boxes, "robin@larkspur.example")).toBe("robin@larkspur.example");
    expect(fromChoice(boxes, "sam@fourthcoffee.example")).toBe("robin@northwind.example");
    expect(fromChoice(boxes, null)).toBe("robin@northwind.example");
    expect(fromChoice([], null)).toBe("");
  });
});

describe("mail sorting by the hub's model", () => {
  it("says how much new mail is not sorted, with Sort new mail, only when the hub waits to be asked", () => {
    expect(triageRow(true, { waiting: 3, running: false, auto: false })).toEqual({ text: "3 new mails are not sorted yet.", button: true });
    expect(triageRow(true, { waiting: 1, running: false, auto: false })).toEqual({ text: "1 new mail is not sorted yet.", button: true });
    expect(triageRow(true, { waiting: 0, running: false, auto: false })).toBeNull();
    // A hub its owner set up to sort by itself after each refresh, the switch off, an older hub: nothing new.
    expect(triageRow(true, { waiting: 3, running: false, auto: true })).toBeNull();
    expect(triageRow(false, { waiting: 3, running: false, auto: false })).toBeNull();
    expect(triageRow(true, undefined)).toBeNull();
    expect(triageRow(undefined, undefined)).toBeNull();
  });

  it("while a run goes it says how much is left, with no button; after one that ended early, the hub's sentence and the button again", () => {
    expect(triageRow(true, { waiting: 5, running: true, auto: false })).toEqual({ text: "Sorting new mail: 5 left.", button: false });
    expect(triageRow(true, { waiting: 5, running: true, auto: true })).toEqual({ text: "Sorting new mail: 5 left.", button: false });
    const stopped = "Sorting stopped: a game is using the graphics card.";
    expect(triageRow(true, { waiting: 4, running: false, auto: false, stopped })).toEqual({ text: stopped, button: true });
    expect(triageRow(true, { waiting: 4, running: true, auto: false, stopped })?.text).toBe("Sorting new mail: 4 left.");
  });

  it("the screen asks the hub only when Sort new mail is pressed, looks again every 4 seconds while a run goes, and says when sorting runs", () => {
    const src = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");
    const api = fs.readFileSync(path.join(__dirname, "../sync/api.ts"), "utf8");
    expect(api).toContain('return this.req<TriageAnswer>("POST", "/mail/triage", {});');
    expect(src.match(/mailTriageNow\(\)/g)).toHaveLength(1);
    expect(src).toContain("onClick={async () => { setBusy(true); await act((c) => c.mailTriageNow()); setBusy(false); }}>Sort new mail</button>");
    // The timer runs only while a run goes, and is cleared when the run ends or the screen closes.
    expect(src).toMatch(/if \(!sorting\) return;\n\s+const t = setInterval\(\(\) => \{ if \(document\.visibilityState === "visible"\) void reload\(\); \}, 4000\);\n\s+return \(\) => clearInterval\(t\);\n\s+\}, \[sorting, reload\]\);/);
    expect(src).toContain('auto === undefined ? "" : auto ? "It runs after each refresh. " : "It runs when you press Sort new mail. "');
    // Only in the Inbox, and not while searching or showing pinned mail only.
    expect(src).toContain('const sort = shownList.kind === "inbox" && !searching && !pinnedOnly ? triageRow(list.data?.triage, list.data?.triage_state) : null;');
    // A hub that does not sort mail (an older one) gets no switch.
    expect(src).toContain('{typeof data.triage === "boolean" && <TriageSwitch on={data.triage} auto={data.triage_state?.auto} />}');
  });
});

describe("mail blocking a sender", () => {
  it("offers to undo a block: how many moved, and the mail to move back by its new ids", () => {
    expect(blockUndo({ blocked: ["sam@fourthcoffee.example"], moved: 2, failed: 0, to: { old1: "new1", old2: "new2" } }, "sam@fourthcoffee.example")).toEqual({ text: "Blocked sam@fourthcoffee.example: 2 moved to Spam", back: ["new1", "new2"] });
    expect(blockUndo({ blocked: ["@fourthcoffee.example"], moved: 0, failed: 0, to: {} }, "everyone at fourthcoffee.example")).toEqual({ text: "Blocked everyone at fourthcoffee.example", back: [] });
    // An older hub says only how many moved: there is nothing to move back by id.
    expect(blockUndo({ blocked: [], moved: 3 }, "sam@fourthcoffee.example")).toEqual({ text: "Blocked sam@fourthcoffee.example: 3 moved to Spam", back: [] });
  });

  it("asks before the page is left while something typed is not saved, and only then", () => {
    const leave = (unsaved: boolean) => {
      const e = { prevented: false, returnValue: undefined as unknown, preventDefault() { this.prevented = true; } };
      askBeforeLeaving(() => unsaved)(e);
      return [e.prevented, e.returnValue];
    };
    expect(leave(true)).toEqual([true, ""]);
    expect(leave(false)).toEqual([false, undefined]);
    // Set once for the page, over everything typed: to a mail (a reply, a forward, a changed draft) and a new mail.
    const src = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");
    expect(src).toContain('window.addEventListener("beforeunload", askBeforeLeaving(() => [...WRITING.typed.values()].some((t) => t.dirty)));');
    expect(src.match(/addEventListener\("beforeunload"/g)).toHaveLength(1);
  });

  it("Undo unblocks, then moves that mail back; what did not move is said, and a refused block shows the hub's sentence", () => {
    const src = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");
    expect(src).toMatch(/await c\.mailUnblock\(sender\);\n\s+for \(const part of batches\(undo\.back\)\) \{ const one = await c\.mailMove\(part, "inbox", true\); if \(one\.error\) throw new Error\(one\.error\); \}/);
    expect(src).toContain("await act(async () => { if (r.error) throw new Error(r.error); });");
    // The hub's own sentence, as it is: a refusal comes as an error with words, and plainError keeps a hub's words.
    expect(src).toContain("try { setMsg(await f()); } catch (e) { setErr(plainError(e)); }");
  });
});

describe("mail at a glance", () => {
  const src = fs.readFileSync(path.join(__dirname, "../views/Mail.tsx"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "../styles.css"), "utf8");

  it("moves mail only on a deliberate choice: the folder menu chooses, the Move button moves", () => {
    const menu = src.slice(src.indexOf("function MoveMenu("), src.indexOf("function FolderActions("));
    expect(menu).toContain("onChange={(e) => setTo(e.target.value)}");
    expect(menu).toContain("onClick={() => chosen && pick(chosen)}>Move</button>");
    expect(menu.match(/pick\(/g)).toHaveLength(1);
  });

  it("checks each picture's preview once, when the list arrives", () => {
    expect(src.match(/previewSrc\(/g)).toHaveLength(1);
    expect(src).toContain("const pics = useMemo(() => (list ?? []).flatMap((a) => { const src = previewSrc(a.preview); return src ? [{ a, src }] : []; }), [list]);");
  });

  it("never cuts a file's name by code (a cut in the middle of an emoji leaves half a character): the page shortens it, with an ellipsis", () => {
    expect(css).toContain(".mailx-att-list .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }");
    expect(src).not.toMatch(/name\.(slice|substring|substr)\(/);
    expect(src.match(/<span className="name">\{(a|f)\.name\}<\/span>/g)).toHaveLength(3);
  });

  it("uses example addresses only in what it shows as an example", () => {
    const settings = fs.readFileSync(path.join(__dirname, "../views/settings/Connections.tsx"), "utf8");
    for (const text of [src, settings]) expect(text).not.toMatch(/@(icloud|me|mac|gmail|googlemail|fastmail|outlook|hotmail|yahoo|proton)\.(com|me)\b/);
    expect(src).toContain('placeholder="family@northwind.example"');
  });
});

describe("dayGrouper", () => {
  it("gives every time the heading dayGroup gives it, from today back over a year", () => {
    const now = new Date();
    const group = dayGrouper(now);
    for (let i = 0; i < 3000; i++) {
      const iso = new Date(now.getTime() - (i * 7919 % 420) * 86_400_000 - (i * 104_729 % 86_400_000) + 3_600_000).toISOString();
      expect(group(iso)).toBe(dayGroup(iso, now));
    }
    expect(group("not a date")).toBe("Earlier");
  });
});
