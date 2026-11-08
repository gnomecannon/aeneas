import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeHub } from "./helpers.js";
import { basicPitch, estimateBpm, estimateKey, findHits, hear, humEngine, HUM_RATE, melodyNotes, midiFile, readWav, snapToGrid, stopHumWorker, writeWav, type HumNote, type PitchTrack } from "../src/hum.js";

after(() => stopHumWorker());

/** A hummed line: a voice-like tone (overtones, vibrato, a little breath) gliding into each note, at `bpm` quarter notes. */
function hum(midi: number[], bpm: number, rate = HUM_RATE): Float32Array {
  const q = 60 / bpm;
  const out = new Float32Array(Math.ceil(rate * (midi.length * q + 0.4)));
  let phase = 0;
  let seed = 7;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const n = Math.min(midi.length - 1, Math.floor(t / q));
    const within = t - n * q;
    const glide = within < 0.04 && n > 0 ? (midi[n - 1] - midi[n]) * (1 - within / 0.04) : 0;
    const f = 440 * 2 ** ((midi[n] + glide + 0.2 * Math.sin(2 * Math.PI * 5.5 * t) - 69) / 12);
    phase += 2 * Math.PI * f / rate;
    const env = t < midi.length * q ? Math.min(1, within / 0.03) * Math.min(1, (q - within) / 0.06) : 0;
    let s = 0;
    for (let h = 1; h <= 8; h++) s += Math.sin(h * phase) / (h * h);
    out[i] = 0.4 * env * s + 0.01 * noise();
  }
  return out;
}

/** A pitch line as the model gives one (86 frames a second): pieces of [pitch at time t within the piece, seconds, level dB]. */
function line(pieces: [number | null | ((t: number) => number | null), number, number?][]): { track: PitchTrack; levels: Float32Array } {
  const fps = 86.13;
  const t: number[] = [], p: number[] = [], sure: number[] = [], lv: number[] = [];
  let at = 0;
  for (const [pitch, secs, db = -10] of pieces) {
    const frames = Math.round(secs * fps);
    for (let i = 0; i < frames; i++) {
      const v = typeof pitch === "function" ? pitch(i / fps) : pitch;
      t.push(at + i / fps); p.push(v ?? 0); sure.push(v == null ? 0.02 : 0.8); lv.push(v == null ? -60 : db);
    }
    at += frames / fps;
  }
  return { track: { t: Float32Array.from(t), p: Float32Array.from(p), s: Float32Array.from(sure) }, levels: Float32Array.from(lv) };
}
const pitches = (x: { track: PitchTrack; levels: Float32Array }) => melodyNotes(x.track, x.levels).map((n) => n.p);

/** Kicks (a low thump), snares (a noisy crack) and hats (a short hiss) at given times. */
function drums(hits: [number, "k" | "s" | "h"][], seconds: number): Float32Array {
  const out = new Float32Array(Math.ceil(HUM_RATE * seconds));
  let seed = 11;
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  for (const [at, kind] of hits) {
    const start = Math.round(at * HUM_RATE);
    let prev = 0;
    for (let i = 0; i < HUM_RATE * 0.15 && start + i < out.length; i++) {
      const t = i / HUM_RATE;
      let v: number;
      if (kind === "k") v = Math.sin(2 * Math.PI * (60 + 60 * Math.exp(-t * 30)) * t) * Math.exp(-t * 18);
      else if (kind === "s") { const n = noise(); v = (n - prev * 0.6) * Math.exp(-t * 30) * 0.6 + Math.sin(2 * Math.PI * 200 * t) * Math.exp(-t * 40) * 0.3; prev = n; }
      else { const n = noise(); v = (n - prev) * Math.exp(-t * 90) * 0.5; prev = n; }
      out[start + i] += v * 0.8;
    }
  }
  return out;
}

test("hum: Basic Pitch hears a hummed melody's notes, and the tempo and key come from them", async () => {
  // Recorded on a phone at 44.1 kHz stereo; the hub reads it to mono at 22.05 kHz.
  const at44 = hum([60, 64, 67, 64, 62, 60, 67, 65, 64, 62, 60], 100, 44100);
  const stereo = new Float32Array(at44.length * 2);
  for (let i = 0; i < at44.length; i++) { stereo[2 * i] = at44[i]; stereo[2 * i + 1] = at44[i]; }
  const wav = writeWav(at44, 44100);
  const mono = readWav(wav);
  assert.ok(Math.abs(mono.length - at44.length / 2) <= 2);
  const h = await hear(mono, "melody", undefined, basicPitch);
  assert.deepEqual(h.notes.map((n) => n.p), [60, 64, 67, 64, 62, 60, 67, 65, 64, 62, 60]);
  assert.equal(h.notes[0].s, 0);
  assert.ok(Math.abs(h.bpm - 100) <= 2, `bpm ${h.bpm}`);
  assert.equal(h.key, "C major");
});

