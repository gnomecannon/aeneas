// Measures how well made-up hums are heard (hum-synth.ts), scenario by scenario. Run from hub/:
//   node --import tsx test/hum-bench.mts
// The model's pitch lines come from test/fixtures/hum-pitch-lines.json (what hum-accuracy.test.ts scores); a scenario
// missing there, or every one with FRESH=1, is heard by Basic Pitch on the CPU (about a minute for all) and written back.
import fs from "node:fs";
import { basicPitch, stopHumWorker, type PitchTrack } from "../src/hum.js";
import { measureHum, scenarios, synthHum } from "./hum-synth.js";
const cache = process.env.HUM_TRACKS ?? new URL("./fixtures/hum-pitch-lines.json", import.meta.url).pathname;
const tracks: Record<string, { t: number[]; p: number[]; s: number[] }> = cache && fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, "utf8")) : {};
const sum = { expected: 0, correct: 0, wrong: 0, octave: 0, missed: 0, extra: 0, gridCorrect: 0, gridExtra: 0, fileNotes: 0, fileExtra: 0 };
for (const sc of scenarios()) {
  const raw = synthHum(sc.notes, sc.opts);
  let top = 0; for (const v of raw) top = Math.max(top, Math.abs(v));
  const x = raw.map((v) => (v / top) * 0.9);
  let tr = tracks[sc.name];
  if (!tr || process.env.FRESH) { const r = await basicPitch(x); tr = { t: [...r.t], p: [...r.p], s: [...r.s] }; tracks[sc.name] = tr; }
  const track: PitchTrack = { t: Float32Array.from(tr.t), p: Float32Array.from(tr.p), s: Float32Array.from(tr.s) };
  const m = measureHum(sc.notes, x, track);
  sum.expected += m.heard.expected; sum.correct += m.heard.correct; sum.wrong += m.heard.wrongPitch; sum.octave += m.heard.octave; sum.missed += m.heard.missed; sum.extra += m.heard.extra;
  sum.gridCorrect += m.grid.correct; sum.gridExtra += m.grid.extra; sum.fileNotes += m.fileNotes; sum.fileExtra += m.fileExtra;
  console.log(`${sc.name.padEnd(13)} hummed ${m.heard.expected}  right ${m.heard.correct}  wrong ${m.heard.wrongPitch}  missed ${m.heard.missed}  extra ${m.heard.extra}  | grid right ${m.grid.correct} extra ${m.grid.extra} at ${m.bpm}  | file ${m.fileNotes} notes (${m.use}), ${m.fileExtra} never hummed`);
}
console.log(JSON.stringify(sum), `heard right ${(100 * sum.correct / sum.expected).toFixed(1)}%, grid right ${(100 * sum.gridCorrect / sum.expected).toFixed(1)}%`);
const r = (a: number[], k: number) => a.map((v) => Math.round(v * 10 ** k) / 10 ** k);
fs.writeFileSync(cache, JSON.stringify(Object.fromEntries(Object.entries(tracks).map(([k, v]) => [k, { t: r(v.t, 4), p: r(v.p, 2), s: r(v.s, 2) }]))) + "\n");
stopHumWorker();
