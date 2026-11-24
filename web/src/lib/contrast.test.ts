import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAIL_HOVER, MAIL_WORDS, themeVars } from "../feel/appTheme";
import { APP_THEMES } from "../feel/prefs";
import { OWN_COLORS } from "./mail";

/** WCAG relative luminance from a #rrggbb string. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

export function contrast(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** Pulls `--name: #hex;` tokens out of one CSS block. */
function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6});/g)) out[m[1]] = m[2].toLowerCase();
  return out;
}

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const light = tokens(css.slice(0, css.indexOf("@media (prefers-color-scheme: dark)")));
const darkStart = css.indexOf(':root[data-theme="dark"]');
const dark = tokens(css.slice(darkStart, css.indexOf("}", darkStart)));
/** The same dark tokens again, for a system in dark mode with no appearance chosen. */
const systemDarkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const systemDark = tokens(css.slice(systemDarkStart, css.indexOf("}", systemDarkStart)));

/** `top` laid over `bottom` with `part` of it showing (0 to 1), as a #rrggbb. */
function over(top: string, part: number, bottom: string): string {
  const a = parseInt(top.slice(1), 16);
  const b = parseInt(bottom.slice(1), 16);
  const ch = (shift: number) => Math.round(((a >> shift) & 255) * part + ((b >> shift) & 255) * (1 - part));
  return "#" + [16, 8, 0].map((sh) => ch(sh).toString(16).padStart(2, "0")).join("");
}

/** A black or white veil written as `rgb(0 0 0 / .2)` in the rule that starts with `selector`: its color and how much of it shows. */
function veil(selector: string): { color: string; part: number } {
  const at = css.indexOf(selector);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const m = /rgb\((0 0 0|255 255 255) \/ (\.\d+)\)/.exec(css.slice(at, css.indexOf("}", at)));
  expect(m, selector).not.toBeNull();
  return { color: m![1] === "0 0 0" ? "#000000" : "#ffffff", part: Number(m![2]) };
}

const MAIL = Object.keys(MAIL_WORDS.light);

/**
 * Pin, Snooze, Done and Sweep: their words are their color moved toward the text color (`words` of the color left), on
 * a wash of the color over what is behind (`wash` of it showing), as their rule in styles.css says.
 */
