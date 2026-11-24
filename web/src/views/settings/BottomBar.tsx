import { useEffect, useRef, useState } from "react";
import {
  BAR_COUNTS, BAR_LIBRARY, DEFAULT_BAR, barCanEmpty, barCanPick, barCountChange, barEmpty, barPick, barWhere, barWithLibrary,
  defaultBar, sameBar, type Bar, type BarCount, type BarRow,
} from "@everythingapp/shared";
import { SCREEN_LABELS, useAreas, useBar } from "../../components/Shell";
import { ScreenIcon } from "../../components/ScreenIcon";
import { updateFeel } from "../../feel/store";
import { screenId } from "../../lib/bar";
import { Segmented, SubPage } from "./common";

/**
 * What Theme, Bottom bar says, the same words as the Apple apps' page (EACore `BarText`; web/src/lib/bar.test.ts
 * keeps the two the same).
 */
export const BAR_TEXT = {
  intro: "The bar along the bottom of the screen on a phone. Choose how many screens it shows across and which ones. Drag up on the bar to reach the second row.",
  where: "iPad, Mac and wide windows keep the sidebar, which this does not change.",
  across: "Screens across",
  acrossNote: "Fewer across means larger icons and names with more room. Going down to fewer leaves out the last screens of each row.",
  preview: "Preview",
  first: "First row",
  second: "Second row",
  tap: "Choose a place, then the screen for it.",
  secondNote: "With nothing in the second row, the bar has no grabber and nothing to drag up.",
  swap: "Choosing a screen that already has a place swaps the two.",
  library: "Library always has a place, since every other screen and Settings are reached from it. Here it can only swap with a screen that has a place.",
  main: "Main",
  empty: "Empty this place",
  free: "Empty",
  off: "off",
  here: "Here",
  cancel: "Cancel",
  reset: "Reset",
  resetAsk: "Put the bottom bar back to Today, Assistant, Capture, Library and Search, with Tasks, Week, Notes, Memory and People in the second row?",
  more: "More screens",
} as const;

/** The line under Bottom bar in Theme. */
export function barSummary(bar: Bar): string {
  const more = barWithLibrary(bar).second.length;
  return `${bar.count} across, ${more ? `${more} in the second row` : "no second row"}`;
}

const ROW_NAME: Record<BarRow, string> = { first: BAR_TEXT.first, second: BAR_TEXT.second };
/** The first group of the list to choose from: the screens the Library does not list, and Library. */
const MAIN_GROUP = ["today", "assistant", "capture", BAR_LIBRARY, "search"];

/**
 * Theme, Bottom bar: how many screens the phone's bar shows across (3, 4 or 5), a picture of both rows, and a place
 * chosen to pick its screen from the screens that are on. Saved to the feel setting at once, so every device follows.
 */
