import { test } from "node:test";
import assert from "node:assert/strict";
import { mailCards, senderCards, senderData, textCards } from "../src/mail-cards.js";
import { keepInbox, listMail, openMailDb, type MailSummary } from "../src/mail-inbox.js";
import { makeHub } from "./helpers.js";
import { ago, done, fake, linked } from "./fake-icloud-mail.js";

// Cards: a mail's key facts, from the sender's schema.org data or patterns in its text. Made-up mail.

const ld = (o: unknown) => `<html><head><script type="application/ld+json">${JSON.stringify(o)}</script></head><body>Hi</body></html>`;
const SHOP = { name: "Shop", address: "orders@shop.example" };

test("mail cards: a package from the sender's data", () => {
  const html = ld({
    "@context": "http://schema.org", "@type": "ParcelDelivery",
    carrier: { "@type": "Organization", name: "UPS" }, trackingNumber: "1Z999AA10123456784",
    trackingUrl: "https://track.shop.example/1Z999AA10123456784", expectedArrivalUntil: "2026-11-24T20:00:00-05:00",
    deliveryStatus: "http://schema.org/OrderInTransit",
  });
  assert.deepEqual(senderCards(html), [{ kind: "package", source: "sender", title: "UPS", number: "1Z999AA10123456784", url: "https://track.shop.example/1Z999AA10123456784", at: "2026-11-25T01:00:00.000Z", status: "In transit" }]);
});

test("mail cards: a flight, a stay and an order, from @graph and arrays", () => {
  const flight = { "@type": "FlightReservation", reservationNumber: "RXJ34P", reservationFor: { "@type": "Flight", flightNumber: "110", airline: { name: "Example Air", iataCode: "EA" }, departureAirport: { name: "San Francisco", iataCode: "SFO" }, arrivalAirport: { iataCode: "JFK" }, departureTime: "2026-12-03T08:00:00-08:00", arrivalTime: "2026-12-03T16:30:00-05:00" } };
  const stay = { "@type": "LodgingReservation", reservationNumber: "H-4411", reservationFor: { "@type": "LodgingBusiness", name: "Harbor Inn" }, checkinDate: "2026-12-03", checkoutDate: "2026-12-06" };
  const order = { "@type": "Order", merchant: { name: "Shop" }, orderNumber: "A-1009", priceCurrency: "USD", price: "42.1", orderStatus: "http://schema.org/OrderProcessing" };
  const cards = senderCards(ld({ "@context": "http://schema.org", "@graph": [flight, [stay, order]] }));
  assert.deepEqual(cards.map((c) => c.kind), ["flight", "stay", "order"]);
  assert.deepEqual(cards[0], { kind: "flight", source: "sender", title: "Example Air", number: "EA 110", from: "SFO", to: "JFK", at: "2026-12-03T16:00:00.000Z", until: "2026-12-03T21:30:00.000Z", status: "Confirmation RXJ34P" });
  assert.equal(cards[1].title, "Harbor Inn");
  assert.equal(cards[2].amount, "$42.10");
  assert.equal(cards[2].status, "Processing");
});

test("mail cards: a bill from the sender's data", () => {
  const html = ld({ "@type": "Invoice", provider: { name: "City Water" }, totalPaymentDue: { "@type": "PriceSpecification", price: 61.5, priceCurrency: "USD" }, paymentDueDate: "2026-12-15" });
  assert.deepEqual(senderCards(html), [{ kind: "bill", source: "sender", title: "City Water", amount: "$61.50", at: "2026-12-15" }]);
});

