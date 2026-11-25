import { useEffect, useRef, useState, type CSSProperties } from "react";
import { SLIDE_START, SLIDE_TEXTS, slideStep, type Slide, type SlideInput } from "../lib/slideToRun";

/** A thumbs up on the 24 by 24 grid the app's other line drawings use (ScreenIcon), in the color of the knob's words. */
export function ThumbsUpIcon() {
  return (
    <svg className="slide-run-icon" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="10" width="4" height="10.5" rx="1" />
      <path d="M7.5 10.5l3.2-6.4a1.7 1.7 0 0 1 3.2 1.1L13.2 9.5h5.3a2 2 0 0 1 2 2.3l-1.1 6.9a2 2 0 0 1-2 1.8H7.5" />
    </svg>
  );
}

/** How far the knob can move: the track's height less the knob and the same gap above it as below. */
function travelOf(track: HTMLElement | null, knob: HTMLElement | null): number {
  if (!track || !knob) return 0;
  const gap = track.clientHeight - knob.offsetTop - knob.offsetHeight;
  return track.clientHeight - knob.offsetHeight - 2 * gap;
}

/**
 * Slide up to run (lib/slideToRun.ts has the rules): a vertical track with a thumbs-up knob at the bottom. Dragging the
 * knob up (mouse, touch or pen) and letting go near the top calls `onRun` once; the knob then stays at the top and the
 * words say Running. `running` is the chat's own busy state. If `onRun` settles while the card is still showing (the
 * hub could not be reached), the knob goes back down so it can be tried again.
 */
export function SlideToRun({ onRun, running = false, danger = false }: { onRun: () => void | Promise<unknown>; running?: boolean; danger?: boolean }) {
  const [s, setS] = useState<Slide>(SLIDE_START);
  // Pointer events come faster than React draws: each step starts from the last one, not from the last drawing.
  const live = useRef<Slide>(SLIDE_START);
  const mounted = useRef(true);
  const track = useRef<HTMLDivElement | null>(null);
  const knob = useRef<HTMLDivElement | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const set = (next: Slide) => { live.current = next; setS(next); };
  const feed = (input: SlideInput): boolean => {
    const r = slideStep(live.current, input);
    if (r.next !== live.current) set(r.next);
    if (r.run) {
      const p = onRun();
      if (p && typeof (p as Promise<unknown>).then === "function") {
        void (p as Promise<unknown>).then(
          () => { if (mounted.current) set(SLIDE_START); },
          () => { if (mounted.current) set(SLIDE_START); },
        );
      }
    }
    return r.handled;
  };

  const locked = s.done || running;
  const value = locked ? 100 : Math.round(s.value);
  return (
    <div className={`slide-run${danger ? " danger" : ""}${locked ? " done" : ""}${s.drag ? " dragging" : ""}`}>
      <div className="slide-run-words">
        <div className="slide-run-label" role="status">{locked ? SLIDE_TEXTS.running : SLIDE_TEXTS.label}</div>
        {!locked && <div className="small muted">{SLIDE_TEXTS.skip}</div>}
      </div>
      <div className="slide-run-track" ref={track} style={{ "--slide": value / 100 } as CSSProperties}>
        <div className="slide-run-fill" aria-hidden="true" />
        {/* Which way to slide, as on the Apple apps; it fades as the knob rises. */}
        <svg className="slide-run-chevron" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 14l6-6 6 6" />
        </svg>
        <div
          ref={knob}
          className="slide-run-knob"
          role="slider"
          tabIndex={locked ? -1 : 0}
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={value}
          aria-label={SLIDE_TEXTS.aria}
          aria-disabled={locked || undefined}
          onPointerDown={(e) => {
            if (locked || (e.pointerType === "mouse" && e.button !== 0)) return;
            // No text selection and no focus ring from a press; the drag is followed even off the knob.
            e.preventDefault();
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
            feed({ type: "down", pointer: e.pointerId, y: e.clientY, travel: travelOf(track.current, knob.current) });
          }}
          onPointerMove={(e) => { if (live.current.drag) feed({ type: "move", pointer: e.pointerId, y: e.clientY }); }}
          onPointerUp={(e) => { feed({ type: "up", pointer: e.pointerId }); }}
          onPointerCancel={(e) => { feed({ type: "cancel", pointer: e.pointerId }); }}
          onLostPointerCapture={(e) => { feed({ type: "cancel", pointer: e.pointerId }); }}
          onKeyDown={(e) => {
            if (locked || e.altKey || e.ctrlKey || e.metaKey) return;
            if (feed({ type: "key", key: e.key })) e.preventDefault();
          }}
        >
          <ThumbsUpIcon />
        </div>
      </div>
    </div>
  );
}
