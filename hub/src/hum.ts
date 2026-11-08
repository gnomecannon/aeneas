import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { Entity } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";
import { appendDiary } from "./diary.js";
import { errCode } from "./logsafe.js";

/**
 * Hum to MIDI: a hummed melody or a tapped, clapped or beatboxed rhythm becomes notes, a key, a tempo and a MIDI
 * file for a DAW. The recording is kept beside the data (`<data>/audio/<idea id>.wav`) and the notes live on the
 * music idea (`fields.midi`), so every device can draw, play and export them.
 *
 * Melody uses Spotify's Basic Pitch model (Apache-2.0) on the CPU in a worker thread, so the hub keeps answering
 * while it listens (about 1.2 s of work per second of audio on a recent processor). Rhythm needs no model: hits are found where
 * the sound jumps, and sorted into kick, snare and hi-hat by where their energy sits.
 */

export const HUM_RATE = 22050;
export const MAX_HUM_SECONDS = 120;
export type HumMode = "melody" | "rhythm";
/** One note: MIDI pitch, start and length in seconds from the first note, velocity 1 to 127. */
export interface HumNote { p: number; s: number; d: number; v: number }

// ---------- reading the recording ----------

/** A WAV file (16, 24 or 32 bit PCM, or 32 bit float; any rate; mono or more) as mono samples at HUM_RATE. */
export function readWav(buf: Buffer): Float32Array {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new StoreError(422, "send the recording as a WAV file");
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  for (let o = 12; o + 8 <= buf.length;) {
    const id = buf.toString("ascii", o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    const body = buf.subarray(o + 8, Math.min(buf.length, o + 8 + size));
    if (id === "fmt ") {
      if (body.length < 16) throw new StoreError(422, "the WAV file's format block is cut short");
      let format = body.readUInt16LE(0);
      // WAVE_FORMAT_EXTENSIBLE carries the real format in its sub-format GUID.
      if (format === 0xfffe && body.length >= 26) format = body.readUInt16LE(24);
      fmt = { format, channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (id === "data") data = body;
    o += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new StoreError(422, "the WAV file has no audio in it");
  const { format, channels, rate, bits } = fmt;
  if (!(format === 1 && [16, 24, 32].includes(bits)) && !(format === 3 && bits === 32)) throw new StoreError(422, "the WAV file must be 16, 24 or 32 bit PCM, or 32 bit float");
  if (channels < 1 || rate < 8000 || rate > 192000) throw new StoreError(422, "the WAV file's rate or channels are not usable");
  const step = (bits / 8) * channels;
  const frames = Math.floor(data.length / step);
  if (frames / rate > MAX_HUM_SECONDS + 1) throw new StoreError(413, `a hum can be up to ${MAX_HUM_SECONDS / 60} minutes long`);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) {
      const at = i * step + ch * (bits / 8);
      sum += format === 3 ? data.readFloatLE(at) : bits === 16 ? data.readInt16LE(at) / 32768 : bits === 24 ? data.readIntLE(at, 3) / 8388608 : data.readInt32LE(at) / 2147483648;
    }
    mono[i] = sum / channels;
  }
  return resample(mono, rate, HUM_RATE);
}

/** Linear resampling, with a box filter first when going down a lot so high noise does not fold into the voice range. */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  let src = x;
  const ratio = from / to;
  if (ratio > 1.5) {
    const w = Math.floor(ratio);
    src = new Float32Array(x.length);
    let acc = 0;
    for (let i = 0; i < x.length; i++) { acc += x[i]; if (i >= w) acc -= x[i - w]; src[i] = acc / Math.min(i + 1, w); }
  }
  const n = Math.floor(src.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const j = Math.floor(p);
    const f = p - j;
    out[i] = (src[j] ?? 0) * (1 - f) + (src[j + 1] ?? src[j] ?? 0) * f;
  }
  return out;
}

/** A 16-bit mono WAV of samples at HUM_RATE (the copy kept with the idea). */
export function writeWav(x: Float32Array, rate = HUM_RATE): Buffer {
  const out = Buffer.alloc(44 + x.length * 2);
  out.write("RIFF", 0, "ascii"); out.writeUInt32LE(36 + x.length * 2, 4); out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii"); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii"); out.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  return out;
}

function peak(x: Float32Array): number { let m = 0; for (const v of x) { const a = Math.abs(v); if (a > m) m = a; } return m; }

// ---------- melody: Basic Pitch in a worker ----------

/**
 * The voice's pitch line from the model, one value per frame (about 86 a second): time in seconds, pitch as
 * fractional MIDI, and how sure the model is (0 to 1).
 */
export interface PitchTrack { t: Float32Array; p: Float32Array; s: Float32Array }
export type Transcriber = (samples: Float32Array) => Promise<PitchTrack>;

let worker: Worker | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let nextJob = 0;
const pending = new Map<number, { resolve: (n: PitchTrack) => void; reject: (e: Error) => void }>();

