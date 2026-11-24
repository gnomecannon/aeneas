import { estimateBpm, findHits, frameLevels, HUM_RATE, humUse, melodyNotes, snapToGrid, type HumNote, type PitchTrack } from "../src/hum.js";

/**
 * Made-up hums whose notes are known, for measuring how well a hum is heard. A voice does more than a tone generator:
 * it scoops up into a note, wobbles with vibrato, drifts, falls off at the end of a phrase, breathes between phrases,
 * and sings in a room with some noise. Each of those can be switched on per note or per hum.
 */
export interface SynthNote {
  /** MIDI pitch (the note the singer means), start and length in seconds. */
  p: number; s: number; d: number;
  /** Starts this many semitones below (or above, when negative) and reaches the pitch over `scoopSeconds`. */
  scoop?: number; scoopSeconds?: number;
  /** Falls this many semitones over the last `fallSeconds` while fading (the end of a phrase). */
  fall?: number; fallSeconds?: number;
  /** Loudness, 0 to 1 (default 0.6). */
  amp?: number;
  /** Sung this many semitones off the note meant (a singer is rarely exactly on it). */
  off?: number;
  /** Overshoots the pitch by this many semitones after arriving and settles back over about 150 ms. */
  overshoot?: number;
}

export interface SynthOptions {
  /** Vibrato depth (semitones either way) and rate; it starts after the first 150 ms of a note. */
  vibrato?: number; vibratoHz?: number;
  /** Slow wandering of the pitch, semitones either way. */
  drift?: number;
  /** The whole hum off the piano's tuning by this many semitones. */
  detune?: number;
  /** "hum": a closed-mouth hum, mostly the fundamental. "ah": an open vowel whose second and third overtones are
   * louder than the fundamental (a low voice singing). */
  timbre?: "hum" | "ah";
  /** Breath noise in the gaps between notes, as a fraction of the notes' loudness (0.1 is 20 dB down). */
  breath?: number;
  /** Steady room noise under everything, as a fraction of full scale. */
  room?: number;
  /** Slow unsteady wavering of a held note (semitones either way, about 2.5 times a second). */
  waver?: number;
  /** Random pitch jitter from moment to moment (semitones). */
  jitter?: number;
  /** Glide between touching notes (seconds). */
  legato?: number;
  /** Silence before the first note and after the last. */
  pad?: number;
  /** A phone's microphone, which loses the low end: a high-pass filter at this many Hz (two poles). */
  highpass?: number;
  seed?: number;
}

