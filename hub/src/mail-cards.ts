import { mailHref } from "./mail-html.js";

/**
 * Cards (CONTRACT.md, Mail): a mail's key facts, shown under its subject and at the top of the open mail, so a package,
 * a flight or a bill can be read without opening it. Two readers, both code (no model):
 * - the sender's own structured data: the schema.org blocks (`<script type="application/ld+json">`) airlines, shops and
 *   ticket sellers put in their mail, read from the raw HTML at refresh (the cleaned HTML keeps no script);
 * - patterns in the text: a carrier's tracking number, an amount due and its date, a confirmation or order number.
 * Everything here is written by the sender: every value is plain text, trimmed and capped, a date only when it reads
 * as one, a link only when it is https (and the screen opens it as any mail link). A card acts on nothing.
 */

export type CardKind = "package" | "flight" | "stay" | "table" | "event" | "bill" | "order" | "booking";
export interface MailCard {
  kind: CardKind;
  /** A carrier, an airline's flight, a hotel, a restaurant, an event, a shop. */
  title?: string;
  /** A tracking, flight, confirmation or order number. */
  number?: string;
  /** Airports (flight). */
  from?: string;
  to?: string;
  /** When: a package arrives, a flight leaves, a stay or a table or an event starts, a bill is due. */
  at?: string;
  /** Until: a flight lands, a stay ends. */
  until?: string;
  /** An amount due or a total, as written ("$42.10"). */
  amount?: string;
  /** A package's state ("In transit", "Delivered"). */
  status?: string;
  /** Where to follow it (https only). */
  url?: string;
  /** From the sender's data, or read from the text. */
  source: "sender" | "text";
}

/** At most this many cards per mail, and this much JSON read. */
const CARDS_MAX = 3;
const JSON_MAX = 100_000;

/** Plain text: control and direction-changing characters out, spaces closed up, at most 80 characters. */
function str(v: unknown, max = 80): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) v = String(v);
  if (typeof v !== "string") return undefined;
  const t = v.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
}
/**
 * A date and time as ISO, only when it reads as one between 2000 and 2100. A day without a time ("2026-12-15",
 * "Dec 15, 2026") stays a day (`YYYY-MM-DD`): as midnight UTC it would show as the day before west of Greenwich.
 */
function date(v: unknown): string | undefined {
  const s = str(v, 60);
  if (!s) return undefined;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const t = day ? Date.UTC(+day[1], +day[2] - 1, +day[3]) : Date.parse(s);
  if (Number.isNaN(t)) return undefined;
  const d = new Date(t);
  if (day) return d.getUTCFullYear() >= 2000 && d.getUTCFullYear() <= 2100 && d.getUTCDate() === +day[3] ? s : undefined;
  if (d.getFullYear() < 2000 || d.getFullYear() > 2100) return undefined;
  // No time in it: Date.parse read it as local midnight; the day as written.
  if (!/\d:\d/.test(s)) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return d.toISOString();
}
/** An https link, checked as any mail link is; nothing else. */
function https(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  const h = s ? mailHref(s) : null;
  return h && h.startsWith("https://") && h.length <= 500 ? h : undefined;
}
const SYMBOLS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", CAD: "CA$", AUD: "A$", JPY: "¥" };
/** An amount from a price (or a MonetaryAmount / PriceSpecification) and its currency. */
function money(v: unknown, currency?: unknown): string | undefined {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return money(o.price ?? o.value, o.priceCurrency ?? o.currency);
  }
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^\d.]/g, "")) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 1e9) return undefined;
  const c = typeof currency === "string" ? currency.toUpperCase().slice(0, 3) : "";
  const amount = n.toFixed(2);
  return SYMBOLS[c] ? `${SYMBOLS[c]}${amount}` : c ? `${amount} ${c}` : amount;
}
const nameOf = (v: unknown): string | undefined => (v && typeof v === "object" ? str((v as Record<string, unknown>).name) : str(v));
const STATUS: Record<string, string> = { OrderInTransit: "In transit", OrderDelivered: "Delivered", OrderPickupAvailable: "Ready for pickup", OrderProcessing: "Processing", OrderProblem: "Problem", OrderReturned: "Returned", OrderCancelled: "Cancelled", OrderPaymentDue: "Payment due" };
const statusOf = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v : v && typeof v === "object" ? String((v as Record<string, unknown>)["@id"] ?? (v as Record<string, unknown>).name ?? "") : "";
  const key = s.split("/").pop() ?? "";
  // Only a name the table itself has: "__proto__" and the like are every object's, and read as a status they showed as "[object Object]".
  return Object.hasOwn(STATUS, key) ? STATUS[key] : str(key.replace(/([a-z])([A-Z])/g, "$1 $2"), 30);
};
const typesOf = (o: Record<string, unknown>): string[] => (Array.isArray(o["@type"]) ? o["@type"] : [o["@type"]]).filter((t): t is string => typeof t === "string").map((t) => t.split("/").pop() ?? t);
/** A card without its empty fields (so the stored JSON is short). */
const drop = (o: MailCard): MailCard => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as unknown as MailCard;

