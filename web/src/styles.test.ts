import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const css = fs.readFileSync(path.resolve(__dirname, "styles.css"), "utf8");

describe("touch targets", () => {
  it("are at least 44 px on touch screens, set only under (pointer: coarse) so a mouse keeps the compact look", () => {
    const touch = css.split("@media (pointer: coarse) {").slice(1).find((b) => b.includes("button.small")) ?? "";
    expect(touch).toMatch(/button, button\.small,[^{]*\{ min-height: 44px; \}/);
    expect(touch).toMatch(/\.tabs a \{ min-height: 44px;/);
    expect(css).toMatch(/^button\.small \{ min-height: 28px;/m);
  });
  it("a screen's heading that takes the focus shows no ring for a mouse or a tap", () => {
    expect(css).toContain("#main h1:focus:not(:focus-visible) { outline: none; }");
  });
});

describe("the Mail screen's side list", () => {
  it("keeps every row at its height and scrolls, and heads a mailbox's folders with its address on one line", () => {
    // Free to shrink, the rows of a long list (two mailboxes' folders and the bundles) were drawn over each other.
    expect(css).toMatch(/^\.mailx-rail > \* \{ flex-shrink: 0; \}/m);
    expect(css).toMatch(/^\.mailx-rail \{[^}]*overflow-y: auto;/m);
    expect(css).toMatch(/^\.mailx-label\.box \{ text-transform: none;[^}]*text-overflow: ellipsis; white-space: nowrap; \}/m);
    const src = fs.readFileSync(path.join(__dirname, "views/Mail.tsx"), "utf8");
    expect(src).toContain('<div className="mailx-label box" title={g.email}>{g.email}</div>');
    expect(src).toContain("{boxes.length > 1\n            ? folderGroups(list.data?.folders ?? [], boxes).map((g) => (");
  });
});

describe("the Mail screen's Undo bar", () => {
  it("stays in view wherever the list is scrolled to: it sticks to the bottom, and is the last thing in the scrolling column", () => {
    expect(css).toMatch(/^\.mailx-undo \{ position: sticky; bottom: 8px;/m);
    const screen = fs.readFileSync(path.resolve(__dirname, "views/Mail.tsx"), "utf8");
    const main = screen.slice(screen.indexOf('<div className="mailx-main">'));
    const bar = main.indexOf('className="mailx-undo"');
    // Sticking to the bottom holds only for what comes after the rest: above the list, the bar scrolled away with it.
    for (const before of ["<InboxList ", "<Flat ", "<FolderView ", "<HitList title=\"In all your mail\"", "mailx-hint"]) {
      expect(main.indexOf(before)).toBeGreaterThan(-1);
      expect(bar).toBeGreaterThan(main.indexOf(before));
    }
    expect(main.slice(bar, bar + 400)).toMatch(/Undo<\/button>\s*<\/div>\s*\)\}\s*<\/div>/);
  });
});

describe("the Mail screen at every width", () => {
  it("an open mail's actions go on as many lines as they need, so each can be reached on a phone", () => {
    expect(css).toMatch(/^\.mailx-card-acts \{ display: flex; flex-wrap: wrap;/m);
  });
  it("a selection's actions wrap and are never scrolled out of sight; the bar grows with them and uses its whole width", () => {
    expect(css).toMatch(/^\.mailx-selbar \{[^}]*flex-wrap: wrap;[^}]*\}/m);
    expect(css).not.toMatch(/\.mailx-selbar \{[^}]*(flex-wrap: nowrap|overflow-x)/);
    expect(css).not.toMatch(/\.mailx-selbar[^{]*\{[^}]*position: sticky/);
    expect(css).toContain(".mailx-bar.selecting { grid-template-columns: minmax(0, 1fr); height: auto; min-height: 56px; }");
    expect(css).toContain("@media (pointer: coarse) { .mailx-bar.selecting { min-height: 64px; } }");
    expect(css).toMatch(/@media \(min-width: 1200px\) \{[^@]*\.mailx-bar\.selecting \{ padding-right: 16px; \} \}/);
  });
  it("a long bundle or folder name shortens with an ellipsis and leaves New mail in the bar", () => {
    expect(css).toContain(".mailx-bar { container-type: inline-size; }");
    expect(css).toMatch(/^\.mailx-bar h1 \{ min-width: 0; max-width: calc\(100cqw - \d+px\); overflow: hidden; text-overflow: ellipsis; \}/m);
    for (const w of [767, 560, 420]) expect(css, `up to ${w}px`).toMatch(new RegExp(`@media \\(max-width: ${w}px\\) \\{ \\.mailx-bar h1 \\{ max-width: calc\\(100cqw - \\d+px\\); \\} \\}`));
    // While mail is selected on a wide window the title keeps the side list's width, so the cap does not apply there.
    expect(css).toMatch(/\.mailx-bar\.selecting \.mailx-bar-left > h1 \{ flex: none; width: calc\(var\(--mailx-rail, 210px\) - 26px\); max-width: none;/);
  });
});