export function BottomBarPage() {
  const { bar: saved, available, label } = useBar();
  const areas = useAreas();
  // A setting that leaves Library out is drawn with it in the last place of the first row: edit the bar as it is drawn.
  const bar = barWithLibrary(saved);
  const [sel, setSel] = useState<{ row: BarRow; index: number } | null>(null);
  /** The bar before this run of count changes, so going back to more across brings back what fewer cut. */
  const [before, setBefore] = useState<Bar | null>(null);
  const chooser = useRef<HTMLHeadingElement>(null);
  const back = useRef<string | null>(null);

  useEffect(() => {
    if (sel && sel.index >= bar.count) setSel(null);
  }, [sel, bar.count]);
  // Opening the list moves to it, and a choice moves back to the place it was for (the keyboard and a screen reader follow).
  useEffect(() => {
    if (sel) {
      chooser.current?.focus({ preventScroll: true });
      chooser.current?.scrollIntoView({ block: "nearest" });
    } else if (back.current) {
      document.querySelector<HTMLElement>(`[data-place="${back.current}"]`)?.focus();
      back.current = null;
    }
  }, [sel]);

  const edit = (next: Bar) => {
    setBefore(null);
    updateFeel({ bar: next });
  };
  const done = (next: Bar | null) => {
    if (sel) back.current = `${sel.row}-${sel.index}`;
    if (next) edit(next);
    setSel(null);
  };
  const across = (n: BarCount) => {
    if (!before) setBefore(bar);
    updateFeel({ bar: barCountChange(bar, n, before) });
  };
  const groups = [
    { title: BAR_TEXT.main, ids: MAIN_GROUP },
    ...areas.map((a) => ({ title: a.title, ids: a.items.map((i) => screenId(i.path)) })),
    { title: "System", ids: ["status"] },
  ];
  const whereNow = (id: string): string => {
    const w = barWhere(bar, id);
    if (!w) return "";
    return sel && w.row === sel.row && w.index === sel.index ? BAR_TEXT.here : ROW_NAME[w.row];
  };

  const row = (r: BarRow) => (
    <div className="bar-edit-row" role="group" aria-label={ROW_NAME[r]}>
      {Array.from({ length: bar.count }, (_, i) => {
        const id = bar[r][i] ?? null;
        const on = id !== null && (id === BAR_LIBRARY || available.has(id));
        const name = id === null ? BAR_TEXT.free : SCREEN_LABELS[id] ? label(id) : id;
        const picked = sel?.row === r && sel.index === i;
        return (
          <button
            key={i}
            type="button"
            data-place={`${r}-${i}`}
            className={`bar-place${picked ? " sel" : ""}${id === null ? " free" : ""}${id !== null && !on ? " off" : ""}`}
            aria-pressed={picked}
            aria-label={`${ROW_NAME[r]}, place ${i + 1}: ${name}${id !== null && !on ? `, ${BAR_TEXT.off}` : ""}`}
            onClick={() => setSel(picked ? null : { row: r, index: i })}
          >
            {id === null ? <span className="bar-plus" aria-hidden="true">+</span> : <ScreenIcon id={id} />}
            <span className="tab-name">{name}{id !== null && !on ? ` (${BAR_TEXT.off})` : ""}</span>
          </button>
        );
      })}
    </div>
  );

  const there = sel ? (bar[sel.row][sel.index] ?? null) : null;

  return (
    <SubPage path="/settings/theme/bar">
      <div className="muted small">{BAR_TEXT.intro} {BAR_TEXT.where}</div>
      <section className="col">
        <h2 className="settings-h">{BAR_TEXT.across}</h2>
        <Segmented
          label={BAR_TEXT.across}
          value={String(bar.count)}
          options={BAR_COUNTS.map((n) => ({ value: String(n), label: String(n) }))}
          onChange={(v) => across(Number(v) as BarCount)}
        />
        <div className="muted small">{BAR_TEXT.acrossNote}</div>
      </section>
      <section className="col">
        <h2 className="settings-h">{BAR_TEXT.preview}</h2>
        <div className={`bar-edit count-${bar.count}`}>
          <span className="tabs-grab-pill" aria-hidden="true" />
          <div className="bar-edit-name" aria-hidden="true">{BAR_TEXT.second}</div>
          {row("second")}
          <div className="bar-edit-name" aria-hidden="true">{BAR_TEXT.first}</div>
          {row("first")}
        </div>
        <div className="muted small">{BAR_TEXT.tap} {BAR_TEXT.secondNote}</div>
      </section>
      {sel && (
        <section className="col bar-chooser" aria-labelledby="bar-chooser-h">
          <div className="row between">
            <h2 id="bar-chooser-h" ref={chooser} tabIndex={-1}>{ROW_NAME[sel.row]}, place {sel.index + 1}</h2>
            <button type="button" className="small" onClick={() => done(null)}>{BAR_TEXT.cancel}</button>
          </div>
          <div className="muted small">{there === BAR_LIBRARY ? BAR_TEXT.library : BAR_TEXT.swap}</div>
          {barCanEmpty(bar, sel.row, sel.index) && (
            <button type="button" className="bar-empty" onClick={() => done(barEmpty(bar, sel.index))}>{BAR_TEXT.empty}</button>
          )}
          {groups.map((g) => (
            <div key={g.title} className="col">
              <h3 className="settings-h">{g.title}</h3>
              <div className="list">
                {g.ids.map((id) => {
                  const now = whereNow(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`item bar-choice${id === there ? " on" : ""}`}
                      aria-pressed={id === there}
                      disabled={!barCanPick(bar, sel.row, sel.index, id)}
                      onClick={() => done(barPick(bar, sel.row, sel.index, id))}
                    >
                      <ScreenIcon id={id} />
                      <span className="body"><span className="t">{label(id)}</span></span>
                      {now && <span className="meta">{now}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </section>
      )}
      <div className="row">
        <button
          type="button"
          disabled={sameBar(saved, DEFAULT_BAR)}
          onClick={() => {
            if (!confirm(BAR_TEXT.resetAsk)) return;
            setSel(null);
            edit(defaultBar());
          }}
        >
          {BAR_TEXT.reset}
        </button>
      </div>
    </SubPage>
  );
}
