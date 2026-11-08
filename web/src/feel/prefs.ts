import { KEYS, SCALES, SHAPES, SYNTHS, THEMES, type Key, type Scale, type ShapeName, type Synth, type Theme } from "./theory";

/** A saved tap palette, chosen as `custom:<id>`. */
export interface Palette {
  id: string;
  name: string;
  colors: string[];
}

/** An uploaded image used as a shape, served from /prefs/feel/images/:id. */
export interface ImageShape {
  id: string;
  name: string;
  enabled: boolean;
  type: "image/png" | "image/webp";
}

/** The app's own colors. Built-ins come from the hub's `options.app_themes`; saved ones are chosen as `custom:<id>`. */
export interface AppTheme {
  id: string;
  name: string;
  mode: "light" | "dark";
  accent: string;
  background: string;
  surface: string;
  text: string;
}

export type Appearance = "system" | "light" | "dark";

/** The hub's feel setting (GET /prefs/feel). One for every device. */
export interface Feel {
  motion: boolean;
  theme: Theme;
  palettes: Palette[];
  shapes: ShapeName[];
  images: ImageShape[];
  shape_size: number;
  density: number;
  sound: boolean;
  volume: number;
  key: Key;
  scale: Scale;
  synth: Synth;
  octave: number;
  follow_music: boolean;
  hold: boolean;
  drag_bend: boolean;
  app_theme: string;
  app_themes: AppTheme[];
  appearance: Appearance;
}

export interface FeelView extends Feel {
  /** What is actually played: the setting, or the newest music idea's key when following music. */
  effective: { key: Key; scale: Scale; from: { id: string; title: string; key: string } | null };
  options?: {
    keys: string[];
    scales: string[];
    synths: string[];
    themes: string[];
    shapes?: string[];
    app_themes?: Array<AppTheme | { id: "classic"; name: string }>;
  };
}

/**
 * Built-in app color themes, copied from hub/src/feel.ts (the hub's `options.app_themes` wins when present).
 * `classic` changes nothing: the app's own light and dark look, chosen by `appearance`.
 */
export const APP_THEMES: AppTheme[] = [
  { id: "midnight", name: "Midnight", mode: "dark", accent: "#7C5CFF", background: "#0E1020", surface: "#181B33", text: "#E8E9F3" },
  { id: "paper", name: "Paper", mode: "light", accent: "#B5562B", background: "#F7F3EA", surface: "#FFFDF8", text: "#2B2622" },
  { id: "daylight", name: "Daylight", mode: "light", accent: "#0A84FF", background: "#F4F6FA", surface: "#FFFFFF", text: "#1C1C1E" },
  { id: "forest", name: "Forest", mode: "dark", accent: "#52B788", background: "#0F1A14", surface: "#17261D", text: "#E3F1E8" },
  { id: "ocean", name: "Ocean", mode: "dark", accent: "#2EC5FF", background: "#08151F", surface: "#10222F", text: "#E2F3FA" },
  { id: "sunset", name: "Sunset", mode: "dark", accent: "#FF9F43", background: "#1C1016", surface: "#2A1820", text: "#FBE9E1" },
  { id: "neon", name: "Neon", mode: "dark", accent: "#FF00E5", background: "#07070B", surface: "#121219", text: "#F2F2FF" },
];

export const MAX_PALETTES = 30;
export const MAX_PALETTE_COLORS = 8;
export const MAX_IMAGES = 24;
export const MAX_APP_THEMES = 20;

