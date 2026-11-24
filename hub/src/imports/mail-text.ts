/**
 * Turning a message's parts into the plain text the model reads, for every mail source: the text part when it says
 * enough, else the HTML part with its markup taken out; invisible padding (zero-width spaces, soft hyphens, word
 * joiners) goes, and runs of spaces and blank lines close up.
 */

/** The text of a message from its text parts and HTML parts, in the order they came. */
export function bodyText(plain: string[], html: string[]): string {
  const raw = plain.join("\n").trim().length > 200 ? plain.join("\n") : html.length ? htmlToText(html.join("\n")) : plain.join("\n");
  return raw.replace(/[​-‏­͏⁠﻿ ]/g, (c) => (c === " " ? " " : ""))
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n");
}

/**
 * The text of a message for reading as a person (the Mail screen), not for the model: the text part whenever there is
 * one, since it keeps what the cleaning rules look for (`> ` quotes, the `-- ` signature line); the HTML made plain
 * only when there is none. Paragraphs stay apart (one blank line); invisible padding goes.
 *
 * HTML read this way (`readableHtml`) loses what a mail app hides (`display:none`, `visibility:hidden`, `hidden`: the
 * inbox preview line, text meant only for programs) and keeps where its links go: `[label](url)` with `links: "marks"`,
 * for the cleaning rules, which turn each into its label and a link; `label (url)` otherwise, as a text part writes
 * them. A link whose label the text part also has with its own address (`label <https://…>`, often the direct one where
 * the HTML has a click tracker's) takes the text part's.
 *
 * `prefer: "html"` (the Mail screen's list and search): the HTML made plain whenever it says anything, since it is
 * what a mail app shows; many senders' text parts are an afterthought (Markdown links, a mail service's placeholders).
 */
export function readingText(plain: string[], html: string[], links: "marks" | "text" = "text", prefer: "text" | "html" = "text"): string {
  const p = plain.join("\n");
  const fromHtml = (s: string) => readableHtml(s, links, p);
  const h = html.length ? fromHtml(html.join("\n")) : "";
  const count = (s: string) => s.split("\n").filter((l) => l.trim()).length;
  // Some senders put HTML in the text part: then the HTML part (or that text, made plain) is read, never the tags.
  // Others flatten the text part to a line or two (iCloud Mail on the web: "Hi Jennifer, I'd be glad … Best, Robin")
  // while the HTML keeps the lines that tell greeting, message and sign-off apart: then the HTML is read too.
  const flattened = h && count(p) <= 2 && count(h) >= 3;
  const raw = prefer === "html" && h.trim() ? h : p.trim() && !looksLikeHtml(p) && !flattened ? p : html.length ? h : fromHtml(p);
  const lines = raw.replace(/\r\n?/g, "\n").replace(/[\u200b-\u200f\u00ad\u034f\u2060\ufeff]/g, "").replace(/\u00a0/g, " ")
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim());
  return lines.filter((l, i) => l.trim() !== "" || (i > 0 && lines[i - 1].trim() !== "")).join("\n").trim();
}

/** Elements with no closing tag: a hidden one is only its tag. */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
/**
 * The start of an opening tag. Its attributes are what follows up to the next `>`, when that is within TAG_MAX
 * characters (else it is not read as a tag). The next `>` is looked for once and remembered (nextMatch), so a mail of
 * nothing but `<p<p<p` is not searched TAG_MAX characters deep from every one of them.
 */
const OPEN_TAG = /<([a-z][a-z0-9]{0,20})\b/gi;
const TAG_MAX = 4000;
/** Attributes that hide an element in a mail app. */
const HIDES = (attrs: string) => /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrs) || /(^|\s)hidden(\s|=|\/|$)/i.test(attrs);

