import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { basicPitch, hitsEchoMelody, humUse, stopHumWorker, type HumNote, type PitchTrack } from "../src/hum.js";
import { measureHum, scenarios, synthHum, type SynthNote } from "./hum-synth.js";

after(() => stopHumWorker());

/**
 * The hum harness (gnomecannon/aeneas#11): made-up hums whose notes are known (hum-synth.ts: vibrato, scoops, glides,
 * fall-offs, breaths, room noise, a low voice through a phone, loose pitch, soft notes), scored note by note. The
 * model's pitch line for each is kept in fixtures/hum-pitch-lines.json, so every scenario is scored in a moment; one is
 * also heard by the model itself here. test/hum-bench.mts prints the numbers per scenario and hears them again.
 * Before the fix: 100 of 100 notes right but 2 extra notes (fall-offs), and 185 notes in the files of 100 hummed
 * (83 drum hits that repeated the melody's starts, kept by default).
 */
const lines = JSON.parse(fs.readFileSync(new URL("./fixtures/hum-pitch-lines.json", import.meta.url), "utf8")) as Record<string, { t: number[]; p: number[]; s: number[] }>;

function samples(notes: SynthNote[], opts: Parameters<typeof synthHum>[1]): Float32Array {
  const raw = synthHum(notes, opts);
  let top = 0;
  for (const v of raw) top = Math.max(top, Math.abs(v));
  return raw.map((v) => (v / top) * 0.9);
}

test("hum harness: every hummed note is heard at its pitch and time, and nothing that was not hummed is added", () => {
  let hummed = 0, right = 0, extra = 0, fileNotes = 0, fileExtra = 0;
  for (const sc of scenarios()) {
    const l = lines[sc.name];
    assert.ok(l, `${sc.name} has a pitch line (node --import tsx test/hum-bench.mts makes it)`);
    const track: PitchTrack = { t: Float32Array.from(l.t), p: Float32Array.from(l.p), s: Float32Array.from(l.s) };
    const m = measureHum(sc.notes, samples(sc.notes, sc.opts), track);
    hummed += m.heard.expected; right += m.heard.correct; extra += m.heard.extra; fileNotes += m.fileNotes; fileExtra += m.fileExtra;
    assert.equal(m.heard.correct, m.heard.expected, `${sc.name}: ${JSON.stringify(m.heard)}`);
    assert.equal(m.heard.extra, 0, `${sc.name}: notes never hummed ${JSON.stringify(m.heard)}`);
    assert.equal(m.grid.correct, m.grid.expected, `${sc.name}: on the grid at ${m.bpm} BPM ${JSON.stringify(m.grid)}`);
    assert.equal(m.use, "melody", `${sc.name}: a hummed tune keeps its melody only`);
    assert.equal(m.fileExtra, 0, `${sc.name}: the file has ${m.fileNotes} notes`);
  }
  assert.equal(right, hummed);
  assert.equal(extra, 0);
  assert.equal(fileNotes, hummed);
  assert.equal(fileExtra, 0);
});

test("hum harness: the model itself hears scoops and fall-offs as the notes they lead to and from", async () => {
  const sc = scenarios().find((s) => s.name === "scoops falls")!;
  const x = samples(sc.notes, sc.opts);
  const m = measureHum(sc.notes, x, await basicPitch(x));
  assert.equal(m.heard.correct, m.heard.expected, JSON.stringify(m.heard));
  assert.equal(m.heard.extra, 0, JSON.stringify(m.heard));
  assert.equal(m.fileExtra, 0);
});

test("hum: hits that only repeat the melody's note starts are not kept by default; taps of their own are", () => {
  const note = (p: number, s: number): HumNote => ({ p, s, d: 0.4, v: 90 });
  const melody = [note(60, 0), note(62, 0.5), note(64, 1), note(65, 1.5)];
  const echo = [36, 38, 36, 38].map((p, i) => ({ p, s: i * 0.5 + 0.03, d: 0.1, v: 90 }));
  assert.ok(hitsEchoMelody({ melody, rhythm: echo }));
  assert.equal(humUse(undefined, { melody, rhythm: echo }), "melody");
  assert.equal(humUse("both", { melody, rhythm: echo }), "both", "the owner's choice stands");
  // Taps between the notes (a beat kept while humming): both.
  const taps = [0.25, 0.75, 1.25, 1.75, 0, 1].map((s) => ({ p: 42, s, d: 0.1, v: 80 }));
  assert.ok(!hitsEchoMelody({ melody, rhythm: taps }));
  assert.equal(humUse(undefined, { melody, rhythm: taps }), "both");
  assert.equal(humUse(undefined, { melody: [], rhythm: taps }), "rhythm");
});
