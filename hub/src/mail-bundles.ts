import crypto from "node:crypto";
import type { DB } from "./db.js";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";
import type { ModuleId } from "./modules.js";

/**
 * The Mail screen's bundles (CONTRACT.md, Mail): which colored group each Inbox mail sits in, worked out from its
 * headers when the list is built, so a new record or a module switched off changes the sorting at once and nothing
 * stale is stored. The sender, the subject and what the headers say are read; of the text, only its start, and only
 * for the job and order phrases (a recruiter's note and signature, a shop's "estimated arrival").
 *
 * Bundles: Transactions, Trips, Updates and Promotions for every mail a system sent; Bills, Pet and Jobs only while
 * their module is on (their part of BundleContext is null when it is off). A person's own mail stands alone (null),
 * so it is never lost among notices, and so does a reply in a mailing list's discussion (people talking).
 * Since 2026-11-22 Purchases is called Transactions (money moving too), Promos is called Promotions, and Other is called
 * Updates and takes the social networks' mail too (there is no Social bundle any more). The ids did not change with the
 * names (BUNDLE_IDS says why).
 *
 * The sender's name and the subject are whatever the sender wrote: a mail can put itself in the wrong bundle, nothing
 * more. The screen always shows the real address when a mail is opened.
 */

/** What bundleOf reads of a mail. */
export interface BundleMail {
  from: { name: string; address: string };
  subject: string;
  /** A system sent it (a notice, a newsletter), not a person: isAutomated in imports/icloud.ts. */
  automated: boolean;
  /** It carries List-Unsubscribe: marketing mail or a newsletter, most of the time. */
  unsubscribe: boolean;
  /** Its List-Id, when it comes from a mailing list. */
  list_id: string | null;
  /** The start of its text (TEXT_START characters), read for the job and order phrases and the owner's text words. */
  text?: string;
  /** The addresses it was sent to (To and Cc, lowercase), for the owner's recipient rules; absent for mail kept before. */
  to?: string[];
  /** It answers another mail (it carries In-Reply-To or References), as a reply in a discussion does. */
  answers?: boolean;
}

/** How much of a mail's text the phrases are looked for in: enough to reach a normal mail's signature. */
export const TEXT_START = 3000;

/** What the module bundles match against, from the owner's records; null while that module is off. */
export interface BundleContext {
  /** Job search: each application's company and the address of its posting. */
  jobs: { company: string; url: string | null }[] | null;
  /** Renewals and bills: each record's title and its address. */
  bills: { title: string; url: string | null }[] | null;
  /** Pet: the pets' names. */
  pets: string[] | null;
  /** The owner's own bundles, checked before every other rule. */
  custom?: CustomBundle[];
}

// ---------------------------------------------------------------------------------------------------------------------
// The owner's own bundles (since 2026-11-20)

/**
 * A bundle of the owner's: a name, one of the screen's eight colors, and rules: mail from one of `addresses`, from one
 * of `domains` (or a domain under it), or whose subject has one of `words` (whole words). Checked before the built-in
 * rules, so the owner's wins; unlike those, it may take a person's mail ("Family": a sister's address).
 */
export interface CustomBundle { id: string; name: string; color: number; addresses: string[]; domains: string[]; words: string[]; body_words?: string[]; to?: string[] }
export const CUSTOM_MAX = 20;
const LIST_MAX = 30;

