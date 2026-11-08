import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";

/**
 * How the app feels: the shapes that burst on a tap or a new item, and the note each tap plays. One setting for
 * every device, kept in `<data>/feel.json`. With `follow_music` the key and scale come from the newest music idea
 * that has a key, so a melody captured later sets the notes the app plays.
 */

export const KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;
export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  major_pentatonic: [0, 2, 4, 7, 9],
  minor_pentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
  whole_tone: [0, 2, 4, 6, 8, 10],
  hirajoshi: [0, 2, 3, 7, 8],
} as const;
export const SYNTHS = ["sine", "glass", "pluck", "bell", "marimba", "chip", "pad"] as const;
/** Built-in tap palettes. A saved palette is chosen as `custom:<id>`. */
export const THEMES = ["aurora", "sunset", "ocean", "forest", "neon", "candy", "mono"] as const;
export const SHAPES = ["triangle", "square", "circle", "hexagon", "diamond", "star", "ring", "spark"] as const;

/** Built-in app color themes. `classic` changes nothing (the system look, light or dark per `appearance`). */
export interface AppTheme { id: string; name: string; mode: "light" | "dark"; accent: string; background: string; surface: string; text: string }
export const APP_THEMES: Array<AppTheme | { id: "classic"; name: string }> = [
  { id: "classic", name: "Classic" },
  { id: "midnight", name: "Midnight", mode: "dark", accent: "#7C5CFF", background: "#0E1020", surface: "#181B33", text: "#E8E9F3" },
  { id: "paper", name: "Paper", mode: "light", accent: "#B5562B", background: "#F7F3EA", surface: "#FFFDF8", text: "#2B2622" },
  { id: "daylight", name: "Daylight", mode: "light", accent: "#0A84FF", background: "#F4F6FA", surface: "#FFFFFF", text: "#1C1C1E" },
  { id: "forest", name: "Forest", mode: "dark", accent: "#52B788", background: "#0F1A14", surface: "#17261D", text: "#E3F1E8" },
  { id: "ocean", name: "Ocean", mode: "dark", accent: "#2EC5FF", background: "#08151F", surface: "#10222F", text: "#E2F3FA" },
  { id: "sunset", name: "Sunset", mode: "dark", accent: "#FF9F43", background: "#1C1016", surface: "#2A1820", text: "#FBE9E1" },
  { id: "neon", name: "Neon", mode: "dark", accent: "#FF00E5", background: "#07070B", surface: "#121219", text: "#F2F2FF" },
];

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const Id = z.string().regex(/^[a-z0-9-]{1,40}$/);
const Name = z.string().trim().min(1).max(40);

export const Palette = z.object({ id: Id, name: Name, colors: z.array(Hex).min(1).max(8) });
export const ImageShape = z.object({ id: Id, name: Name, enabled: z.boolean(), type: z.enum(["image/png", "image/webp"]) });
export const CustomAppTheme = z.object({ id: Id, name: Name, mode: z.enum(["light", "dark"]), accent: Hex, background: Hex, surface: Hex, text: Hex });

export const Feel = z.object({
  motion: z.boolean(),
  /** A built-in palette name or `custom:<palette id>`. */
  theme: z.string(),
  /** Saved tap palettes, named and renameable. */
  palettes: z.array(Palette).max(30),
  shapes: z.array(z.enum(SHAPES)).max(SHAPES.length),
  /** Uploaded images used as shapes (translucent PNG or WebP), served from /prefs/feel/images/:id. */
  images: z.array(ImageShape).max(24),
  /** Shape size and how many shapes fly per burst, each 0.5 to 2 (1 is normal). */
  shape_size: z.number().min(0.5).max(2),
  density: z.number().min(0.5).max(2),
  sound: z.boolean(),
  volume: z.number().min(0).max(1),
  key: z.enum(KEYS),
  scale: z.enum(Object.keys(SCALES) as [keyof typeof SCALES, ...(keyof typeof SCALES)[]]),
  synth: z.enum(SYNTHS),
  octave: z.number().int().min(2).max(6),
  follow_music: z.boolean(),
  /** A held tap sustains its note until the finger lifts. */
  hold: z.boolean(),
  /** While holding, dragging up and down bends the note through the scale and left and right sweeps a filter. */
  drag_bend: z.boolean(),
  /** The app's own colors: a built-in id or `custom:<id>`; `appearance` applies to `classic`. */
  app_theme: z.string(),
  app_themes: z.array(CustomAppTheme).max(20),
  appearance: z.enum(["system", "light", "dark"]),
});
export type Feel = z.infer<typeof Feel>;