export const DEFAULT_FEEL: FeelView = {
  motion: true,
  theme: "aurora",
  palettes: [],
  shapes: ["triangle", "square", "circle", "hexagon", "diamond"],
  images: [],
  shape_size: 1,
  density: 1,
  sound: true,
  volume: 0.4,
  key: "C",
  scale: "major_pentatonic",
  synth: "sine",
  octave: 4,
  follow_music: false,
  hold: true,
  drag_bend: false,
  app_theme: "classic",
  app_themes: [],
  appearance: "system",
  effective: { key: "C", scale: "major_pentatonic", from: null },
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const ID = /^[a-z0-9-]{1,40}$/;

function name(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= 40 ? t : null;
}

function palette(v: unknown): Palette | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const n = name(r.name);
  if (typeof r.id !== "string" || !ID.test(r.id) || !n || !Array.isArray(r.colors)) return null;
  const colors = r.colors.filter((c): c is string => typeof c === "string" && HEX.test(c));
  if (!colors.length || colors.length !== r.colors.length || colors.length > MAX_PALETTE_COLORS) return null;
  return { id: r.id, name: n, colors };
}

function image(v: unknown): ImageShape | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const n = name(r.name);
  if (typeof r.id !== "string" || !ID.test(r.id) || !n || typeof r.enabled !== "boolean") return null;
  if (r.type !== "image/png" && r.type !== "image/webp") return null;
  return { id: r.id, name: n, enabled: r.enabled, type: r.type };
}

function appTheme(v: unknown): AppTheme | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const n = name(r.name);
  if (typeof r.id !== "string" || !ID.test(r.id) || !n || (r.mode !== "light" && r.mode !== "dark")) return null;
  for (const k of ["accent", "background", "surface", "text"] as const) if (typeof r[k] !== "string" || !HEX.test(r[k] as string)) return null;
  return { id: r.id, name: n, mode: r.mode, accent: r.accent as string, background: r.background as string, surface: r.surface as string, text: r.text as string };
}

/** Every item valid and ids unique, else nothing: a list is replaced whole, so a half list would lose things. */
function list<T extends { id: string }>(v: unknown, max: number, item: (x: unknown) => T | null): T[] | undefined {
  if (!Array.isArray(v) || v.length > max) return undefined;
  const out = v.map(item);
  if (out.some((x) => !x)) return undefined;
  const ids = out.map((x) => x!.id);
  if (new Set(ids).size !== ids.length) return undefined;
  return out as T[];
}

const range = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);

/** Keep only valid fields of an unknown value (a cached copy or a hub answer), so a bad value never breaks playback. */
export function cleanPatch(raw: unknown): Partial<Feel> {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<Feel> = {};
  for (const k of ["motion", "sound", "follow_music", "hold", "drag_bend"] as const) if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
  if (typeof r.theme === "string" && ((THEMES as readonly string[]).includes(r.theme) || /^custom:[a-z0-9-]{1,40}$/.test(r.theme))) out.theme = r.theme;
  const pals = list(r.palettes, MAX_PALETTES, palette);
  if (pals) out.palettes = pals;
  if (Array.isArray(r.shapes) && r.shapes.every((s) => (SHAPES as readonly unknown[]).includes(s))) out.shapes = [...new Set(r.shapes as ShapeName[])];
  const imgs = list(r.images, MAX_IMAGES, image);
  if (imgs) out.images = imgs;
  const size = range(r.shape_size, 0.5, 2);
  if (size !== undefined) out.shape_size = size;
  const dens = range(r.density, 0.5, 2);
  if (dens !== undefined) out.density = dens;
  const vol = range(r.volume, 0, 1);
  if (vol !== undefined) out.volume = vol;
  if ((KEYS as readonly unknown[]).includes(r.key)) out.key = r.key as Key;
  if (typeof r.scale === "string" && r.scale in SCALES) out.scale = r.scale as Scale;
  if ((SYNTHS as readonly unknown[]).includes(r.synth)) out.synth = r.synth as Synth;
  if (typeof r.octave === "number" && Number.isInteger(r.octave)) out.octave = Math.min(6, Math.max(2, r.octave));
  if (typeof r.app_theme === "string" && (r.app_theme === "classic" || /^(custom:)?[a-z0-9-]{1,40}$/.test(r.app_theme))) out.app_theme = r.app_theme;
  const apps = list(r.app_themes, MAX_APP_THEMES, appTheme);
  if (apps) out.app_themes = apps;
  if (r.appearance === "system" || r.appearance === "light" || r.appearance === "dark") out.appearance = r.appearance;
  return out;
}

