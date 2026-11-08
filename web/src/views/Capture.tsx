import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Entity } from "@everythingapp/shared";
import { capture, type CaptureResult } from "../sync/actions";
import { hideCurrentWindow, isTauri } from "../tauri/bridge";
import { showKeyboardHints } from "../lib/keyboardHints";
import { fmtDateTime } from "../lib/time";
import { useDictation } from "../lib/useDictation";
import { useEntity } from "../sync/hooks";
import { HumRecorder } from "../components/Hum";
import { useModules } from "../lib/modules";
import { engine } from "../sync/engine";
import { DictationNotice } from "../components/DictationNotice";

function describe(e: Entity): string {
  const f = e.fields as Record<string, unknown>;
  switch (e.kind) {
    case "task":
      return f.remind_at ? `task: ${f.title}, reminds ${fmtDateTime(String(f.remind_at))}` : `task: ${f.title}`;
    case "note":
      return `note: ${f.title} (${f.path})`;
    case "log":
      return `log: ${f.type} ${f.value}`;
    case "fact":
      return `fact: ${f.key} = ${f.value}`;
    default:
      return e.kind;
  }
}

export function Capture({ mini = false }: { mini?: boolean }) {
  const [text, setText] = useState("");
  const { on } = useModules();
  const [humming, setHumming] = useState(false);
  const [hummed, setHummed] = useState<Entity | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CaptureResult | null>(null);
  // The saved capture as it changes: the assistant files it in the background and says what it did.
  const live = useEntity(result?.capture?.id);
  const filing = String((live ?? result?.capture)?.fields.filing ?? "");
  const [err, setErr] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  // Set when dictation added text, so the capture is tagged as voice.
  const [usedVoice, setUsedVoice] = useState(false);
  const dictation = useDictation((t) => {
    if (!t) return;
    setText((cur) => (cur.trim() ? `${cur.trimEnd()} ${t}` : t));
    setUsedVoice(true);
  }, isTauri);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // Every capture is sorted: written into the day's diary, then filed by the assistant. Nothing waits to be sorted by hand.
  const save = async () => {
    if (dictation.listening) dictation.stop();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setErr("");
    try {
      const r = await capture(t, usedVoice ? "voice" : undefined);
      setResult(r);
      setText("");
      setUsedVoice(false);
      ref.current?.focus();
      if (mini && isTauri) setTimeout(() => void hideCurrentWindow(), 900);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void save();
    }
    if (e.key === "Escape" && mini && isTauri) void hideCurrentWindow();
  };

  return (
    <div>
      {!mini && <h1>Capture</h1>}
      <textarea
        ref={ref}
        value={dictation.listening && dictation.interim ? `${text}${text ? " " : ""}${dictation.interim}` : text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder={dictation.listening ? "Listening. Tap Stop when you are done." : "Anything. It gets filed for you."}
        rows={mini ? 5 : 8}
        aria-label="Capture text"
        data-capture=""
      />
      <div className="actions">
        <button className="primary" onClick={() => save()} disabled={busy || !text.trim()}>
          Save
        </button>
        {dictation.supported && on("voice") && (
          <button type="button" className={dictation.listening ? "danger" : ""} onClick={dictation.toggle} aria-pressed={dictation.listening}>
            {dictation.listening ? "Stop" : "Talk"}
          </button>
        )}
        {on("music") && engine.client && (
          <button type="button" className={humming ? "on" : ""} aria-pressed={humming} onClick={() => { setHumming(!humming); setHummed(null); }}>
            Hum
          </button>
        )}
        {mini && isTauri && (
          <button className="ghost" onClick={() => hideCurrentWindow()}>
            Close
          </button>
        )}
        <span className="muted small">Save writes it in today's diary and the assistant files it: calendar, tasks and reminders, people, memory, logs, notes and ideas.{showKeyboardHints() ? " Ctrl+Enter saves." : ""}</span>
      </div>
      {humming && (
        <div className="card" style={{ marginTop: 12 }}>
          <HumRecorder fromCapture onDone={(idea) => { setHumming(false); setHummed(idea); }} />
        </div>
      )}
      {hummed && (
        <div className="card small" style={{ marginTop: 12 }}>
          {hummed.fields.midi && (hummed.fields.midi as { mode: string }).mode === "rhythm" ? "Tapped rhythm" : "Hummed melody"}: in <a href={`#/music/${hummed.id}`}>Music</a>. The notes and the MIDI file are there in a few seconds.
        </div>
      )}
      <DictationNotice d={dictation} />
      {(err || dictation.error) && <div className="error">{err || dictation.error}</div>}
      {result && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="small muted">
            Saved{result.offline ? " locally, will sync" : ""}
            {result.suggested_kind && result.suggested_kind !== "none" && !result.created.length ? `, looks like a ${result.suggested_kind}` : ""}
          </div>
          {filing === "pending" ? (
            <div>Saved to your diary. Filing it now.</div>
          ) : filing === "done" && live ? (
            <div>
              Filed: {String(live.fields.filed ?? "Diary only")}
              {typeof live.fields.thread === "string" && <> <a className="small" href={`#/assistant/${live.fields.thread}`} title="Open the chat that filed this, to correct it">Fix</a></>}
            </div>
          ) : filing === "failed" ? (
            <div>Saved to your diary. It will be filed when the assistant is back.</div>
          ) : result.created.length > 0 ? (
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              {result.created.map((c) => (
                <li key={c.id}>{describe(c)}</li>
              ))}
            </ul>
          ) : (
            <div>
              {result.offline ? "It is sorted when the hub is back." : <>In <a href="#/inbox">Unsorted Info</a>.</>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