/** The hum's samples at HUM_RATE. */
export function synthHum(notes: SynthNote[], o: SynthOptions = {}): Float32Array {
  const pad = o.pad ?? 0.3;
  const end = Math.max(...notes.map((n) => n.s + n.d)) + pad;
  const out = new Float32Array(Math.ceil((end + pad) * HUM_RATE));
  let seed = o.seed ?? 5;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  const vib = o.vibrato ?? 0, vibHz = o.vibratoHz ?? 5.5, legato = o.legato ?? 0.05;
  const harm = o.timbre === "ah" ? [0.35, 1, 0.8, 0.45, 0.3, 0.2, 0.12, 0.08, 0.05, 0.03] : [1, 0.25, 0.11, 0.06, 0.04, 0.03, 0.02, 0.015];
  // Slow drift: a sum of two slow sines with random phases.
  const ph1 = rnd() * Math.PI, ph2 = rnd() * Math.PI;
  const driftAt = (t: number) => (o.drift ?? 0) * (0.6 * Math.sin(2 * Math.PI * 0.4 * t + ph1) + 0.4 * Math.sin(2 * Math.PI * 0.9 * t + ph2));
  let phase = 0;
  let lp = 0, lp2 = 0, jit = 0;
  const sorted = [...notes].sort((a, b) => a.s - b.s);
  for (let i = 0; i < out.length; i++) {
    const t = i / HUM_RATE - pad;
    // The note sounding now (or the last one before a gap).
    let k = -1;
    for (let j = 0; j < sorted.length; j++) if (sorted[j].s <= t) k = j;
    const n = k >= 0 ? sorted[k] : null;
    const sounding = n !== null && t < n.s + n.d;
    let amp = 0, pitch = n ? n.p : 60;
    if (n && sounding) {
      const within = t - n.s, left = n.s + n.d - t;
      const prev = k > 0 ? sorted[k - 1] : null;
      const touching = prev && n.s - (prev.s + prev.d) < 0.01;
      // Attack and release; touching notes run into each other without a dip.
      const att = touching ? 1 : Math.min(1, within / 0.03);
      const fallS = n.fall ? (n.fallSeconds ?? 0.12) : 0;
      const next = sorted[k + 1];
      const nextTouches = next && next.s - (n.s + n.d) < 0.01;
      const rel = nextTouches ? 1 : Math.min(1, left / (fallS || 0.05));
      amp = (n.amp ?? 0.6) * att * rel;
      if (touching && within < legato) pitch = prev!.p + (n.p - prev!.p) * (within / legato);
      if (n.scoop && within < (n.scoopSeconds ?? 0.08)) pitch -= n.scoop * (1 - within / (n.scoopSeconds ?? 0.08));
      if (n.fall && left < fallS) pitch -= n.fall * (1 - left / fallS);
      if (n.overshoot) { const ws = Math.max(0, within - (n.scoop ? (n.scoopSeconds ?? 0.08) : touching ? legato : 0)); pitch += n.overshoot * Math.exp(-ws / 0.06) * Math.cos(2 * Math.PI * ws / 0.25) * Math.min(1, ws / 0.02); }
      if (o.waver) pitch += o.waver * Math.sin(2 * Math.PI * 2.5 * within + ph1);
      if (within > 0.15) pitch += vib * Math.min(1, (within - 0.15) / 0.2) * Math.sin(2 * Math.PI * vibHz * (within - 0.15));
      pitch += driftAt(t) + (o.detune ?? 0) + (n.off ?? 0);
    }
    if (o.jitter) { jit = 0.98 * jit + 0.2 * rnd(); pitch += o.jitter * jit; }
    const f = 440 * 2 ** ((pitch - 69) / 12);
    phase += (2 * Math.PI * f) / HUM_RATE;
    let s = 0;
    if (amp > 0) for (let h = 0; h < harm.length && f * (h + 1) < HUM_RATE / 2; h++) s += harm[h] * Math.sin((h + 1) * phase);
    s *= amp / harm.reduce((a, b) => a + b, 0) * 1.5;
    // Breath: band-limited noise in the gaps between notes (and a little under the notes' starts).
    const white = rnd();
    lp = 0.7 * lp + 0.3 * white; lp2 = 0.95 * lp2 + 0.05 * white;
    const breathy = (lp - lp2) * 2;
    let gapBreath = 0;
    if (o.breath && n && !sounding) {
      const next = sorted[k + 1];
      if (next) {
        const g0 = n.s + n.d, g1 = next.s, mid = (g0 + g1) / 2, half = (g1 - g0) / 2;
        if (half > 0.04) gapBreath = Math.max(0, 1 - Math.abs(t - mid) / half);
      }
    }
    out[i] = s + (o.breath ?? 0) * 0.6 * gapBreath * breathy + (o.room ?? 0) * white;
  }
  if (o.highpass) {
    const a = Math.exp(-2 * Math.PI * o.highpass / HUM_RATE);
    for (let pass = 0; pass < 2; pass++) {
      let y = 0, xPrev = 0;
      for (let i = 0; i < out.length; i++) { const x0 = out[i]; y = a * (y + x0 - xPrev); xPrev = x0; out[i] = y; }
    }
  }
  return out;
}

export interface Score { expected: number; found: number; correct: number; wrongPitch: number; octave: number; missed: number; extra: number }

/**
 * How a hearing compares with the notes hummed (both in seconds from the start of the recording, the found ones moved
 * by `shift`): a found note is right when it has the pitch and starts within 100 ms of a hummed note not already
 * matched. A found note that overlaps a hummed note mostly but has another pitch is a wrong pitch (an octave off is
 * counted on its own too); every other found note was never hummed (extra).
 */
export function scoreNotes(want: SynthNote[], got: HumNote[], shift = 0): Score {
  const g = got.map((n) => ({ ...n, s: n.s + shift }));
  const used = new Set<number>();
  let correct = 0;
  const hit = new Set<number>();
  want.forEach((w, wi) => {
    let best = -1, bestD = 0.1;
    g.forEach((n, i) => { if (!used.has(i) && n.p === w.p && Math.abs(n.s - w.s) <= bestD) { best = i; bestD = Math.abs(n.s - w.s); } });
    if (best >= 0) { used.add(best); hit.add(wi); correct++; }
  });
  let wrongPitch = 0, octave = 0, extra = 0;
  const wrongFor = new Set<number>();
  g.forEach((n, i) => {
    if (used.has(i)) return;
    // The hummed note it overlaps most.
    let bestW = -1, bestO = 0;
    want.forEach((w, wi) => { const o = Math.min(n.s + n.d, w.s + w.d) - Math.max(n.s, w.s); if (o > bestO) { bestO = o; bestW = wi; } });
    if (bestW >= 0 && !hit.has(bestW) && !wrongFor.has(bestW) && bestO >= 0.5 * Math.min(n.d, want[bestW].d)) {
      wrongFor.add(bestW); wrongPitch++;
      if (Math.abs(n.p - want[bestW].p) === 12 || Math.abs(n.p - want[bestW].p) === 24) octave++;
    } else extra++;
  });
  return { expected: want.length, found: got.length, correct, wrongPitch, octave, missed: want.length - correct - wrongPitch, extra };
}

