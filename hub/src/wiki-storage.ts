/**
 * Confluence storage format (XHTML with `ac:` and `ri:` elements) to markdown, for the wiki mirror. Tolerant of
 * unclosed tags. Links to other pages come out as `wiki-title:<space>/<title>` and images stored on a page as
 * `wiki-media:<pageId>/<file>`; the wiki resolves both when a page is read, so a page added later still links.
 */

interface El { tag: string; attrs: Record<string, string>; kids: Node[] }
type Node = El | string;

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  mdash: "—", ndash: "–", hellip: "…", middot: "·", bull: "•", times: "×", rarr: "→", larr: "←",
  deg: "°", copy: "©", reg: "®", trade: "™", plusmn: "±", le: "≤", ge: "≥", ne: "≠",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const VOID = new Set(["br", "hr", "img", "col"]);

export function parseStorage(src: string): El {
  const root: El = { tag: "#root", attrs: {}, kids: [] };
  const stack: El[] = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>|([^<]+)|(<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.kids.push(m[1]);
    else if (m[2]) {
      const name = m[2].toLowerCase();
      const at = stack.map((e) => e.tag).lastIndexOf(name);
      if (at > 0) stack.length = at;
    } else if (m[3]) {
      const attrs: Record<string, string> = {};
      for (const a of (m[4] ?? "").matchAll(/([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g)) attrs[a[1].toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? "");
      const el: El = { tag: m[3].toLowerCase(), attrs, kids: [] };
      top.kids.push(el);
      if (!m[5] && !VOID.has(el.tag)) stack.push(el);
    } else if (m[6] !== undefined) top.kids.push(decodeEntities(m[6]));
    else if (m[7]) top.kids.push("<");
  }
  return root;
}

const child = (e: El, tag: string) => e.kids.find((k): k is El => typeof k !== "string" && k.tag === tag);
const children = (e: El, tag: string) => e.kids.filter((k): k is El => typeof k !== "string" && k.tag === tag);
const param = (e: El, name: string) => {
  const p = e.kids.find((k): k is El => typeof k !== "string" && k.tag === "ac:parameter" && k.attrs["ac:name"] === name);
  return p ? textOf(p).trim() : "";
};
function textOf(n: Node): string {
  return typeof n === "string" ? n : n.kids.map(textOf).join("");
}

const BLOCK = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "pre", "blockquote", "hr", "div", "section",
  "ac:layout", "ac:layout-section", "ac:layout-cell", "ac:task-list", "ac:rich-text-body", "ac:adf-extension", "ac:adf-node",
]);
const INLINE_MACROS = new Set(["status", "anchor", "jira", "mention"]);
const DROP_MACROS = new Set(["toc", "children", "pagetree", "recently-updated", "contentbylabel", "content-report-table", "livesearch", "pagetreesearch", "attachments", "include", "excerpt-include", "create-from-template", "profile", "space-details"]);
const CALLOUTS: Record<string, string> = { info: "Info", note: "Note", warning: "Warning", tip: "Tip", panel: "", "note-panel": "Note" };

function isBlock(n: Node): boolean {
  if (typeof n === "string") return false;
  if (n.tag === "ac:structured-macro" || n.tag === "ac:macro") return !INLINE_MACROS.has(n.attrs["ac:name"] ?? "");
  return BLOCK.has(n.tag);
}

class Renderer {
  constructor(private pageId: string, private spaceKey: string) {}

  blocks(kids: Node[]): string[] {
    const out: string[] = [];
    let buf = "";
    const flush = () => {
      const t = buf.replace(/ *  \n */g, "  \n").trim();
      if (t) out.push(t);
      buf = "";
    };
    for (const k of kids) {
      if (isBlock(k)) {
        flush();
        out.push(...this.block(k as El).filter((b) => b.trim()));
      } else buf += this.inline(k);
    }
    flush();
    return out;
  }

