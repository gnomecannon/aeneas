// Basic Pitch (Spotify, Apache-2.0) in a worker thread for hum.ts: the model runs on the CPU in plain JavaScript and
// takes about 1.2 s per second of audio, so it must not run on the thread that answers requests. It returns the
// voice's pitch line (one value per model frame), not the model's own notes: those split a held note at every wobble
// of vibrato or loudness, and hum.ts makes notes from the line instead.
import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

// TensorFlow.js prints a banner about its native build on first use; the hub's log has no use for it, and this
// worker says everything it has to say through postMessage.
console.log = () => {};
console.warn = () => {};
console.info = () => {};
const tf = await import("@tensorflow/tfjs");
const { BasicPitch } = await import("@spotify/basic-pitch");
await tf.setBackend("cpu");

const dir = workerData.modelDir;
const json = JSON.parse(fs.readFileSync(path.join(dir, "model.json"), "utf8"));
const weights = fs.readFileSync(path.join(dir, json.weightsManifest[0].paths[0]));
const model = tf.loadGraphModel(tf.io.fromMemory({
  modelTopology: json.modelTopology, weightSpecs: json.weightsManifest[0].weights,
  weightData: weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength),
  format: json.format, generatedBy: json.generatedBy, convertedBy: json.convertedBy,
}));
const bp = new BasicPitch(model);

// Basic Pitch's frame timing (toMidi.js): 22,050 Hz, hop 256, 2 s windows stitched with a small offset per window.
const SR = 22050, HOP = 256, FPS = Math.floor(SR / HOP), WIN_FRAMES = FPS * 2, WIN_SAMPLES = SR * 2 - HOP;
const WINDOW_OFFSET = (HOP / SR) * (WIN_FRAMES - WIN_SAMPLES / HOP) + 0.0018;
const frameTime = (f) => (f * HOP) / SR - WINDOW_OFFSET * Math.floor(f / WIN_FRAMES);
// Contour bins are a third of a semitone from A0 (MIDI 21). Measured on pure tones the peak sits one bin above the
// pitch (220 Hz read as 57.31), so one bin comes off. Only the human voice's range is searched (MIDI 33 to 86,
// 55 to 1175 Hz), so an overtone above it is never taken for the voice.
const LO = (33 - 21) * 3, HI = (86 - 21) * 3;

parentPort.on("message", async ({ id, samples }) => {
  try {
    const contours = [];
    await bp.evaluateModel(samples, (_f, _o, c) => { contours.push(...c); }, () => {});
    const n = contours.length;
    const t = new Float32Array(n), p = new Float32Array(n), s = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const c = contours[i];
      let k = LO;
      for (let j = LO; j <= HI && j < c.length; j++) if (c[j] > c[k]) k = j;
      const a = c[k - 1] ?? c[k], b = c[k + 1] ?? c[k], den = a - 2 * c[k] + b;
      const dk = den < 0 ? (0.5 * (a - b)) / den : 0;
      t[i] = frameTime(i);
      p[i] = 21 + (k + dk - 1) / 3;
      s[i] = c[k];
    }
    parentPort.postMessage({ id, track: { t, p, s } }, [t.buffer, p.buffer, s.buffer]);
  } catch (e) {
    parentPort.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
});
