import { describe, expect, it } from "vitest";
import { downsample, wavBlob } from "./hum";

describe("hum recording", () => {
  it("writes a 16-bit mono WAV the hub reads, at the device's own rate", async () => {
    const x = new Float32Array([0, 0.5, -0.5, 1, -1.2]);
    const buf = new DataView(await wavBlob(x, 48000).arrayBuffer());
    const text = (o: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => buf.getUint8(o + i)));
    expect(text(0)).toBe("RIFF");
    expect(text(8)).toBe("WAVE");
    expect(buf.getUint16(20, true)).toBe(1);
    expect(buf.getUint16(22, true)).toBe(1);
    expect(buf.getUint32(24, true)).toBe(48000);
    expect(buf.getUint16(34, true)).toBe(16);
    expect(buf.getUint32(40, true)).toBe(10);
    expect([0, 1, 2, 3, 4].map((i) => buf.getInt16(44 + i * 2, true))).toEqual([0, 16384, -16383, 32767, -32768]);
  });
});

describe("downsample", () => {
  it("cuts a fast recording to 22 to 24 kHz so two minutes stay under the hub's upload limit", () => {
    for (const rate of [176400, 192000, 96000, 48000, 44100]) {
      const x = new Float32Array(rate).fill(0.5);
      const d = downsample(x, rate);
      expect(d.rate).toBeGreaterThanOrEqual(22050);
      expect(d.rate).toBeLessThanOrEqual(24000);
      expect(d.x.length).toBe(Math.floor(rate / (rate / d.rate)));
      expect(d.x[10]).toBeCloseTo(0.5);
      // Two minutes as 16-bit mono WAV.
      expect(44 + d.rate * 120 * 2).toBeLessThan(25 * 1024 * 1024);
    }
  });
  it("leaves a recording that is already slow alone", () => {
    const x = new Float32Array(100);
    expect(downsample(x, 22050)).toEqual({ x, rate: 22050 });
    expect(downsample(x, 16000)).toEqual({ x, rate: 16000 });
  });
});
