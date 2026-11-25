import { plainError } from "../lib/errors";
import { useEffect, useRef, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { engine } from "../sync/engine";
import { MAX_HUM_SECONDS, playParts, startHumRecording, type HumRecording } from "../lib/hum";
import { saveBlob } from "../lib/download";
import { humLayers, humUse, type HumMidi, type HumNote, type HumUse, type MusicF } from "../lib/creative";
import { updateEntity } from "../sync/edits";

/**
 * Record anything hummed, sung, tapped or beatboxed and send it to the hub, which hears it both as a melody and as a
 * rhythm and makes notes and a MIDI file (hub hum.ts); which to keep is chosen afterwards. Used on Song ideas and
 * on Capture (`fromCapture`, which also puts a line in the day's diary).
 */
export function HumRecorder({ fromCapture = false, projectId, onDone }: { fromCapture?: boolean; projectId?: string; onDone: (idea: Entity) => void }) {
  const [bpm, setBpm] = useState("");
  const [rec, setRec] = useState<HumRecording | null>(null);
  const [secs, setSecs] = useState(0);
  const [level, setLevel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  // A take whose upload failed (the hub restarting, the network gone): kept to send again.
  const [unsent, setUnsent] = useState<{ wav: Blob; bpm?: number; id: string } | null>(null);
  const tick = useRef<number | null>(null);
  const live = useRef<HumRecording | null>(null);

  // On leaving the screen only: a cleanup tied to `rec` ran when recording started and stopped the clock and meter.
  useEffect(() => () => { if (tick.current) cancelAnimationFrame(tick.current); live.current?.cancel(); }, []);

  const send = async (take: { wav: Blob; bpm?: number; id: string }) => {
    setBusy(true);
    setErr("");
    try {
      const idea = await engine.client!.hum(take.wav, { bpm: take.bpm, projectId, fromCapture, clientId: take.id });
      setUnsent(null);
      await engine.absorb([idea]);
      onDone(idea);
    } catch (e) {
      setUnsent(take);
      setErr(`${plainError(e).replace(/\.$/, "")}. The recording is kept: send it again when the hub is back.`);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setErr("");
    setUnsent(null);
    try {
      const r = await startHumRecording();
      live.current = r;
      setRec(r);
      const loop = () => {
        setSecs(r.seconds());
        setLevel(r.level());
        if (r.seconds() >= MAX_HUM_SECONDS) { void stop(r); return; }
        tick.current = requestAnimationFrame(loop);
      };
      loop();
    } catch (e) {
      setErr(e instanceof Error && e.name === "NotAllowedError" ? "The microphone is blocked for this app. Allow it in the browser's site settings, then try again." : plainError(e));
    }
  };

  const stop = async (r: HumRecording | null = live.current) => {
    if (!r) return;
    if (tick.current) cancelAnimationFrame(tick.current);
    live.current = null;
    setRec(null);
    if (r.seconds() < 0.5) { r.cancel(); setErr("That was under half a second. Hold Record a little longer."); return; }
    const wav = await r.stop();
    const n = Number(bpm);
    await send({ wav, bpm: Number.isFinite(n) && n >= 30 && n <= 300 ? n : undefined, id: newTakeId() });
  };

  return (
    <div className="col hum">
      <div className="row wrap">
        <input className="mono" style={{ width: 90 }} inputMode="numeric" value={bpm} onChange={(e) => setBpm(e.target.value.replace(/[^\d]/g, ""))} placeholder="BPM" aria-label="Tempo (optional)" disabled={!!rec || busy} />
        {!rec ? (
          <button type="button" className="primary" disabled={busy || !engine.client} onClick={() => void start()}>
            {busy ? "Sending" : "Record"}
          </button>
        ) : (
          <button type="button" className="primary" onClick={() => void stop()}>Stop</button>
        )}
        {rec && <button type="button" className="ghost small" onClick={() => { if (tick.current) cancelAnimationFrame(tick.current); rec.cancel(); live.current = null; setRec(null); }}>Cancel</button>}
        {!rec && unsent && (
          <>
            <button type="button" disabled={busy || !engine.client} onClick={() => void send(unsent)}>Send again</button>
            <button type="button" className="ghost small" disabled={busy} onClick={() => { setUnsent(null); setErr(""); }}>Discard</button>
          </>
        )}
      </div>
      {rec && (
        <div className="row small" aria-live="polite">
          <span className="mono">{Math.floor(secs / 60)}:{String(Math.floor(secs % 60)).padStart(2, "0")}</span>
          <div className="meter" style={{ flex: 1, height: 6, background: "var(--line, #8883)", borderRadius: 3, overflow: "hidden" }} aria-hidden="true">
            <div style={{ width: `${Math.min(100, Math.round(level * 140))}%`, height: "100%", background: "var(--accent, #6af)" }} />
          </div>
        </div>
      )}
      <div className="muted small">
        Hum, sing, tap or beatbox, up to 2 minutes. The hub hears it as a melody and as a rhythm; choose Melody, Rhythm or Both afterwards.
      </div>
      {err && <div className="error small">{err}</div>}
    </div>
  );
}

/** One id per take, so the hub knows a take sent again. */
function newTakeId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? `web-${crypto.randomUUID()}` : `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A hummed idea: what was heard both ways, which of it to keep, drawn, playable, and its MIDI file. */
export function HumResult({ idea }: { idea: Entity }) {
  const f = idea.fields as MusicF;
  const m = f.midi as HumMidi;
  const [stopPlay, setStopPlay] = useState<(() => void) | null>(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => () => { stopPlay?.(); if (audioUrl) URL.revokeObjectURL(audioUrl); }, [stopPlay, audioUrl]);
  const client = engine.client;

  if (m.state === "listening") return <div className="card muted">Listening to the recording ({m.seconds ? `${Math.round(m.seconds)} s` : "a moment"}); the notes appear here when it is done.</div>;

  const layers = humLayers(m);
  const use = humUse(f.hum_use, layers);
  const melody = use === "rhythm" ? [] : layers.melody;
  const rhythm = use === "melody" ? [] : layers.rhythm;
  const shown = [...melody, ...rhythm];

  const play = () => {
    stopPlay?.();
    const stop = playParts([{ notes: melody, mode: "melody" }, { notes: rhythm, mode: "rhythm" }]);
    setStopPlay(() => stop);
    const end = Math.max(0, ...shown.map((n) => n.s + n.d)) * 1000 + 600;
    setTimeout(() => setStopPlay((cur) => (cur === stop ? null : cur)), end);
  };
  const download = async (grid: boolean) => {
    try { const r = await client!.musicMidi(idea.id, grid, use); saveBlob(r.blob, r.name); } catch (e) { setMsg(plainError(e)); }
  };
  const original = async () => {
    try { setAudioUrl(URL.createObjectURL(await client!.musicAudio(idea.id))); } catch (e) { setMsg(plainError(e)); }
  };
  const rehear = async (body: { bpm?: number }) => {
    try { await engine.absorb([await client!.rehearHum(idea.id, body)]); setMsg(""); } catch (e) { setMsg(plainError(e)); }
  };
  const keep = (u: HumUse) => { stopPlay?.(); setStopPlay(null); void updateEntity(idea, { hum_use: u }); };
  const has: Record<HumUse, boolean> = { melody: layers.melody.length > 0, rhythm: layers.rhythm.length > 0, both: layers.melody.length > 0 && layers.rhythm.length > 0 };
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

  return (
    <section className="card col">
      {m.state === "failed" ? (
        <div className="error small">{m.error ?? "It could not be heard."}</div>
      ) : (
        <>
          <div className="row wrap small">
            <div className="seg" role="radiogroup" aria-label="What to keep">
              {(["melody", "rhythm", "both"] as const).map((u) => (
                <button key={u} type="button" role="radio" aria-checked={use === u} className={use === u ? "on" : ""} disabled={!has[u]} title={has[u] ? undefined : `No ${u === "both" ? "melody or no rhythm" : u} was heard`} onClick={() => keep(u)}>
                  {u === "melody" ? "Melody" : u === "rhythm" ? "Rhythm" : "Both"}
                </button>
              ))}
            </div>
            <strong>{[melody.length ? count(melody.length, "note") : "", rhythm.length ? count(rhythm.length, "hit") : ""].filter(Boolean).join(", ")}</strong>
            {f.key && melody.length > 0 && <span className="mono">{f.key}</span>}
            {f.bpm && <span className="mono">{f.bpm} BPM</span>}
          </div>
          {melody.length > 0 && <PianoRoll notes={melody} lanes={false} end={Math.max(...shown.map((n) => n.s + n.d))} />}
          {rhythm.length > 0 && <PianoRoll notes={rhythm} lanes end={Math.max(...shown.map((n) => n.s + n.d))} />}
          <div className="row wrap">
            {stopPlay ? <button type="button" onClick={() => { stopPlay(); setStopPlay(null); }}>Stop</button> : <button type="button" className="primary" onClick={play}>Play</button>}
            <button type="button" onClick={() => void download(true)}>Download MIDI</button>
            <button type="button" className="ghost small" onClick={() => void download(false)}>MIDI as hummed</button>
          </div>
        </>
      )}
      <div className="row wrap small">
        {audioUrl ? <audio src={audioUrl} controls autoPlay style={{ height: 32 }} /> : <button type="button" className="ghost small" onClick={() => void original()}>Play the recording</button>}
        <RetempoButton bpm={f.bpm} onSet={(b) => void rehear({ bpm: b })} />
      </div>
      {msg && <div className="error small">{msg}</div>}
      <div className="muted small">The MIDI file opens in Cubase, Ableton or any DAW: drag it onto a track. With Both, the melody is on channel 1 and the drums on channel 10. Downloads snap to a 1/16 grid at the tempo; "as hummed" keeps your timing.</div>
    </section>
  );
}

function RetempoButton({ bpm, onSet }: { bpm?: number; onSet: (bpm: number) => void }) {
  const [v, setV] = useState("");
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); const n = Number(v); if (n >= 30 && n <= 300) { onSet(n); setV(""); } }}>
      <input className="mono" style={{ width: 80 }} inputMode="numeric" value={v} onChange={(e) => setV(e.target.value.replace(/[^\d]/g, ""))} placeholder={bpm ? String(bpm) : "BPM"} aria-label="Hear again at this tempo" />
      <button type="submit" className="ghost small" disabled={!v}>Set tempo</button>
    </form>
  );
}

/** Notes across time, pitch up the side, or a rhythm's three lanes (hat, snare, kick); `end` lines up two of them. */
function PianoRoll({ notes, lanes: drumLanes, end }: { notes: HumNote[]; lanes: boolean; end: number }) {
  if (!notes.length) return null;
  const lanes = drumLanes ? [42, 38, 36] : null;
  const lo = lanes ? 0 : Math.min(...notes.map((n) => n.p)) - 1;
  const hi = lanes ? 2 : Math.max(...notes.map((n) => n.p)) + 1;
  const rows = hi - lo + 1;
  const W = 640, H = lanes ? 60 : Math.max(80, Math.min(220, rows * 10));
  const y = (p: number) => (lanes ? Math.max(0, lanes.indexOf(p)) : hi - p) * (H / rows);
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${notes.length} ${lanes ? "hits" : "notes"} over ${end.toFixed(1)} seconds`} style={{ background: "var(--surface-2, #8881)", borderRadius: 6 }}>
      {!lanes && Array.from({ length: rows }, (_, i) => hi - i).filter((p) => p % 12 === 0).map((p) => (
        <g key={p}>
          <line x1={0} x2={W} y1={y(p) + H / rows} y2={y(p) + H / rows} stroke="currentColor" opacity={0.12} />
          <text x={2} y={y(p) + H / rows - 1} fontSize={9} fill="currentColor" opacity={0.5}>{names[p % 12]}{Math.floor(p / 12) - 1}</text>
        </g>
      ))}
      {lanes && ["Hat", "Snare", "Kick"].map((l, i) => <text key={l} x={2} y={(i + 0.7) * (H / rows)} fontSize={10} fill="currentColor" opacity={0.5}>{l}</text>)}
      {notes.map((n, i) => (
        <rect key={i} x={(n.s / end) * W} y={y(n.p) + 1} width={Math.max(3, (n.d / end) * W - 1)} height={Math.max(3, H / rows - 2)} rx={2} fill="var(--accent, #6af)" opacity={0.35 + 0.65 * (n.v / 127)} />
      ))}
    </svg>
  );
}