export const DEFAULT_FEEL: Feel = {
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
};

/**
 * Old files and dangling choices made whole: the single `custom` color list becomes a saved palette, and a theme
 * or app theme that points at something deleted falls back to the default.
 */
function normalize(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...DEFAULT_FEEL, ...raw } as Record<string, any>;
  if (out.theme === "custom") {
    const colors = Array.isArray(raw.colors) ? raw.colors : [];
    if (colors.length && !out.palettes.some((p: any) => p.id === "mine")) out.palettes = [...out.palettes, { id: "mine", name: "My colors", colors }];
    out.theme = colors.length ? "custom:mine" : DEFAULT_FEEL.theme;
  }
  delete out.colors;
  const paletteOk = (t: string) => (THEMES as readonly string[]).includes(t) || (t.startsWith("custom:") && out.palettes.some((p: any) => `custom:${p.id}` === t));
  if (typeof out.theme !== "string" || !paletteOk(out.theme)) out.theme = DEFAULT_FEEL.theme;
  const appOk = (t: string) => APP_THEMES.some((a) => a.id === t) || (t.startsWith("custom:") && out.app_themes.some((a: any) => `custom:${a.id}` === t));
  if (typeof out.app_theme !== "string" || !appOk(out.app_theme)) out.app_theme = DEFAULT_FEEL.app_theme;
  return out;
}

export class FeelStore {
  constructor(private file: string) {}

  /** Uploaded image shapes live next to the setting. */
  get imageDir(): string { return path.join(path.dirname(this.file), "feel-images"); }

  get(): Feel {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
      return Feel.parse(normalize(raw));
    } catch {
      return { ...DEFAULT_FEEL };
    }
  }

  /** Merge a partial update; anything invalid is refused whole. Ids inside a list must be unique. */
  set(patch: Record<string, unknown>): Feel {
    const merged = { ...this.get(), ...patch } as Record<string, unknown>;
    const next = Feel.safeParse(normalize(merged));
    if (!next.success) throw new StoreError(422, next.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    for (const list of ["palettes", "images", "app_themes"] as const) {
      const ids = next.data[list].map((x) => x.id);
      if (new Set(ids).size !== ids.length) throw new StoreError(422, `${list}: ids must be unique`);
    }
    // A theme the request chose but that does not exist is an error, not a silent fallback.
    for (const [k, v] of [["theme", patch.theme], ["app_theme", patch.app_theme]] as const) {
      if (typeof v === "string" && v !== "custom" && next.data[k] !== v) throw new StoreError(422, `${k}: ${v} does not exist`);
    }
    this.write(next.data);
    return next.data;
  }

  /**
   * Written to a temp file and renamed over the old one, so a crash or a full disk mid-write leaves the old file
   * whole. It was written in place: a half-written file read as the defaults, and the next change saved those over
   * the owner's palettes and images.
   */
  write(f: Feel): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(f), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
  }

  // ---- image shapes ----

  addImage(bytes: Uint8Array, type: string, name: string): Feel {
    if (type !== "image/png" && type !== "image/webp") throw new StoreError(415, "send a PNG or WebP image");
    if (bytes.length > MAX_IMAGE_BYTES) throw new StoreError(413, `images must be ${MAX_IMAGE_BYTES / 1024} KB or smaller; shrink it to about 256 px first`);
    const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const webp = String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
    if (!(type === "image/png" ? png : webp)) throw new StoreError(415, "the file is not the image type it claims to be");
    const f = this.get();
    if (f.images.length >= 24) throw new StoreError(422, "24 images at most; remove one first");
    const id = crypto.randomBytes(6).toString("hex");
    fs.mkdirSync(this.imageDir, { recursive: true });
    fs.writeFileSync(path.join(this.imageDir, id), bytes, { mode: 0o600 });
    const clean = name.trim().slice(0, 40) || "Image";
    return this.set({ images: [...f.images, { id, name: clean, enabled: true, type }] });
  }

  image(id: string): { bytes: Buffer; type: string } {
    const img = this.get().images.find((i) => i.id === id);
    const file = path.join(this.imageDir, id);
    if (!img || !/^[a-z0-9-]+$/.test(id) || !fs.existsSync(file)) throw new StoreError(404, "image not found");
    return { bytes: fs.readFileSync(file), type: img.type };
  }

  removeImage(id: string): Feel {
    const f = this.get();
    if (!f.images.some((i) => i.id === id)) throw new StoreError(404, "image not found");
    if (/^[a-z0-9-]+$/.test(id)) fs.rmSync(path.join(this.imageDir, id), { force: true });
    return this.set({ images: f.images.filter((i) => i.id !== id) });
  }
}

