import { APP_THEMES, type AppTheme, type Appearance, type Feel } from "./prefs";

/**
 * App color themes. Classic leaves styles.css alone (its own light and dark, picked by `appearance`). Any other theme
 * overrides the CSS variables on <html> from four colors, deriving the rest (secondary text, muted text, borders, the
 * second surface, text on the accent) so everything stays readable.
 */

export type ThemeColors = Pick<AppTheme, "mode" | "accent" | "background" | "surface" | "text">;

/** The classic light and dark tokens, for previews of Classic and for the status colors of other themes. */
export const CLASSIC = {
  light: { bg: "#f5f4f1", surface: "#ffffff", text: "#1b1d22", accent: "#2f5fbf", danger: "#b4443c", ok: "#3a8f5a", warn: "#c2871a" },
  dark: { bg: "#17181b", surface: "#1f2126", text: "#e8e6e1", accent: "#7ea2ea", danger: "#e07a73", ok: "#6cc08a", warn: "#e0a84a" },
} as const;

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
}

/** `a` moved toward `b` by `t` (0 is a, 1 is b). */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return hex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** WCAG relative luminance of a #rrggbb color. */
export function luminance(c: string): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(c);
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrast(a: string, b: string): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * The text color softened toward the surface by `t`, pulled back toward the text color until it reads at `min`
 * against every background given. When even the text color itself cannot, the text color is returned.
 */
function softened(text: string, toward: string, t: number, min: number, on: string[]): string {
  for (let k = t; k > 0; k -= 0.04) {
    const c = mix(text, toward, k);
    if (on.every((b) => contrast(c, b) >= min)) return c;
  }
  return text;
}

/** Text on an accent button: white when it reads, else a dark ink from the theme, else whichever of white or black reads better. */
function onAccent(accent: string, ink: string): string {
  const white = "#ffffff";
  if (contrast(white, accent) >= 4.5) return white;
  if (contrast(ink, accent) >= 4.5) return ink;
  return contrast(white, accent) >= contrast("#000000", accent) ? white : "#000000";
}

/** Every CSS variable a theme sets. */
export function themeVars(t: ThemeColors): Record<string, string> {
  const dark = t.mode === "dark";
  const base = dark ? CLASSIC.dark : CLASSIC.light;
  const on = [t.background, t.surface];
  const ink = mix(t.background, "#000000", dark ? 0.4 : 0.85);
  return {
    "--bg": t.background,
    "--surface": t.surface,
    "--surface-2": mix(t.surface, t.text, dark ? 0.09 : 0.07),
    "--text": t.text,
    "--text-2": softened(t.text, t.surface, 0.25, 4.5, on),
    "--muted": softened(t.text, t.surface, 0.42, 4.5, on),
    "--border": mix(t.surface, t.text, dark ? 0.18 : 0.15),
    "--accent": t.accent,
    "--accent-text": onAccent(t.accent, ink),
    "--danger": base.danger,
    "--ok": base.ok,
    "--warn": base.warn,
    "color-scheme": t.mode,
  };
}

/** Built-in and saved themes, in the order Settings shows them (Classic first). */
export function allAppThemes(f: Pick<Feel, "app_themes">): Array<AppTheme & { custom: boolean }> {
  return [...APP_THEMES.map((a) => ({ ...a, custom: false })), ...f.app_themes.map((a) => ({ ...a, id: `custom:${a.id}`, custom: true }))];
}

/** The theme chosen, or null for Classic. */
export function resolveAppTheme(f: Pick<Feel, "app_theme" | "app_themes">): AppTheme | null {
  if (f.app_theme === "classic") return null;
  if (f.app_theme.startsWith("custom:")) return f.app_themes.find((a) => `custom:${a.id}` === f.app_theme) ?? null;
  return APP_THEMES.find((a) => a.id === f.app_theme) ?? null;
}

/** Classic's colors for a preview card, as the appearance and the system would show them. */
export function classicColors(appearance: Appearance, systemDark: boolean): ThemeColors {
  const dark = appearance === "dark" || (appearance === "system" && systemDark);
  const c = dark ? CLASSIC.dark : CLASSIC.light;
  return { mode: dark ? "dark" : "light", accent: c.accent, background: c.bg, surface: c.surface, text: c.text };
}

export function appThemeName(f: Pick<Feel, "app_theme" | "app_themes" | "appearance">): string {
  const t = resolveAppTheme(f);
  if (t) return t.name;
  return f.appearance === "system" ? "Classic" : `Classic, ${f.appearance}`;
}

const VARS = Object.keys(themeVars({ mode: "light", accent: "#000000", background: "#ffffff", surface: "#ffffff", text: "#000000" }));
let themeColorMeta: Array<{ el: HTMLMetaElement; content: string }> | null = null;

/** Put the chosen theme on <html>. Classic removes every override and sets `data-theme` from the appearance. */
export function applyAppTheme(f: Pick<Feel, "app_theme" | "app_themes" | "appearance">): void {
  const root = document.documentElement;
  const t = resolveAppTheme(f);
  if (!themeColorMeta) themeColorMeta = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')).map((el) => ({ el, content: el.content }));
  if (!t) {
    for (const v of VARS) root.style.removeProperty(v);
    if (f.appearance === "light" || f.appearance === "dark") root.setAttribute("data-theme", f.appearance);
    else root.removeAttribute("data-theme");
    for (const m of themeColorMeta) m.el.content = m.content;
    return;
  }
  const vars = themeVars(t);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.setAttribute("data-theme", t.mode);
  for (const m of themeColorMeta) m.el.content = t.background;
}
