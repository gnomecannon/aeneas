/**
 * Notes and colors for the feel layer. Pure functions only, so the tests and the mock hub can use them.
 * KEYS, SCALES and parseKey are copied from hub/src/feel.ts and must stay in step with it.
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

export type Key = (typeof KEYS)[number];
export type Scale = keyof typeof SCALES;
export type Synth = (typeof SYNTHS)[number];
/** A built-in palette or `custom:<palette id>`. */
export type Theme = string;
export type BuiltinTheme = (typeof THEMES)[number];
export type ShapeName = (typeof SHAPES)[number];

/** Voices that hold their level while pressed; the others ring and fade to a quiet sustain. */
export const SUSTAINING: readonly Synth[] = ["sine", "glass", "pad", "chip"];

export const SCALE_NAMES: Record<Scale, string> = {
  major: "Major",
  minor: "Minor",
  major_pentatonic: "Major pentatonic",
  minor_pentatonic: "Minor pentatonic",
  blues: "Blues",
  dorian: "Dorian",
  phrygian: "Phrygian",
  lydian: "Lydian",
  mixolydian: "Mixolydian",
  harmonic_minor: "Harmonic minor",
  whole_tone: "Whole tone",
  hirajoshi: "Hirajoshi",
};

export const SYNTH_NAMES: Record<Synth, string> = {
  sine: "Sine",
  glass: "Glass",
  pluck: "Pluck",
  bell: "Bell",
  marimba: "Marimba",
  chip: "Chiptune",
  pad: "Pad",
};

export const THEME_NAMES: Record<BuiltinTheme, string> = {
  aurora: "Aurora",
  sunset: "Sunset",
  ocean: "Ocean",
  forest: "Forest",
  neon: "Neon",
  candy: "Candy",
  mono: "Accent only",
};

export const SHAPE_NAMES: Record<ShapeName, string> = {
  triangle: "Triangle",
  square: "Square",
  circle: "Circle",
  hexagon: "Hexagon",
  diamond: "Diamond",
  star: "Star",
  ring: "Ring",
  spark: "Spark",
};

export const THEME_COLORS: Record<Exclude<BuiltinTheme, "mono">, string[]> = {
  aurora: ["#7C5CFF", "#2EC5FF", "#3DF5A7", "#FFD166", "#FF5C8A"],
  sunset: ["#FF6B6B", "#FF9F43", "#FECA57", "#FF7EB6", "#A55EEA"],
  ocean: ["#00B4D8", "#0077B6", "#48CAE4", "#90E0EF", "#06D6A0"],
  forest: ["#2D6A4F", "#52B788", "#95D5B2", "#B5E48C", "#74C69D"],
  neon: ["#FF00E5", "#00F0FF", "#39FF14", "#FFF300", "#FF3131"],
  candy: ["#FFADAD", "#FFD6A5", "#FDFFB6", "#CAFFBF", "#9BF6FF", "#A0C4FF", "#BDB2FF", "#FFC6FF"],
};

/** MIDI note of the scale root: C4 is 60. */
export function rootMidi(key: Key, octave: number): number {
  const i = KEYS.indexOf(key);
  return 12 * (octave + 1) + (i < 0 ? 0 : i);
}

/** Every note of the scale across two octaves up from the root, with the top root included. */
export function scaleNotes(key: Key, scale: Scale, octave: number): number[] {
  const root = rootMidi(key, octave);
  const steps = SCALES[scale] ?? SCALES.major_pentatonic;
  const out: number[] = [];
  for (const o of [0, 12]) for (const s of steps) out.push(root + o + s);
  out.push(root + 24);
  return out;
}

/** The MIDI note of a scale degree counted up from the root (0 is the root, 2 the third step, and so on). */
export function degreeNote(key: Key, scale: Scale, octave: number, degree: number): number {
  const steps = SCALES[scale] ?? SCALES.major_pentatonic;
  const o = Math.floor(degree / steps.length);
  return rootMidi(key, octave) + 12 * o + steps[degree % steps.length];
}

/** A random note from the list that is never `last`, unless the list has only that note. */
export function randomNote(notes: number[], last: number | null, rnd: () => number = Math.random): number {
  const pool = notes.length > 1 && last !== null ? notes.filter((n) => n !== last) : notes;
  return pool[Math.min(pool.length - 1, Math.floor(rnd() * pool.length))];
}

