/**
 * Markdown to safe HTML: headings, paragraphs, fenced code, block quotes, nested lists, task lists, tables, rules,
 * images, links, inline code, bold, italics and strikethrough. Raw HTML is shown as text, never run.
 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export interface MarkdownOptions {
  /** Hard line breaks: every newline inside a paragraph shows (notes, chat). Off, lines join and only two trailing spaces break (docs). */
  breaks?: boolean;
  /** Added to each heading level, so a note's `#` sits below the screen's own title. 2 by default (`#` is h3). */
  headingShift?: number;
  /** Give headings ids (`h-<slug>`) so `#slug` links can scroll to them. */
  anchors?: boolean;
  /** Where a link or image points, or null to show its text only. The default keeps web, mail and app links. */
  url?: (href: string, kind: "link" | "image") => string | null;
  /**
   * "link" shows every image as a link to open instead of loading it. For text a model wrote: a reply that names a
   * picture at https://anywhere/?d=<something private> would otherwise send it there the moment the reply shows.
   */
  images?: "show" | "link";
  /**
   * Which images load where they stand (with `images: "show"`). Any other image is a link to open: loading a picture
   * from another site tells that site this device's address and when the text was read, and nothing the user turned
   * on asked for that. By default none load; the wiki passes the pictures it keeps on the hub.
   */
  loadImage?: (url: string) => boolean;
}

/** Links that are safe to keep as they are: web pages, mail and the app's own `everythingapp://` links. */
export function safeUrl(href: string, kind: "link" | "image"): string | null {
  if (/^https?:\/\//i.test(href)) return href;
  if (kind === "link" && /^(mailto:|everythingapp:\/\/)/i.test(href)) return href;
  return null;
}

/** GitHub's heading slug: lower case, punctuation dropped, spaces to hyphens. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}>/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;
const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** A line that ends a fence opened with `mark`: the same character, at least as many, nothing after. */
const closesFence = (l: string, mark: string) => {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l);
  return !!m && m[1][0] === mark[0] && m[1].length >= mark.length;
};
const indentOf =(l: string) => (/^\s*/.exec(l)?.[0] ?? "").replace(/\t/g, "    ").length;
const isItem = (l: string) => {
  const m = ITEM.exec(l);
  // "- " needs text or the end of the line; a lone "-1" or "2020." inside a sentence is not a list.
  return !!m && (m[3] !== undefined || /^\s*([-*+]|\d{1,9}[.)])\s*$/.test(l));
};
const isTableStart = (lines: string[], i: number) =>
  lines[i].includes("|") && i + 1 < lines.length && DELIM.test(lines[i + 1]) && lines[i + 1].includes("-") && tableCells(lines[i]).length === tableCells(lines[i + 1]).length;
const startsBlock = (lines: string[], i: number) => {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || isItem(l) || isTableStart(lines, i);
};

