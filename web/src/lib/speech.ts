import { useEffect, useState } from "react";

/**
 * A reply as it should sound: markdown marks, link targets and bare URLs dropped, code blocks named rather than
 * spelled out, and the pre-flight markers removed. Inline code keeps its words.
 */
export function speakableText(md: string): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, " (code block) ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/^\s*(?:-{3,}|\|.*\|)\s*$/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export const speechSupported = typeof window !== "undefined" && "speechSynthesis" in window;

const KEY = "ea.speakVoiceReplies";

/** Whether a reply to a dictated message is read out on its own. On unless turned off on this device. */
export function speakVoiceReplies(): boolean {
  try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
}
export function setSpeakVoiceReplies(on: boolean) {
  try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* private window */ }
}

/**
 * The voice replies are read with: one that runs on this device (`localService`), in the page's language when there is
 * one. Online voices send the text to the browser's company (Google, Microsoft), so they are never picked; with no
 * local voice nothing is read aloud.
 */
export function pickLocalVoice(voices: Pick<SpeechSynthesisVoice, "localService" | "lang" | "default">[], lang: string): number {
  const base = lang.toLowerCase().split("-")[0];
  const local = voices.map((v, i) => ({ v, i })).filter(({ v }) => v.localService);
  const exact = local.find(({ v }) => v.lang.toLowerCase() === lang.toLowerCase());
  const same = local.find(({ v }) => v.lang.toLowerCase().split(/[-_]/)[0] === base);
  const def = local.find(({ v }) => v.default);
  return (exact ?? same ?? def ?? local[0])?.i ?? -1;
}

function voices(): Promise<SpeechSynthesisVoice[]> {
  const now = window.speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  // Some browsers load the list a moment after the page.
  return new Promise((resolve) => {
    const done = () => resolve(window.speechSynthesis.getVoices());
    window.speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1500);
  });
}

/** Whether this browser has a voice that reads aloud on the device. */
export async function localVoiceAvailable(): Promise<boolean> {
  if (!speechSupported) return false;
  return pickLocalVoice(await voices(), navigator.language || "en-US") >= 0;
}

/** Said in place of reading aloud when the device has no voice of its own. */
export const NO_LOCAL_VOICE = "This browser has no voice that works on the device, so answers are not read aloud (the others send the text to Google or Microsoft).";

let current: string | null = null;
const listeners = new Set<(k: string | null) => void>();
const announce = (k: string | null) => { current = k; listeners.forEach((l) => l(k)); };

/** Reads `text` aloud, stopping whatever was being read. `key` names what is playing, for its Stop button. */
export function speak(key: string, text: string) {
  if (!speechSupported) return;
  const said = speakableText(text);
  window.speechSynthesis.cancel();
  if (!said) { announce(null); return; }
  announce(key);
  void voices().then((list) => {
    if (current !== key) return;
    const lang = navigator.language || "en-US";
    const i = pickLocalVoice(list, lang);
    if (i < 0) { announce(null); return; }
    const u = new SpeechSynthesisUtterance(said);
    u.voice = list[i];
    u.lang = list[i].lang || lang;
    u.onend = u.onerror = () => { if (current === key) announce(null); };
    window.speechSynthesis.speak(u);
  });
}

export function stopSpeaking() {
  if (speechSupported) window.speechSynthesis.cancel();
  announce(null);
}

/** The key being read aloud right now, or null. */
export function useSpeaking(): string | null {
  const [k, setK] = useState<string | null>(current);
  useEffect(() => { listeners.add(setK); return () => { listeners.delete(setK); }; }, []);
  return k;
}