/** The model's worker, started on first use and stopped after 10 idle minutes (it holds about 200 MB). */
function getWorker(): Worker {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (worker) return worker;
  const req = createRequire(import.meta.url);
  const modelDir = path.join(path.dirname(req.resolve("@spotify/basic-pitch/package.json")), "model");
  worker = new Worker(new URL("./hum-worker.mjs", import.meta.url), { workerData: { modelDir } });
  worker.unref();
  worker.on("message", (m: { id: number; track?: PitchTrack; error?: string }) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error || !m.track) p.reject(new Error(m.error ?? "no pitch line")); else p.resolve(m.track);
    if (!pending.size) idleTimer = setTimeout(stopHumWorker, 10 * 60_000).unref();
  });
  worker.on("error", (e) => { for (const p of pending.values()) p.reject(e); pending.clear(); worker = null; });
  // A worker that ends without an error event (killed for memory) would leave its jobs waiting for good.
  worker.on("exit", (code) => {
    worker = null;
    for (const p of pending.values()) p.reject(new Error(`the listener stopped (exit ${code})`));
    pending.clear();
  });
  return worker;
}

export function stopHumWorker(): void {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  void worker?.terminate();
  worker = null;
}

/**
 * The default transcriber: Basic Pitch, one recording at a time in the worker. A job that takes far longer than the
 * model ever does (about 1.2 times the recording's length on a recent processor) fails instead of leaving the idea listening.
 */
export const basicPitch: Transcriber = (samples) => new Promise((resolve, reject) => {
  const id = ++nextJob;
  const timer = setTimeout(() => {
    if (!pending.delete(id)) return;
    reject(new Error("the listener took too long"));
    stopHumWorker();
  }, 60_000 + (samples.length / HUM_RATE) * 5_000);
  timer.unref();
  pending.set(id, { resolve: (t) => { clearTimeout(timer); resolve(t); }, reject: (e) => { clearTimeout(timer); reject(e); } });
  const copy = new Float32Array(samples);
  getWorker().postMessage({ id, samples: copy }, [copy.buffer]);
});

const median = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };

/** The same median as `median` (the upper middle), kept as values arrive: a long held note no longer re-sorts every frame. */
class RunningMedian {
  private lo: number[] = []; // max-heap of the lower half
  private hi: number[] = []; // min-heap of the upper half, which holds the median
  private static push(h: number[], v: number, less: (a: number, b: number) => boolean): void {
    h.push(v);
    for (let i = h.length - 1; i > 0;) { const p = (i - 1) >> 1; if (!less(h[i], h[p])) break; [h[i], h[p]] = [h[p], h[i]]; i = p; }
  }
  private static pop(h: number[], less: (a: number, b: number) => boolean): number {
    const top = h[0];
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && less(h[l], h[m])) m = l;
        if (r < h.length && less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]]; i = m;
      }
    }
    return top;
  }
  private static readonly max = (a: number, b: number) => a > b;
  private static readonly min = (a: number, b: number) => a < b;
  add(v: number): void {
    if (this.hi.length && v < this.hi[0]) RunningMedian.push(this.lo, v, RunningMedian.max);
    else RunningMedian.push(this.hi, v, RunningMedian.min);
    // hi holds ceil(n / 2) values, so its smallest is the upper middle.
    if (this.lo.length > this.hi.length) RunningMedian.push(this.hi, RunningMedian.pop(this.lo, RunningMedian.max), RunningMedian.min);
    else if (this.hi.length > this.lo.length + 1) RunningMedian.push(this.lo, RunningMedian.pop(this.hi, RunningMedian.min), RunningMedian.max);
  }
  get value(): number { return this.hi.length ? this.hi[0] : NaN; }
}

/** The level in dB around each frame time (a 23 ms window), for silences and re-sung notes. */
export function frameLevels(samples: Float32Array, t: Float32Array): Float32Array {
  const out = new Float32Array(t.length);
  for (let i = 0; i < t.length; i++) {
    const c = Math.round(t[i] * HUM_RATE);
    let e = 0, n = 0;
    for (let k = Math.max(0, c - 256); k < Math.min(samples.length, c + 256); k++) { e += samples[k] * samples[k]; n++; }
    out[i] = 10 * Math.log10(e / Math.max(1, n) + 1e-10);
  }
  return out;
}

/** Tuning for melody notes; the reasons are on `melodyNotes`. */
export const MELODY = {
  /** How sure the model must be that this is the voice's pitch. */
  minSure: 0.2,
  /** Quieter than this below the loudest moment is silence. */
  silenceDb: 30,
  /** Steady: the pitch stays within this many semitones across `steadySpan` (5 frames, about 58 ms)... */
  steadySemitones: 0.45,
  steadySpan: 0.046,
  /** ...for at least this long (seconds; the window already trims about 23 ms off each end, so a note held about
   * 90 ms counts) to be a note; anything moving in between is a slide. */
  coreSeconds: 0.045,
  /** Steady stretches closer than this (semitones), with only a slide or wobble between, are one note (vibrato). */
  sameSemitones: 0.75,
  /** A dip this deep (dB) below the level on both sides within `dipSpan` is a re-sung note. */
  dipDb: 8,
  dipSpan: 0.1,
  /** Shortest note kept (seconds); shorter ones join the note before them or go. */
  minSeconds: 0.08,
  /** Unvoiced frames bridged inside a sung line (a soft consonant, a crackle). */
  bridgeFrames: 2,
};