/** One schema.org item as a card, or null for a kind cards do not show. */
function cardOf(o: Record<string, unknown>): MailCard | null {
  const types = typesOf(o);
  const rf = (o.reservationFor && typeof o.reservationFor === "object" ? o.reservationFor : {}) as Record<string, unknown>;
  const has = (t: string) => types.includes(t);
  if (has("ParcelDelivery")) {
    return drop({ kind: "package", source: "sender", title: nameOf(o.carrier) ?? nameOf(o.provider), number: str(o.trackingNumber, 40), url: https(o.trackingUrl), at: date(o.expectedArrivalUntil ?? o.expectedArrivalFrom), status: statusOf(o.deliveryStatus) });
  }
  if (has("FlightReservation")) {
    const airline = rf.airline && typeof rf.airline === "object" ? (rf.airline as Record<string, unknown>) : {};
    const code = str(airline.iataCode, 3) ?? "";
    const n = str(rf.flightNumber, 8);
    const port = (v: unknown) => (v && typeof v === "object" ? str((v as Record<string, unknown>).iataCode, 4) ?? nameOf(v) : undefined);
    const conf = str(o.reservationNumber, 20);
    return drop({ kind: "flight", source: "sender", title: nameOf(rf.airline), number: n ? `${code} ${n}`.trim() : undefined, from: port(rf.departureAirport), to: port(rf.arrivalAirport), at: date(rf.departureTime), until: date(rf.arrivalTime), url: https(o.url), status: conf ? `Confirmation ${conf}` : undefined });
  }
  if (has("LodgingReservation")) {
    return drop({ kind: "stay", source: "sender", title: nameOf(rf), number: str(o.reservationNumber, 20), at: date(o.checkinDate ?? o.checkinTime), until: date(o.checkoutDate ?? o.checkoutTime), url: https(o.url) });
  }
  if (has("FoodEstablishmentReservation")) {
    return drop({ kind: "table", source: "sender", title: nameOf(rf), number: str(o.reservationNumber, 20), at: date(o.startTime), url: https(o.url) });
  }
  if (has("EventReservation")) {
    const place = rf.location && typeof rf.location === "object" ? nameOf(rf.location) : undefined;
    return drop({ kind: "event", source: "sender", title: nameOf(rf), number: str(o.reservationNumber, 20), at: date(rf.startDate), status: place, url: https(o.url) });
  }
  if (types.some((t) => /Reservation$/.test(t))) {
    return drop({ kind: "booking", source: "sender", title: nameOf(rf) ?? nameOf(o.provider), number: str(o.reservationNumber, 20), at: date(o.pickupTime ?? rf.departureTime ?? o.startTime), url: https(o.url) });
  }
  if (has("Invoice")) {
    return drop({ kind: "bill", source: "sender", title: nameOf(o.provider), amount: money(o.totalPaymentDue ?? o.minimumPaymentDue), at: date(o.paymentDueDate ?? o.paymentDue), url: https(o.url) });
  }
  if (has("Order")) {
    const offer = Array.isArray(o.acceptedOffer) ? o.acceptedOffer[0] : o.acceptedOffer;
    return drop({ kind: "order", source: "sender", title: nameOf(o.merchant) ?? nameOf(o.seller), number: str(o.orderNumber, 30), amount: money(o.price ?? (offer as Record<string, unknown> | undefined)?.price, o.priceCurrency ?? (offer as Record<string, unknown> | undefined)?.priceCurrency), status: statusOf(o.orderStatus), url: https(o.url) });
  }
  return null;
}

/** At most this much of a mail's HTML is looked through for the sender's data, this many of its blocks read, and a tag this long. */
const HTML_READ = 2_000_000;
const BLOCKS_MAX = 10;
const TAG_MAX = 420;

/**
 * The `application/ld+json` blocks of a mail's HTML, read left to right once: each `<script` tag is looked at where it
 * stands (its own end searched for in the next TAG_MAX characters only), and a block's closing tag is searched for
 * forward from there. When one search for a closing tag finds none, no later block can have one either, so the reading
 * stops. A pattern for this (2026-11-22) searched to the end of the HTML again from every tag that was never closed: a
 * crafted mail of 2 MB of such tags held the hub's one thread for 30 seconds at each refresh.
 */