function actWash(): { words: number; wash: number } {
  const at = css.indexOf(".mailx-act.act-pin, .mailx-act.act-snooze, .mailx-act.act-done, .mailx-act.mailx-sweep { color:");
  expect(at).toBeGreaterThanOrEqual(0);
  const m = /\{ color: color-mix\(in srgb, var\(--ct\) (\d+)%, var\(--text\)\); background: color-mix\(in srgb, var\(--ct\) (\d+)%, transparent\);/.exec(css.slice(at, css.indexOf("}", at) + 1));
  expect(m).not.toBeNull();
  return { words: Number(m![1]) / 100, wash: Number(m![2]) / 100 };
}
/** The places those four sit by their color: Pin is the Inbox's, Snooze is Snoozed's, Done and Sweep are Done's. */
const ACTS = ["inbox", "snoozed", "done"];

describe("design token contrast", () => {
  for (const [name, t] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    it(`${name}: status text (text-2) reads at 4.5:1 on bg and surface`, () => {
      expect(contrast(t["text-2"], t.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t["text-2"], t.surface)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: body text and muted text read on bg and surface`, () => {
      expect(contrast(t.text, t.bg)).toBeGreaterThanOrEqual(7);
      expect(contrast(t.muted, t.surface)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: primary button text reads on the accent`, () => {
      expect(contrast(t["accent-text"], t.accent)).toBeGreaterThanOrEqual(4.5);
    });

    // The Mail screen (Mail.tsx). Its fills carry white; its words sit on the page, a mail's row, a row being pointed at
    // (the row under a thin veil) and the side list.
    const pointedAt = over(MAIL_HOVER[name].veil, MAIL_HOVER[name].part, t["mail-item"]);
    it(`${name}: Mail's colors carry white (the bar's words, a bundle's icon, a sender's initials)`, () => {
      for (const id of MAIL) expect(contrast("#ffffff", t[`b-${id}`]), `white on ${id}`).toBeGreaterThanOrEqual(4.5);
    });
    it(`${name}: the owner's own bundle colors carry white, and are the ones styles.css draws`, () => {
      const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
      OWN_COLORS.forEach((c, i) => {
        expect(contrast("#ffffff", c), `white on color ${i + 1}`).toBeGreaterThanOrEqual(4.5);
        expect(css, `cc${i}`).toContain(`.b-custom.cc${i} { --c: ${c}; --barc: ${c}; }`);
      });
    });
    it(`${name}: Mail's colors as words read on the page, a row and a row being pointed at, and as icons on the side list`, () => {
      for (const id of MAIL) {
        expect(t[`bt-${id}`], id).toBe(MAIL_WORDS[name][id as keyof typeof MAIL_WORDS.light]);
        for (const bg of [t["mail-page"], t["mail-item"], pointedAt]) expect(contrast(t[`bt-${id}`], bg), `${id} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        for (const bg of [t.surface, t["surface-2"]]) expect(contrast(t[`bt-${id}`], bg), `${id} icon on ${bg}`).toBeGreaterThanOrEqual(3);
      }
    });
    it(`${name}: every kind of words reads on Mail's page, a row and a row being pointed at`, () => {
      for (const k of ["text", "muted", "text-2", "link", "danger-text", "ok-text", "warn-text"]) {
        for (const bg of [t["mail-page"], t["mail-item"], pointedAt]) expect(contrast(t[k], bg), `${k} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${name}: Mail's search box carries white words and its placeholder on every bar color`, () => {
      const box = veil(".mailx-search {");
      const placeholder = veil(".mailx-search::placeholder {");
      expect(box.color).toBe("#000000");
      expect(placeholder.color).toBe("#ffffff");
      // Pointed at, the search box goes deeper, never lighter: its words and placeholder read as well or better.
      const hovered = veil(".mailx-search:hover:not(:focus) {");
      expect(hovered.color).toBe("#000000");
      expect(hovered.part).toBeGreaterThanOrEqual(box.part);
      // The selection's buttons when pointed at: the bar darkened, as the search box, so their white words read too.
      for (const rule of [".mailx-selbar button:hover {"]) expect(veil(rule).color, rule).toBe("#000000");
      // Refresh, New mail and Search are white with the bar's color on them, as the Pinned only switch's circle: white
      // under the bar's color reads as the bar's white words do.
      const white = css.slice(css.indexOf(".mailx-bar .mailx-refresh, .mailx-bar .mailx-compose-btn, .mailx-bar .mailx-search-btn {"));
      expect(white.slice(0, white.indexOf("}"))).toMatch(/background: #fff;[^}]*color: var\(--barc\);/);
      // Pointed at, they turn the bar's color deepened (never lightened), with white on it: white reads there as on the bar.
      const hover = white.slice(white.indexOf("}") + 1);
      expect(hover.slice(0, hover.indexOf("}"))).toMatch(/background: color-mix\(in srgb, var\(--barc\) \d+%, #000\); color: #fff;/);
      for (const id of MAIL) {
        const field = over(box.color, box.part, t[`b-${id}`]);
        expect(contrast("#ffffff", field), `typed words on ${id}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(over(placeholder.color, placeholder.part, field), field), `placeholder on ${id}`).toBeGreaterThanOrEqual(4.5);
      }
    });
    // Words that sit on something other than the plain page or a row (2026-11-23: Sweep read at 3.87 on the light
    // page, a swiped row's label at 2.74, a past trip's words at 3.65 and 3.44).
    it(`${name}: Pin, Snooze, Done and Sweep read on their own wash, over the page and over a mail's row`, () => {
      const { words, wash } = actWash();
      for (const id of ACTS) {
        for (const bg of [t["mail-page"], t["mail-item"]]) {
          expect(contrast(over(t[`bt-${id}`], words, t.text), over(t[`bt-${id}`], wash, bg)), `${id} on its wash over ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });
    it(`${name}: a swiped row's label is white on a panel that is never faded or lightened`, () => {
      expect(css).not.toMatch(/\.mailx-swipe[^{]*\{[^}]*opacity/);
      const at = css.indexOf(".mailx-swipe {");
      expect(css.slice(at, css.indexOf("}", at))).toContain("color: #fff;");
      for (const [cls, id] of [["done", "done"], ["snooze", "snoozed"]] as const) {
        const deep = new RegExp(`\\.mailx-swipe\\.${cls} \\{ background: color-mix\\(in srgb, var\\(--b-${id}\\) (\\d+)%, #000\\);`).exec(css);
        expect(deep, cls).not.toBeNull();
        expect(css).toContain(`.mailx-swipe.${cls}.armed { background: var(--b-${id}); }`);
        // Before it is far enough to act the color is deepened; once it is, the color itself.
        expect(contrast("#ffffff", over(t[`b-${id}`], Number(deep![1]) / 100, "#000000")), `${cls}, not far enough yet`).toBeGreaterThanOrEqual(4.5);
        expect(contrast("#ffffff", t[`b-${id}`]), `${cls}, far enough`).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${name}: a trip that is over is gray, not faded, so its words read like any others on a mail's row`, () => {
      expect(css).not.toMatch(/\.mailx-trip\.past[^{]*\{[^}]*opacity/);
      expect(css).toContain(".mailx-trip.past .mailx-trip-head b { color: var(--muted); }");
      expect(css).toContain(".mailx-trip.past .mailx-av.bundle { background: var(--surface-2); color: var(--muted); border-color: var(--border); }");
      for (const k of ["text", "muted"]) expect(contrast(t[k], t["mail-item"]), `${k} in a past trip`).toBeGreaterThanOrEqual(4.5);
      // Its circle's icon: not words, 3:1.
      expect(contrast(t.muted, t["surface-2"])).toBeGreaterThanOrEqual(3);
    });
  }

  it("in every built-in theme Pin, Snooze, Done and Sweep read on their own wash, and a past trip's words on a mail's row", () => {
    const { words, wash } = actWash();
    for (const theme of APP_THEMES) {
      const v = themeVars(theme);
      for (const id of ACTS) {
        for (const bg of [v["--mail-page"], v["--mail-item"]]) {
          expect(contrast(over(v[`--bt-${id}`], words, v["--text"]), over(v[`--bt-${id}`], wash, bg)), `${theme.name}: ${id} on its wash over ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(contrast(v["--muted"], v["--mail-item"]), `${theme.name}: a past trip's name`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(v["--muted"], v["--surface-2"]), `${theme.name}: a past trip's icon`).toBeGreaterThanOrEqual(3);
    }
  });

  it("the veil over a pointed-at mail is the one the themes count on", () => {
    const lightVeil = /--mail-hover: rgb\(0 0 0 \/ (\.\d+)\);/.exec(css.slice(0, systemDarkStart));
    const darkVeil = /--mail-hover: rgb\(255 255 255 \/ (\.\d+)\);/.exec(css.slice(darkStart));
    expect(Number(lightVeil?.[1])).toBe(MAIL_HOVER.light.part);
    expect(Number(darkVeil?.[1])).toBe(MAIL_HOVER.dark.part);
  });

  it("dark is the same whether the system or the appearance setting chose it", () => {
    expect(systemDark).toEqual(dark);
    for (const rule of ["--mail-hover"]) {
      const a = new RegExp(`${rule}: ([^;]+);`).exec(css.slice(systemDarkStart, css.indexOf("}", systemDarkStart)));
      const b = new RegExp(`${rule}: ([^;]+);`).exec(css.slice(darkStart, css.indexOf("}", darkStart)));
      expect(a?.[1]).toBe(b?.[1]);
      expect(a).not.toBeNull();
    }
  });
});
