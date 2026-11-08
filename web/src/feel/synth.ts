import { FILTER_REST_HZ, midiToHz, SUSTAINING, type Synth } from "./theory";

/**
 * Web Audio voices for the tap notes. One shared context, created or resumed on the first gesture (browsers refuse
 * sound before one). Every voice has its own low-pass filter and envelope gain, so it starts and ends at silence, can
 * be bent and darkened while it sounds, and disconnects itself when done.
 *
 * A note is started with startNote and ended with releaseNote. A held note (`hold`) sustains until released: sine,
 * glass, pad and chip hold their level, pluck, bell and marimba ring and fade to a quiet sustain. Released within
 * QUICK_S it finishes exactly as the fixed-length note would have, so a tap sounds the same as ever. Without `hold`
 * the fixed-length note plays and release does nothing.
 */

interface Spec {
  attack: number;
  peak: number;
  /** Length of the fixed note in seconds. */
  dur: number;
  /** Held level as a share of the peak, and how fast the level settles there. */
  sustain: number;
  settle: number;
  /** Fade after a held note is let go. */
  release: number;
}

const SPECS: Record<Synth, Spec> = {
  sine: { attack: 0.012, peak: 0.5, dur: 0.5, sustain: 0.45, settle: 0.25, release: 0.45 },
  glass: { attack: 0.006, peak: 0.45, dur: 0.6, sustain: 0.45, settle: 0.2, release: 0.45 },
  pluck: { attack: 0.003, peak: 0.6, dur: 0.8, sustain: 1, settle: 0.1, release: 0.35 },
  bell: { attack: 0.005, peak: 0.38, dur: 1.2, sustain: 0.08, settle: 0.14, release: 0.8 },
  marimba: { attack: 0.003, peak: 0.55, dur: 0.4, sustain: 0.08, settle: 0.047, release: 0.25 },
  chip: { attack: 0.004, peak: 0.12, dur: 0.15, sustain: 0.9, settle: 0.05, release: 0.08 },
  pad: { attack: 0.04, peak: 0.16, dur: 0.9, sustain: 1, settle: 0.2, release: 0.6 },
};

/** Released within this many seconds of the press, a held note ends as a tap. */
export const QUICK_S = 0.3;
/** A held note ends on its own after this long. */
export const MAX_HOLD_MS = 20_000;
/** Glide time constant when the pitch moves (about 50 ms to arrive). */
const GLIDE = 0.016;
/** Resonance of the filter a bent note runs through. */
const BEND_Q = 4.5;