function dataBlocks(html: string): string[] {
  const page = html.slice(0, HTML_READ);
  const blocks: string[] = [];
  const open = /<script\b/gi;
  const close = /<\/script\s*>/gi;
  for (let m = open.exec(page); m && blocks.length < BLOCKS_MAX; m = open.exec(page)) {
    const from = m.index + m[0].length;
    const gt = page.slice(from, from + TAG_MAX).indexOf(">");
    if (gt < 0) continue;
    if (!/(^|\s)type\s*=\s*["']?application\/ld\+json["']?(\s|$)/i.test(page.slice(from, from + gt))) continue;
    close.lastIndex = from + gt + 1;
    const end = close.exec(page);
    if (!end) break;
    blocks.push(page.slice(from + gt + 1, end.index));
    open.lastIndex = close.lastIndex;
  }
  return blocks;
}

/** The schema.org items in a mail's HTML: its `application/ld+json` blocks, arrays and `@graph` opened. */
export function senderData(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const block of dataBlocks(html)) {
    if (block.length > JSON_MAX) continue;
    let v: unknown;
    try { v = JSON.parse(block.replace(/^\s*<!--|-->\s*$/g, "")); } catch { continue; }
    const walk = (x: unknown, depth: number) => {
      if (depth > 3 || out.length > 20 || !x || typeof x !== "object") return;
      if (Array.isArray(x)) { for (const y of x.slice(0, 20)) walk(y, depth + 1); return; }
      const o = x as Record<string, unknown>;
      if (Array.isArray(o["@graph"])) walk(o["@graph"], depth + 1);
      if (o["@type"]) out.push(o);
    };
    walk(v, 0);
  }
  return out;
}

const TRACKING: { carrier: string; re: RegExp; url?: (n: string) => string; needs?: RegExp }[] = [
  { carrier: "UPS", re: /\b(1Z[0-9A-Z]{16})\b/, url: (n) => `https://www.ups.com/track?tracknum=${n}` },
  { carrier: "USPS", re: /\b(9[2-5]\d{18,20})\b/, url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}` },
  { carrier: "Amazon", re: /\b(TBA\d{12})\b/ },
  { carrier: "FedEx", re: /\b(\d{12}|\d{15})\b/, url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`, needs: /\bfedex\b/i },
];

/** Cards read from a mail's text (and subject), for mail without the sender's data. */
export function textCards(subject: string, text: string, from: { name: string; address: string }): MailCard[] {
  const all = `${subject}\n${text.slice(0, 6000)}`;
  const cards: MailCard[] = [];
  for (const t of TRACKING) {
    if (t.needs && !t.needs.test(all) && !t.needs.test(from.address)) continue;
    const m = t.re.exec(all);
    if (m) { cards.push(drop({ kind: "package", source: "text", title: t.carrier, number: m[1], url: t.url?.(m[1]) })); break; }
  }
  const due = /\b(?:amount|balance|total|payment|minimum payment)\s+(?:due|owed)\b[^$€£\d\n]{0,20}([$€£]\s?[\d,]{1,9}(?:\.\d{2})?)/i.exec(all);
  if (due) {
    const when = /\bdue\s+(?:on|by|date:?)\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]{0,6}\.? \d{1,2}(?:, \d{4})?|\d{1,2}\/\d{1,2}\/\d{2,4})/i.exec(all);
    let at: string | undefined;
    if (when) {
      const w = /\d{4}/.test(when[1]) || when[1].includes("/") ? when[1] : `${when[1]}, ${new Date().getFullYear()}`;
      at = date(w);
    }
    cards.push(drop({ kind: "bill", source: "text", title: str(from.name), amount: due[1].replace(/\s/g, ""), at }));
  }
  // An order or confirmation number: after its label, and with a digit in it (so "Order number: below" is not one).
  const order = /\border\s*(?:number|#|no\.?|id)\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{4,23})\b/i.exec(all);
  if (order && /\d/.test(order[1])) cards.push(drop({ kind: "order", source: "text", title: str(from.name), number: order[1].toUpperCase() }));
  const conf = /\bconfirmation\s*(?:number|code|#|no\.?)\s*[:#]?\s*([A-Z0-9]{5,10})\b/i.exec(all);
  if (conf && /\d/.test(conf[1])) cards.push(drop({ kind: "booking", source: "text", title: str(from.name), number: conf[1].toUpperCase() }));
  return cards.slice(0, CARDS_MAX);
}

/**
 * A mail's cards: the sender's data when it has any, else (`automated`: a system sent it) what its text shows; a
 * person's mail gets only the sender's data. At most CARDS_MAX. Never throws: a mail it cannot read has no cards.
 */
export function mailCards(html: string, subject: string, text: string, from: { name: string; address: string }, automated = true): MailCard[] {
  try {
    const own = senderCards(html);
    return own.length || !automated ? own : textCards(subject, text, from);
  } catch { return []; }
}

/** The cards in the sender's schema.org data, one per thing (a package, a flight), at most CARDS_MAX. */
export function senderCards(html: string): MailCard[] {
  const seen = new Set<string>();
  const out: MailCard[] = [];
  for (const o of senderData(html)) {
    const c = cardOf(o);
    if (!c) continue;
    const k = `${c.kind}:${c.number ?? c.title ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
    if (out.length >= CARDS_MAX) break;
  }
  return out;
}
