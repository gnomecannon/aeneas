import { beforeAll, describe, expect, it } from "vitest";

/**
 * The synth against a fake Web Audio graph that records every automation call, so held, released, bent and filtered
 * notes can be checked without ears.
 */

type Call = [string, ...number[]];

class Param {
  value: number;
  calls: Call[] = [];
  constructor(v = 0) {
    this.value = v;
  }
  setValueAtTime(v: number, t: number) {
    this.calls.push(["set", v, t]);
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(["lin", v, t]);
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.calls.push(["exp", v, t]);
  }
  setTargetAtTime(v: number, t: number, tc: number) {
    this.calls.push(["target", v, t, tc]);
  }
  cancelScheduledValues(t: number) {
    this.calls.push(["cancel", t]);
  }
  cancelAndHoldAtTime(t: number) {
    this.calls.push(["hold", t]);
  }
}

class Node {
  connect<T>(n: T): T {
    return n;
  }
  disconnect() {}
}

class Source extends Node {
  started = -1;
  stops: number[] = [];
  onended: (() => void) | null = null;
  start(t: number) {
    this.started = t;
  }
  stop(t: number) {
    this.stops.push(t);
  }
}

class Osc extends Source {
  type = "sine";
  frequency = new Param(440);
  detune = new Param(0);
}

class BufSource extends Source {
  buffer: { length: number; sampleRate: number } | null = null;
  playbackRate = new Param(1);
  loop = false;
  loopStart = 0;
  loopEnd = 0;
}

class Ctx {
  currentTime = 0;
  sampleRate = 48000;
  state = "running";
  destination = new Node();
  gains: Array<Node & { gain: Param }> = [];
  oscs: Osc[] = [];
  filters: Array<Node & { type: string; frequency: Param; Q: Param }> = [];
  bufs: BufSource[] = [];
  resume() {
    return Promise.resolve();
  }
  createGain() {
    const g = Object.assign(new Node(), { gain: new Param(1) });
    this.gains.push(g);
    return g;
  }
  createOscillator() {
    const o = new Osc();
    this.oscs.push(o);
    return o;
  }
  createBiquadFilter() {
    const f = Object.assign(new Node(), { type: "lowpass", frequency: new Param(350), Q: new Param(1) });
    this.filters.push(f);
    return f;
  }
  createBufferSource() {
    const b = new BufSource();
    this.bufs.push(b);
    return b;
  }
  createBuffer(_ch: number, length: number, sampleRate: number) {
    const d = new Float32Array(length);
    return { length, sampleRate, getChannelData: () => d };
  }
  createWaveShaper() {
    return Object.assign(new Node(), { curve: null as Float32Array | null });
  }
  createDynamicsCompressor() {
    return Object.assign(new Node(), { threshold: new Param(), ratio: new Param() });
  }
}

let ctx: Ctx;
let synth: typeof import("./synth");

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = {
    AudioContext: class extends Ctx {
      constructor() {
        super();
        ctx = this;
      }
    },
  };
  synth = await import("./synth");
  synth.unlockAudio();
});

/** A voice's envelope gain, as the fake recorded it. */
function envOf(v: unknown): Param {
  return (v as { env: { gain: Param } }).env.gain;
}