test("hum: a tapped rhythm becomes kick, snare and hat hits at its tempo", async () => {
  const e = 60 / 110 / 2;
  const pattern: [number, "k" | "s" | "h"][] = [];
  const bar = ["k", "h", "s", "h", "k", "k", "s", "h"] as const;
  for (let i = 0; i < 16; i++) pattern.push([0.2 + i * e, bar[i % 8]]);
  const h = await hear(drums(pattern, 0.2 + 16 * e + 0.5), "rhythm", undefined, async () => { throw new Error("no model for rhythm"); });
  const want = pattern.map(([, k]) => (k === "k" ? 36 : k === "s" ? 38 : 42));
  assert.deepEqual(h.notes.map((n) => n.p), want);
  assert.ok(Math.abs(h.bpm - 110) <= 2, `bpm ${h.bpm}`);
  assert.equal(h.key, null);
  assert.equal(findHits(new Float32Array(HUM_RATE)).length, 0, "silence has no hits");
});

test("hum: what the voice does between notes is not a note (the owner's first hum, 2026-11-03: 19 notes for 9)", () => {
  // Sliding up into the next note over 60 ms.
  assert.deepEqual(pitches(line([[60, 0.4], [(t) => 60 + 4 * t / 0.06, 0.06], [64, 0.4]])), [60, 64]);
  // Vibrato right on the line between B and C, held: one note, not B C B C.
  assert.deepEqual(pitches(line([[(t) => 59.6 + 0.35 * Math.sin(2 * Math.PI * 5.5 * t), 0.9]])), [60]);
  // A quick flip up and back (50 ms) inside a held note.
  assert.deepEqual(pitches(line([[62, 0.3], [64, 0.05], [62, 0.3]])), [62]);
  // A held note whose loudness wobbles a little is one note; one re-sung (the level dips 12 dB and comes back) is two.
  assert.deepEqual(pitches(line([[62, 0.3, -10], [62, 0.05, -14], [62, 0.3, -10]])), [62]);
  assert.deepEqual(pitches(line([[62, 0.3, -10], [62, 0.035, -24], [62, 0.3, -10]])), [62, 62]);
  // A breath between notes ends one and starts the next.
  assert.deepEqual(pitches(line([[57, 0.3], [null, 0.1], [57, 0.3]])), [57, 57]);
  // A whole hum half a semitone off the piano: the steps between notes stay right (2, 2, 1), not 3, 1, 1.
  const off = melodyNotes(...Object.values(line([[60.47, 0.3], [null, 0.08], [62.56, 0.3], [null, 0.08], [64.44, 0.3], [null, 0.08], [65.53, 0.3]])) as [PitchTrack, Float32Array]).map((n) => n.p);
  assert.deepEqual(off.slice(1).map((p, i) => p - off[i]), [2, 2, 1]);
  // A slow slide (a fifth down over 250 ms) between two held notes is not a staircase of the notes it passes.
  assert.deepEqual(pitches(line([[62, 0.3], [(t) => 62 - 5 * t / 0.25, 0.25], [57, 0.3]])), [62, 57]);
  // A quick run of real notes (120 ms each, 25 ms slides between) keeps every note.
  const run = [60, 62, 64, 65, 67, 65, 64, 62];
  assert.deepEqual(pitches(line(run.flatMap((p, k) => (k ? [[(t: number) => run[k - 1] + (p - run[k - 1]) * t / 0.025, 0.025], [p, 0.12]] : [[p, 0.12]]) as [number | ((t: number) => number), number][]))), run);
  // A blip under 80 ms after silence goes.
  assert.deepEqual(pitches(line([[60, 0.3], [null, 0.1], [67, 0.05], [null, 0.1], [62, 0.3]])), [60, 62]);
});