/** `html` without the elements a mail app hides: each hidden element with all that is inside it. */
function withoutHidden(html: string): string {
  let out = "";
  let at = 0;
  const gt = nextMatch(html, />/g);
  OPEN_TAG.lastIndex = 0;
  for (let m = OPEN_TAG.exec(html), n = 0; m; m = OPEN_TAG.exec(html)) {
    const close = gt(OPEN_TAG.lastIndex);
    if (close.at < 0) break; // no ">" from here on: nothing after this is a tag
    if (close.at - OPEN_TAG.lastIndex > TAG_MAX) continue;
    if (n++ >= 5000) break;
    const attrs = html.slice(OPEN_TAG.lastIndex, close.at);
    OPEN_TAG.lastIndex = close.end;
    if (!HIDES(attrs)) continue;
    const name = m[1].toLowerCase();
    let end = close.end;
    if (!VOID.has(name) && !attrs.trimEnd().endsWith("/")) {
      // The matching closing tag: the same name, nesting counted.
      const tag = new RegExp(`<(/?)${name}\\b`, "gi");
      tag.lastIndex = end;
      let depth = 1;
      for (let t = tag.exec(html); t; t = tag.exec(html)) {
        const c = gt(tag.lastIndex);
        if (c.at < 0) break;
        if (c.at - tag.lastIndex > TAG_MAX) continue;
        tag.lastIndex = c.end;
        depth += t[1] ? -1 : 1;
        if (depth === 0) { end = c.end; break; }
      }
      if (depth !== 0) end = html.length; // never closed: hidden to the end, as a mail app shows it
    }
    out += html.slice(at, m.index);
    at = end;
    OPEN_TAG.lastIndex = end;
  }
  return out + html.slice(at);
}

/** Marks for a link while the HTML is made plain (the private-use characters are taken out of the mail first). */
const L0 = "\uE000", L1 = "\uE001", L2 = "\uE002";
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const flatSpaces = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The HTML of a mail made plain for reading: hidden elements go, and each link keeps where it goes (see readingText).
 * `plain`: the message's text part, whose `label <url>` addresses are preferred for the same label.
 */
export function readableHtml(html: string, links: "marks" | "text", plain = ""): string {
  const flatPlain = flatSpaces(plain);
  /** The text part's address for this label, when it writes `label <https://…>`. */
  const direct = (label: string) => {
    const i = label.length >= 2 ? flatPlain.indexOf(`${label} <http`) : -1;
    if (i < 0) return null;
    const from = i + label.length + 2;
    const j = flatPlain.indexOf(">", from);
    const url = j > from ? flatPlain.slice(from, j) : "";
    return /^https?:\/\/[^\s<>]{1,2000}$/i.test(url) ? url : null;
  };
  let s = withoutComments(withoutBlocks(html.replace(/[\uE000-\uE002]/g, "")));
  s = withoutHidden(s);
  // Each <a href> with its label, as marks: the label made plain, the address kept.
  let out = "";
  let at = 0;
  const open = /<a\b/gi;
  // The next ">" and the next "</a>" are found once and remembered: links that have none, or one far off, do not
  // search for it again.
  const gt = nextMatch(s, />/g);
  const closing = nextMatch(s, /<\/a\s*>/gi);
  for (let m = open.exec(s), n = 0; m; m = open.exec(s)) {
    const tagEnd = gt(open.lastIndex);
    if (tagEnd.at < 0) break; // no ">" from here on: nothing after this is a tag
    if (tagEnd.at - open.lastIndex > TAG_MAX) continue;
    if (n++ >= 5000) break;
    const attrs = s.slice(open.lastIndex, tagEnd.at);
    open.lastIndex = tagEnd.end;
    const c = closing(open.lastIndex);
    if (c.at < 0) break; // no "</a>" from here on: no later link has one either
    if (c.at - open.lastIndex > 4000) continue;
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
    const raw = (href?.[2] ?? href?.[3] ?? href?.[4] ?? "").trim();
    const label = flatSpaces(htmlToText(s.slice(open.lastIndex, c.at))).replace(/[[\]]/g, "");
    const url = /^https?:\/\//i.test(raw) && !/[<>\s]/.test(raw) ? (direct(label) ?? htmlToText(raw)) : "";
    out += s.slice(at, m.index) + (label && url ? `${L0}${escapeHtml(label)}${L1}${escapeHtml(url)}${L2}` : s.slice(open.lastIndex, c.at));
    at = c.end;
    open.lastIndex = c.end;
  }
  s = htmlToText(out + s.slice(at));
  return s.replace(new RegExp(`${L0}([^${L0}${L1}${L2}]*)${L1}([^${L0}${L1}${L2}]*)${L2}`, "g"), (_, label: string, url: string) =>
    links === "marks" ? `[${label}](${url})` : `${label} (${url})`);
}

