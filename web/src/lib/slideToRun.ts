/**
 * Slide up to run (since 2026-11-24): how the assistant's approval card asks before a command runs. A knob with a
 * thumbs up starts at the bottom of a short track; dragging it up past most of the way and letting go runs the
 * command, anything less springs back. There is no Cancel: typing any other reply skips the command (the hub sets it
 * aside). A tap, a click, Enter or Space never runs it, so it cannot happen by accident.
 *
 * This file is the control's whole behavior as plain steps (components/SlideToRun.tsx draws it and feeds it pointer
 * and key events), so it is tested without a page.
 */

export const SLIDE_TEXTS = {
  label: "Slide up to run",
  running: "Running…",
  skip: "Or type a reply to skip it.",
  aria: "Slide up to run this command",
} as const;

/** How far up a release must be, in percent of the travel, to run the command. */
export const SLIDE_RUN_AT = 85;
/** How far one Arrow Up or Page Up moves the knob, in percent. */
export const SLIDE_STEP = 25;

/** Where the knob is (0 at the bottom, 100 at the top), the drag under way, and whether it has run. */
export interface Slide {
  value: number;
  drag: { pointer: number; y: number; from: number; travel: number } | null;
  done: boolean;
}

export const SLIDE_START: Slide = { value: 0, drag: null, done: false };

/** What the page saw: `y` is the pointer's height on screen in pixels, `travel` how far the knob can move in pixels. */
export type SlideInput =
  | { type: "down"; pointer: number; y: number; travel: number }
  | { type: "move"; pointer: number; y: number }
  | { type: "up"; pointer: number }
  | { type: "cancel"; pointer: number }
  | { type: "key"; key: string };

export interface SlideResult {
  next: Slide;
  /** True for the one step that runs the command; never again after it. */
  run: boolean;
  /** A key the control used, so the page should not also act on it (scroll, for one). */
  handled: boolean;
}

const clamp = (v: number) => Math.min(100, Math.max(0, v));
const same = (s: Slide): SlideResult => ({ next: s, run: false, handled: false });
const ran = (): SlideResult => ({ next: { value: 100, drag: null, done: true }, run: true, handled: true });

/** One step of the control. */
export function slideStep(s: Slide, input: SlideInput): SlideResult {
  // Once it has run it stays at the top and takes nothing more.
  if (s.done) return same(s);
  switch (input.type) {
    case "down":
      // A second finger, or a knob that cannot move, starts nothing.
      if (s.drag || !(input.travel > 0)) return same(s);
      return { next: { ...s, drag: { pointer: input.pointer, y: input.y, from: s.value, travel: input.travel } }, run: false, handled: false };
    case "move": {
      const d = s.drag;
      if (!d || d.pointer !== input.pointer) return same(s);
      // Up the screen is a smaller y.
      return { next: { ...s, value: clamp(d.from + ((d.y - input.y) / d.travel) * 100) }, run: false, handled: false };
    }
    case "up":
      if (!s.drag || s.drag.pointer !== input.pointer) return same(s);
      return s.value >= SLIDE_RUN_AT ? ran() : { next: SLIDE_START, run: false, handled: false };
    case "cancel":
      // The browser took the touch over (a scroll, a call coming in): back to the bottom, nothing runs.
      if (!s.drag || s.drag.pointer !== input.pointer) return same(s);
      return { next: SLIDE_START, run: false, handled: false };
    case "key": {
      if (s.drag) return same(s);
      if (input.key === "ArrowUp" || input.key === "PageUp") {
        const value = Math.min(100, Math.floor(s.value / SLIDE_STEP) * SLIDE_STEP + SLIDE_STEP);
        return value >= 100 ? ran() : { next: { ...s, value }, run: false, handled: true };
      }
      if (input.key === "ArrowDown" || input.key === "PageDown") {
        return { next: { ...s, value: Math.max(0, Math.ceil(s.value / SLIDE_STEP) * SLIDE_STEP - SLIDE_STEP) }, run: false, handled: true };
      }
      if (input.key === "Home") return { next: SLIDE_START, run: false, handled: true };
      // Enter, Space, End and the rest do nothing: one key press never runs a command.
      return same(s);
    }
  }
}
