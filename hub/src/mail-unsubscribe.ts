import { isAddress } from "./mail-compose.js";

/**
 * Unsubscribe (CONTRACT.md, Mail): the ways a mail's List-Unsubscribe header offers, as the hub takes them. Everything
 * here is the sender's: only an https address without a login in it (one-click when List-Unsubscribe-Post says so,
 * else a page to open), and only a plain mailto address; nothing else is used.
 */
export interface UnsubscribeWays {
  /** RFC 8058: the hub POSTs `List-Unsubscribe=One-Click` here (the owner confirms). */
  one_click?: string;
  /** A page the owner opens in their browser. */
  link?: string;
  /** An address to write to: a draft the owner sends. */
  mailto?: { to: string; subject: string };
}

const https = (raw: string): string | null => {
  if (raw.length > 2000) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname.includes(".") && !u.username && !u.password ? u.toString() : null;
  } catch { return null; }
};

export function unsubscribeWays(header: string, post: string): UnsubscribeWays {
  const out: UnsubscribeWays = {};
  const oneClick = /List-Unsubscribe\s*=\s*One-Click/i.test(post);
  for (const m of header.slice(0, 8000).matchAll(/<([^<>\s]{1,2000})>/g)) {
    const v = m[1];
    if (/^https:/i.test(v)) {
      const url = https(v);
      if (!url) continue;
      if (oneClick && !out.one_click) out.one_click = url;
      else if (!out.link) out.link = url;
    } else if (/^mailto:/i.test(v) && !out.mailto) {
      const [addr, query = ""] = v.slice(7).split("?");
      let to = "";
      try { to = decodeURIComponent(addr).trim().toLowerCase(); } catch { continue; }
      if (!isAddress(to)) continue;
      let subject = "unsubscribe";
      try { subject = (new URLSearchParams(query).get("subject") ?? "unsubscribe").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "unsubscribe"; } catch { /* the default */ }
      out.mailto = { to, subject };
    }
  }
  return out;
}

/** A blocked sender as kept: an address, or `@domain` for a whole domain (and its subdomains). */
export function blockedForm(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s.startsWith("@")) return /^@([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(s) ? s : null;
  return isAddress(s) ? s : null;
}

/**
 * Mail providers so many people use that a block of the whole domain would take mail from people the owner knows.
 * One address there can be blocked.
 */
const SHARED_DOMAINS = new Set(["gmail.com", "googlemail.com", "icloud.com", "me.com", "mac.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "aol.com",
  "proton.me", "protonmail.com", "pm.me", "fastmail.com", "gmx.com", "gmx.de", "gmx.net", "web.de", "mail.com", "yandex.com", "yandex.ru", "mail.ru", "qq.com", "163.com", "126.com",
  "hey.com", "tutanota.com", "tuta.com", "duck.com", "t-online.de", "orange.fr", "free.fr", "laposte.net", "comcast.net", "verizon.net", "att.net", "btinternet.com", "sky.com"]);
/**
 * The same providers under a country's ending (hotmail.co.uk, yahoo.co.jp, outlook.de, gmx.at, yahoo.com.br): the
 * list above cannot name each one, so the provider's name before a country's ending counts.
 */
const SHARED_NAME = /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|rocketmail|aol|gmx|yandex|mail|icloud)\.(?:co\.|com\.)?[a-z]{2}$/;
/** An ending many sites share (co.uk, com.au, or.jp): not one sender's domain. */
const SHARED_ENDING = /^(co|com|net|org|ac|gov|edu|ne|or|go)\.[a-z]{2}$/;

/**
 * Why a sender (in blockedForm) cannot be blocked, in the hub's words, or null when it can: the owner's own address
 * (`own`: the linked mailboxes), a mail provider's whole domain, or an ending many sites share.
 */
export function blockRefusal(sender: string, own: string[]): string | null {
  if (!sender.startsWith("@")) return own.includes(sender) ? "That is your own address." : null;
  const domain = sender.slice(1);
  // The owner's own domain (or one above it): their own mail, and that of everyone who shares the domain with them,
  // would be moved out with it.
  if (own.some((a) => isBlocked([sender], a))) return `Your own address is at ${domain}. Block the one address instead.`;
  if (SHARED_DOMAINS.has(domain) || SHARED_NAME.test(domain)) return `Many people have an address at ${domain}. Block the one address instead.`;
  if (SHARED_ENDING.test(domain)) return `${domain} is the ending of many sites, not one sender's. Block the sender's own domain or address.`;
  return null;
}

/** Whether an address is one of the blocked: the address itself, or under a blocked domain. */
export function isBlocked(blocked: string[], address: string): boolean {
  const a = address.trim().toLowerCase();
  // The domain is what follows the last @: an address may hold one inside quotes ("a@b"@spam.example), and read from
  // the first one, such a sender was under no blocked domain.
  const domain = a.slice(a.lastIndexOf("@") + 1);
  return blocked.some((b) => (b.startsWith("@") ? domain === b.slice(1) || domain.endsWith(`.${b.slice(1)}`) : b === a));
}