  block(e: El): string[] {
    const t = e.tag;
    if (/^h[1-6]$/.test(t)) {
      const s = this.inlineKids(e).replace(/\s+/g, " ").trim();
      return s ? [`${"#".repeat(Number(t[1]))} ${s}`] : [];
    }
    if (t === "p") return [this.inlineKids(e).replace(/ *  \n */g, "  \n").trim()];
    if (t === "hr") return ["---"];
    if (t === "ul" || t === "ol") return [this.list(e, t === "ol")];
    if (t === "table") return [this.table(e)];
    if (t === "pre") return [fence(textOf(e), "")];
    if (t === "blockquote") return [quote(this.blocks(e.kids).join("\n\n"))];
    if (t === "ac:task-list") return [this.tasks(e)];
    if (t === "ac:adf-extension" || t === "ac:adf-node") {
      const fb = child(e, "ac:adf-fallback");
      return fb ? this.blocks(fb.kids) : [];
    }
    if (t === "ac:structured-macro" || t === "ac:macro") return this.macro(e);
    return this.blocks(e.kids);
  }

  macro(e: El): string[] {
    const name = e.attrs["ac:name"] ?? "";
    const body = child(e, "ac:rich-text-body");
    if (name === "code" || name === "noformat") {
      const plain = child(e, "ac:plain-text-body");
      return [fence(plain ? textOf(plain) : "", param(e, "language"))];
    }
    if (DROP_MACROS.has(name)) return [];
    if (name in CALLOUTS) {
      const title = param(e, "title");
      const label = [CALLOUTS[name], title].filter(Boolean).join(": ");
      const inner = body ? this.blocks(body.kids).join("\n\n") : "";
      return inner || label ? [quote((label ? `**${label}**\n\n` : "") + inner)] : [];
    }
    if (name === "expand") {
      const inner = body ? this.blocks(body.kids) : [];
      return [`**${param(e, "title") || "Details"}**`, ...inner];
    }
    if (body) return this.blocks(body.kids);
    const plain = child(e, "ac:plain-text-body");
    return plain ? [fence(textOf(plain), "")] : [];
  }

  list(e: El, ordered: boolean): string {
    const items = children(e, "li");
    return items.map((li, i) => {
      const marker = ordered ? `${i + 1}. ` : "- ";
      const pad = " ".repeat(marker.length);
      const inner = this.blocks(li.kids).join("\n") || "";
      return marker + inner.split("\n").map((l, j) => (j === 0 || !l ? l : pad + l)).join("\n");
    }).join("\n");
  }

  tasks(e: El): string {
    return children(e, "ac:task").map((t) => {
      const done = textOf(child(t, "ac:task-status") ?? { tag: "", attrs: {}, kids: [] }).trim() === "complete";
      const b = child(t, "ac:task-body");
      return `- [${done ? "x" : " "}] ${b ? this.inlineKids(b).replace(/\s+/g, " ").trim() : ""}`;
    }).join("\n");
  }

  table(e: El): string {
    const rows: El[] = [];
    const walk = (n: El) => { for (const k of n.kids) if (typeof k !== "string") { if (k.tag === "tr") rows.push(k); else if (k.tag !== "table") walk(k); } };
    walk(e);
    const grid = rows.map((r) => r.kids.filter((k): k is El => typeof k !== "string" && (k.tag === "th" || k.tag === "td"))
      .map((c) => this.blocks(c.kids).join(" ").replace(/\n+/g, " ").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim()));
    const width = Math.max(0, ...grid.map((r) => r.length));
    if (!width) return "";
    const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
    return [line(grid[0]), `| ${Array(width).fill("---").join(" | ")} |`, ...grid.slice(1).map(line)].join("\n");
  }

  inlineKids(e: El): string {
    return e.kids.map((k) => (isBlock(k) ? ` ${this.blocks([k]).join(" ")} ` : this.inline(k))).join("");
  }