/** Notes back to back from a list of [pitch, beats] at a tempo, with a gap (seconds) after each, starting at 0. */
export function phrase(spec: [number, number][], bpm: number, gap = 0.06, extra: Partial<SynthNote> = {}): SynthNote[] {
  const beat = 60 / bpm;
  let at = 0;
  return spec.map(([p, beats]) => { const n = { p, s: at, d: beats * beat - gap, ...extra }; at += beats * beat; return n; });
}

/** The hums the harness measures: each a thing real hums do that made notes go wrong. */
export function scenarios(): { name: string; notes: SynthNote[]; opts: SynthOptions }[] {
  const out: { name: string; notes: SynthNote[]; opts: SynthOptions }[] = [];
  // A plain tune, gently hummed (a sanity check).
  out.push({ name: "plain", notes: phrase([[60, 1], [62, 1], [64, 1], [65, 1], [67, 2], [64, 1], [60, 1]], 110), opts: { vibrato: 0.15 } });
  // Long held notes with wide vibrato (half a semitone either way) and scoops up into each.
  out.push({ name: "vibrato", notes: phrase([[57, 2], [60, 2], [59, 2], [57, 3]], 90, 0.08, { scoop: 1.5, scoopSeconds: 0.1 }), opts: { vibrato: 0.5, vibratoHz: 5.5 } });
  // Phrases with loud breaths between them and notes that fall off at the end of each phrase.
  out.push({
    name: "breaths",
    notes: [
      ...phrase([[64, 1], [62, 1], [60, 2]], 100, 0.05).map((n, i) => (i === 2 ? { ...n, fall: 3, fallSeconds: 0.15 } : n)),
      ...phrase([[60, 1], [62, 1], [64, 2]], 100, 0.05).map((n, i) => ({ ...n, s: n.s + 2.9, ...(i === 2 ? { fall: 2, fallSeconds: 0.15 } : {}) })),
    ],
    opts: { breath: 0.25, vibrato: 0.2 },
  });
  // A low voice singing "ah": the overtones are louder than the note itself.
  out.push({ name: "low ah", notes: phrase([[45, 1], [48, 1], [50, 1], [52, 2], [50, 1], [48, 1], [45, 2]], 100), opts: { timbre: "ah", vibrato: 0.2 } });
  // A noisy room, with long silences between short phrases.
  out.push({
    name: "room noise",
    notes: [...phrase([[67, 1], [69, 1], [67, 1]], 120), ...phrase([[65, 1], [64, 1], [62, 2]], 120).map((n) => ({ ...n, s: n.s + 2.2 }))],
    opts: { room: 0.012, vibrato: 0.15 },
  });
  // The same note hummed several times with short breaks.
  out.push({ name: "repeats", notes: phrase([[62, 1], [62, 1], [62, 1], [64, 1], [64, 1], [62, 2]], 120, 0.07), opts: { vibrato: 0.15 } });
  // A quick run of eighth notes, sung legato with glides between.
  out.push({ name: "fast legato", notes: phrase([[60, 0.5], [62, 0.5], [64, 0.5], [65, 0.5], [67, 0.5], [65, 0.5], [64, 0.5], [62, 0.5], [60, 1]], 116, 0), opts: { legato: 0.04, vibrato: 0.1 } });
  // A singer drifting slowly and a little sharp overall, with scoops.
  out.push({ name: "drift", notes: phrase([[55, 1], [57, 1], [59, 1], [60, 2], [59, 1], [57, 2]], 96, 0.06, { scoop: 1, scoopSeconds: 0.07 }), opts: { drift: 0.2, detune: 0.3, vibrato: 0.25 } });
  // A trained voice's wide vibrato (most of a semitone either way) on long notes.
  out.push({ name: "wide vibrato", notes: phrase([[64, 2], [62, 2], [60, 3], [59, 1], [60, 3]], 92, 0.08), opts: { vibrato: 0.85, vibratoHz: 5.8 } });
  // Slow scoops up into notes (three semitones over 200 ms) and long fall-offs at the end of phrases.
  out.push({
    name: "scoops falls",
    notes: [
      ...phrase([[60, 1.5], [64, 1.5], [67, 2]], 100, 0.06, { scoop: 3, scoopSeconds: 0.2 }).map((n, i) => (i === 2 ? { ...n, fall: 5, fallSeconds: 0.3 } : n)),
      ...phrase([[65, 1.5], [64, 1.5], [62, 2]], 100, 0.06, { scoop: 2.5, scoopSeconds: 0.18 }).map((n, i) => ({ ...n, s: n.s + 3.4, ...(i === 2 ? { fall: 4, fallSeconds: 0.25 } : {}) })),
    ],
    opts: { vibrato: 0.2, breath: 0.15 },
  });
  // A low hum on a phone, whose microphone loses most of the note itself (only the overtones are left).
  out.push({ name: "phone low", notes: phrase([[43, 1], [47, 1], [50, 1], [48, 2], [47, 1], [45, 1], [43, 2]], 96), opts: { timbre: "ah", highpass: 160, vibrato: 0.2, room: 0.004 } });
  // Each note a little off in its own way (up to 0.4 semitone), as an untrained singer hums.
  out.push({
    name: "loose pitch",
    notes: phrase([[57, 1], [60, 1], [62, 1], [64, 2], [62, 1], [60, 1], [57, 2]], 104).map((n, i) => ({ ...n, off: [0.35, -0.3, 0.4, -0.2, 0.3, -0.38, 0.1][i] })),
    opts: { vibrato: 0.2 },
  });
  // A soft note between loud ones, and a quiet phrase after a loud one.
  out.push({
    name: "dynamics",
    notes: [...phrase([[60, 1], [64, 1], [62, 1], [60, 1]], 108).map((n, i) => ({ ...n, amp: i === 2 ? 0.12 : 0.7 })), ...phrase([[67, 1], [65, 1], [64, 2]], 108).map((n) => ({ ...n, s: n.s + 2.6, amp: 0.08 }))],
    opts: { vibrato: 0.2, room: 0.002 },
  });
  // A loud room (a fan, a phone turning its gain up in the silences) with breaths between phrases.
  out.push({
    name: "loud room",
    notes: [...phrase([[62, 1], [65, 1], [69, 2]], 100), ...phrase([[67, 1], [65, 1], [62, 2]], 100).map((n) => ({ ...n, s: n.s + 3.2 }))],
    opts: { room: 0.04, breath: 0.4, vibrato: 0.2 },
  });
  // Leaps that overshoot and settle, and an unsteady voice that wavers and jitters on held notes.
  out.push({
    name: "overshoot",
    notes: phrase([[57, 1], [64, 1], [60, 1], [67, 2], [62, 1], [57, 2]], 100, 0, { overshoot: 0.9 }),
    opts: { legato: 0.06, vibrato: 0.15, jitter: 0.25 },
  });
  out.push({ name: "unsteady", notes: phrase([[60, 2], [63, 2], [65, 2], [63, 1], [60, 3]], 84, 0.07), opts: { waver: 0.4, jitter: 0.3, vibrato: 0.1 } });
  return out;
}