/** The owner's bundles. */
export function customBundles(db: DB): CustomBundle[] {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'custom_bundles'").get() as { value: string } | undefined;
  try { return r ? JSON.parse(r.value) as CustomBundle[] : []; } catch { return []; }
}
const saveAll = (db: DB, all: CustomBundle[]) => db.prepare("INSERT INTO settings (key, value) VALUES ('custom_bundles', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(all));

/** A bundle's fields from a request, checked: a name, a color 0 to 7, and at least one rule. */
function checked(body: Record<string, unknown>): Omit<CustomBundle, "id"> {
  const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > 40) throw new StoreError(422, "name is 1 to 40 characters");
  if (!Number.isInteger(body.color) || (body.color as number) < 0 || (body.color as number) > 7) throw new StoreError(422, "color is 0 to 7");
  const list = (v: unknown, what: string, ok: (s: string) => boolean) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > LIST_MAX || !v.every((x) => typeof x === "string")) throw new StoreError(422, `${what} is a list of at most ${LIST_MAX}`);
    const out = [...new Set((v as string[]).map((x) => x.trim().toLowerCase()).filter(Boolean))];
    const bad = out.find((x) => !ok(x));
    if (bad !== undefined) throw new StoreError(422, `${what}: "${bad.slice(0, 60)}" is not one`);
    return out;
  };
  const addresses = list(body.addresses, "addresses", (x) => x.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
  const domains = list(body.domains, "domains", (x) => x.length <= 253 && /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(x.replace(/^@/, ""))).map((x) => x.replace(/^@/, ""));
  const words = list(body.words, "words", (x) => x.length <= 60);
  // Since 2026-11-22: words in the mail's text (its first 3,000 characters), and the addresses it was sent to (an alias).
  const bodyWords = list(body.body_words, "body_words", (x) => x.length <= 60);
  const to = list(body.to, "to", (x) => x.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
  if (!addresses.length && !domains.length && !words.length && !bodyWords.length && !to.length) throw new StoreError(422, "a bundle needs at least one address, domain, word or recipient");
  return { name, color: body.color as number, addresses, domains, words, ...(bodyWords.length ? { body_words: bodyWords } : {}), ...(to.length ? { to } : {}) };
}

export function addCustomBundle(db: DB, body: Record<string, unknown>): CustomBundle {
  const all = customBundles(db);
  if (all.length >= CUSTOM_MAX) throw new StoreError(409, `at most ${CUSTOM_MAX} bundles of your own`);
  const b = { id: `c-${crypto.randomBytes(5).toString("hex")}`, ...checked(body) };
  saveAll(db, [...all, b]);
  return b;
}

export function updateCustomBundle(db: DB, id: string, body: Record<string, unknown>): CustomBundle {
  const all = customBundles(db);
  const i = all.findIndex((b) => b.id === id);
  if (i < 0) throw new StoreError(404, "there is no such bundle");
  // An app from before 2026-11-22 does not know the text words and the recipients, and sends neither: they stay as
  // they are. (It replaced the whole bundle, so an edit of its name there took both rules away.)
  const old = all[i];
  all[i] = { id, ...checked({ ...body, ...(body.body_words === undefined && old.body_words ? { body_words: old.body_words } : {}), ...(body.to === undefined && old.to ? { to: old.to } : {}) }) };
  saveAll(db, all);
  return all[i];
}

export function deleteCustomBundle(db: DB, id: string): void {
  const all = customBundles(db);
  if (!all.some((b) => b.id === id)) throw new StoreError(404, "there is no such bundle");
  saveAll(db, all.filter((b) => b.id !== id));
}

/** The owner's bundle a mail is in, or null: the first whose rules match. */
export function customBundleOf(mail: BundleMail, custom: CustomBundle[]): string | null {
  const address = mail.from.address.toLowerCase();
  const domain = domainOf(address);
  for (const b of custom) {
    if (b.addresses.includes(address)) return b.id;
    if (b.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return b.id;
    if (b.words.length && hasWord(mail.subject, b.words)) return b.id;
    if (b.body_words?.length && hasWord((mail.text ?? "").slice(0, TEXT_START), b.body_words)) return b.id;
    if (b.to?.length && mail.to?.some((a) => b.to!.includes(a))) return b.id;
  }
  return null;
}

/**
 * Every bundle's id, the built-in ones and the module ones. An id is what the apps and the kept settings know a bundle
 * by, so it stays when the bundle is renamed: `purchases` is Transactions, `other` is Updates and `promos` is
 * Promotions (renamed 2026-11-22). An app that shipped before the renaming has a fixed list of ids, and the hub updates
 * itself before the apps do: under an id it does not know, mail set to show later or never showed nowhere in that app.
 */
export const BUNDLE_IDS = ["purchases", "other", "promos", "trips", "bills", "pet", "jobs"] as const;
/** Their names, as the screen shows them (for notifications). */
export const BUNDLE_NAMES: Record<string, string> = { purchases: "Transactions", trips: "Trips", other: "Updates", promos: "Promotions", bills: "Bills", pet: "Pet", jobs: "Jobs" };
/** Ids that name no bundle any more: `social`, whose mail is in Updates since 2026-11-22. */
export const RETIRED_BUNDLE_IDS: readonly string[] = ["social"];
/**
 * Ids a build of the renaming used for a few days in November 2026, and the bundle each one is. Settings kept under
 * them move back at start (mail-inbox.ts settleBundleIds), and a request that still sends one is taken as the real id.
 */
export const SHORT_LIVED_BUNDLE_IDS: Record<string, string> = { transactions: "purchases", updates: "other", promotions: "promos" };
/** The bundle id a request means: a short-lived one's real id, else itself. */
export const bundleIdAsSent = (id: string): string => (Object.hasOwn(SHORT_LIVED_BUNDLE_IDS, id) ? SHORT_LIVED_BUNDLE_IDS[id] : id);

/** No modules on: only the bundles every mail can have. */
export const NO_MODULES: BundleContext = { jobs: null, bills: null, pets: null };

/** The records the module bundles match against, read once per list. */
export function bundleContext(hub: Hub): BundleContext {
  const on = (m: ModuleId) => hub.modules.on(m);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    jobs: on("jobs") ? hub.store.list({ kind: "application", limit: 100000 }).map((e) => ({ company: str(e.fields.company) ?? "", url: str(e.fields.url) })).filter((j) => j.company || j.url) : null,
    bills: on("renewals") ? hub.store.list({ kind: "watch", limit: 100000 }).map((e) => ({ title: str(e.fields.title) ?? "", url: str(e.fields.url) })).filter((b) => b.title || b.url) : null,
    pets: on("pet") ? [...new Set(hub.store.list({ kind: "pet_event", limit: 100000 }).map((e) => str(e.fields.pet)).filter((p): p is string => !!p))] : null,
    custom: customBundles(hub.mailDb),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers for the rules

/** The domain of an address, lower case: "orders@mail.northwind.example" gives "mail.northwind.example". */
export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1).trim().toLowerCase();
}

/** The host of a web address, lower case, without "www."; "" when it is not one. */
export function hostOf(url: string | null): string {
  if (!url) return "";
  try { return new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

/**
 * Whether two hosts belong to the same site: their last two labels match ("mail.contoso.example" and
 * "careers.contoso.example" both end in "contoso.example"). Good enough for sorting, not for security: a site under a
 * two-part country ending ("shop.co.uk") is matched loosely.
 */
export function sameSite(a: string, b: string): boolean {
  return !!a && !!b && siteOf(a) === siteOf(b);
}

/** A host's last two labels, what sameSite compares. */
const siteOf = (h: string) => h.split(".").filter(Boolean).slice(-2).join(".");

/** Whether `text` has any of `words` as whole words, in any case: "order" is in "Your order shipped", not in "Border". */
export function hasWord(text: string, words: string[]): boolean {
  return hasWordIn(wordText(text), wordPattern(words));
}

/** Text as hasWord reads it: lower case, and runs of spaces and line breaks as one space, so a phrase split across
 * lines still matches. */
const wordText = (text: string) => text.toLowerCase().replace(/\s+/g, " ");

/** hasWord on text already made into wordText (a mail's subject is looked at for several bundles), with the words'
 * pattern made already (wordPattern). */
function hasWordIn(text: string, re: RegExp | null): boolean {
  return !!re && re.test(text);
}

/**
 * One pattern for a list of words, made once and kept: the list is built for every mail, thousands at a time. Null for
 * an empty list (a pattern of no words would match everything).
 */
const patterns = new Map<string, RegExp | null>();
function wordPattern(words: string[]): RegExp | null {
  const key = words.join("\n");
  let re = patterns.get(key);
  if (re === undefined) {
    const parts = words.map((w) => w.trim().toLowerCase()).filter(Boolean).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, " "));
    re = parts.length ? new RegExp(`(^|[^a-z0-9])(${parts.join("|")})($|[^a-z0-9])`) : null;
    if (patterns.size > 2000) patterns.clear(); // records come and go; the kept patterns stay few
    patterns.set(key, re);
  }
  return re;
}

// ---------------------------------------------------------------------------------------------------------------------
// The rules

/** Hiring systems that send mail for many companies. */
const HIRING = ["greenhouse.io", "lever.co", "myworkday.com", "ashbyhq.com", "smartrecruiters.com", "icims.com"];
/** Social networks' mail domains. */
const SOCIAL = ["facebookmail.com", "linkedin.com", "instagram.com", "reddit.com", "redditmail.com", "discord.com", "nextdoor.com", "x.com"];
/** Developer and work tools: their notices carry an unsubscribe link (to stop a repository's notices), but are updates, not promotions. */
const TOOLS = ["github.com", "gitlab.com", "bitbucket.org", "atlassian.net", "atlassian.com"];
/** A reply's subject: "Re:" (and "Aw:", "Sv:"). */
const REPLY = /^\s*(re|aw|sv)\s*:/i;
/**
 * Phrases that almost only hiring mail has, looked for in the subject and the start of the text: about an application,
 * about the next steps, and the titles in a recruiter's signature. Never single words like "interview" or "position",
 * which newsletters use all the time.
 */
const JOB_PHRASES = [
  "your application", "received your application", "thank you for applying", "thanks for applying", "applied for", "application status",
  "interview invitation", "schedule an interview", "schedule a phone screen", "a phone screen with", "next steps in the hiring process",
  "recruiter", "talent acquisition", "hiring manager", "hiring team", "people operations",
];
const VET_WORDS =["vet", "veterinary", "animal hospital"];
const BILL_WORDS = ["invoice", "bill", "statement", "payment due", "autopay"];
const TRIP_WORDS = ["flight", "boarding pass", "itinerary", "reservation", "check-in", "hotel", "booking"];
/** Transactions: buying (an order, its shipping) and money moving (a transfer, a deposit, a payment sent or received, a refund). */
const TRANSACTION_WORDS = ["order", "receipt", "shipped", "delivered", "delivery", "tracking", "purchase", "package", "pick up",
  "transaction", "transfer", "deposit", "withdrawal", "refund", "payment received", "payment sent", "payment confirmation", "you paid", "paid you", "sent you money", "money request"];
/**
 * Order-status phrases, looked for in the start of the text: a shop's notice whose subject says nothing ("meet your
 * next coffee") still has them. Never "shipping" or "delivery" alone, which promos say all the time ("free shipping").
 */
const ORDER_PHRASES = ["estimated arrival", "estimated delivery", "order number", "order confirmation", "tracking number", "out for delivery", "has shipped", "your shipment",
  "transaction id", "transfer amount", "has been deposited", "available balance"];

/** The sites of the fixed lists, for fromAny, and the patterns of the fixed word lists. */
const HIRING_SITES = new Set(HIRING.map(siteOf));
const SOCIAL_SITES = new Set(SOCIAL.map(siteOf));
const TOOL_SITES = new Set(TOOLS.map(siteOf));
const JOB_RE = wordPattern(JOB_PHRASES);
const BILL_RE = wordPattern(BILL_WORDS);
const TRIP_RE = wordPattern(TRIP_WORDS);
const TRANSACTION_RE = wordPattern(TRANSACTION_WORDS);
const ORDER_RE = wordPattern(ORDER_PHRASES);

/**
 * What the module rules need of a context, worked out once per context instead of once per mail (a list is thousands
 * of mails against the same records): the sites of the records' addresses, and their names in one pattern. The
 * answers are those of testing each record in turn. A context is made for each list (bundleContext) and not changed
 * once it is used.
 */
interface Records {
  /** Each record's address as a site. */
  sites: Set<string>;
  /** The records' names, looked for as whole words in the sender's name. */
  names: RegExp | null;
  /** The names of 4 or more letters, lower case, looked for inside the sender's domain. */
  inDomain: string[];
}
interface Prepared {
  jobs: Records | null;
  bills: Records | null;
  /** The pets' names and the vet words. */
  pets: RegExp | null;
}
const prepared = new WeakMap<BundleContext, Prepared>();
function prepare(ctx: BundleContext): Prepared {
  let p = prepared.get(ctx);
  if (!p) {
    const records = (list: { name: string; url: string | null }[]) => ({
      sites: new Set(list.map((r) => hostOf(r.url)).filter(Boolean).map(siteOf)),
      names: wordPattern(list.map((r) => r.name).filter((n) => n !== "")),
      inDomain: list.map((r) => r.name).filter((n) => n.length >= 4).map((n) => n.toLowerCase()),
    });
    p = {
      jobs: ctx.jobs ? records(ctx.jobs.map((j) => ({ name: j.company, url: j.url }))) : null,
      bills: ctx.bills ? records(ctx.bills.map((b) => ({ name: b.title, url: b.url }))) : null,
      pets: ctx.pets ? wordPattern([...ctx.pets, ...VET_WORDS]) : null,
    };
    prepared.set(ctx, p);
  }
  return p;
}

/**
 * The bundle a mail sits in, or null when it stands alone (a person's mail). The rules, most specific first (the first
 * that matches wins); test/mail-bundles.test.ts has a case for each:
 *  1. jobs:  ctx.jobs is not null, and the sender's domain is the same site as an application's url, or the sender's
 *            name has its company (a name of 4 or more letters, its domain too); or the mail comes from a hiring system (greenhouse.io, lever.co,
 *            myworkday.com, ashbyhq.com, smartrecruiters.com, icims.com); or a job phrase (JOB_PHRASES) is in the
 *            subject or the start of the text. The only rule that also takes a person's mail
 *            (a recruiter writes as a person).
 *  2. A person's mail (not automated, no unsubscribe) stands alone: return null.
 *  3. pet:   ctx.pets is not null, and a pet's name, or "vet", "veterinary", "animal hospital", is in the sender's name
 *            or the subject.
 *  4. bills: ctx.bills is not null, and the sender is the same site as a record's url or has its title; or the subject
 *            has invoice, bill, statement, payment due, autopay.
 *  5. trips:     flight, boarding pass, itinerary, reservation, check-in, hotel, booking.
 *  6. purchases (Transactions): a buying or money word (TRANSACTION_WORDS: order, receipt, shipped, transfer, deposit, refund,
 *                payment received...) in the subject; or an order or money phrase (ORDER_PHRASES) in the start of the text.
 *  7. other (Updates): the sender's domain is a social network's (facebookmail.com, linkedin.com, instagram.com, reddit.com,
 *                redditmail.com, discord.com, nextdoor.com, x.com) or a developer or work tool's (TOOLS: github.com,
 *                gitlab.com, ...), though it carries unsubscribe.
 *  8. none:      a reply in a mailing list's discussion (a List-Id, a "Re:" subject, and it answers another mail)
 *                stands alone, as people talking. "Re:" alone is not enough: a newsletter writes it to look like one.
 *  9. promos (Promotions): anything left that carries unsubscribe.
 * 10. other (Updates): anything else a system sent.
 */
export function bundleOf(mail: BundleMail, ctx: BundleContext): string | null {
  const domain = domainOf(mail.from.address);
  /** The sender's domain as a site ("" for none, which is no site's). */
  const site = domain ? siteOf(domain) : "";
  const p = prepare(ctx);
  // Each part of the mail is made into wordText once, however many bundles look at it.
  const name = wordText(mail.from.name);
  const subject = wordText(mail.subject);
  /** The start of the text, where the job and order phrases are looked for. */
  let start: string | null = null;
  const textStart = () => (start ??= wordText((mail.text ?? "").slice(0, TEXT_START)));
  /** Whether the sender's domain is one of these sites. */
  const fromAny = (sites: Set<string>) => !!domain && sites.has(site);
  /**
   * Whether a record's site is the sender's, or its name is the sender's name or part of its domain ("Fabrikam" in
   * no-reply@fabrikam.example). Only a name of 4 or more letters is looked for inside a domain: "box" is inside
   * dropbox.com, "ea" inside most domains.
   */
  const fromRecord = (r: Records) => fromAny(r.sites) || hasWordIn(name, r.names) || r.inDomain.some((n) => domain.includes(n));

  // 0. The owner's own bundles first: theirs wins, a person's mail included.
  const own = ctx.custom?.length ? customBundleOf(mail, ctx.custom) : null;
  if (own) return own;

  // 1. Jobs: the one rule that takes a person's mail too, since a recruiter writes as a person.
  if (p.jobs) {
    const sounds = hasWordIn(subject, JOB_RE) || hasWordIn(textStart(), JOB_RE);
    if (fromRecord(p.jobs) || fromAny(HIRING_SITES) || sounds) return "jobs";
  }

  // 2. A person's mail stands alone.
  if (!mail.automated && !mail.unsubscribe) return null;

  // 3. Pet: a pet's name or a vet word, in the sender's name or the subject.
  if (p.pets) {
    if (hasWordIn(name, p.pets) || hasWordIn(subject, p.pets)) return "pet";
  }

  // 4. Bills: a renewal record's site or name, or a bill word in the subject.
  if (p.bills) {
    if (fromRecord(p.bills) || hasWordIn(subject, BILL_RE)) return "bills";
  }

  // 5 to 9: the bundles every mail can have.
  if (hasWordIn(subject, TRIP_RE)) return "trips";
  if (hasWordIn(subject, TRANSACTION_RE) || hasWordIn(textStart(), ORDER_RE)) return "purchases";
  if (fromAny(SOCIAL_SITES) || fromAny(TOOL_SITES)) return "other";
  // A mail kept before the hub knew what it answers (undefined) counts as before.
  if (mail.list_id && REPLY.test(mail.subject) && mail.answers !== false) return null;
  if (mail.unsubscribe) return "promos";
  return "other";
}
