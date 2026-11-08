import type { HumNote } from "./creative";

/**
 * Recording a hum in the browser (and the Windows app's webview) as a WAV the hub can read, and playing the notes it
 * heard. The hub does the listening (hub/src/hum.ts); this side only records and plays.
 */

export const MAX_HUM_SECONDS = 120;

export interface HumRecording {
  /** Live input level 0 to 1, for the meter. */
  level(): number;
  /** Seconds recorded so far. */
  seconds(): number;
  /** Stop and get the recording as a 16-bit mono WAV at the device's own rate (the hub resamples it). */
  stop(): Promise<Blob>;
  /** Stop and throw the recording away. */
  cancel(): void;
}

/**
 * Start recording from the microphone. Echo cancellation, noise suppression and automatic gain are off: they are
 * made for speech and would smear or cut a hum, and they pump the level between taps.
 */
export async function startHumRecording(): Promise<HumRecording> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot record from a microphone.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessorNode is old but runs everywhere this app does (Chrome, Safari, Edge's WebView2) with no module file.
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let frames = 0;
  let last = 0;
  node.onaudioprocess = (ev) => {
    if (frames >= MAX_HUM_SECONDS * ctx.sampleRate) return;
    const data = new Float32Array(ev.inputBuffer.getChannelData(0));
    chunks.push(data);
    frames += data.length;
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    last = peak;
  };
  // Connected through a silent gain so the processor runs without the hum coming back out of the speakers.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    node.disconnect();
    source.disconnect();
    mute.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => undefined);
  };
  return {
    level: () => last,
    seconds: () => frames / ctx.sampleRate,
    stop: async () => {
      const rate = ctx.sampleRate;
      close();
      const all = new Float32Array(frames);
      let at = 0;
      for (const c of chunks) { all.set(c.subarray(0, Math.min(c.length, frames - at)), at); at += c.length; if (at >= frames) break; }
      const small = downsample(all, rate);
      return wavBlob(small.x, small.rate);
    },
    cancel: close,
  };
}

/**
 * Audio interfaces record at up to 192 kHz, where two minutes is a 46 MB file, over the hub's 25 MB limit. The hub
 * hears at 22,050 Hz, so a fast recording is cut to 22 to 24 kHz first: each group of samples becomes their average
 * (which also keeps out what the lower rate could not hold).
 */
export function downsample(x: Float32Array, rate: number): { x: Float32Array; rate: number } {
  const k = Math.floor(rate / 22050);
  if (k < 2) return { x, rate };
  const out = new Float32Array(Math.floor(x.length / k));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let j = 0; j < k; j++) sum += x[i * k + j];
    out[i] = sum / k;
  }
  return { x: out, rate: rate / k };
}

/** A 16-bit mono WAV file. */
export function wavBlob(x: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + x.length * 2);
  const v = new DataView(buf);
  const text = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  text(0, "RIFF"); v.setUint32(4, 36 + x.length * 2, true); text(8, "WAVE");
  text(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, "data"); v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), true);
  return new Blob([buf], { type: "audio/wav" });
}

const hz = (p: number) => 440 * 2 ** ((p - 69) / 12);

/**
 * Play heard notes: a soft triangle voice for a melody; for a rhythm a low thump (36), a noise crack (38) and a short
 * hiss (42). Returns a function that stops it.
 */
export function playNotes(notes: HumNote[], mode: "melody" | "rhythm"): () => void {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  const out = ctx.createGain();
  out.gain.value = 0.35;
  out.connect(ctx.destination);
  const t0 = ctx.currentTime + 0.08;
  let noise: AudioBuffer | null = null;
  const noiseBuf = () => {
    if (noise) return noise;
    noise = ctx.createBuffer(1, ctx.sampleRate * 0.3, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return noise;
  };
  for (const n of notes) {
    const at = t0 + n.s;
    const vel = n.v / 127;
    const g = ctx.createGain();
    g.connect(out);
    if (mode === "melody") {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = hz(n.p);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(vel, at + 0.015);
      g.gain.setValueAtTime(vel, Math.max(at + 0.02, at + n.d - 0.04));
      g.gain.linearRampToValueAtTime(0, at + n.d);
      o.connect(g);
      o.start(at);
      o.stop(at + n.d + 0.02);
    } else if (n.p === 36) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(120, at);
      o.frequency.exponentialRampToValueAtTime(45, at + 0.12);
      g.gain.setValueAtTime(vel * 1.2, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.25);
      o.connect(g);
      o.start(at);
      o.stop(at + 0.3);
    } else {
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf();
      const f = ctx.createBiquadFilter();
      f.type = n.p === 42 ? "highpass" : "bandpass";
      f.frequency.value = n.p === 42 ? 7000 : 1800;
      const len = n.p === 42 ? 0.05 : 0.16;
      g.gain.setValueAtTime(vel * (n.p === 42 ? 0.6 : 0.9), at);
      g.gain.exponentialRampToValueAtTime(0.001, at + len);
      src.connect(f);
      f.connect(g);
      src.start(at);
      src.stop(at + len + 0.02);
    }
  }
  return () => { void ctx.close(); };
}
