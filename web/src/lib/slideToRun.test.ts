import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SlideToRun } from "../components/SlideToRun";
import { SLIDE_RUN_AT, SLIDE_START, SLIDE_TEXTS, slideStep, type Slide, type SlideInput } from "./slideToRun";

/** Feeds the inputs in order and counts how many times the command would run. */
function play(inputs: SlideInput[], from: Slide = SLIDE_START): { s: Slide; runs: number; handled: boolean[] } {
  let s = from;
  let runs = 0;
  const handled: boolean[] = [];
  for (const i of inputs) {
    const r = slideStep(s, i);
    s = r.next;
    if (r.run) runs++;
    handled.push(r.handled);
  }
  return { s, runs, handled };
}

const TRAVEL = 72;
/** A drag with one pointer from y 500 up by `percent` of the travel, then let go. */
const drag = (percent: number, pointer = 1): SlideInput[] => [
  { type: "down", pointer, y: 500, travel: TRAVEL },
  { type: "move", pointer, y: 500 - (TRAVEL * percent) / 2 / 100 },
  { type: "move", pointer, y: 500 - (TRAVEL * percent) / 100 },
  { type: "up", pointer },
];
const keys = (...k: string[]): SlideInput[] => k.map((key) => ({ type: "key", key }));

describe("slide up to run", () => {
  it("does not run when let go below the line, and springs back to the bottom", () => {
    for (const p of [0, 10, 50, 80, SLIDE_RUN_AT - 1]) {
      const { s, runs } = play(drag(p));
      expect(runs, `${p}%`).toBe(0);
      expect(s).toEqual(SLIDE_START);
    }
  });

  it("follows the pointer while held, within the track", () => {
    const held = play(drag(60).slice(0, 3)).s;
    expect(held.value).toBeCloseTo(60);
    expect(held.drag).not.toBeNull();
    expect(play([{ type: "down", pointer: 1, y: 500, travel: TRAVEL }, { type: "move", pointer: 1, y: 100 }]).s.value).toBe(100);
    expect(play([{ type: "down", pointer: 1, y: 500, travel: TRAVEL }, { type: "move", pointer: 1, y: 900 }]).s.value).toBe(0);
  });

  it("runs once when let go past the line, and then stays at the top taking nothing more", () => {
    const first = play(drag(90));
    expect(first.runs).toBe(1);
    expect(first.s).toEqual({ value: 100, drag: null, done: true });
    // Another drag, the keys, a cancel: nothing moves and nothing runs again.
    const after = play([...drag(100, 2), ...keys("ArrowUp", "PageUp", "ArrowDown", "Home"), { type: "cancel", pointer: 2 }], first.s);
    expect(after.runs).toBe(0);
    expect(after.s).toEqual(first.s);
    // Pushed all the way to the top counts too.
    expect(play(drag(100)).runs).toBe(1);
  });

  it("does not run from a tap, a second finger or a drag the browser took over", () => {
    expect(play([{ type: "down", pointer: 1, y: 500, travel: TRAVEL }, { type: "up", pointer: 1 }]).runs).toBe(0);
    // A second finger neither starts a drag nor ends the first one.
    const two = play([
      { type: "down", pointer: 1, y: 500, travel: TRAVEL },
      { type: "down", pointer: 2, y: 300, travel: TRAVEL },
      { type: "move", pointer: 2, y: 200 },
      { type: "up", pointer: 2 },
    ]);
    expect(two.runs).toBe(0);
    expect(two.s.value).toBe(0);
    expect(two.s.drag?.pointer).toBe(1);
    // Past the line, then the browser cancels the touch (a scroll): back to the bottom.
    const taken = play([{ type: "down", pointer: 1, y: 500, travel: TRAVEL }, { type: "move", pointer: 1, y: 400 }, { type: "cancel", pointer: 1 }, { type: "up", pointer: 1 }]);
    expect(taken.runs).toBe(0);
    expect(taken.s).toEqual(SLIDE_START);
    // A knob that measured no room to move starts nothing.
    expect(play([{ type: "down", pointer: 1, y: 500, travel: 0 }, { type: "move", pointer: 1, y: 0 }, { type: "up", pointer: 1 }]).runs).toBe(0);
  });

  it("steps up by a quarter with Arrow Up or Page Up and runs on reaching the top", () => {
    const three = play(keys("ArrowUp", "PageUp", "ArrowUp"));
    expect(three.runs).toBe(0);
    expect(three.s.value).toBe(75);
    expect(three.handled).toEqual([true, true, true]);
    const four = play(keys("ArrowUp"), three.s);
    expect(four.runs).toBe(1);
    expect(four.s.done).toBe(true);
    expect(four.s.value).toBe(100);
    expect(play(keys("PageUp", "PageUp", "PageUp", "PageUp", "PageUp")).runs).toBe(1);
  });

  it("goes back down with Arrow Down, Page Down and Home", () => {
    expect(play(keys("ArrowUp", "ArrowUp", "ArrowDown")).s.value).toBe(25);
    expect(play(keys("ArrowUp", "ArrowUp", "PageDown")).s.value).toBe(25);
    expect(play(keys("ArrowUp", "ArrowUp", "ArrowUp", "Home")).s).toEqual(SLIDE_START);
    expect(play(keys("ArrowDown")).s.value).toBe(0);
    // From partway up after a drag, Arrow Up goes to the next quarter and Arrow Down to the one below.
    const partway: Slide = { value: 60, drag: null, done: false };
    expect(slideStep(partway, { type: "key", key: "ArrowUp" }).next.value).toBe(75);
    expect(slideStep(partway, { type: "key", key: "ArrowDown" }).next.value).toBe(50);
  });

  it("does nothing on Enter, Space or End, even with the knob most of the way up", () => {
    for (const from of [SLIDE_START, { value: 75, drag: null, done: false }]) {
      const r = play(keys("Enter", " ", "Spacebar", "End", "Escape"), from);
      expect(r.runs).toBe(0);
      expect(r.s).toEqual(from);
      expect(r.handled.every((h) => !h)).toBe(true);
    }
  });
});