/** What the hub makes of one made-up hum, given the model's pitch line for it, scored against the notes hummed. */
export interface Measured {
  /** The melody's notes as heard (before the grid). */
  heard: Score;
  /** The melody snapped to the 1/16 grid at the tempo found, as the MIDI file has it. */
  grid: Score;
  /** Notes in the MIDI file made with nothing chosen (the melody, plus the hits when both are kept). */
  fileNotes: number;
  /** Notes in that file that were never hummed: extra melody notes and every drum hit. */
  fileExtra: number;
  bpm: number;
  use: string;
}

export function measureHum(want: SynthNote[], x: Float32Array, track: PitchTrack, pad = 0.3): Measured {
  const melody0 = melodyNotes(track, frameLevels(x, track.t));
  const rhythm0 = findHits(x).map((h) => ({ p: h.p, s: h.s, d: 0.1, v: h.v }));
  const heard = scoreNotes(want, melody0, -pad);
  const t0 = Math.min(melody0[0]?.s ?? Infinity, rhythm0[0]?.s ?? Infinity);
  const shift = (ns: HumNote[]) => ns.map((n) => ({ ...n, s: n.s - t0 }));
  const melody = shift(melody0), rhythm = shift(rhythm0);
  const bpm = estimateBpm((melody.length >= rhythm.length ? melody : rhythm).map((n) => n.s));
  const snapped = snapToGrid(melody, bpm, "melody");
  const grid = scoreNotes(want, snapped, t0 - pad);
  const use = humUse(undefined, { melody, rhythm });
  const drums = use === "melody" ? 0 : rhythm.length;
  const mel = use === "rhythm" ? 0 : snapped.length;
  return { heard, grid, fileNotes: mel + drums, fileExtra: (use === "rhythm" ? 0 : grid.extra) + drums, bpm, use };
}