export const MAX_IMAGE_BYTES = 512 * 1024;

const FLATS: Record<string, string> = { DB: "C#", EB: "D#", GB: "F#", AB: "G#", BB: "A#", CB: "B", FB: "E" };
const SCALE_WORDS: Array<[RegExp, keyof typeof SCALES]> = [
  [/harmonic/, "harmonic_minor"],
  [/minor pent|min pent|m pent/, "minor_pentatonic"],
  [/pent/, "major_pentatonic"],
  [/blues/, "blues"],
  [/dorian/, "dorian"],
  [/phrygian/, "phrygian"],
  [/mixo/, "mixolydian"],
  [/lydian/, "lydian"],
  [/whole/, "whole_tone"],
  [/hirajoshi/, "hirajoshi"],
  [/minor|\bmin\b|^[a-g][#b]?m\b/, "minor"],
  [/major|\bmaj\b/, "major"],
];

/** "A minor", "Am", "F# dorian", "Bb", "Eb maj" → key and scale. Null when no note name leads the text. */
export function parseKey(text: string): { key: Feel["key"]; scale: Feel["scale"] } | null {
  const s = text.trim().toLowerCase();
  const m = /^([a-g])([#b♯♭]?)(?=$|[\s,/m-])/.exec(s);
  if (!m) return null;
  const acc = m[2] === "♯" ? "#" : m[2] === "♭" ? "b" : m[2];
  const raw = (m[1] + acc).toUpperCase();
  const key = FLATS[raw] ?? raw;
  if (!(KEYS as readonly string[]).includes(key)) return null;
  const scale = SCALE_WORDS.find(([re]) => re.test(s))?.[1] ?? "major";
  return { key: key as Feel["key"], scale };
}

export interface FeelView extends Feel {
  /** The key and scale actually played: the setting, or the newest music idea's when following music. */
  effective: { key: Feel["key"]; scale: Feel["scale"]; from: { id: string; title: string; key: string } | null };
  options: { keys: readonly string[]; scales: string[]; synths: readonly string[]; themes: readonly string[]; shapes: readonly string[]; app_themes: typeof APP_THEMES };
}

export function feelView(hub: Hub): FeelView {
  const feel = hub.feel.get();
  let effective: FeelView["effective"] = { key: feel.key, scale: feel.scale, from: null };
  if (feel.follow_music) {
    const ideas = hub.store.list({ kind: "music_idea", limit: 100000 })
      .filter((e) => typeof e.fields.key === "string" && parseKey(String(e.fields.key)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const idea = ideas[0];
    if (idea) {
      const k = parseKey(String(idea.fields.key))!;
      effective = { ...k, from: { id: idea.id, title: String(idea.fields.title ?? ""), key: String(idea.fields.key) } };
    }
  }
  return { ...feel, effective, options: { keys: KEYS, scales: Object.keys(SCALES), synths: SYNTHS, themes: THEMES, shapes: SHAPES, app_themes: APP_THEMES } };
}