export function midiToHz(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function hexToRgba(hex: string, a: number): string | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** The accent at a few opacities, for the "Accent only" palette. */
export function monoColors(accent: string): string[] {
  const a = accent.trim() || "#2f5fbf";
  const rgba = [1, 0.75, 0.5, 0.3].map((o) => hexToRgba(a, o));
  return rgba.every((c) => c) ? (rgba as string[]) : [a];
}

/**
 * The colors shapes are drawn in: a built-in palette, or `custom:<id>` of a saved one. `mono` is the app accent at a
 * few opacities; anything unknown or empty falls back to aurora.
 */
export function themeColors(theme: Theme, palettes: Array<{ id: string; colors: string[] }>, accent: string): string[] {
  if (theme.startsWith("custom:")) {
    const p = palettes.find((x) => `custom:${x.id}` === theme);
    return p && p.colors.length ? p.colors : THEME_COLORS.aurora;
  }
  if (theme === "mono") return monoColors(accent);
  return THEME_COLORS[theme as keyof typeof THEME_COLORS] ?? THEME_COLORS.aurora;
}

/**
 * The note `steps` scale steps away from `midi` (up is positive), kept inside two octaves either side of it. A start
 * note outside the scale counts from the nearest scale note below it.
 */
export function stepInScale(key: Key, scale: Scale, midi: number, steps: number): number {
  const pcs = new Set<number>((SCALES[scale] ?? SCALES.major_pentatonic).map((s) => (s + KEYS.indexOf(key) + 12) % 12));
  const list: number[] = [];
  for (let m = midi - 24; m <= midi + 24; m++) if (pcs.has(((m % 12) + 12) % 12)) list.push(m);
  let i = list.findIndex((m) => m >= midi);
  if (i < 0) i = list.length - 1;
  else if (list[i] > midi && i > 0) i -= 1;
  const j = Math.min(list.length - 1, Math.max(0, i + Math.round(steps)));
  return list[j] ?? midi;
}

/** Vertical drag ignored before the first step, then pixels per scale step while bending. */
export const BEND_DEAD_PX = 12;
export const BEND_PX = 44;

/** Scale steps for a vertical drag (`dy` down positive): up is higher. */
export function bendSteps(dy: number): number {
  const travel = Math.max(0, Math.abs(dy) - BEND_DEAD_PX);
  return Math.round(travel / BEND_PX) * (dy < 0 ? 1 : -1) || 0;
}

/** Where the filter knob rests for every note, before any sideways drag. */
export const FILTER_REST_HZ = 3100;

/** The low-pass cutoff for a sideways drag: one octave per 30 px from 3.1 kHz, 60 Hz to 16 kHz. */
export function filterHz(dx: number): number {
  return Math.min(16000, Math.max(60, FILTER_REST_HZ * Math.pow(2, dx / 30)));
}

/** Saturation fed to the filter for a sideways drag, 0 to 1 (full by 40 px): a sine has no overtones to cut. */
export function filterDrive(dx: number): number {
  return Math.min(1, Math.abs(dx) / 40);
}

const FLATS: Record<string, string> = { DB: "C#", EB: "D#", GB: "F#", AB: "G#", BB: "A#", CB: "B", FB: "E" };
const SCALE_WORDS: Array<[RegExp, Scale]> = [
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

/** "A minor", "Am", "F# dorian", "Bb" to key and scale, as the hub reads a music idea's key. Null when no note leads. */
export function parseKey(text: string): { key: Key; scale: Scale } | null {
  const s = text.trim().toLowerCase();
  const m = /^([a-g])([#b♯♭]?)(?=$|[\s,/m-])/.exec(s);
  if (!m) return null;
  const acc = m[2] === "♯" ? "#" : m[2] === "♭" ? "b" : m[2];
  const raw = (m[1] + acc).toUpperCase();
  const key = FLATS[raw] ?? raw;
  if (!(KEYS as readonly string[]).includes(key)) return null;
  const scale = SCALE_WORDS.find(([re]) => re.test(s))?.[1] ?? "major";
  return { key: key as Key, scale };
}
