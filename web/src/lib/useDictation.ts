import { useEffect, useRef, useState } from "react";

type SpeechRec = { continuous: boolean; interimResults: boolean; lang: string; start(): void; stop(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null };

const ERRORS: Record<string, string> = {
  "not-allowed": "Microphone not allowed",
  "service-not-allowed": "Speech recognition is not available here",
  network: "Speech recognition is not available here",
  "audio-capture": "No microphone found",
};

/**
 * Which company's speech service the browser's speech recognition uses: the audio goes there to be turned into text.
 * Chrome and other Chromium browsers send it to Google, Edge and the Windows app (WebView2) to Microsoft, Safari to
 * Apple (which may do it on the device). Null when the browser cannot be told apart.
 */
export function dictationCompany(ua: string, inWindowsApp = false): string | null {
  if (inWindowsApp || /\bEdg(e|A|iOS)?\//.test(ua)) return "Microsoft";
  if (/\b(Chrome|CriOS|Chromium)\//.test(ua)) return "Google";
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return "Apple";
  return null;
}

/** The one-time notice before the first dictation in this browser, naming who hears the audio. */
export function dictationNotice(company: string | null): string {
  const who = company ? `${company}'s speech service` : "the speech service your browser uses";
  return `Talk uses your browser's speech recognition: while the mic is on, what you say goes to ${who} to be turned into text. EverythingApp keeps only the text you send. Use it?`;
}

const NOTICE_KEY = "ea.dictation.noticeAccepted";
const noticeAccepted = () => { try { return localStorage.getItem(NOTICE_KEY) === "yes"; } catch { return false; } };

/** Tap to start, tap to stop. Never sends by itself and never stops because you paused. Before the first use in a
 * browser it asks once (`notice`), naming the company whose service hears the audio. */
export function useDictation(onFinal: (text: string) => void, inWindowsApp = false) {
  const Ctor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  const rec = useRef<SpeechRec | null>(null);
  const wanted = useRef(false);
  const final = useRef(onFinal);
  final.current = onFinal;
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const acceptedHere = useRef(false);
  const start = () => {
    if (!Ctor || rec.current) return;
    if (!noticeAccepted() && !acceptedHere.current) { setNotice(dictationNotice(dictationCompany(navigator.userAgent, inWindowsApp))); return; }
    const r: SpeechRec = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || "en-US";
    r.onresult = (e: any) => {
      let live = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) final.current(res[0].transcript.trim());
        else live += res[0].transcript;
      }
      setInterim(live);
    };
    // Browsers end recognition after silence; restart until the person taps stop.
    r.onend = () => { if (wanted.current) { try { r.start(); } catch { /* already running */ } } else { rec.current = null; setListening(false); setInterim(""); } };
    // A refusal or a missing service would restart forever; stop and say why.
    r.onerror = (e: any) => { const msg = ERRORS[e?.error]; if (msg) { wanted.current = false; setError(msg); } };
    rec.current = r;
    wanted.current = true;
    setError("");
    r.start();
    setListening(true);
  };
  const stop = () => { wanted.current = false; rec.current?.stop(); };
  useEffect(() => () => { wanted.current = false; rec.current?.stop(); }, []);
  const accept = () => { acceptedHere.current = true; try { localStorage.setItem(NOTICE_KEY, "yes"); } catch { /* private window: asks again next time */ } setNotice(null); start(); };
  const decline = () => setNotice(null);
  return { supported: !!Ctor, listening, interim, error, start, stop, notice, accept, decline, toggle: () => (wanted.current ? stop() : start()) };
}
