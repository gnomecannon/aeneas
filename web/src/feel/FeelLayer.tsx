import { useEffect, useRef } from "react";
import { engine } from "../sync/engine";
import { onCelebrate, type Celebration } from "./events";
import { ShapeLayer, type BurstStyle } from "./shapes";
import { activeVoices, audioClock, bendNote, inspectVoice, filterNote, playNote, releaseAll, releaseNote, setVolume, sounding, startNote, synthStats, unlockAudio, type NoteHandle } from "./synth";
import { bendSteps, degreeNote, filterDrive, filterHz, randomNote, scaleNotes, stepInScale, themeColors, type Key, type Scale } from "./theory";
import { enabledBitmaps, preloadImages } from "./images";
import { getFeel, refreshFeel, soundHere, subscribeFeel } from "./store";
import type { FeelView } from "./prefs";

/**
 * Shapes and notes for taps and celebrations. Mounted once; draws on a canvas over everything that never takes a click.
 *
 * A press starts a note and a burst. With `hold` the note lasts until the press ends; with `drag_bend` moving up and
 * down steps it through the scale and moving left and right sweeps its filter, leaving small shapes along the way.
 * Mouse and pen are followed with pointer events. Touch is followed with touch events, because the browser cancels the
 * pointer as soon as a scroll starts and the bend has to keep working while the page scrolls. Nothing here calls
 * preventDefault, so clicks, scrolling and text selection behave as they always have.
 */

let layer: ShapeLayer | null = null;
let lastNote: number | null = null;
let lastPos: { x: number; y: number } | null = null;

interface Gesture {
  id: number;
  x0: number;
  y0: number;
  /** Where the last trail shape was left, and how far the press has moved since. */
  tx: number;
  ty: number;
  note: NoteHandle | null;
  midi: number;
  key: Key;
  scale: Scale;
  step: number;
  bend: boolean;
  /** Set once the press moves sideways enough to start working the filter. */
  filtered: boolean;
}

let gesture: Gesture | null = null;
const TRAIL_PX = 40;

export function motionOn(f: FeelView): boolean {
  // The Shapes switch alone decides: Windows' web view reports reduced motion even with animations on.
  return f.motion;
}

function accent(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--accent");
}

/** The current burst look: palette colors, enabled shapes and images, size and amount. */
export function burstStyle(f: FeelView, colors?: string[]): BurstStyle {
  return {
    colors: colors ?? themeColors(f.theme, f.palettes, accent()),
    shapes: f.shapes,
    images: enabledBitmaps(f.images),
    size: f.shape_size,
    density: f.density,
  };
}