describe("the slide control on the page", () => {
  const html = (props: Parameters<typeof SlideToRun>[0]) => renderToStaticMarkup(createElement(SlideToRun, props));

  it("is a focusable vertical slider from 0 to 100 at the bottom, with its words and a drawn thumbs up", () => {
    const h = html({ onRun: () => undefined });
    expect(h).toContain('role="slider"');
    expect(h).toContain('tabindex="0"');
    expect(h).toContain('aria-orientation="vertical"');
    expect(h).toContain('aria-valuemin="0"');
    expect(h).toContain('aria-valuemax="100"');
    expect(h).toContain('aria-valuenow="0"');
    expect(h).toContain(`aria-label="${SLIDE_TEXTS.aria}"`);
    expect(h).toContain("Slide up to run<");
    expect(h).toContain("Or type a reply to skip it.");
    expect(h).toContain("<svg");
    expect(h).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(h).not.toContain("<button");
  });

  it("while the command runs: knob at the top, out of the tab order, and the words say Running", () => {
    const h = html({ onRun: () => undefined, running: true });
    expect(h).toContain('aria-valuenow="100"');
    expect(h).toContain('aria-disabled="true"');
    expect(h).toContain('tabindex="-1"');
    expect(h).toContain("Running…");
    expect(h).not.toContain("Slide up to run<");
    expect(h).not.toContain(SLIDE_TEXTS.skip);
  });

  it("takes the danger color for a high risk command", () => {
    expect(html({ onRun: () => undefined, danger: true })).toContain('class="slide-run danger"');
    expect(html({ onRun: () => undefined })).toContain('class="slide-run"');
  });

  it("is the approval card's only control: no Run it, no Cancel, nothing that cancels on the hub", () => {
    const src = fs.readFileSync(path.join(__dirname, "../views/Assistant.tsx"), "utf8");
    const card = src.slice(src.indexOf("function ApprovalCard("), src.indexOf("export function Reply("));
    expect(card).toContain('<SlideToRun onRun={onRun} running={busy} danger={action.risk === "high"} />');
    expect(card).not.toContain("<button");
    expect(src).not.toContain("Run it<");
    expect(src).not.toContain("cancelAction");
    expect(src).not.toContain("onCancel");
  });

  it("keeps the knob's spring out of reduced motion, and the track's drag away from page scrolling", () => {
    const css = fs.readFileSync(path.join(__dirname, "../styles.css"), "utf8");
    expect(css).toContain("@media (prefers-reduced-motion: reduce) { .slide-run-knob, .slide-run-fill { transition: none; } }");
    expect(css).toMatch(/^\.slide-run-track \{[^}]*touch-action: none;/m);
    expect(css).toMatch(/^\.slide-run-knob \{[^}]*background: var\(--accent\); color: var\(--accent-text\);/m);
  });
});