test("mail cards: what the sender writes is only ever plain, short text, and a link only https", () => {
  const html = ld({
    "@type": "ParcelDelivery", carrier: { name: `UPS\u202e\u0000<b>${"x".repeat(500)}` }, trackingNumber: "1Z999AA10123456784",
    trackingUrl: "javascript:alert(1)", expectedArrivalUntil: "not a date", deliveryStatus: { "@id": "x" },
  });
  const [c] = senderCards(html);
  assert.equal(c.title!.length <= 80, true, "capped");
  assert.equal(/[\u202e\u0000]/.test(c.title!), false, "no control or direction characters");
  assert.equal(c.url, undefined, "a javascript: link is no link");
  assert.equal(c.at, undefined, "a date only when it reads as one");
  assert.equal(senderCards(ld({ "@type": "ParcelDelivery", trackingUrl: "http://track.example/1" }))[0].url, undefined, "plain http is no link");
  assert.equal(senderCards(ld({ "@type": "ParcelDelivery", trackingUrl: "https://user:pw@track.example/1" }))[0].url, undefined, "nor one with a login in it");
  assert.equal(senderCards(ld({ "@type": "Invoice", totalPaymentDue: -5 }))[0].amount, undefined, "no negative amounts");
  assert.equal(senderCards(ld({ "@type": "EventReservation", reservationFor: { startDate: "1850-01-01" } }))[0].at, undefined, "no dates out of range");
});

test("mail cards: broken, huge and endless data is skipped, not a failure", () => {
  assert.deepEqual(senderData(`<script type="application/ld+json">{ not json</script>`), []);
  assert.deepEqual(senderData(`<script type="application/ld+json">${JSON.stringify({ "@type": "Order", orderNumber: "x".repeat(200_000) })}</script>`), [], "too big to read");
  let deep: unknown = { "@type": "Order", orderNumber: "A-1" };
  for (let i = 0; i < 50; i++) deep = [deep];
  assert.deepEqual(senderData(ld(deep)), [], "too deep to look into");
  const many = ld(Array.from({ length: 30 }, (_, i) => ({ "@type": "ParcelDelivery", trackingNumber: `1Z999AA1012345${String(i).padStart(4, "0")}` })));
  assert.equal(senderCards(many).length, 3, "at most three cards");
  assert.deepEqual(senderCards(ld({ "@type": "Person", name: "Sam" })), [], "kinds cards do not show");
  assert.deepEqual(mailCards("<script type=\"application/ld+json\">[[[", "Hi", "", SHOP), [], "never throws");
});

test("mail cards: a mail of nothing but tags that are never closed is read once, quickly", () => {
  // 2 MB of them took a pattern 30 seconds (it searched to the end again from every tag), on the hub's one thread.
  for (const tag of [`<script type="application/ld+json">`, `<script type="application/ld+json"`, `<script `, `</script`]) {
    const html = tag.repeat(Math.ceil(2_000_000 / tag.length));
    const t = Date.now();
    assert.deepEqual(senderData(html), []);
    assert.ok(Date.now() - t < 2000, `${tag} read in ${Date.now() - t} ms`);
  }
  // Closed blocks among other scripts are still read, in any letter case, and only the first ten.
  const block = `<SCRIPT TYPE='application/ld+json'>${JSON.stringify({ "@type": "Order", orderNumber: "A-1" })}</SCRIPT >`;
  assert.equal(senderData(`<script>var a = "<script";</script>${block}`).length, 1);
  assert.equal(senderData(block.repeat(30)).length, 10);
  assert.deepEqual(senderData(`<script type="text/javascript">x</script>`), []);
});

test("mail cards: a status named like something every object has is plain words, never an object", () => {
  for (const s of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    const [c] = senderCards(ld({ "@type": "Order", orderNumber: "A-1", orderStatus: s }));
    assert.equal(typeof (c.status ?? ""), "string", s);
    assert.equal(String(c.status ?? "").includes("[object"), false, s);
  }
});