interface Voice {
  synth: Synth;
  spec: Spec;
  midi: number;
  start: number;
  level: number;
  env: GainNode;
  filter: BiquadFilterNode;
  /** A bent note's saturation ahead of the filter: the plain path, the driven one, and the gain into the shaper. */
  drive: { dry: GainNode; pre: GainNode; wet: GainNode } | null;
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  /** Detune params with their own resting offset in cents, or the pluck's playback rate. */
  pitch: Array<{ param: AudioParam; base: number; rate: boolean }>;
  pluck: AudioBufferSourceNode | null;
  held: boolean;
  done: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** What the caller holds on to between press and release. Safe to use after the voice was stolen or ended. */
export type NoteHandle = Voice;

const MAX_VOICES = 8;
const SILENT = 0.0001;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let volume = 0.4;
const voices: Voice[] = [];
const pluckCache = new Map<string, AudioBuffer>();

/** Counters for checking the synth without ears (Settings never shows them). */
export const synthStats = { started: 0, held: 0, quick: 0, released: 0, stolen: 0, ended: 0, bends: 0, filters: 0, timeouts: 0 };

export function activeVoices(): number {
  return voices.length;
}

/** The audio context's state and clock, for the same checks. */
export function audioClock(): { state: string; time: number } {
  return { state: ctx?.state ?? "none", time: ctx?.currentTime ?? 0 };
}

/** A voice's live parameters (for checks without ears): envelope level, filter cutoff and Q, pitch offsets. */
export function inspectVoice(v: NoteHandle | null): { level: number; cutoff: number; q: number; pitch: number[]; held: boolean; done: boolean } | null {
  if (!v) return null;
  return { level: v.env.gain.value, cutoff: v.filter.frequency.value, q: v.filter.Q.value, pitch: v.pitch.map((p) => p.param.value), held: v.held, done: v.done };
}

/** Create or resume the context. Call from inside a user gesture. */
export function unlockAudio(): AudioContext | null {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    // A gentle compressor keeps chords and fast taps from clipping.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(comp);
    comp.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function setVolume(v: number): void {
  volume = Math.min(1, Math.max(0, v));
  if (ctx && master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.02);
}

function finish(v: Voice) {
  if (v.done) return;
  v.done = true;
  v.held = false;
  if (v.timer) clearTimeout(v.timer);
  for (const n of v.nodes) n.disconnect();
  v.filter.disconnect();
  v.env.disconnect();
  const i = voices.indexOf(v);
  if (i >= 0) voices.splice(i, 1);
  synthStats.ended++;
}

function stopAt(v: Voice, when: number) {
  for (const s of v.sources) {
    try {
      s.stop(when);
    } catch {
      /* already stopped */
    }
  }
}

/** Freeze a gain where it is now so new automation starts from the sound actually heard. */
function hold(g: AudioParam, t: number) {
  const hasHold = typeof (g as AudioParam & { cancelAndHoldAtTime?: unknown }).cancelAndHoldAtTime === "function";
  if (hasHold) {
    g.cancelAndHoldAtTime(t);
  } else {
    const v = g.value;
    g.cancelScheduledValues(t);
    g.setValueAtTime(v, t);
  }
}

/** Fade the oldest voice out quickly to make room. */
function steal() {
  const v = voices.shift();
  if (!v || !ctx) return;
  const t = ctx.currentTime;
  v.held = false;
  if (v.timer) clearTimeout(v.timer);
  hold(v.env.gain, t);
  v.env.gain.linearRampToValueAtTime(0, t + 0.03);
  stopAt(v, t + 0.04);
  synthStats.stolen++;
}

/** Attack to `peak`, then an exponential fall to silence at `t + dur`. */
function envelope(g: AudioParam, t: number, attack: number, peak: number, dur: number) {
  g.setValueAtTime(0, t);
  g.linearRampToValueAtTime(peak, t + attack);
  g.exponentialRampToValueAtTime(SILENT, t + dur);
  g.linearRampToValueAtTime(0, t + dur + 0.02);
}

function osc(c: AudioContext, type: OscillatorType, hz: number, cents = 0): OscillatorNode {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.value = hz;
  o.detune.value = cents;
  return o;
}

/** Karplus-Strong: a noise burst through a delay line that averages and decays, rendered once per note. */
function pluckBuffer(c: AudioContext, midi: number): AudioBuffer {
  const id = `${midi}@${c.sampleRate}`;
  const hit = pluckCache.get(id);
  if (hit) return hit;
  const sr = c.sampleRate;
  const len = Math.floor(sr * 0.8);
  const buf = c.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  const n = Math.max(2, Math.round(sr / midiToHz(midi)));
  for (let i = 0; i < n && i < len; i++) d[i] = Math.random() * 2 - 1;
  for (let i = n; i < len; i++) d[i] = 0.996 * 0.5 * (d[i - n] + d[i - n + 1]);
  pluckCache.set(id, buf);
  return buf;
}

/** Build a voice's sources into its filter and envelope. Envelopes of inner parts (bell index, marimba click) start here. */
function build(c: AudioContext, synth: Synth, midi: number, t: number, level: number, bend: boolean): Voice {
  const hz = midiToHz(midi);
  const env = c.createGain();
  env.gain.value = 0;
  const filter = c.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = bend ? FILTER_REST_HZ : Math.min(20000, c.sampleRate / 2 - 100);
  filter.Q.value = bend ? BEND_Q : 0;
  filter.connect(env);
  env.connect(master!);
  const v: Voice = { synth, spec: SPECS[synth], midi, start: t, level, env, filter, drive: null, sources: [], nodes: [], pitch: [], pluck: null, held: false, done: false, timer: undefined };
  // A bent note goes through a dry path and a saturated one (silent until a sideways move) on its way to the filter.
  let input: AudioNode = filter;
  if (bend) {
    const into = c.createGain();
    const dry = c.createGain();
    const pre = c.createGain();
    const shaper = c.createWaveShaper();
    const wet = c.createGain();
    shaper.curve = driveCurve();
    pre.gain.value = 1 / DRIVE_RANGE;
    wet.gain.value = 0;
    into.connect(dry).connect(filter);
    into.connect(pre).connect(shaper).connect(wet).connect(filter);
    v.drive = { dry, pre, wet };
    v.nodes.push(into, dry, pre, shaper, wet);
    input = into;
  }
  const tune = (...os: OscillatorNode[]) => {
    for (const o of os) v.pitch.push({ param: o.detune, base: o.detune.value, rate: false });
  };

  switch (synth) {
    case "glass": {
      const a = osc(c, "triangle", hz);
      const b = osc(c, "sine", hz * 2, 7);
      const bg = c.createGain();
      bg.gain.value = 0.18;
      a.connect(input);
      b.connect(bg).connect(input);
      v.sources.push(a, b);
      v.nodes.push(a, b, bg);
      tune(a, b);
      break;
    }
    case "sine": {
      const a = osc(c, "sine", hz);
      a.connect(input);
      v.sources.push(a);
      v.nodes.push(a);
      tune(a);
      break;
    }
    case "pluck": {
      const s = c.createBufferSource();
      s.buffer = pluckBuffer(c, midi);
      s.connect(input);
      v.sources.push(s);
      v.nodes.push(s);
      v.pluck = s;
      v.pitch.push({ param: s.playbackRate, base: 1, rate: true });
      break;
    }
    case "bell": {
      const dur = SPECS.bell.dur;
      const car = osc(c, "sine", hz);
      const mod = osc(c, "sine", hz * 3.5);
      const idx = c.createGain();
      idx.gain.setValueAtTime(hz * 3.5 * 1.6, t);
      idx.gain.exponentialRampToValueAtTime(hz * 0.05, t + dur);
      mod.connect(idx).connect(car.frequency);
      car.connect(input);
      v.sources.push(car, mod);
      v.nodes.push(car, mod, idx);
      tune(car, mod);
      break;
    }
    case "marimba": {
      const a = osc(c, "sine", hz);
      const p = osc(c, "sine", hz * 4);
      const pg = c.createGain();
      envelope(pg.gain, t, 0.002, 0.3, 0.07);
      a.connect(input);
      p.connect(pg).connect(input);
      v.sources.push(a, p);
      v.nodes.push(a, p, pg);
      tune(a, p);
      break;
    }
    case "chip": {
      const a = osc(c, "square", hz);
      a.connect(input);
      v.sources.push(a);
      v.nodes.push(a);
      tune(a);
      break;
    }
    case "pad": {
      const a = osc(c, "sawtooth", hz, -8);
      const b = osc(c, "sawtooth", hz, 8);
      const lp = c.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = Math.min(2400, hz * 4);
      lp.Q.value = 0.5;
      a.connect(lp);
      b.connect(lp);
      lp.connect(input);
      v.sources.push(a, b);
      v.nodes.push(a, b, lp);
      tune(a, b);
      break;
    }
  }
  return v;
}

/** The fixed-length envelope from `from` on: the whole note when `from` is its start, the rest of it after a quick tap. */
function fixedTail(v: Voice, from: number) {
  const g = v.env.gain;
  const { attack, peak, dur } = v.spec;
  const t = v.start;
  const p = peak * v.level;
  if (from <= t) {
    if (v.synth === "pluck") {
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(p, t + attack);
      g.setValueAtTime(p, t + dur - 0.08);
      g.linearRampToValueAtTime(0, t + dur);
    } else if (v.synth === "pad") {
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(p, t + attack);
      g.setTargetAtTime(0, t + 0.3, 0.15);
      g.setValueAtTime(SILENT, t + dur);
      g.linearRampToValueAtTime(0, t + dur + 0.02);
    } else {
      envelope(g, t, attack, p, dur);
    }
  } else {
    hold(g, from);
    if (v.synth === "pluck") {
      g.setValueAtTime(p, Math.max(from, t + dur - 0.08));
      g.linearRampToValueAtTime(0, t + dur);
    } else if (v.synth === "pad") {
      g.setTargetAtTime(0, Math.max(from, t + 0.3), 0.15);
      g.setValueAtTime(SILENT, t + dur);
      g.linearRampToValueAtTime(0, t + dur + 0.02);
    } else if (t + dur > from + 0.01) {
      g.exponentialRampToValueAtTime(SILENT, t + dur);
      g.linearRampToValueAtTime(0, t + dur + 0.02);
    } else {
      g.linearRampToValueAtTime(0, from + 0.02);
    }
  }
  stopAt(v, Math.max(t + v.spec.dur, from + 0.02) + 0.05);
}

/** Attack, then settle to the held level (sustaining voices) or ring down to a quiet one (percussive voices). */
function holdEnvelope(v: Voice) {
  const g = v.env.gain;
  const { attack, peak, sustain, settle } = v.spec;
  const t = v.start;
  const p = peak * v.level;
  g.setValueAtTime(0, t);
  g.linearRampToValueAtTime(p, t + attack);
  g.setTargetAtTime(p * sustain, t + attack, settle);
  if (v.pluck) {
    // The string decays on its own; loop the last whole periods of it so it keeps ringing quietly while held.
    const buf = v.pluck.buffer!;
    const n = Math.max(2, Math.round(buf.sampleRate / midiToHz(v.midi)));
    const periods = Math.max(1, Math.floor((0.05 * buf.sampleRate) / n));
    v.pluck.loop = true;
    v.pluck.loopEnd = buf.length / buf.sampleRate;
    v.pluck.loopStart = (buf.length - n * periods) / buf.sampleRate;
  }
}

export interface NoteOptions {
  /** Seconds from now. */
  at?: number;
  level?: number;
  /** Sustain until releaseNote. */
  hold?: boolean;
  /** Run through the bend filter (resting at 3.1 kHz) and the drive, instead of an open filter. */
  bend?: boolean;
}

/** Start one note. Null when no gesture has unlocked audio yet or the volume is zero. */
export function startNote(midi: number, synth: Synth, o: NoteOptions = {}): NoteHandle | null {
  const c = ctx;
  if (!c || !master || volume <= 0) return null;
  while (voices.length >= MAX_VOICES) steal();
  const t = c.currentTime + (o.at ?? 0) + 0.005;
  const v = build(c, synth, midi, t, o.level ?? 1, !!o.bend);
  for (const s of v.sources) s.start(t);
  v.sources[0].onended = () => finish(v);
  if (o.hold) {
    v.held = true;
    holdEnvelope(v);
    v.timer = setTimeout(() => {
      synthStats.timeouts++;
      releaseNote(v);
    }, MAX_HOLD_MS);
    synthStats.held++;
  } else {
    fixedTail(v, t);
  }
  voices.push(v);
  synthStats.started++;
  return v;
}

/** Let a held note go: a quick tap ends as the fixed note would, a longer hold fades over the voice's release time. */
export function releaseNote(v: NoteHandle | null): void {
  if (!v || !v.held || v.done || !ctx) return;
  v.held = false;
  if (v.timer) clearTimeout(v.timer);
  const now = ctx.currentTime;
  synthStats.released++;
  if (now - v.start < QUICK_S) {
    synthStats.quick++;
    if (v.pluck) v.pluck.loop = false;
    fixedTail(v, Math.max(now, v.start));
    return;
  }
  const g = v.env.gain;
  hold(g, now);
  // A curved fade over the release time, like the voice's own decay.
  g.setTargetAtTime(0, now, v.spec.release / 4.6);
  stopAt(v, now + v.spec.release * 1.3 + 0.05);
}

/** Let every held note go (the page was hidden). */
export function releaseAll(): void {
  for (const v of voices.slice()) releaseNote(v);
}

/** Glide the note to another MIDI note (fractions allowed), relative to the note it started on. */
export function bendNote(v: NoteHandle | null, midi: number): void {
  if (!v || v.done || !ctx) return;
  const now = ctx.currentTime;
  const semis = midi - v.midi;
  for (const p of v.pitch) p.param.setTargetAtTime(p.rate ? Math.pow(2, semis / 12) : p.base + semis * 100, now, GLIDE);
  synthStats.bends++;
}

/** Turn the note's filter knob: cutoff in Hz, and `drive` (0 to 1) of saturation feeding it overtones to cut. */
export function filterNote(v: NoteHandle | null, hz: number, drive = 0): void {
  if (!v || v.done || !ctx) return;
  const now = ctx.currentTime;
  v.filter.frequency.setTargetAtTime(Math.min(20000, Math.max(40, hz)), now, 0.03);
  if (v.drive) {
    const d = Math.min(1, Math.max(0, drive));
    const g = 1 + 5 * d;
    v.drive.dry.gain.setTargetAtTime(1 - d, now, 0.02);
    v.drive.pre.gain.setTargetAtTime(g / DRIVE_RANGE, now, 0.02);
    v.drive.wet.gain.setTargetAtTime(d / Math.tanh(g), now, 0.02);
  }
  synthStats.filters++;
}

/** The shaper's input span: the curve is tanh over plus or minus this, so a gain of up to 6 never clips flat. */
const DRIVE_RANGE = 8;
let curve: Float32Array<ArrayBuffer> | null = null;
function driveCurve(): Float32Array<ArrayBuffer> {
  if (!curve) {
    curve = new Float32Array(new ArrayBuffer(1025 * 4));
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(((i / (curve.length - 1)) * 2 - 1) * DRIVE_RANGE);
  }
  return curve;
}

/** Whether a voice still sounds (not stolen or ended). */
export function sounding(v: NoteHandle | null): boolean {
  return !!v && !v.done;
}

/** Play one fixed-length note. `at` is seconds from now. Silent when no gesture has unlocked audio yet. */
export function playNote(midi: number, synth: Synth, at = 0, level = 1): void {
  startNote(midi, synth, { at, level });
}

/** Whether a synth holds its level while pressed (the others fade to a quiet sustain). */
export function isSustaining(s: Synth): boolean {
  return SUSTAINING.includes(s);
}