/** Cells of one table row: split on pipes that are not escaped and not inside code. */
export function tableCells(row: string): string[] {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (ch === "`") {
      code = !code;
      cur += ch;
    } else if (ch === "|" && !code) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

class Renderer {
  private slugs = new Map<string, number>();
  private breaks: boolean;
  private shift: number;
  private url: (href: string, kind: "link" | "image") => string | null;

  constructor(private o: MarkdownOptions) {
    this.breaks = o.breaks ?? true;
    this.shift = o.headingShift ?? 2;
    this.url = o.url ?? safeUrl;
  }

  inline(src: string): string {
    const held: string[] = [];
    const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;
    let s = src;
    // A pipe in code inside a table cell is written `\|`; it shows as a plain pipe.
    s = s.replace(/`([^`]+)`/g, (_, c: string) => hold(`<code>${escapeHtml(c.replace(/\\\|/g, "|"))}</code>`));
    s = s.replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_, c: string) => hold(escapeHtml(c)));
    s = s.replace(/!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g, (_, alt: string, href: string) => {
      const u = this.url(href, "image");
      if (u && (this.o.images === "link" || !this.o.loadImage?.(u))) return hold(`<a href="${escapeHtml(u)}" target="_blank" rel="noreferrer" title="A picture, not loaded until you open it">${escapeHtml(alt || "Picture")}</a>`);
      return hold(u ? `<img src="${escapeHtml(u)}" alt="${escapeHtml(alt)}" loading="lazy"/>` : escapeHtml(alt));
    });
    s = s.replace(/\[((?:[^[\]]|\[[^\]]*\])*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g, (_, text: string, href: string) => {
      const u = this.url(href, "link");
      const inner = this.emphasis(text);
      if (!u) return hold(inner);
      const ext = /^https?:/i.test(u) ? ' target="_blank" rel="noreferrer"' : "";
      return hold(`<a href="${escapeHtml(u)}"${ext}>${inner}</a>`);
    });
    s = s.replace(/<(https?:\/\/[^>\s]+)>/g, (m, href: string) => {
      const u = this.url(href, "link");
      return u ? hold(`<a href="${escapeHtml(u)}" target="_blank" rel="noreferrer">${escapeHtml(href)}</a>`) : m;
    });
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<\u0000]*[^\s<\u0000.,;:!?)'"])/g, (m, pre: string, href: string) => {
      const u = this.url(href, "link");
      return u ? pre + hold(`<a href="${escapeHtml(u)}" target="_blank" rel="noreferrer">${escapeHtml(href)}</a>`) : m;
    });
    let out = this.emphasis(s);
    // Held pieces can hold others (code inside a link), so put them back until none are left.
    for (let n = 0; n < 4 && out.includes("\u0000"); n++) out = out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => held[Number(i)] ?? "");
    return out;
  }

  private emphasis(s: string): string {
    let out = escapeHtml(s);
    out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^\w])__([^_]+)__(?!\w)/g, "$1<strong>$2</strong>");
    out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    out = out.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
    out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return out;
  }

  private heading(level: number, text: string): string {
    const lvl = Math.min(Math.max(level + this.shift, 1), 6);
    let id = "";
    if (this.o.anchors) {
      const base = slugify(text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_~]/g, ""));
      const n = this.slugs.get(base) ?? 0;
      this.slugs.set(base, n + 1);
      id = ` id="h-${escapeHtml(n ? `${base}-${n}` : base)}"`;
    }
    return `<h${lvl}${id}>${this.inline(text)}</h${lvl}>`;
  }

  private paragraph(lines: string[]): string {
    if (this.breaks) return `<p>${this.inline(lines.join("\n")).replace(/\n/g, "<br/>")}</p>`;
    const parts = lines.map((l, i) => {
      const hard = i < lines.length - 1 && (/ {2,}$/.test(l) || /\\$/.test(l));
      const t = l.replace(/\\$/, "").trim();
      return hard ? t + "\u0001" : t;
    });
    return `<p>${this.inline(parts.join(" ").replace(/\u0001 /g, "\n")).replace(/\n/g, "<br/>")}</p>`;
  }

  private table(lines: string[]): string {
    const head = tableCells(lines[0]);
    const align = tableCells(lines[1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : /^:-+/.test(c) ? "left" : ""));
    const cell = (tag: string, text: string, i: number) => `<${tag}${align[i] ? ` style="text-align:${align[i]}"` : ""}>${this.inline(text)}</${tag}>`;
    const body = lines.slice(2).map((r) => {
      const cells = tableCells(r);
      return `<tr>${head.map((_, i) => cell("td", cells[i] ?? "", i)).join("")}</tr>`;
    });
    return `<div class="md-table"><table><thead><tr>${head.map((h, i) => cell("th", h, i)).join("")}</tr></thead>${body.length ? `<tbody>${body.join("")}</tbody>` : ""}</table></div>`;
  }

  /** One list at the indentation of `lines[start]`; returns the HTML and the line after it. */
  private list(lines: string[], start: number): [string, number] {
    const base = indentOf(lines[start]);
    const kind = (l: string) => /\d/.test(ITEM.exec(l)![2]);
    const ordered = kind(lines[start]);
    const num = ordered ? parseInt(ITEM.exec(lines[start])![2], 10) : 1;
    const sameLevel = (l: string) => isItem(l) && indentOf(l) <= base + 1;
    const items: string[][] = [];
    // Where the current item's text starts; deeper lines are cut to it, or to their own indent when that is less.
    let content = 0;
    let i = start;
    while (i < lines.length) {
      const l = lines[i].replace(/\t/g, "    ");
      if (sameLevel(l)) {
        // A different kind of marker at the same depth starts a new list.
        if (kind(l) !== ordered) break;
        const m = ITEM.exec(l)!;
        content = m[3] ? l.length - m[3].length : m[1].length + m[2].length + 1;
        items.push([m[3] ?? ""]);
        i++;
        continue;
      }
      if (!l.trim()) {
        // A blank line stays in the list only when the list goes on after it.
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && (indentOf(lines[j]) > base || (sameLevel(lines[j]) && kind(lines[j]) === ordered))) {
          for (; i < j; i++) items[items.length - 1].push("");
          continue;
        }
        break;
      }
      if (indentOf(l) > base) {
        items[items.length - 1].push(l.slice(Math.min(indentOf(l), content)));
        i++;
        continue;
      }
      break;
    }
    const lis = items.map((body) => {
      // The item's first lines are its text; anything after them (a nested list, code, a quote) is its blocks.
      let k = 0;
      const text: string[] = [];
      while (k < body.length && body[k].trim() && (k === 0 || !startsBlock(body, k))) text.push(body[k++]);
      const rest = this.blocks(body.slice(k));
      const task = /^\[([ xX])\]\s+/.exec(text[0] ?? "");
      if (task) text[0] = text[0].slice(task[0].length);
      const inner = text.length ? (this.breaks ? this.inline(text.join("\n")).replace(/\n/g, "<br/>") : this.inline(text.map((t) => t.trim()).join(" "))) : "";
      if (task) return `<li class="task"><input type="checkbox" disabled${task[1] === " " ? "" : " checked"}/> ${inner}${rest}</li>`;
      return `<li>${inner}${rest}</li>`;
    });
    const html = ordered ? `<ol${num !== 1 ? ` start="${num}"` : ""}>${lis.join("")}</ol>` : `<ul>${lis.join("")}</ul>`;
    return [html, i];
  }

  blocks(lines: string[]): string {
    const html: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = FENCE.exec(line);
      if (fence) {
        const mark = fence[1];
        const lang = fence[2];
        const buf: string[] = [];
        i++;
        while (i < lines.length && !closesFence(lines[i], mark)) buf.push(lines[i++]);
        i++;
        html.push(`<pre><code${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}>${escapeHtml(buf.join("\n"))}</code></pre>`);
        continue;
      }
      const h = HEADING.exec(line);
      if (h) {
        html.push(this.heading(h[1].length, h[2]));
        i++;
        continue;
      }
      if (RULE.test(line)) {
        html.push("<hr/>");
        i++;
        continue;
      }
      if (QUOTE.test(line)) {
        const buf: string[] = [];
        while (i < lines.length && QUOTE.test(lines[i])) buf.push(lines[i++].replace(/^ {0,3}> ?/, ""));
        html.push(`<blockquote>${this.blocks(buf)}</blockquote>`);
        continue;
      }
      if (isTableStart(lines, i)) {
        const buf = [lines[i], lines[i + 1]];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) buf.push(lines[i++]);
        html.push(this.table(buf));
        continue;
      }
      if (isItem(line)) {
        const [list, next] = this.list(lines, i);
        html.push(list);
        i = next;
        continue;
      }
      if (!line.trim()) {
        i++;
        continue;
      }
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim() && (buf.length === 0 || !startsBlock(lines, i))) buf.push(lines[i++]);
      html.push(this.paragraph(buf));
    }
    return html.join("\n");
  }
}

export function renderMarkdown(src: string, opts: MarkdownOptions = {}): string {
  return new Renderer(opts).blocks(src.replace(/\r\n?/g, "\n").split("\n"));
}

/** Wikilink targets in a markdown body, without brackets or aliases. */
export function wikilinks(body: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.add(m[1].trim());
  return [...out];
}
