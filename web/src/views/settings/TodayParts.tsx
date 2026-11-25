import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  TODAY_CARDS, TODAY_PARTS, TODAY_TOP, defaultToday, isDefaultToday, todayCardOrder, todayMove, todayWithOrder, todayWithShown,
  type TodayCard, type TodayPart, type TodaySetting,
} from "@everythingapp/shared";
import { updateFeel, useFeel } from "../../feel/store";
import { SubPage } from "./common";

/**
 * What Theme, Today says, and Today's own lines about it: the same words as the Apple apps' (EACore `TodayText`;
 * web/src/lib/todayParts.test.ts keeps the two the same).
 */
export const TODAY_TEXT = {
  intro: "Choose which parts Today shows and in what order. Every device follows.",
  top: "At the top",
  topNote: "This line stays at the top of Today. It can only be shown or hidden.",
  cards: "Cards",
  drag: "Drag a card by its handle to move it.",
  wide: "On a wide window the cards fill the columns in this order. Tech sits at the top of the card after it.",
  moveUp: "Move up",
  moveDown: "Move down",
  reset: "Reset",
  resetAsk: "Put Today back to every part shown, in the usual order?",
  edit: "Edit Today",
  none: "No cards are shown.",
  usual: "Usual order",
  yours: "Your order",
  allShown: "all shown",
} as const;

/** Each part's name and the line under it saying what it holds; the same words as EACore `TodayText.parts`. */
export const TODAY_PART_TEXT: Record<TodayPart, { name: string; holds: string }> = {
  now: { name: "Now and free time", holds: "What is on now or next, and your free time." },
  tech: { name: "Tech", holds: "One line with the light for your machines, checks and readings. It shows only while something is watched." },
  needs: { name: "Needs you", holds: "Reminders that have come due, renewals, follow-ups, medicine not logged, and captures that could not be filed." },
  schedule: { name: "Schedule", holds: "Today's plans in time order, free time to schedule, and the people in them." },
  todo: { name: "To do", holds: "The task you are doing or the next one, then your other open tasks." },
  sofar: { name: "Today so far", holds: "Today's numbers, the diary's lines, finished tasks and logs." },
  coming: { name: "Coming up", holds: "Tomorrow's plans, and birthdays and other dates in the next two weeks." },
};

/** The line under Today in Theme: "Usual order, all shown", "Your order, 2 hidden". */
export function todaySummary(s: TodaySetting): string {
  const hidden = TODAY_PARTS.filter((p) => s.hidden.includes(p)).length;
  const order = todayCardOrder(s).join() === TODAY_CARDS.join() ? TODAY_TEXT.usual : TODAY_TEXT.yours;
  return `${order}, ${hidden ? `${hidden} hidden` : TODAY_TEXT.allShown}`;
}

/**
 * Theme, Today: the line at the top with its switch, then the cards in their order, each with a switch, a handle to
 * drag it by, and Move up and Move down for the keyboard. Saved to the feel setting at once, so every device follows.
 */
export function TodayPartsPage() {
  return <TodayParts saved={useFeel().today} edit={(next) => updateFeel({ today: next })} />;
}

/** The page itself, for the setting `saved`; `edit` keeps a change. */
export function TodayParts({ saved, edit }: { saved: TodaySetting; edit: (next: TodaySetting) => void }) {
  /** The card being dragged and the order it would leave, drawn while the drag lasts. */
  const [drag, setDrag] = useState<{ card: TodayCard; order: TodayCard[] } | null>(null);
  const rows = useRef(new Map<TodayCard, HTMLLIElement>());
  const cards = drag?.order ?? todayCardOrder(saved);

  const shown = (p: TodayPart) => !saved.hidden.includes(p);

  // A drag follows the pointer (a finger too: the handle takes no scrolling), and the card takes the place of the
  // cards whose middles it passes. It is saved when the pointer lets go. The window hears the pointer: the row moves
  // in the page while it is dragged, which can cost the handle its hold on the pointer.
  const latest = useRef({ drag, saved, edit });
  latest.current = { drag, saved, edit };
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const move = (e: globalThis.PointerEvent) => {
      const d = latest.current.drag;
      if (!d) return;
      const others = d.order.filter((c) => c !== d.card);
      const at = others.filter((c) => {
        const r = rows.current.get(c)?.getBoundingClientRect();
        return r ? r.top + r.height / 2 < e.clientY : false;
      }).length;
      const order = [...others];
      order.splice(at, 0, d.card);
      if (order.join() !== d.order.join()) setDrag({ card: d.card, order });
    };
    const up = () => {
      const { drag: d, saved: s, edit: keep } = latest.current;
      if (d && d.order.join() !== todayCardOrder(s).join()) keep(todayWithOrder(s, d.order));
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [dragging]);
  const down = (card: TodayCard) => (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setDrag({ card, order: todayCardOrder(saved) });
  };

  const row = (p: TodayPart, i: number) => {
    const { name, holds } = TODAY_PART_TEXT[p];
    const card = p === TODAY_TOP ? null : (p as TodayCard);
    return (
      <li
        key={p}
        ref={(el) => {
          if (card && el) rows.current.set(card, el);
          else if (card) rows.current.delete(card);
        }}
        className={`item today-part${shown(p) ? "" : " off"}${drag?.card === p ? " dragging" : ""}`}
      >
        {card && (
          <span
            className="grip"
            aria-hidden="true"
            title={TODAY_TEXT.drag}
            onPointerDown={down(card)}
          >
            {"⠿"}
          </span>
        )}
        <label className="today-part-label">
          <input type="checkbox" checked={shown(p)} onChange={(e) => edit(todayWithShown(saved, p, e.target.checked))} />
          <span className="body">
            <span className="t">{name}</span>
            <span className="meta">{holds}</span>
          </span>
        </label>
        {card && (
          <span className="moves">
            <button type="button" className="ghost small" aria-label={`${TODAY_TEXT.moveUp}: ${name}`} title={TODAY_TEXT.moveUp} disabled={i === 0} onClick={() => edit(todayMove(saved, card, i - 1))}>
              <span aria-hidden="true">&#9650;</span>
            </button>
            <button type="button" className="ghost small" aria-label={`${TODAY_TEXT.moveDown}: ${name}`} title={TODAY_TEXT.moveDown} disabled={i === cards.length - 1} onClick={() => edit(todayMove(saved, card, i + 1))}>
              <span aria-hidden="true">&#9660;</span>
            </button>
          </span>
        )}
      </li>
    );
  };

  return (
    <SubPage path="/settings/theme/today">
      <div className="muted small">{TODAY_TEXT.intro}</div>
      <section className="col">
        <h2 className="settings-h">{TODAY_TEXT.top}</h2>
        <ul className="list rows today-parts">{row(TODAY_TOP, 0)}</ul>
        <div className="muted small">{TODAY_TEXT.topNote}</div>
      </section>
      <section className="col">
        <h2 className="settings-h" id="today-cards-h">{TODAY_TEXT.cards}</h2>
        <ol className={`list rows today-parts${dragging ? " dragging" : ""}`} aria-labelledby="today-cards-h">{cards.map((c, i) => row(c, i))}</ol>
        <div className="muted small">{TODAY_TEXT.drag} {TODAY_TEXT.wide}</div>
      </section>
      <div className="row">
        <button
          type="button"
          disabled={isDefaultToday(saved)}
          onClick={() => {
            if (!confirm(TODAY_TEXT.resetAsk)) return;
            setDrag(null);
            edit(defaultToday());
          }}
        >
          {TODAY_TEXT.reset}
        </button>
      </div>
    </SubPage>
  );
}