test("hum: one voice at a time, the grid, the key, the tempo", () => {
  const snapped = snapToGrid([{ p: 60, s: 0.02, d: 0.13, v: 90 }, { p: 62, s: 0.31, d: 0.01, v: 90 }], 120);
  assert.deepEqual(snapped.map((n) => [n.s, n.d]), [[0, 0.125], [0.25, 0.125]]);
  const aMinor: HumNote[] = [57, 60, 64, 62, 60, 59, 57, 64, 57].map((p, i) => ({ p, s: i * 0.5, d: 0.45, v: 90 }));
  assert.equal(estimateKey(aMinor), "A minor");
  assert.equal(estimateKey([{ p: 60, s: 0, d: 1, v: 1 }]), null);
  assert.equal(estimateBpm([0, 0.5, 1, 1.5, 2, 2.75, 3]), 120);
});

test("hum: the MIDI file has the tempo, the time signature and every note, drums on channel 10", () => {
  const notes: HumNote[] = [{ p: 60, s: 0, d: 0.5, v: 100 }, { p: 60, s: 0.5, d: 0.5, v: 90 }, { p: 67, s: 1, d: 1, v: 80 }];
  const f = midiFile(notes, { bpm: 120, name: "Melody in C major", drums: false });
  assert.equal(f.toString("ascii", 0, 4), "MThd");
  assert.equal(f.readUInt16BE(8), 0, "format 0");
  assert.equal(f.readUInt16BE(12), 480);
  assert.equal(f.toString("ascii", 14, 18), "MTrk");
  const track = f.subarray(22);
  assert.ok(track.includes(Buffer.from([0xff, 0x51, 0x03, 0x07, 0xa1, 0x20])), "500,000 microseconds a quarter is 120 BPM");
  assert.ok(track.includes(Buffer.from([0xff, 0x58, 0x04, 4, 2, 24, 8])), "4/4");
  let ons = 0;
  for (let i = 0; i < track.length - 2; i++) if (track[i] === 0x90 && track[i + 2] > 0) ons++;
  assert.equal(ons, 3);
  // The repeated C: its note off comes before the next note on at the same tick.
  const off = track.indexOf(Buffer.from([0x80, 60, 0])), secondOn = track.indexOf(Buffer.from([0x90, 60, 90]));
  assert.ok(off > 0 && off < secondOn);
  assert.equal(f.readUInt32BE(18), track.length);
  assert.ok(midiFile(notes, { bpm: 120, name: "Beat", drums: true }).includes(Buffer.from([0x99, 60, 100])));
});

test("hum: POST /music/hum makes the idea at once, fills in the notes, and gives a MIDI file and the recording", async () => {
  const t = makeHub();
  const real = humEngine.transcribe;
  try {
    humEngine.transcribe = async () => line([[null, 0.1], [57, 0.45], [null, 0.05], [60, 0.45], [null, 0.05], [64, 0.45], [null, 0.05], [62, 0.45], [null, 0.05], [57, 0.9]]).track;
    const wav = writeWav(hum([57, 60, 64, 62, 57], 120));
    const r = await t.api("/music/hum?mode=melody&from=capture", { method: "POST", body: wav as unknown as RequestInit["body"], headers: { "content-type": "audio/wav" } });
    assert.equal(r.status, 202);
    const idea = await r.json() as { id: string; fields: { title: string; midi: { state: string } } };
    assert.equal(idea.fields.midi.state, "listening");
    for (let i = 0; i < 50 && (t.hub.store.get(idea.id)!.fields.midi as { state: string }).state === "listening"; i++) await new Promise((res) => setTimeout(res, 20));
    const done = t.hub.store.get(idea.id)!;
    const midi = done.fields.midi as { state: string; notes: HumNote[] };
    assert.equal(midi.state, "done");
    assert.deepEqual(midi.notes.map((n) => n.p), [57, 60, 64, 62, 57]);
    assert.equal(done.fields.bpm, 120);
    assert.equal(done.fields.key, "A minor");
    assert.equal(done.fields.title, "Melody in A minor, 120 BPM");
    const file = await t.api(`/music/${idea.id}/midi`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "audio/midi");
    assert.match(file.headers.get("content-disposition") ?? "", /Melody in A minor, 120 BPM\.mid/);
    assert.equal(Buffer.from(await file.arrayBuffer()).toString("ascii", 0, 4), "MThd");
    assert.equal((await t.api(`/music/${idea.id}/audio`)).status, 200);
    // From Capture, the day's diary says so.
    const diary = t.hub.store.list({ kind: "note" }).find((n) => String(n.fields.path ?? "").startsWith("Diary/"));
    assert.match(String(diary?.fields.body ?? ""), /Hummed a melody: Melody in A minor/);
    // Heard again as a rhythm from the kept recording.
    assert.equal((await t.api(`/music/${idea.id}/rehear`, { method: "POST", json: { mode: "rhythm" } })).status, 202);
    for (let i = 0; i < 50 && (t.hub.store.get(idea.id)!.fields.midi as { state: string }).state === "listening"; i++) await new Promise((res) => setTimeout(res, 20));
    const again = t.hub.store.get(idea.id)!;
    assert.equal((again.fields.midi as { mode: string }).mode, "rhythm");
    assert.equal(again.fields.key, undefined, "a rhythm has no key");
    assert.match(String(again.fields.title), /^Rhythm, \d+ BPM$/);
    // Not a WAV, and silence.
    assert.equal((await t.api("/music/hum", { method: "POST", body: Buffer.from("hello") as unknown as RequestInit["body"] })).status, 422);
    const quiet = await (await t.api("/music/hum", { method: "POST", body: writeWav(new Float32Array(HUM_RATE)) as unknown as RequestInit["body"] })).json() as { id: string };
    for (let i = 0; i < 50 && (t.hub.store.get(quiet.id)!.fields.midi as { state: string }).state === "listening"; i++) await new Promise((res) => setTimeout(res, 20));
    assert.match(String((t.hub.store.get(quiet.id)!.fields.midi as { error?: string }).error), /silent/);
    // With Music off, there is no humming.
    t.hub.modules.set({ music: false });
    assert.equal((await t.api("/music/hum", { method: "POST", body: wav as unknown as RequestInit["body"] })).status, 404);
  } finally { humEngine.transcribe = real; t.cleanup(); }
});