/**
 * Notes from the voice's pitch line, one at a time (a hum has one pitch at once). A voice moves between notes: it
 * slides, scoops into a note, flicks past one, wobbles with vibrato. A note is where the pitch holds steady (within
 * about half a semitone over 60 ms) for 70 ms or more; everything moving in between is a slide and belongs to the
 * note it leads to. Steady stretches less than 3/4 of a semitone apart are one note (vibrato, a wobble across the
 * line between two semitones), and its pitch is the middle (median) of its line, rounded. A note also starts after
 * a breath, or where the level dips 8 dB and comes back (the same note sung again). When the whole hum sits clearly
 * off the piano's tuning by one amount, that amount comes out first, so the steps between notes are right. Notes
 * under 80 ms join the note before them or go.
 * Basic Pitch's own notes split a held note at every wobble and turn every slide into a staircase, which is why
 * they are not used (the owner's first two hums, 2026-11-03).
 */
export function melodyNotes(track: PitchTrack, levels: Float32Array, trace?: string[]): HumNote[] {
  const n = track.t.length;
  if (!n) return [];
  const dt = n > 1 ? (track.t[n - 1] - track.t[0]) / (n - 1) : 256 / HUM_RATE;
  const top = Math.max(...levels);
  const voiced = Array.from({ length: n }, (_, i) => track.s[i] >= MELODY.minSure && levels[i] > top - MELODY.silenceDb && track.p[i] >= 33 && track.p[i] <= 86);
  // The hum's own tuning: where the fractional parts of its pitch gather (a circular mean), used only when they
  // clearly do (a singer whose pitch drifts note to note has no one offset).
  let sx = 0, sy = 0, sw = 0;
  for (let i = 0; i < n; i++) if (voiced[i]) { const w = track.s[i]; sx += w * Math.cos(2 * Math.PI * track.p[i]); sy += w * Math.sin(2 * Math.PI * track.p[i]); sw += w; }
  const offset = sw && Math.hypot(sx, sy) / sw >= 0.5 ? Math.atan2(sy, sx) / (2 * Math.PI) : 0;
  const q = Array.from({ length: n }, (_, i) => track.p[i] - offset);
  // A 5 frame median over sung frames takes out single-frame jumps (an octave slip, a crackle).
  const line = q.map((_, i) => (voiced[i] ? median([-2, -1, 0, 1, 2].map((d) => i + d).filter((j) => j >= 0 && j < n && voiced[j]).map((j) => q[j])) : NaN));
  const half = Math.max(1, Math.round(MELODY.steadySpan / dt / 2));
  const steady = line.map((v, i) => {
    if (!voiced[i]) return false;
    let lo = v, hi = v;
    for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) if (voiced[k]) { lo = Math.min(lo, line[k]); hi = Math.max(hi, line[k]); }
    return hi - lo <= MELODY.steadySemitones;
  });
  const coreLen = Math.max(2, Math.round(MELODY.coreSeconds / dt));
  const span = Math.max(2, Math.round(MELODY.dipSpan / dt));
  type Note = { a: number; b: number; vals: number[]; resung: boolean };
  const out: { p: number; s: number; d: number; v: number; resung: boolean }[] = [];
  let i = 0;
  while (i < n) {
    if (!voiced[i]) { i++; continue; }
    // One sung line: voiced frames, across gaps of a couple of frames.
    let j = i;
    while (j + 1 < n) {
      if (voiced[j + 1]) { j++; continue; }
      let k = j + 1;
      while (k < n && !voiced[k] && k - j <= MELODY.bridgeFrames) k++;
      if (k < n && voiced[k] && k - j - 1 <= MELODY.bridgeFrames) { j = k; continue; }
      break;
    }
    // Re-sung points in this line: a valley dipDb below the highest level on each side.
    const resungAt = new Set<number>();
    for (let k = i + 1; k < j; k++) {
      if (!voiced[k] || levels[k] > levels[k - 1] || levels[k] > levels[k + 1]) continue;
      let left = -Infinity, right = -Infinity;
      for (let m = Math.max(i, k - span); m < k; m++) left = Math.max(left, levels[m]);
      for (let m = k + 1; m <= Math.min(j, k + span); m++) right = Math.max(right, levels[m]);
      if (left - levels[k] >= MELODY.dipDb && right - levels[k] >= MELODY.dipDb) resungAt.add(k);
    }
    // Steady stretches (cores), split where the pitch drifts off their middle or where a note is sung again.
    const cores: { a: number; b: number; vals: number[] }[] = [];
    let cur: { a: number; b: number; vals: number[]; mid: RunningMedian } | null = null;
    for (let k = i; k <= j; k++) {
      const ok = steady[k] && !resungAt.has(k) && (!cur || Math.abs(line[k] - cur.mid.value) <= MELODY.steadySemitones);
      if (ok && cur) { cur.b = k; cur.vals.push(line[k]); cur.mid.add(line[k]); continue; }
      if (cur && cur.b - cur.a + 1 >= coreLen) cores.push(cur);
      if (steady[k]) { const mid = new RunningMedian(); mid.add(line[k]); cur = { a: k, b: k, vals: [line[k]], mid }; } else cur = null;
    }
    if (cur && cur.b - cur.a + 1 >= coreLen) cores.push(cur);
    trace?.push(`line ${track.t[i].toFixed(2)}-${track.t[j].toFixed(2)} cores ${cores.map((c) => `${track.t[c.a].toFixed(2)}-${track.t[c.b].toFixed(2)}:${median(c.vals).toFixed(2)}`).join(" ")} resung ${[...resungAt].map((k) => track.t[k].toFixed(2)).join(" ")}`);
    if (!cores.length) {
      // No steady stretch at all (one long slide): the whole line is one note at its middle.
      const vals: number[] = [];
      for (let k = i; k <= j; k++) if (voiced[k]) vals.push(line[k]);
      cores.push({ a: i, b: j, vals });
    }
    // Neighbouring cores close in pitch are one note, unless a re-sung point lies between them.
    const notes: Note[] = [];
    for (const c of cores) {
      const last = notes[notes.length - 1];
      let resungBetween = false;
      if (last) for (let k = last.b + 1; k <= c.a; k++) if (resungAt.has(k)) resungBetween = true;
      // Only steady frames set a note's pitch: a slide between two cores would pull it off.
      if (last && !resungBetween && Math.abs(median(c.vals) - median(last.vals)) < MELODY.sameSemitones) {
        last.vals.push(...c.vals);
        last.b = c.b;
        continue;
      }
      notes.push({ a: c.a, b: c.b, vals: [...c.vals], resung: resungBetween });
    }
    // The slide before a note belongs to it: each note starts where the one before it held steady last, and the
    // first starts with the line; the last runs to the end of the line.
    for (let x = 0; x < notes.length; x++) {
      const a = x === 0 ? i : notes[x - 1].b + 1;
      const b = x === notes.length - 1 ? j : notes[x].b;
      const lv: number[] = [];
      for (let k = notes[x].a; k <= notes[x].b; k++) if (voiced[k]) lv.push(levels[k]);
      const loud = lv.length ? median(lv) : top - MELODY.silenceDb;
      out.push({ p: Math.round(median(notes[x].vals)), s: track.t[a], d: track.t[b] - track.t[a] + dt, v: Math.max(30, Math.min(127, Math.round(127 - (top - loud) * 3))), resung: notes[x].resung });
    }
    i = j + 1;
  }
  // Short notes join the touching note before them, or go.
  const kept: typeof out = [];
  for (const x of out) {
    const last = kept[kept.length - 1];
    if (x.d < MELODY.minSeconds) { if (last && x.s - (last.s + last.d) < 0.03) last.d = x.s + x.d - last.s; continue; }
    // Touching notes that round to the same pitch are one note slid into, unless the second was sung again.
    if (last && last.p === x.p && !x.resung && x.s - (last.s + last.d) < 0.03) { last.d = x.s + x.d - last.s; continue; }
    kept.push({ ...x });
  }
  return kept.map(({ p, s, d, v }) => ({ p, s: round3(s), d: round3(d), v }));
}