describe("synth voices", () => {
  it("plays a fixed note exactly as before when hold is off", () => {
    ctx.currentTime = 1;
    synth.startNote(60, "sine");
    const env = ctx.gains.find((g) => g.gain.calls.some((c) => c[0] === "exp"))!.gain;
    const t = 1.005;
    expect(env.calls).toEqual([
      ["set", 0, t],
      ["lin", 0.5, t + 0.012],
      ["exp", 0.0001, t + 0.5],
      ["lin", 0, t + 0.52],
    ]);
    expect(ctx.oscs[ctx.oscs.length - 1].stops).toEqual([t + 0.55]);
    const f = ctx.filters[ctx.filters.length - 1];
    expect(f.frequency.value).toBe(20000);
    expect(f.Q.value).toBe(0);
  });

  it("holds a sustaining voice at its level and ends a quick tap like the fixed note", () => {
    ctx.currentTime = 2;
    const v = synth.startNote(60, "sine", { hold: true })!;
    const env = envOf(v);
    expect(env.calls).toEqual([
      ["set", 0, 2.005],
      ["lin", 0.5, 2.017],
      ["target", 0.225, 2.017, 0.25],
    ]);
    const osc = ctx.oscs[ctx.oscs.length - 1];
    expect(osc.stops).toEqual([]);
    ctx.currentTime = 2.1;
    synth.releaseNote(v);
    expect(env.calls.slice(3)).toEqual([
      ["hold", 2.1],
      ["exp", 0.0001, 2.505],
      ["lin", 0, 2.525],
    ]);
    expect(osc.stops[0]).toBeCloseTo(2.555, 6);
    expect(synth.synthStats.quick).toBe(1);
  });

  it("fades a long hold over the release time", () => {
    ctx.currentTime = 3;
    const v = synth.startNote(64, "glass", { hold: true })!;
    const env = envOf(v);
    ctx.currentTime = 4;
    synth.releaseNote(v);
    expect(env.calls.slice(-2)).toEqual([
      ["hold", 4],
      ["target", 0, 4, 0.45 / 4.6],
    ]);
    for (const o of ctx.oscs.slice(-2)) expect(o.stops[0]).toBeCloseTo(4 + 0.45 * 1.3 + 0.05, 6);
    // Releasing twice does nothing more.
    synth.releaseNote(v);
    expect(env.calls).toHaveLength(5);
  });

  it("lets percussive voices ring down to a quiet sustain", () => {
    ctx.currentTime = 5;
    const v = synth.startNote(67, "bell", { hold: true });
    const target = envOf(v).calls.find((c) => c[0] === "target")!;
    expect(target[1]).toBeCloseTo(0.38 * 0.08, 6);
  });

  it("bends through detune and sweeps the filter while held", () => {
    ctx.currentTime = 6;
    const v = synth.startNote(60, "glass", { hold: true, bend: true })!;
    const f = ctx.filters[ctx.filters.length - 1];
    expect(f.frequency.value).toBe(3100);
    expect(f.Q.value).toBe(4.5);
    const [a, b] = ctx.oscs.slice(-2);
    ctx.currentTime = 6.5;
    synth.bendNote(v, 64);
    expect(a.detune.calls.at(-1)).toEqual(["target", 400, 6.5, 0.016]);
    expect(b.detune.calls.at(-1)).toEqual(["target", 407, 6.5, 0.016]);
    synth.filterNote(v, 14000);
    expect(f.frequency.calls.at(-1)).toEqual(["target", 14000, 6.5, 0.03]);
  });

  it("bends the pluck through its playback rate and loops it while held", () => {
    ctx.currentTime = 7;
    const v = synth.startNote(60, "pluck", { hold: true, bend: true })!;
    const s = ctx.bufs[ctx.bufs.length - 1];
    expect(s.loop).toBe(true);
    expect(s.loopEnd).toBeGreaterThan(s.loopStart);
    synth.bendNote(v, 72);
    expect(s.playbackRate.calls.at(-1)?.[1]).toBeCloseTo(2, 6);
    ctx.currentTime = 7.05;
    synth.releaseNote(v);
    expect(s.loop).toBe(false);
  });

  it("steals the oldest voice past eight and leaves the stolen handle harmless", () => {
    ctx.currentTime = 8;
    const first = synth.startNote(60, "sine", { hold: true })!;
    for (let i = 0; i < 9; i++) synth.startNote(62, "sine", { hold: true });
    expect(synth.activeVoices()).toBeLessThanOrEqual(8);
    expect(first.held).toBe(false);
    expect(() => synth.releaseNote(first)).not.toThrow();
    synth.releaseAll();
    expect(synth.synthStats.stolen).toBeGreaterThan(0);
  });
});
