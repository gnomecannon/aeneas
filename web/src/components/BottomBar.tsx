import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ESCAPE_EVENT } from "../lib/keys";
import { settlesOpen } from "../lib/bar";
import { ScreenIcon } from "./ScreenIcon";

/** One screen in the bar: its id (for the icon), where it leads, and its name. */
export interface BarItem {
  id: string;
  path: string;
  label: string;
}

/** How far a press must move, mostly up or down, before it is a drag on the bar and no longer a tap on a screen. */
const DRAG_START = 8;

function Row({ items, lit, inbox, onChoose }: { items: BarItem[]; lit: string; inbox: number; onChoose: () => void }) {
  return (
    <>
      {items.map((t) => {
        const on = t.id === lit;
        return (
          <a key={t.id} href={`#${t.path}`} draggable={false} className={on ? "active" : ""} aria-current={on ? "page" : undefined} onClick={onChoose}>
            <ScreenIcon id={t.id} />
            <span className="tab-name">{t.label}</span>
            {t.id === "library" && inbox > 0 && (
              <span className="badge" aria-label={`${inbox} to sort`}>
                {inbox}
              </span>
            )}
          </a>
        );
      })}
    </>
  );
}

/**
 * The phone layout's bottom bar (Settings, Theme, Bottom bar chooses what is in it): the first row always shows, and
 * a press and drag up anywhere on the bar pulls the second row out above it. The row follows the finger, stays open
 * once more than half shows (or after a flick up), and folds on a drag down, a tap outside the bar, Escape, or a
 * choice. The grabber on the top edge is a button that does the same without a drag. `lit` is the screen that is
 * showing; `at` is the route, so the second row folds when the screen changes by any other way.
 */
export function BottomBar({ count, first, second, lit, inbox, at }: { count: number; first: BarItem[]; second: BarItem[]; lit: string; inbox: number; at: string }) {
  const [open, setOpen] = useState(false);
  /** While a finger drags: how many pixels of the second row show. */
  const [drag, setDrag] = useState<number | null>(null);
  const nav = useRef<HTMLElement>(null);
  const more = useRef<HTMLDivElement>(null);
  const moreRow = useRef<HTMLDivElement>(null);
  const press = useRef<{ id: number; x: number; y: number; base: number; full: number; moved: boolean; lastY: number; lastT: number; speed: number } | null>(null);
  /** A drag that ends over a screen must not also open it: until this time, a click on the bar is the drag's own. */
  const swallowUntil = useRef(0);
  const hasMore = second.length > 0;
  const shown = open && hasMore;

  useEffect(() => setOpen(false), [at, lit]);
  useEffect(() => {
    if (!shown) return;
    const close = () => setOpen(false);
    window.addEventListener(ESCAPE_EVENT, close);
    return () => window.removeEventListener(ESCAPE_EVENT, close);
  }, [shown]);

  // The screens leave room for the bar as it is folded: its height changes with the count, the size of the words and
  // whether there is a second row to hint at.
  useEffect(() => {
    const el = nav.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    let last = -1;
    const measure = () => {
      const h = Math.max(0, el.offsetHeight - (more.current?.offsetHeight ?? 0));
      if (h === last) return;
      last = h;
      // No height: a wide window, where the bar is not drawn.
      if (h > 0) root.style.setProperty("--tabs-h", `${h}px`);
      else root.style.removeProperty("--tabs-h");
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => {
      ro.disconnect();
      root.style.removeProperty("--tabs-h");
    };
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (!hasMore || (e.pointerType === "mouse" && e.button !== 0)) return;
    const full = moreRow.current?.scrollHeight ?? 0;
    press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, base: shown ? full : 0, full, moved: false, lastY: e.clientY, lastT: e.timeStamp, speed: 0 };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    const up = p.y - e.clientY;
    if (!p.moved) {
      if (Math.abs(up) < DRAG_START || Math.abs(up) < Math.abs(e.clientX - p.x)) return;
      p.moved = true;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    }
    const dt = e.timeStamp - p.lastT;
    if (dt > 0) p.speed = (p.lastY - e.clientY) / dt;
    p.lastY = e.clientY;
    p.lastT = e.timeStamp;
    setDrag(Math.min(p.full, Math.max(0, p.base + up)));
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    if (!p.moved) return;
    const reveal = Math.min(p.full, Math.max(0, p.base + (p.y - e.clientY)));
    // A finger that rested before lifting is not a flick.
    const speed = e.timeStamp - p.lastT > 80 ? 0 : p.speed;
    setOpen(cancelled ? p.base > 0 : settlesOpen(reveal, p.full, speed));
    setDrag(null);
    swallowUntil.current = e.timeStamp + 350;
  };
  const onClickCapture = (e: ReactMouseEvent<HTMLElement>) => {
    if (e.timeStamp > swallowUntil.current) return;
    swallowUntil.current = 0;
    e.preventDefault();
    e.stopPropagation();
  };

  const dragging = drag !== null;
  const moreStyle: CSSProperties | undefined = dragging ? { gridTemplateRows: `${drag}px`, transition: "none" } : undefined;
  const fold = () => setOpen(false);
  const litBelow = second.some((t) => t.id === lit);

  return (
    <>
      {shown && <div className="tabs-scrim" aria-hidden="true" onClick={fold} />}
      <nav
        ref={nav}
        className={`tabs count-${count}${shown ? " open" : ""}${dragging ? " dragging" : ""}`}
        aria-label="Sections"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => onPointerEnd(e, false)}
        onPointerCancel={(e) => onPointerEnd(e, true)}
        onClickCapture={onClickCapture}
      >
        {hasMore && (
          <button type="button" className={`tabs-grab${litBelow ? " lit" : ""}`} aria-label="More screens" aria-expanded={shown} aria-controls="tabs-more" onClick={() => setOpen((o) => !o)}>
            <span className="tabs-grab-pill" aria-hidden="true" />
          </button>
        )}
        {hasMore && (
          <div ref={more} className="tabs-more" style={moreStyle}>
            <div ref={moreRow} id="tabs-more" className="tabs-row" role="group" aria-label="More screens">
              <Row items={second} lit={lit} inbox={inbox} onChoose={fold} />
            </div>
          </div>
        )}
        <div className="tabs-row">
          <Row items={first} lit={lit} inbox={inbox} onChoose={fold} />
        </div>
      </nav>
    </>
  );
}