// ---------- rhythm: hits without a model ----------

/** One-pole filters are enough to tell a kick's thump from a snare's crack and a hat's hiss. */
function lowpass(x: Float32Array, hz: number): Float32Array {
  const a = Math.exp(-2 * Math.PI * hz / HUM_RATE);
  const out = new Float32Array(x.length);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y = (1 - a) * x[i] + a * y; out[i] = y; }
  return out;
}

/** Hits in a tapped, clapped or beatboxed rhythm: start, loudness, and kick (36), snare (38) or closed hat (42). */
export function findHits(x: Float32Array): { s: number; p: number; v: number }[] {
  const hop = 256;
  const frames = Math.floor(x.length / hop);
  if (frames < 4) return [];
  const low = lowpass(x, 180);
  const lowMid = lowpass(x, 2500);
  const bands = (i: number) => {
    let e = 0, l = 0, m = 0, h = 0;
    for (let k = i * hop; k < (i + 1) * hop && k < x.length; k++) {
      e += x[k] * x[k]; l += low[k] * low[k];
      const mid = lowMid[k] - low[k]; m += mid * mid;
      const hi = x[k] - lowMid[k]; h += hi * hi;
    }
    return { e, l, m, h };
  };
  const b = Array.from({ length: frames }, (_, i) => bands(i));
  // Onset strength: how much louder this frame is than the one before, on a log scale.
  const flux = b.map((f, i) => (i === 0 ? 0 : Math.max(0, Math.log10(f.e + 1e-9) - Math.log10(b[i - 1].e + 1e-9))));
  const loud = b.map((f) => f.e);
  const maxE = Math.max(...loud);
  const hits: { s: number; p: number; v: number }[] = [];
  let lastAt = -1e9;
  for (let i = 1; i < frames - 1; i++) {
    const lo = Math.max(0, i - 16), hi = Math.min(frames, i + 16);
    const local = flux.slice(lo, hi).sort((p, q) => p - q)[Math.floor((hi - lo) / 2)];
    const isPeak = flux[i] >= flux[i - 1] && flux[i] > flux[i + 1] && flux[i] > local + 0.35;
    // A hit must be loud enough to be meant, and 70 ms from the one before.
    if (!isPeak || i - lastAt < Math.round(0.07 * HUM_RATE / hop)) continue;
    const span = b.slice(i, Math.min(frames, i + 5));
    const e = span.reduce((s, f) => s + f.e, 0);
    if (e / span.length < maxE * 0.02) continue;
    const l = span.reduce((s, f) => s + f.l, 0), m = span.reduce((s, f) => s + f.m, 0), h = span.reduce((s, f) => s + f.h, 0);
    const total = l + m + h || 1;
    // A hat is all hiss with no body and dies within a few frames; a snare or clap has some low end and rings on.
    const head = (b[i]?.e ?? 0) + (b[i + 1]?.e ?? 0), tail = (b[i + 3]?.e ?? 0) + (b[i + 4]?.e ?? 0);
    const decay = head ? tail / head : 0;
    const hat = l / total < 0.06 && ((h - m) / total > 0.3 || (decay < 0.02 && h / total > 0.55));
    const p = l / total > 0.5 ? 36 : hat ? 42 : 38;
    const v = Math.max(30, Math.min(127, Math.round(40 + 87 * Math.sqrt(e / span.length / maxE))));
    hits.push({ s: (i * hop) / HUM_RATE, p, v });
    lastAt = i;
  }
  return hits;
}