  inline(n: Node): string {
    if (typeof n === "string") return n.replace(/\s+/g, " ");
    const t = n.tag;
    const inner = () => this.inlineKids(n);
    const wrap = (mark: string) => {
      const s = inner();
      const core = s.trim();
      if (!core) return s;
      return s.slice(0, s.indexOf(core[0])) + mark + core + mark + s.slice(s.lastIndexOf(core[core.length - 1]) + 1);
    };
    switch (t) {
      case "br": return "  \n";
      case "strong": case "b": return wrap("**");
      case "em": case "i": return wrap("*");
      case "s": case "del": case "strike": return wrap("~~");
      case "code": return "`" + textOf(n).replace(/`/g, "'") + "`";
      case "a": {
        const href = n.attrs.href ?? "";
        const s = inner().trim() || href;
        return href ? `[${s}](${href.replace(/ /g, "%20")})` : s;
      }
      case "time": return n.attrs.datetime ?? inner();
      case "ac:link": return this.link(n);
      case "ac:image": return this.image(n);
      case "ac:emoticon": return n.attrs["ac:emoji-fallback"] ?? "";
      case "ac:placeholder": return "";
      case "ac:structured-macro": case "ac:macro": {
        const name = n.attrs["ac:name"] ?? "";
        if (name === "status") { const s = param(n, "title"); return s ? `**[${s}]**` : ""; }
        if (name === "jira") { const k = param(n, "key"); return k ? `Jira ${k}` : ""; }
        return "";
      }
      case "ri:user": return "";
      default: return inner();
    }
  }

  link(n: El): string {
    const body = child(n, "ac:plain-text-link-body") ?? child(n, "ac:link-body");
    const text = body ? (body.tag === "ac:link-body" ? this.inlineKids(body) : textOf(body)).trim() : "";
    const page = child(n, "ri:page") ?? child(n, "ri:blog-post");
    if (page) {
      const title = page.attrs["ri:content-title"] ?? "";
      const space = page.attrs["ri:space-key"] || this.spaceKey;
      return title ? `[${text || title}](wiki-title:${encodeURIComponent(space)}/${encodeURIComponent(title)})` : text;
    }
    const url = child(n, "ri:url");
    if (url?.attrs["ri:value"]) return `[${text || url.attrs["ri:value"]}](${url.attrs["ri:value"]})`;
    const att = child(n, "ri:attachment");
    if (att?.attrs["ri:filename"]) return `[${text || att.attrs["ri:filename"]}](wiki-media:${this.pageId}/${encodeURIComponent(att.attrs["ri:filename"])})`;
    return text;
  }

  image(n: El): string {
    const alt = (n.attrs["ac:alt"] ?? n.attrs["ac:title"] ?? "").replace(/[\[\]]/g, "");
    const att = child(n, "ri:attachment");
    if (att?.attrs["ri:filename"]) {
      const owner = child(att, "ri:page");
      // An image attached to another page is named by that page's title; the mirror keeps only this page's files.
      if (owner) return alt || att.attrs["ri:filename"];
      return `![${alt || att.attrs["ri:filename"]}](wiki-media:${this.pageId}/${encodeURIComponent(att.attrs["ri:filename"])})`;
    }
    const url = child(n, "ri:url");
    return url?.attrs["ri:value"] ? `![${alt}](${url.attrs["ri:value"]})` : "";
  }
}

function fence(code: string, lang: string): string {
  const body = code.replace(/^\n+|\s+$/g, "");
  const ticks = /```/.test(body) ? "````" : "```";
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

function quote(s: string): string {
  return s.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
}

/** Markdown for one page's storage body. */
export function storageToMarkdown(xhtml: string, pageId = "", spaceKey = ""): string {
  const r = new Renderer(pageId, spaceKey);
  return r.blocks(parseStorage(xhtml).kids).join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** File names of the images and attachments a page's body shows from itself. */
export function attachmentsShown(xhtml: string): string[] {
  const out = new Set<string>();
  const walk = (n: Node, inOtherPage: boolean) => {
    if (typeof n === "string") return;
    if (n.tag === "ri:attachment" && !inOtherPage && !child(n, "ri:page") && n.attrs["ri:filename"]) out.add(n.attrs["ri:filename"]);
    for (const k of n.kids) walk(k, inOtherPage);
  };
  walk(parseStorage(xhtml), false);
  return [...out];
}