test("hum: the nightly sweep removes the recording of a deleted idea and keeps the rest", async () => {
  const t = makeHub();
  const real = humEngine.transcribe;
  try {
    humEngine.transcribe = async () => line([[60, 0.4]]).track;
    const post = async () => (await (await t.api("/music/hum", { method: "POST", body: writeWav(hum([60], 120)) as unknown as RequestInit["body"] })).json()) as { id: string };
    const keep = await post(), drop = await post();
    await t.api(`/entities/${drop.id}`, { method: "DELETE" });
    const { pruneHumAudio, humAudioPath } = await import("../src/hum.js");
    assert.equal(pruneHumAudio(t.hub), 1);
    assert.ok(fs.existsSync(humAudioPath(t.hub, keep.id)));
    assert.ok(!fs.existsSync(humAudioPath(t.hub, drop.id)));
  } finally { humEngine.transcribe = real; t.cleanup(); }
});

test("hum: notes that land on one grid step do not stack, and a typed tempo of 0 still makes a playable file", () => {
  // A melody: two notes on one step keep the longer; a note still sounding when the next starts ends there.
  const mel = snapToGrid([{ p: 60, s: 0.12, d: 0.1, v: 90 }, { p: 62, s: 0.24, d: 0.5, v: 90 }, { p: 64, s: 0.6, d: 0.2, v: 90 }], 70);
  assert.deepEqual(mel.map((n) => n.p), [62, 64]);
  for (let i = 1; i < mel.length; i++) assert.ok(mel[i - 1].s + mel[i - 1].d <= mel[i].s + 1e-9, "one voice at a time");
  // A rhythm: the same drum twice on a step keeps the louder hit; a kick and a hat together stay.
  const beat = snapToGrid([{ p: 42, s: 0, d: 0.2, v: 60 }, { p: 42, s: 0.08, d: 0.2, v: 100 }, { p: 36, s: 0, d: 0.2, v: 90 }, { p: 42, s: 0.2, d: 0.2, v: 70 }], 75, "rhythm");
  assert.deepEqual(beat.filter((n) => n.s === 0).map((n) => [n.p, n.v]).sort(), [[36, 90], [42, 100]]);
  for (const a of beat) for (const b of beat) if (a !== b && a.p === b.p) assert.ok(a.s + a.d <= b.s + 1e-9 || b.s + b.d <= a.s + 1e-9, "the same drum never overlaps itself");
});