/**
 * The hub's own repairs, made here too so a cached or offline copy behaves the same: an older single `colors` list
 * chosen as `custom` becomes the saved palette "My colors", and a palette or app theme that points at something
 * deleted falls back to the default.
 */
export function normalizeFeel<T extends Feel>(f: T, raw?: unknown): T {
  const out = { ...f };
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (r.theme === "custom") {
    const colors = Array.isArray(r.colors) ? r.colors.filter((c): c is string => typeof c === "string" && HEX.test(c)).slice(0, MAX_PALETTE_COLORS) : [];
    if (colors.length && !out.palettes.some((p) => p.id === "mine")) out.palettes = [...out.palettes, { id: "mine", name: "My colors", colors }];
    out.theme = colors.length ? "custom:mine" : DEFAULT_FEEL.theme;
  }
  if (!paletteExists(out, out.theme)) out.theme = DEFAULT_FEEL.theme;
  if (!appThemeExists(out, out.app_theme)) out.app_theme = DEFAULT_FEEL.app_theme;
  return out;
}

export function paletteExists(f: Pick<Feel, "palettes">, theme: string): boolean {
  return (THEMES as readonly string[]).includes(theme) || (theme.startsWith("custom:") && f.palettes.some((p) => `custom:${p.id}` === theme));
}

export function appThemeExists(f: Pick<Feel, "app_themes">, id: string): boolean {
  return id === "classic" || APP_THEMES.some((a) => a.id === id) || (id.startsWith("custom:") && f.app_themes.some((a) => `custom:${a.id}` === id));
}

/**
 * Apply a partial change over a view. Without follow_music the played key and scale are the setting's own, so they
 * move at once; with it they stay as the hub last said until its answer arrives.
 */
export function mergeFeel(base: FeelView, patch: Partial<Feel>): FeelView {
  const next: FeelView = normalizeFeel({ ...base, ...cleanPatch(patch) }, patch);
  if (!next.follow_music) next.effective = { key: next.key, scale: next.scale, from: null };
  return next;
}

/** A whole view from an unknown value (the hub's answer or the cached copy), defaults for anything missing or invalid. */
export function viewFrom(raw: unknown): FeelView {
  const base = mergeFeel(DEFAULT_FEEL, { ...cleanPatch(raw), ...legacy(raw) });
  const eff = (raw as { effective?: { key?: unknown; scale?: unknown; from?: unknown } } | null)?.effective;
  if (base.follow_music && eff && (KEYS as readonly unknown[]).includes(eff.key) && typeof eff.scale === "string" && eff.scale in SCALES) {
    const from = eff.from && typeof eff.from === "object" ? (eff.from as FeelView["effective"]["from"]) : null;
    base.effective = { key: eff.key as Key, scale: eff.scale as Scale, from };
  }
  const opts = (raw as { options?: FeelView["options"] } | null)?.options;
  if (opts) base.options = opts;
  return base;
}

/** An older cached copy's `{ theme: "custom", colors }`, passed through so normalizeFeel can turn it into a palette. */
function legacy(raw: unknown): Record<string, unknown> {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return r.theme === "custom" ? { theme: "custom", colors: r.colors } : {};
}

/** The palette shown for a theme value, by name. */
export function paletteName(f: Pick<Feel, "palettes">, theme: string, builtinNames: Record<string, string>): string {
  if (theme.startsWith("custom:")) return f.palettes.find((p) => `custom:${p.id}` === theme)?.name ?? "Aurora";
  return builtinNames[theme] ?? theme;
}

/** A fresh id for a palette, image or app theme: lowercase letters, digits and dashes. */
export function newId(taken: string[]): string {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, "") || "x";
    if (!taken.includes(id)) return id;
  }
}