// ---------- tempo, grid, key ----------

/**
 * The tempo that puts the most note starts on an eighth-note grid, between 60 and 180 BPM, where a start on the
 * beat counts more than one between beats (so even quarter notes at 80 are not read as dotted notes at 120), leaning
 * towards about 95 so a grid twice as fine does not win just by catching more starts. On 780 test rhythms (ten
 * patterns, 60 to 160 BPM, up to 30 ms off) it finds the tempo for 86% and half or double for the rest; the plain
 * grid fit found 74% and read 10% as 1.5 times the tempo.
 */
export function estimateBpm(starts: number[]): number {
  if (starts.length < 3) return 100;
  let best = { bpm: 100, score: -1 };
  for (let bpm = 60; bpm <= 180; bpm += 0.5) {
    const step = 60 / bpm / 2;
    let top = 0;
    for (const anchor of starts.slice(0, 8)) {
      let sc = 0;
      for (const s of starts) {
        const k = Math.round((s - anchor) / step);
        const d = s - anchor - k * step;
        sc += Math.exp(-((d / 0.035) ** 2)) * (k % 2 === 0 ? 1 : 0.55);
      }
      top = Math.max(top, sc);
    }
    const prior = Math.exp(-((Math.log2(bpm / 95)) ** 2) / (2 * 0.6 ** 2));
    const score = top * (0.6 + 0.4 * prior);
    if (score > best.score + 1e-9) best = { bpm, score };
  }
  return Math.round(best.bpm);
}

