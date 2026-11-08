import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
  }
});