test("mail cards: patterns in the text, for mail without the sender's data", () => {
  assert.deepEqual(textCards("Your package is on its way", "Tracking number: 1Z999AA10123456784", SHOP), [{ kind: "package", source: "text", title: "UPS", number: "1Z999AA10123456784", url: "https://www.ups.com/track?tracknum=1Z999AA10123456784" }]);
  assert.equal(textCards("Shipped", "USPS 9400111899223197428490", SHOP)[0].title, "USPS");
  assert.equal(textCards("Shipped", "Your tracking: TBA123456789012", SHOP)[0].title, "Amazon");
  assert.equal(textCards("Shipped", "Tracking 123456789012", SHOP).length, 0, "twelve digits alone are not FedEx");
  assert.equal(textCards("Shipped via FedEx", "Tracking 123456789012", SHOP)[0].title, "FedEx");
  const bill = textCards("Your statement is ready", "Amount due: $61.50\nDue by Dec 15, 2026", { name: "City Water", address: "billing@water.example" });
  assert.deepEqual(bill, [{ kind: "bill", source: "text", title: "City Water", amount: "$61.50", at: "2026-12-15" }]);
  assert.equal(textCards("Thanks for your order", "Order number: A-1009-77", SHOP)[0].number, "A-1009-77");
  assert.equal(textCards("Thanks", "Your order number is below.", SHOP).length, 0, "a number needs a digit");
  assert.equal(textCards("Booked", "Confirmation code: X7K2PQ", SHOP)[0].kind, "booking");
});

test("mail cards: kept at refresh (the sender's data read before the HTML is cleaned), in the list and the open mail", async () => {
  const t = makeHub();
  try {
    linked(t);
    const parcel = { "@context": "http://schema.org", "@type": "ParcelDelivery", carrier: { name: "UPS" }, trackingNumber: "1Z999AA10123456784", trackingUrl: "https://track.shop.example/1" };
    fake([
      { uid: 1, folder: "INBOX", at: ago(2), subject: "Your order shipped", from: { address: "orders@shop.example" }, headers: "Auto-Submitted: auto-generated\r\n", html: ld(parcel), plain: "Hi" },
      { uid: 2, folder: "INBOX", at: ago(1), subject: "Your statement", from: { name: "City Water", address: "no-reply@water.example" }, headers: "Auto-Submitted: auto-generated\r\n", plain: "Amount due: $61.50" },
      { uid: 3, folder: "INBOX", at: ago(1), subject: "Lunch", from: { name: "Sam", address: "sam@example.com" }, plain: "My confirmation code: X7K2PQ" },
    ]);
    await t.api("/mail/refresh", { method: "POST" });
    const ms = ((await (await t.api("/mail")).json()) as { messages: MailSummary[] }).messages;
    const by = (s: string) => ms.find((m) => m.subject === s)!;
    assert.deepEqual(by("Your order shipped").cards, [{ kind: "package", source: "sender", title: "UPS", number: "1Z999AA10123456784", url: "https://track.shop.example/1" }]);
    assert.equal(by("Your statement").cards?.[0].amount, "$61.50");
    assert.equal(by("Lunch").cards, undefined, "a person's mail: no patterns from its text");
    const open = (await (await t.api(`/mail/messages/${by("Your order shipped").id}`)).json()) as MailSummary;
    assert.equal(open.cards?.[0].kind, "package");
  } finally { done(t); }
});

test("mail cards: mail kept before cards gets those its text shows when listed", () => {
  const db = openMailDb(":memory:");
  keepInbox(db, "icloud:robin@icloud.example", { present: null, moved: [], mails: [{ id: "1:1:INBOX", at: new Date(), message_id: "a@x", from: SHOP, reply_to: null, subject: "Shipped", text: "Tracking: 1Z999AA10123456784", automated: true, unsubscribe: false, list_id: null, html: null, remote: [], logo: null, refs: [], mine: false }] });
  db.prepare("UPDATE inbox SET cards = NULL").run();
  assert.equal(listMail(db)[0].cards?.[0].title, "UPS");
});

test("mail cards: a person's mail gets only the sender's data, never patterns from its text", () => {
  assert.deepEqual(mailCards("", "Re: dinner", "My confirmation code: X7K2PQ", { name: "Sam", address: "sam@example.com" }, false), []);
  assert.equal(mailCards("", "Booked", "Confirmation code: X7K2PQ", SHOP, true).length, 1);
});