/** Starts and lengths snapped to a 1/16 grid at the tempo, the first note on the first beat; nothing shorter than 1/16. */
export function snapToGrid(notes: HumNote[], bpm: number, mode: HumMode = "melody"): HumNote[] {
  const step = 60 / bpm / 4;
  const snapped = notes.map((n) => {
    const s = Math.round(n.s / step) * step;
    const e = Math.max(s + step, Math.round((n.s + n.d) / step) * step);
    return { ...n, s: round3(s), d: round3(e - s) };
  }).sort((a, b) => a.s - b.s);
  // Notes closer than a step land on one step: one voice keeps the longer, a drum its louder hit, and a note still
  // sounding when the next starts (any note of a melody, the same drum of a rhythm) ends there.
  const out: HumNote[] = [];
  for (const n of snapped) {
    const same = out.findIndex((o) => o.s === n.s && (mode === "melody" || o.p === n.p));
    if (same >= 0) { const o = out[same]; if (mode === "melody" ? n.d > o.d : n.v > o.v) out[same] = n; continue; }
    for (const o of out) if ((mode === "melody" || o.p === n.p) && o.s < n.s && o.s + o.d > n.s) o.d = round3(n.s - o.s);
    out.push(n);
  }
  return out;
}

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** The key the notes sit in best (Krumhansl and Schmuckler's profiles, weighted by length), as "A minor" or "Eb major". */
export function estimateKey(notes: HumNote[]): string | null {
  if (notes.length < 3) return null;
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[((n.p % 12) + 12) % 12] += n.d;
  const corr = (prof: number[], root: number) => {
    const xs = hist, ys = prof.map((_, i) => prof[(i - root + 12) % 12]);
    const mx = xs.reduce((a, b) => a + b, 0) / 12, my = ys.reduce((a, b) => a + b, 0) / 12;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < 12; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
    return num / Math.sqrt(dx * dy || 1);
  };
  let best = { name: "", r: -2 };
  for (let root = 0; root < 12; root++) {
    for (const [prof, mode] of [[MAJOR, "major"], [MINOR, "minor"]] as const) {
      const r = corr(prof, root);
      if (r > best.r) best = { name: `${NAMES[root]} ${mode}`, r };
    }
  }
  // Flat names where players use them.
  return best.name.replace(/^D# /, "Eb ").replace(/^G# /, "Ab ").replace(/^A# /, "Bb ");
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

// ---------- MIDI ----------

function varLen(n: number): number[] {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

/**
 * A standard MIDI file (format 0, 480 ticks per quarter) with the tempo, a 4/4 time signature, the name and the
 * notes: channel 1 for a melody, channel 10 (General MIDI drums) for a rhythm. Opens in Cubase, Ableton, Logic.
 */
export function midiFile(notes: HumNote[], opts: { bpm: number; name: string; drums: boolean }): Buffer {
  const tpq = 480;
  const tick = (sec: number) => Math.max(0, Math.round(sec * (opts.bpm / 60) * tpq));
  const ch = opts.drums ? 9 : 0;
  const ev: { t: number; order: number; bytes: number[] }[] = [];
  const name = [...Buffer.from(opts.name.slice(0, 120), "utf8")];
  ev.push({ t: 0, order: 0, bytes: [0xff, 0x03, ...varLen(name.length), ...name] });
  const us = Math.round(60_000_000 / opts.bpm);
  ev.push({ t: 0, order: 0, bytes: [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff] });
  ev.push({ t: 0, order: 0, bytes: [0xff, 0x58, 0x04, 4, 2, 24, 8] });
  for (const n of notes) {
    const p = Math.max(0, Math.min(127, Math.round(n.p)));
    const v = Math.max(1, Math.min(127, Math.round(n.v)));
    const on = tick(n.s), off = Math.max(on + 1, tick(n.s + n.d));
    // At the same tick a note off comes before a note on, so a repeated pitch is not cut short.
    ev.push({ t: on, order: 2, bytes: [0x90 | ch, p, v] });
    ev.push({ t: off, order: 1, bytes: [0x80 | ch, p, 0] });
  }
  ev.sort((a, b) => a.t - b.t || a.order - b.order);
  const track: number[] = [];
  let now = 0;
  for (const e of ev) { track.push(...varLen(e.t - now), ...e.bytes); now = e.t; }
  track.push(0, 0xff, 0x2f, 0x00);
  const head = Buffer.alloc(14);
  head.write("MThd", 0, "ascii"); head.writeUInt32BE(6, 4); head.writeUInt16BE(0, 8); head.writeUInt16BE(1, 10); head.writeUInt16BE(tpq, 12);
  const th = Buffer.alloc(8);
  th.write("MTrk", 0, "ascii"); th.writeUInt32BE(track.length, 4);
  return Buffer.concat([head, th, Buffer.from(track)]);
}

// ---------- the whole job ----------

export interface Heard { mode: HumMode; notes: HumNote[]; bpm: number; key: string | null; seconds: number }

/** What was hummed or tapped: notes from the first one at 0, the tempo (given or found), and the key of a melody. */
export async function hear(samples: Float32Array, mode: HumMode, bpmGiven: number | undefined, transcribe: Transcriber = basicPitch): Promise<Heard> {
  const seconds = round3(samples.length / HUM_RATE);
  const top = peak(samples);
  if (top < 0.01) throw new StoreError(422, "nothing was heard: the recording is silent");
  const x = new Float32Array(samples.length);
  for (let i = 0; i < x.length; i++) x[i] = (samples[i] / top) * 0.9;
  let notes: HumNote[];
  if (mode === "rhythm") {
    notes = findHits(x).map((h) => ({ p: h.p, s: h.s, d: 0.1, v: h.v }));
  } else {
    const track = await transcribe(x);
    notes = melodyNotes(track, frameLevels(x, track.t));
  }
  if (!notes.length) throw new StoreError(422, mode === "rhythm" ? "no hits were heard; tap or clap closer to the microphone" : "no notes were heard; hum a little louder or closer");
  const t0 = notes[0].s;
  notes = notes.map((n) => ({ ...n, s: round3(n.s - t0), d: round3(n.d) }));
  const bpm = bpmGiven && bpmGiven >= 30 && bpmGiven <= 300 ? Math.round(bpmGiven) : estimateBpm(notes.map((n) => n.s));
  if (mode === "rhythm") notes = notes.map((n) => ({ ...n, d: round3(60 / bpm / 4) }));
  return { mode, notes, bpm, key: mode === "melody" ? estimateKey(notes) : null, seconds };
}

const audioDir = (hub: Hub) => path.join(hub.cfg.dataDir, "audio");
export const humAudioPath = (hub: Hub, id: string) => path.join(audioDir(hub), `${id.replace(/[^0-9a-f-]/gi, "")}.wav`);

/** The model used for the next hum; tests put a fake one here. */
export const humEngine: { transcribe: Transcriber } = { transcribe: basicPitch };

/**
 * POST /music/hum: keep the recording, make the music idea at once (state "listening"), and fill in the notes in
 * the background. Every device sees the idea appear, then its notes, through sync.
 */
export function startHum(hub: Hub, wav: Buffer, opts: { mode?: unknown; bpm?: unknown; title?: unknown; project_id?: unknown; from?: unknown; client_id?: unknown }): Entity {
  // The same take sent again (the Watch's or the app's upload was cut off after the hub had it) is the same idea.
  const clientId = typeof opts.client_id === "string" && /^[\w-]{8,64}$/.test(opts.client_id) ? opts.client_id : null;
  if (clientId) {
    const had = hub.store.list({ kind: "music_idea", where: { hum_client_id: clientId } })[0];
    if (had) return had;
  }
  const mode: HumMode = opts.mode === "rhythm" ? "rhythm" : "melody";
  const samples = readWav(wav);
  if (samples.length < HUM_RATE * 0.5) throw new StoreError(422, "the recording is under half a second");
  const bpm = typeof opts.bpm === "number" ? opts.bpm : typeof opts.bpm === "string" && opts.bpm ? Number(opts.bpm) : undefined;
  const title = typeof opts.title === "string" && opts.title.trim() ? opts.title.trim().slice(0, 160) : mode === "rhythm" ? "Tapped rhythm" : "Hummed melody";
  // The recording is written before the idea exists: a failed write leaves no idea listening for audio it never got.
  const id = crypto.randomUUID();
  fs.mkdirSync(audioDir(hub), { recursive: true, mode: 0o700 });
  fs.writeFileSync(humAudioPath(hub, id), writeWav(samples), { mode: 0o600 });
  const job = newJob();
  hub.store.create("music_idea", {
    title, type: "riff", body: "", status: "idea", tags: ["hummed", mode], audio_ref: `hum:${id}`,
    ...(typeof opts.project_id === "string" && opts.project_id ? { project_id: opts.project_id } : {}),
    ...(clientId ? { hum_client_id: clientId } : {}),
    ...(bpm !== undefined && Number.isFinite(bpm) ? { hum_bpm_given: bpm } : {}),
    midi: { source: "hum", mode, state: "listening", seconds: round3(samples.length / HUM_RATE), notes: [], job },
  }, "personal", id);
  void listen(hub, id, samples, mode, bpm, opts.from === "capture", job);
  return hub.store.get(id)!;
}

/** Each hearing has its own token: a result that comes back after a newer hearing started is dropped. */
const newJob = () => crypto.randomUUID().slice(0, 8);

/** Hear an idea's kept recording again, as a melody or a rhythm, at a given tempo or a found one. */
export function rehear(hub: Hub, id: string, opts: { mode?: unknown; bpm?: unknown }): Entity {
  const idea = hub.store.get(id);
  if (!idea || idea.kind !== "music_idea" || idea.deleted_at) throw new StoreError(404, "music idea not found");
  const file = humAudioPath(hub, id);
  if (!fs.existsSync(file)) throw new StoreError(409, "this idea has no recording to hear again");
  const prev = idea.fields.midi as { mode?: HumMode } | undefined;
  const mode: HumMode = opts.mode === "rhythm" || opts.mode === "melody" ? opts.mode : prev?.mode ?? "melody";
  const bpm = typeof opts.bpm === "number" ? opts.bpm : undefined;
  const samples = readWav(fs.readFileSync(file));
  const job = newJob();
  hub.store.patch(id, { midi: { source: "hum", mode, state: "listening", seconds: round3(samples.length / HUM_RATE), notes: [], job }, tags: [...new Set([...((idea.fields.tags as string[]) ?? []).filter((t) => t !== "melody" && t !== "rhythm"), mode])] });
  void listen(hub, id, samples, mode, bpm, false, job);
  return hub.store.get(id)!;
}

/**
 * Ideas left listening when the hub stopped (a deploy or a restart mid-hearing) are heard again from their recording,
 * or marked failed when it is gone. Run once at start.
 */
export function resumeHums(hub: Hub): number {
  let n = 0;
  for (const idea of hub.store.list({ kind: "music_idea" })) {
    const m = idea.fields.midi as { state?: string; mode?: HumMode } | undefined;
    if (m?.state !== "listening") continue;
    n++;
    const file = humAudioPath(hub, idea.id);
    if (!fs.existsSync(file)) {
      hub.store.patch(idea.id, { midi: { ...m, source: "hum", state: "failed", error: "the hub restarted before it finished hearing this, and the recording is gone; record it again", notes: [] } });
      continue;
    }
    try {
      const samples = readWav(fs.readFileSync(file));
      const job = newJob();
      const given = idea.fields.hum_bpm_given;
      hub.store.patch(idea.id, { midi: { ...m, job } });
      void listen(hub, idea.id, samples, m.mode === "rhythm" ? "rhythm" : "melody", typeof given === "number" ? given : undefined, false, job);
    } catch (e) {
      hub.store.patch(idea.id, { midi: { ...m, source: "hum", state: "failed", error: e instanceof StoreError ? e.message : "its recording could not be read", notes: [] } });
    }
  }
  return n;
}

/** Titles the hub writes itself: the placeholder while listening, and "Melody in A minor, 120 BPM". */
const AUTO_TITLE = /^(Hummed melody|Tapped rhythm|(Melody|Rhythm)( in [A-G][#b]? (major|minor))?, \d+ BPM)$/;

/** Still the idea's current hearing (not deleted, and no newer rehear started since). */
function current(hub: Hub, id: string, job: string): Entity | null {
  const idea = hub.store.get(id);
  if (!idea || idea.deleted_at || (idea.fields.midi as { job?: string } | undefined)?.job !== job) return null;
  return idea;
}

async function listen(hub: Hub, id: string, samples: Float32Array, mode: HumMode, bpm: number | undefined, fromCapture: boolean, job: string): Promise<void> {
  try {
    const h = await hear(samples, mode, bpm, humEngine.transcribe);
    const idea = current(hub, id, job);
    if (!idea) return;
    // A title the hub made (or the placeholder) is made again; one the owner typed stays.
    const generic = AUTO_TITLE.test(String(idea.fields.title ?? ""));
    const title = generic ? `${mode === "rhythm" ? "Rhythm" : "Melody"}${h.key ? ` in ${h.key}` : ""}, ${h.bpm} BPM` : String(idea.fields.title);
    hub.store.patch(id, {
      // A rhythm has no key: one left from hearing it as a melody goes.
      title, bpm: h.bpm, ...(h.key ? { key: h.key } : mode === "rhythm" && generic ? { key: null } : {}),
      midi: { source: "hum", mode, state: "done", seconds: h.seconds, notes: h.notes, job },
    });
    if (fromCapture) {
      try { appendDiary(hub.store, `Hummed ${mode === "rhythm" ? "a rhythm" : "a melody"}: ${title} (${h.notes.length} ${mode === "rhythm" ? "hits" : "notes"}), in Music`, new Date(idea.created_at)); } catch { /* the idea is what matters */ }
    }
  } catch (e) {
    const idea = current(hub, id, job);
    if (!idea) return;
    const msg = e instanceof StoreError ? e.message : `could not hear it: ${(e as Error).message}`;
    if (!(e instanceof StoreError)) console.error(`[hum] ${id}: ${errCode(e)}`);
    hub.store.patch(id, { midi: { ...((idea.fields.midi as object) ?? {}), source: "hum", mode, state: "failed", error: msg, notes: [] } });
  }
}

/**
 * Recordings of music ideas that were deleted (or are gone) are removed, so a deleted hum does not stay on the hub
 * or in the nightly backup copy (deploy/user-backup mirrors this folder). Run by the nightly sweep.
 */
export function pruneHumAudio(hub: Hub): number {
  let gone = 0;
  let files: string[] = [];
  try { files = fs.readdirSync(audioDir(hub)); } catch { return 0; }
  for (const f of files) {
    const id = f.replace(/\.wav$/, "");
    const idea = hub.store.get(id);
    if (idea && idea.kind === "music_idea" && !idea.deleted_at) continue;
    fs.rmSync(path.join(audioDir(hub), f), { force: true });
    gone++;
  }
  return gone;
}

/** GET /music/:id/midi: the idea's notes as a .mid file, snapped to the 1/16 grid unless `grid=off`. */
export function ideaMidi(hub: Hub, id: string, grid: boolean): { name: string; bytes: Buffer } {
  const idea = hub.store.get(id);
  if (!idea || idea.kind !== "music_idea" || idea.deleted_at) throw new StoreError(404, "music idea not found");
  const m = idea.fields.midi as { mode?: HumMode; state?: string; notes?: HumNote[] } | undefined;
  if (!m?.notes?.length) throw new StoreError(409, m?.state === "listening" ? "still listening; try again in a moment" : "this idea has no notes");
  // A typed tempo of 0 or 2 would make NaN times or wrap the file's tempo field.
  const typed = Number(idea.fields.bpm);
  const bpm = Number.isFinite(typed) && typed >= 20 && typed <= 400 ? typed : 100;
  const title = String(idea.fields.title ?? "Hum");
  const notes = grid ? snapToGrid(m.notes, bpm, m.mode === "rhythm" ? "rhythm" : "melody") : m.notes;
  const file = `${title.replace(/[^\w ,.#()-]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "hum"}.mid`;
  return { name: file, bytes: midiFile(notes, { bpm, name: title, drums: m.mode === "rhythm" }) };
}