/**
 * The line a mail app writes above a quoted reply ("On Fri, Nov 13 … Robin <robin@…> wrote:"), in English, French,
 * German, Spanish, Portuguese, Italian, Dutch, the Scandinavian languages and Polish, as their mail apps write it.
 */
const QUOTE_INTRO = [
  /^on\b.{4,400}\bwrote:?$/i, /^le\b.{4,400}\ba écrit ?:$/i, /^am\b.{4,400}\bschrieb\b.{0,400}:$/i,
  /^el\b.{4,400}\bescribió ?:$/i, /^em\b.{4,400}\bescreveu ?:$/i, /^il\b.{4,400}\bha scritto ?:$/i,
  /^op\b.{4,400}\bschreef\b.{0,400}:$/i, /^den\b.{4,400}\bskrev\b.{0,400}:$/i, /^w dniu\b.{4,400}\bnapisał(\(a\)|a)? ?:$/i,
];
/** The words such a line starts with: only lines starting with one are joined and tried. */
const INTRO_START = /^(on|le|am|el|em|il|op|den|w dniu)\b/i;
/** Outlook's quoted reply: its separator ("Original Message" in the languages Outlook writes it in). */
const ORIGINAL = /^-{2,}\s*(original message|ursprüngliche nachricht|message d'origine|mensaje original|messaggio originale|mensagem original|oorspronkelijk bericht|ursprungligt meddelande)\s*-{2,}$/i;
/**
 * Outlook's header block (bold or not, in its languages): a From line with the lines a mail's head has under it. Told
 * from other lists that start with "From:" by what a mail's head has and they do not: the sender's address in the
 * From line with one more header under it, or a Subject line among at least two headers (isHeadBlock). A From line
 * followed by To alone is a bank's transfer notice ("From: Checking 1234", "To: Savings 5678") as often as a mail's
 * head: taken for one, the notice's own facts were folded away and missing from its preview.
 */
const HEAD_FROM = /^\*?(from|de|von|da|van|från|od)\s?:\*?\s/i;
const HEAD_NEXT = /^\*?(sent|date|to|subject|cc|envoyé|à|objet|gesendet|an|betreff|enviado|para|asunto|inviato|oggetto|verzonden|aan|onderwerp|skickat|till|ämne|wysłano|temat)\s?:/i;
const HEAD_SUBJECT = /^\*?(subject|objet|betreff|asunto|oggetto|onderwerp|ämne|temat)\s?:/i;
/** Whether a From line and the lines under it (the next few that are not empty) are a mail's head. */
function isHeadBlock(from: string, under: string[]): boolean {
  if (!HEAD_FROM.test(from)) return false;
  const headers = under.filter((x) => HEAD_NEXT.test(x));
  return from.includes("@") ? headers.length >= 1 : headers.length >= 2 && headers.some((x) => HEAD_SUBJECT.test(x));
}
/** Outlook's long line above its header block. */
const OUTLOOK_LINE = /^_{20,}$/;
/** The line a mail app writes above a forwarded mail. */
const FORWARD_HEAD = /^(-{2,} ?forwarded message ?-{2,}|begin forwarded message:?)$/i;

/**
 * A message's own words: its text up to the quoted history a reply carries below them (a line like "On … wrote:",
 * also split over up to three lines; lines starting with `>`; Outlook's "Original Message" or its From/Sent block).
 * The whole text when cutting would leave nothing (a mail that is only a quote, or a forward).
 */
export function ownWords(text: string): string {
  const at = quoteStart(text);
  return at < 0 ? text : text.slice(0, at).trim();
}

/**
 * Where a message's quoted history starts in its text (see ownWords), or -1 when it has none, or when it is all quote
 * (nothing would be left above it).
 */
export function quoteStart(text: string): number {
  const lines = text.split("\n");
  let cut = -1;
  for (let i = 0; i < lines.length && cut < 0; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (l.startsWith(">") || ORIGINAL.test(l)) { cut = i; break; }
    const next = lines.slice(i + 1, i + 6).map((x) => x.trim()).filter(Boolean);
    // The long line counts only with a header block right under it: a line of underscores alone is not a quote.
    if (OUTLOOK_LINE.test(l) && next[0] && HEAD_FROM.test(next[0]) && next.slice(1, 4).some((x) => HEAD_NEXT.test(x))) { cut = i; break; }
    if (isHeadBlock(l, next.slice(0, 4))) { cut = i; break; }
    if (!INTRO_START.test(l)) continue;
    for (let n = 1; n <= 3 && i + n <= lines.length; n++) {
      const joined = lines.slice(i, i + n).map((x) => x.trim()).join(" ");
      if (QUOTE_INTRO.some((re) => re.test(joined))) { cut = i; break; }
    }
  }
  if (cut < 0) return -1;
  const before = lines.slice(0, cut).join("\n");
  // Nothing above it, or a forward's heading ("---------- Forwarded message ---------", "Begin forwarded message:"):
  // the mail is what follows, and cutting there left a forward with a heading for its words.
  // A forward is not a reply's history either way: with a note above the heading, the forwarded mail is still what
  // the mail is about, and it stays in view.
  const above = before.split("\n").map((x) => x.trim()).filter(Boolean);
  if (!above.length || above.some((x) => FORWARD_HEAD.test(x))) return -1;
  return before.length + (cut > 0 ? 1 : 0);
}

/**
 * The signature a phone or a mail app adds as a mail's last line ("Sent from my iPhone", "Get Outlook for iOS", in the
 * languages those apps write it), or the standard signature line ("-- ") and all below it.
 */
const APP_SIGNATURE = /^(sent from (my )?\S.{0,40}|get outlook for (ios|android)|sent from (mail|outlook) for windows( \d+)?|enviado desde mi .{1,30}|enviado do meu .{1,30}|envoyé de mon .{1,30}|von meinem .{1,30} gesendet|inviato da(l mio)? .{1,30}|verzonden met .{1,30}|skickat från min .{1,30})$/i;

/**
 * A message's words without its signature, for previews: the "-- " line and all below it, or a phone's or mail app's
 * last line. The whole text when nothing would be left.
 */
export function withoutSignature(text: string): string {
  const lines = text.split("\n");
  const dash = lines.findIndex((l) => l === "-- " || l === "--");
  let end = dash > 0 ? dash : lines.length;
  let last = end - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  if (last > 0 && APP_SIGNATURE.test(lines[last].trim())) end = last;
  const kept = lines.slice(0, end).join("\n").trim();
  return kept ? kept : text;
}

/** A text part that is really HTML: five or more layout tags or comments (a text that mentions one tag is not). */
export function looksLikeHtml(s: string): boolean {
  const head = s.slice(0, 512 * 1024);
  const start = /<\/?(table|tr|td|th|tbody|div|p|span|center|br|img|h[1-6]|ul|li|a\s|font|style)\b|<!--/gi;
  const gt = nextMatch(head, />/g);
  let n = 0;
  for (let m = start.exec(head); m && n < 5; m = start.exec(head)) {
    if (m[0] === "<!--") { n++; continue; }
    // A layout tag counts when it closes within 2,000 characters.
    const c = gt(start.lastIndex);
    if (c.at < 0 || c.at - start.lastIndex > 2000) continue;
    start.lastIndex = c.end;
    n++;
  }
  return n >= 5;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", zwnj: "", zwj: "", shy: "", copy: "©", reg: "®", trade: "™", mdash: "-", ndash: "-", hellip: "...", rsquo: "'", lsquo: "'", rdquo: "\"", ldquo: "\"", bull: "*", middot: "*", euro: "€", pound: "£" };

/** A character reference's character, or nothing for a number no character has (&#x110000; threw, and the mail failed). */
const codePoint = (n: number): string => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");

// ---------------------------------------------------------------------------------------------------------------------
// Taking markup out, in one pass each. Mail is hostile input: as patterns (`<!--[\s\S]*?-->`, `<[^>]+>` and the like)
// each of these searched to the end of the mail again from every `<!--`, `<style` or `<` that was never closed, so a
// mail of a few hundred thousand of them held the hub for minutes (2026-11-20). They give the same text as the
// patterns did.

/** Where `re` (global) next matches at or after a place, remembered between asks, which only move forward. */
export function nextMatch(s: string, re: RegExp): (pos: number) => { at: number; end: number } {
  let from = 0;
  let found: { at: number; end: number } | null = null;
  return (pos) => {
    if (found && pos >= from && (found.at === -1 || found.at >= pos)) return found;
    from = pos;
    re.lastIndex = pos;
    const m = re.exec(s);
    found = m ? { at: m.index, end: re.lastIndex } : { at: -1, end: -1 };
    return found;
  };
}

/**
 * `s` with a space for each `<head>`, `<style>`, `<script>` and `<title>` element (or each element named in `names`,
 * plain lowercase names), to its own closing tag: what `<(head|style|script|title)\b[\s\S]*?<\/\1>` (gi) gave.
 */
export function withoutBlocks(s: string, names: readonly string[] = ["head", "style", "script", "title"]): string {
  const open = new RegExp(`<(${names.join("|")})\\b`, "gi");
  const closers = new Map<string, (pos: number) => { at: number; end: number }>();
  let out = "";
  let at = 0;
  for (let m = open.exec(s); m; m = open.exec(s)) {
    const name = m[1].toLowerCase();
    let closer = closers.get(name);
    if (!closer) { closer = nextMatch(s, new RegExp(`</${name}>`, "gi")); closers.set(name, closer); }
    const c = closer(open.lastIndex);
    if (c.at < 0) continue; // never closed: its tag goes with the other tags, its text stays
    out += `${s.slice(at, m.index)} `;
    at = c.end;
    open.lastIndex = c.end;
  }
  return out + s.slice(at);
}

/** `s` with a space for each comment. One never closed stays, and so does anything after it. */
export function withoutComments(s: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const a = s.indexOf("<!--", at);
    if (a < 0) break;
    const b = s.indexOf("-->", a + 4);
    if (b < 0) break;
    out += `${s.slice(at, a)} `;
    at = b + 3;
  }
  return out + s.slice(at);
}

/** `s` with `to` for each tag: a `<`, at least one character, and the next `>`. */
export function withoutTags(s: string, to = " "): string {
  let out = "";
  let at = 0;
  let from = 0;
  for (;;) {
    const lt = s.indexOf("<", from);
    if (lt < 0) break;
    const gt = s.indexOf(">", lt + 1);
    if (gt < 0) break; // no ">" from here on: nothing after this is a tag
    if (gt === lt + 1) { from = gt + 1; continue; } // "<>" is not a tag
    out += s.slice(at, lt) + to;
    at = gt + 1;
    from = at;
  }
  return out + s.slice(at);
}

export function htmlToText(html: string): string {
  return withoutTags(withoutComments(withoutBlocks(html))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section|article)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " "))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