function where(): { x: number; y: number } {
  return lastPos ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

/** Degrees 0, 2 and 4: rising 70 ms apart, or together as a chord. */
function triad(f: FeelView, together: boolean) {
  if (!soundHere(f) || !unlockAudio()) return;
  const { key, scale } = f.effective;
  [0, 2, 4].forEach((d, i) => playNote(degreeNote(key, scale, f.octave, d), f.synth, together ? 0 : i * 0.07, together ? 0.7 : 1));
}

/** Play a celebration now: notes and shapes, each only when turned on. */
export function playCelebration(c: Celebration): void {
  const f = getFeel();
  triad(f, c === "complete");
  if (!layer || !motionOn(f)) return;
  const p = where();
  if (c === "create") layer.create(p.x, p.y, burstStyle(f));
  else layer.complete(p.x, p.y, burstStyle(f));
}

/** A short rising phrase in the current synth and scale, for Settings. */
export function previewFeel(): void {
  triad(getFeel(), false);
}

/** A press began: a note (held when `hold` is on) and a burst. `forceSound` plays even with notes off (the Try it pad). */
function begin(id: number, x: number, y: number, forceSound: boolean) {
  end(null);
  lastPos = { x, y };
  const f = getFeel();
  let note: NoteHandle | null = null;
  let midi = 0;
  if ((soundHere(f) || forceSound) && unlockAudio()) {
    midi = randomNote(scaleNotes(f.effective.key, f.effective.scale, f.octave), lastNote);
    lastNote = midi;
    note = startNote(midi, f.synth, { hold: f.hold, bend: f.drag_bend });
  }
  gesture = { id, x0: x, y0: y, tx: x, ty: y, note, midi, key: f.effective.key, scale: f.effective.scale, step: 0, bend: f.drag_bend, filtered: false };
  if (layer && motionOn(f)) layer.tap(x, y, burstStyle(f));
}

/** The press moved: bend and filter the note when `drag_bend` is on, with a trail of small shapes. */
function move(id: number, x: number, y: number) {
  const g = gesture;
  if (!g || g.id !== id || !g.bend || !sounding(g.note)) return;
  const step = bendSteps(y - g.y0);
  if (step !== g.step) {
    g.step = step;
    bendNote(g.note, stepInScale(g.key, g.scale, g.midi, step));
  }
  // The filter waits for a real sideways move, so a straight drag up or down keeps the plain sound.
  if (Math.abs(x - g.x0) > 6 || g.filtered) {
    g.filtered = true;
    filterNote(g.note, filterHz(x - g.x0), filterDrive(x - g.x0));
  }
  if (Math.hypot(x - g.tx, y - g.ty) >= TRAIL_PX) {
    g.tx = x;
    g.ty = y;
    lastPos = { x, y };
    const f = getFeel();
    if (layer && motionOn(f)) layer.trail(x, y, burstStyle(f));
  }
}

/** The press ended (or was cancelled): let the note go. `null` ends whatever press is under way. */
function end(id: number | null) {
  const g = gesture;
  if (!g || (id !== null && g.id !== id)) return;
  gesture = null;
  releaseNote(g.note);
}

function isTryPad(t: EventTarget | null): boolean {
  return t instanceof Element && !!t.closest("[data-feel-try]");
}

const hasTouch = typeof window !== "undefined" && "ontouchstart" in window;

export function FeelLayer() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const shapes = new ShapeLayer(ref.current);
    layer = shapes;
    setVolume(getFeel().volume);
    preloadImages(getFeel().images);

    // Touch goes through the touch events below, unless this browser has none.
    const viaPointer = (e: PointerEvent) => e.pointerType !== "touch" || !hasTouch;
    const onDown = (e: PointerEvent) => {
      if (!e.isPrimary || !viaPointer(e)) return;
      begin(e.pointerId, e.clientX, e.clientY, isTryPad(e.target));
    };
    const onMove = (e: PointerEvent) => {
      if (viaPointer(e)) move(e.pointerId, e.clientX, e.clientY);
    };
    const onUp = (e: PointerEvent) => {
      if (viaPointer(e)) end(e.pointerId);
    };
    const onTouchStart = (e: TouchEvent) => {
      // A second finger joins the press under way instead of starting another note.
      const g = gesture;
      if (g && Array.from(e.touches).some((t) => t.identifier === g.id)) return;
      const t = e.changedTouches[0];
      if (t) begin(t.identifier, t.clientX, t.clientY, isTryPad(e.target));
    };
    const onTouchMove = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) move(t.identifier, t.clientX, t.clientY);
    };
    const onTouchEnd = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) end(t.identifier);
    };
    const stopAll = () => {
      end(null);
      releaseAll();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshFeel();
      else stopAll();
    };
    // The hub client appears after boot and changes when Settings saves a new hub: fetch once for each.
    let client = engine.client;
    const onEngine = () => {
      if (engine.client && engine.client !== client) void refreshFeel();
      client = engine.client;
    };

    const capture = { capture: true, passive: true } as const;
    document.addEventListener("pointerdown", onDown, capture);
    document.addEventListener("pointermove", onMove, capture);
    document.addEventListener("pointerup", onUp, capture);
    document.addEventListener("pointercancel", onUp, capture);
    document.addEventListener("touchstart", onTouchStart, capture);
    document.addEventListener("touchmove", onTouchMove, capture);
    document.addEventListener("touchend", onTouchEnd, capture);
    document.addEventListener("touchcancel", onTouchEnd, capture);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("blur", stopAll);
    const offEngine = engine.subscribe(onEngine);
    const offFeel = subscribeFeel(() => {
      const f = getFeel();
      setVolume(f.volume);
      preloadImages(f.images);
    });
    const offCelebrate = onCelebrate(playCelebration);
    if (import.meta.env.DEV) (window as unknown as { __feel?: unknown }).__feel = { synthStats, activeVoices, audioClock, gesture: () => gesture, voice: () => inspectVoice(gesture?.note ?? null) };
    void refreshFeel();
    return () => {
      document.removeEventListener("pointerdown", onDown, capture);
      document.removeEventListener("pointermove", onMove, capture);
      document.removeEventListener("pointerup", onUp, capture);
      document.removeEventListener("pointercancel", onUp, capture);
      document.removeEventListener("touchstart", onTouchStart, capture);
      document.removeEventListener("touchmove", onTouchMove, capture);
      document.removeEventListener("touchend", onTouchEnd, capture);
      document.removeEventListener("touchcancel", onTouchEnd, capture);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("blur", stopAll);
      offEngine();
      offFeel();
      offCelebrate();
      stopAll();
      shapes.stop();
      if (layer === shapes) layer = null;
    };
  }, []);

  return <canvas ref={ref} className="feel-layer" aria-hidden="true" />;
}