test("hum: a long held note is quick to hear (it re-sorted every frame: 5 s for two minutes)", () => {
  const drone = line([[(t) => 60 + 0.1 * Math.sin(2 * Math.PI * 5 * t), 120]]);
  const t0 = Date.now();
  const notes = melodyNotes(drone.track, drone.levels);
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0} ms`);
  assert.deepEqual(notes.map((n) => n.p), [60]);
});

test("hum: a newer hearing wins, a resent take is the same idea, a restart hears again, a bad tempo or WAV is handled", async () => {
  const t = makeHub();
  const real = humEngine.transcribe;
  const settle = async (id: string) => { for (let i = 0; i < 100 && (t.hub.store.get(id)!.fields.midi as { state: string }).state === "listening"; i++) await new Promise((res) => setTimeout(res, 20)); };
  try {
    // The melody hearing is slow; a rhythm rehear started meanwhile finishes first and must stay.
    let release: () => void = () => {};
    humEngine.transcribe = () => new Promise((res) => { release = () => res(line([[60, 0.4]]).track); });
    const wav = writeWav(hum([60, 62], 120)) as unknown as RequestInit["body"];
    const idea = await (await t.api("/music/hum?mode=melody&client_id=watch-hum-0001", { method: "POST", body: wav })).json() as { id: string };
    assert.equal((await t.api(`/music/${idea.id}/rehear`, { method: "POST", json: { mode: "rhythm" } })).status, 202);
    await settle(idea.id);
    release();
    await new Promise((res) => setTimeout(res, 50));
    const after = t.hub.store.get(idea.id)!;
    assert.equal((after.fields.midi as { mode: string }).mode, "rhythm", "the older melody hearing was dropped");
    assert.match(String(after.fields.title), /^Rhythm/);
    // The same take sent again comes back as the same idea.
    const again = await (await t.api("/music/hum?mode=melody&client_id=watch-hum-0001", { method: "POST", body: wav })).json() as { id: string };
    assert.equal(again.id, idea.id);
    assert.equal(t.hub.store.list({ kind: "music_idea" }).length, 1);
    // A restart mid-hearing: listening ideas are heard again from their recording, or fail without one.
    humEngine.transcribe = async () => line([[64, 0.4]]).track;
    t.hub.store.patch(idea.id, { midi: { source: "hum", mode: "melody", state: "listening", notes: [], job: "old" } });
    const lost = t.hub.store.create("music_idea", { title: "Hummed melody", type: "riff", midi: { source: "hum", mode: "melody", state: "listening", notes: [] } });
    const { resumeHums } = await import("../src/hum.js");
    assert.equal(resumeHums(t.hub), 2);
    await settle(idea.id);
    assert.deepEqual((t.hub.store.get(idea.id)!.fields.midi as { state: string; notes: HumNote[] }).notes.map((n) => n.p), [64]);
    assert.match(String((t.hub.store.get(lost.id)!.fields.midi as { error?: string }).error), /restarted/);
    // A typed tempo of 0 is not used for the file.
    t.hub.store.patch(idea.id, { bpm: 0 });
    const file = await t.api(`/music/${idea.id}/midi`);
    assert.equal(file.status, 200);
    assert.ok(Buffer.from(await file.arrayBuffer()).includes(Buffer.from([0xff, 0x51, 0x03, 0x09, 0x27, 0xc0])), "100 BPM instead");
    // A WAV whose format block is cut short is refused, not a crash.
    const bad = Buffer.from(writeWav(hum([60], 120)));
    bad.writeUInt32LE(8, 16);
    assert.equal((await t.api("/music/hum", { method: "POST", body: bad as unknown as RequestInit["body"] })).status, 422);
  } finally { humEngine.transcribe = real; t.cleanup(); }
});

test("hum: even quarter notes at a slow tempo are read at that tempo, not as dotted notes half again as fast", () => {
  for (const bpm of [64, 70, 76, 80, 84]) {
    const beat = 60 / bpm;
    for (const starts of [[0, 1, 2, 3, 4, 5, 6, 7], [0, 1, 2, 3, 4, 5, 6, 8, 9, 10]]) {
      const got = estimateBpm(starts.map((i) => i * beat));
      // Twice the tempo (the same notes as eighths) is a fair reading; half again as fast puts the bar lines wrong.
      assert.ok(got === bpm || got === 2 * bpm, `${starts.length} notes at ${bpm} read as ${got}`);
      if (bpm >= 76) assert.equal(got, bpm);
    }
  }
});
