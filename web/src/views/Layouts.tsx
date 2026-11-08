import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { engine } from "../sync/engine";
import type { Layout, LayoutPiece, LayoutPlatform, LayoutRect, LayoutSummary } from "../sync/api";
import { go } from "../lib/router";
import { isTypingTarget } from "../lib/keys";
import { useMediaQuery } from "../lib/useMediaQuery";
import { usePoll } from "../lib/usePoll";
import { useSyncState } from "../sync/hooks";
import {
  PLATFORM_LABEL, arrangedBounds, boardBounds, clampRect, describePiece, dragLimit, drawArranged, guessPlatform,
  noteNumbers, onPicture, partsAt, rectEq, rectFrom, roundRect, scaleParts, suggestParts, type Part,
} from "../lib/layouts";

/**
 * Layout sketches: a picture of a screen with parts of it picked up and moved, resized or taken away, and new boxes
 * drawn in, to show how the screen should be laid out. Works the same for a picture from any device.
 */
export function Layouts({ id }: { id?: string }) {
  return id ? <Editor key={id} id={id} /> : <LayoutList />;
}

const PLATFORMS = Object.keys(PLATFORM_LABEL) as LayoutPlatform[];
const STATUS_LABEL: Record<Layout["status"], string> = { draft: "Draft", ready: "Ready", done: "Built" };

/** True once this device has a hub to talk to (rerenders when that changes). */
function useClientReady(): boolean {
  useSyncState();
  return !!engine.client;
}

/** A blob URL for a sketch picture (the endpoint needs the bearer header), and the loaded image for drawing. */
function usePicture(id: string | null | undefined): { url: string; img: HTMLImageElement | null; err: string } {
  const [state, setState] = useState<{ url: string; img: HTMLImageElement | null; err: string }>({ url: "", img: null, err: "" });
  const ready = useClientReady();
  useEffect(() => {
    if (!id || !ready) { setState({ url: "", img: null, err: "" }); return; }
    let live = true;
    let u = "";
    engine.client?.layoutPicture(id).then((b) => {
      if (!live) return;
      u = URL.createObjectURL(b);
      const img = new Image();
      img.onload = () => { if (live) setState({ url: u, img, err: "" }); };
      img.onerror = () => { if (live) setState({ url: u, img: null, err: "The picture could not be shown." }); };
      img.src = u;
    }, (e) => { if (live) setState({ url: "", img: null, err: (e as Error).message }); });
    return () => { live = false; if (u) URL.revokeObjectURL(u); };
  }, [id, ready]);
  return state;
}

/** A picture file as PNG, JPEG or WebP with its size (another type, such as HEIC, is drawn and saved as PNG). */
async function normalizePicture(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That file is not a picture this browser can open."));
      i.src = url;
    });
    const width = img.naturalWidth, height = img.naturalHeight;
    if (["image/png", "image/jpeg", "image/webp"].includes(file.type)) return { blob: file, width, height };
    const c = document.createElement("canvas");
    c.width = width; c.height = height;
    c.getContext("2d")!.drawImage(img, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("The picture could not be converted."))), "image/png"));
    return { blob, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function Thumb({ l }: { l: LayoutSummary }) {
  const { url } = usePicture(l.after_id ?? l.picture_id);
  return <div className="ly-thumb">{url ? <img src={url} alt="" loading="lazy" /> : null}</div>;
}

// ---------------------------------------------------------------------------------------------------------------
// The list

function LayoutList() {
  const loaded = usePoll((c) => c.layouts(), 60_000);
  const list = loaded.data;
  const [err, setErr] = useState("");
  const [pending, setPending] = useState<{ blob: Blob; url: string; width: number; height: number } | null>(null);
  const [platform, setPlatform] = useState<LayoutPlatform>("iphone");
  const [screen, setScreen] = useState("");
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (pending) URL.revokeObjectURL(pending.url); }, [pending]);

  const take = useCallback(async (file: Blob | null | undefined) => {
    if (!file) return;
    setErr("");
    try {
      const p = await normalizePicture(file);
      setPending({ ...p, url: URL.createObjectURL(p.blob) });
      setPlatform(guessPlatform(p.width, p.height));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  // A picture pasted anywhere on the page starts a sketch.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      if (!item) return;
      e.preventDefault();
      void take(item.getAsFile());
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [take]);

  const start = async () => {
    const c = engine.client;
    if (!c || !pending) return;
    setBusy(true);
    setErr("");
    try {
      const pic = await c.uploadLayoutPicture(pending.blob);
      const title = `${PLATFORM_LABEL[platform]} ${screen.trim() || "screen"}`;
      const l = await c.createLayout({ title, platform, screen: screen.trim(), picture_id: pic.picture_id });
      go(`/layouts/${l.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  const groups: { title: string; items: LayoutSummary[] }[] = list ? [
    { title: "Ready", items: list.filter((l) => l.status === "ready") },
    { title: "Drafts", items: list.filter((l) => l.status === "draft" && l.pieces_count > 0) },
    { title: "Screens to start from", items: list.filter((l) => l.status === "draft" && l.pieces_count === 0) },
    { title: "Built", items: list.filter((l) => l.status === "done") },
  ] : [];

  return (
    <div className="col">
      <h1>Layout sketches</h1>
      <p className="muted small" style={{ margin: 0 }}>
        Pick up parts of a screen and move them, make them bigger or smaller, take them away, or draw boxes for things
        that should be added. Mark a sketch ready when it shows what you want. The pictures are shown to whoever
        builds the change, so keep work items out of them.
      </p>
      <section
        className={`card col ly-new${over ? " over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void take(e.dataTransfer.files[0]); }}
      >
        {!pending ? (
          <div className="row wrap" style={{ alignItems: "center" }}>
            <button type="button" className="primary" onClick={() => fileRef.current?.click()}>New sketch from a picture</button>
            <span className="muted small">or paste a screenshot, or drop one here</span>
          </div>
        ) : (
          <div className="ly-start">
            <img src={pending.url} alt="The picture" className="ly-start-pic" />
            <div className="col">
              <div className="small muted">{pending.width} x {pending.height}</div>
              <div className="chips" role="radiogroup" aria-label="Device">
                {PLATFORMS.map((p) => (
                  <button key={p} type="button" role="radio" aria-checked={platform === p} className={`chip${platform === p ? " on" : ""}`} onClick={() => setPlatform(p)}>{PLATFORM_LABEL[p]}</button>
                ))}
              </div>
              <label className="col small">
                Screen
                <input value={screen} onChange={(e) => setScreen(e.target.value)} placeholder="Today, Capture, Settings..." maxLength={80} onKeyDown={(e) => { if (e.key === "Enter") void start(); }} />
              </label>
              <div className="row">
                <button type="button" className="primary" disabled={busy} onClick={() => void start()}>{busy ? "Starting" : "Start sketch"}</button>
                <button type="button" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
              </div>
            </div>
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { void take(e.target.files?.[0]); e.target.value = ""; }} />
        {err && <div className="error small">{err}</div>}
      </section>
      {list === null && !loaded.error && <div className="muted">Loading</div>}
      {loaded.error && <div className="error small">{loaded.error}</div>}
      {list && list.length === 0 && <div className="empty">No sketches yet.</div>}
      {groups.filter((g) => g.items.length).map((g) => (
        <section key={g.title} className="col">
          <h2 className="section-h">{g.title}</h2>
          <div className="ly-grid">
            {g.items.map((l) => (
              <a key={l.id} className="ly-card" href={`#/layouts/${l.id}`}>
                <Thumb l={l} />
                <div className="ly-card-title">{l.title}</div>
                <div className="muted small">
                  {PLATFORM_LABEL[l.platform]}{l.pieces_count ? ` · ${l.pieces_count} ${l.pieces_count === 1 ? "change" : "changes"}` : ""} · {ago(l.updated_at)}
                </div>
              </a>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The editor

type Mode = "pick" | "cut" | "box" | "pan";
type Drag =
  | { kind: "move" | "resize"; id: string; sx: number; sy: number; orig: LayoutRect; before: LayoutPiece[]; moved: boolean; keep: boolean }
  | { kind: "band"; sx: number; sy: number; x: number; y: number; box: boolean }
  | { kind: "lift"; sx: number; sy: number; part: number; cx: number; cy: number };

const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function cssColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Draw the arranged screen to a PNG (scaled down when it would be too big for a canvas). */
async function renderArranged(img: HTMLImageElement, l: { width: number; height: number }, pieces: LayoutPiece[]): Promise<Blob> {
  const b = arrangedBounds(l.width, l.height, pieces);
  const k = Math.min(1, Math.sqrt(14_000_000 / (b.w * b.h)));
  const c = document.createElement("canvas");
  c.width = Math.round(b.w * k); c.height = Math.round(b.h * k);
  const ctx = c.getContext("2d")!;
  ctx.scale(k, k);
  drawArranged(ctx, img, l.width, l.height, pieces, b, {
    outside: "#e4e3df", hole: "rgba(235,234,230,0.92)", hatch: "rgba(120,120,120,0.45)",
    accent: cssColor("--accent", "#2f5fbf"), danger: "#c0392b", text: "#1b1d22", badgeText: "#ffffff",
  });
  return new Promise((resolve, reject) => c.toBlob((x) => (x ? resolve(x) : reject(new Error("The picture could not be drawn."))), "image/png"));
}

function Editor({ id }: { id: string }) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const [err, setErr] = useState("");
  const pic = usePicture(layout?.picture_id);
  const [pieces, setPieces] = useState<LayoutPiece[]>([]);
  // The pieces as of the last change, for pointer events that come faster than renders.
  const cur = useRef<LayoutPiece[]>([]);
  const put = (next: LayoutPiece[]) => { cur.current = next; setPieces(next); };
  const [past, setPast] = useState<LayoutPiece[][]>([]);
  const [future, setFuture] = useState<LayoutPiece[][]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("pick");
  const [hint, setHint] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [showParts, setShowParts] = useState(false);
  const [band, setBand] = useState<LayoutRect | null>(null);
  const [zoom, setZoom] = useState(1);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "dirty" | "error">("saved");
  const [saveErr, setSaveErr] = useState("");
  const [meta, setMeta] = useState<{ title: string; platform: LayoutPlatform; screen: string; note: string; status: Layout["status"] }>({ title: "", platform: "other", screen: "", note: "", status: "draft" });
  const dirty = useRef(false);
  const drag = useRef<Drag | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageW, setStageW] = useState(600);
  const wide = useMediaQuery("(min-width: 768px)");
  const touch = useMediaQuery("(pointer: coarse)");

  const ready = useClientReady();
  useEffect(() => {
    if (!ready || latest.current.layout) return;
    let live = true;
    engine.client?.layout(id).then((l) => {
      if (!live) return;
      setLayout(l);
      put(l.pieces);
      setMeta({ title: l.title, platform: l.platform, screen: l.screen, note: l.note, status: l.status });
    }, (e) => { if (live) setErr((e as Error).message); });
    return () => { live = false; };
  }, [id, ready]);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageW(el.clientWidth - 24));
    ro.observe(el);
    setStageW(el.clientWidth - 24);
    return () => ro.disconnect();
  }, [layout]);

  // The parts of the picture, found once on a copy at most 1000 px on its long side.
  const parts = useMemo<Part[]>(() => {
    const img = pic.img;
    if (!img || !layout) return [];
    const s = Math.min(1, 1000 / Math.max(layout.width, layout.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(layout.width * s)); c.height = Math.max(1, Math.round(layout.height * s));
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return [];
    ctx.drawImage(img, 0, 0, c.width, c.height);
    try {
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      return scaleParts(suggestParts(data, c.width, c.height), c.width / layout.width);
    } catch {
      return [];
    }
  }, [pic.img, layout?.width, layout?.height]);

  const W = layout?.width ?? 1, H = layout?.height ?? 1;
  // The board keeps its size and place while a drag is under way, so the piece does not slip from under the pointer.
  const [frozen, setFrozen] = useState<LayoutRect | null>(null);
  const grown = useMemo(() => boardBounds(W, H, pieces), [W, H, pieces]);
  const bounds = frozen ?? grown;
  const limit = useMemo(() => dragLimit(W, H), [W, H]);
  const fit = wide ? Math.min(stageW / bounds.w, Math.max(420, window.innerHeight - 230) / bounds.h) : Math.min(stageW / bounds.w, Math.max(360, window.innerHeight - 260) / bounds.h);
  const k = Math.max(0.05, fit * zoom);
  const nums = useMemo(() => noteNumbers(pieces), [pieces]);
  const sel = pieces.find((p) => p.id === selected) ?? null;

  // ---- history and saving ----
  const commit = useCallback((next: LayoutPiece[], before: LayoutPiece[]) => {
    setPast((p) => [...p.slice(-99), before]);
    setFuture([]);
    put(next);
    dirty.current = true;
    setSaveState("dirty");
  }, []);
  const change = (next: LayoutPiece[]) => commit(next, cur.current);
  const editText = (pid: string, f: Partial<Pick<LayoutPiece, "label" | "note">>) => {
    put(cur.current.map((p) => (p.id === pid ? { ...p, ...f } : p)));
    dirty.current = true;
    setSaveState("dirty");
  };
  const undo = () => {
    if (!past.length) return;
    setFuture((f) => [cur.current, ...f]);
    put(past[past.length - 1]);
    setPast((p) => p.slice(0, -1));
    dirty.current = true;
    setSaveState("dirty");
  };
  const redo = () => {
    if (!future.length) return;
    setPast((p) => [...p, cur.current]);
    put(future[0]);
    setFuture((f) => f.slice(1));
    dirty.current = true;
    setSaveState("dirty");
  };

  const latest = useRef({ pieces, meta, img: pic.img, layout });
  latest.current = { pieces, meta, img: pic.img, layout };

  const save = useCallback(async (extra: Partial<Pick<Layout, "status">> = {}) => {
    const c = engine.client;
    const { pieces: ps, meta: m, img, layout: l } = latest.current;
    if (!c || !l) return;
    dirty.current = false;
    setSaveState("saving");
    setSaveErr("");
    try {
      const status = extra.status ?? m.status;
      let after_id: string | null | undefined;
      if (status === "ready" && img) {
        after_id = (await c.uploadLayoutPicture(await renderArranged(img, l, ps))).picture_id;
      }
      const next = await c.saveLayout(l.id, {
        title: m.title.trim() || l.title, platform: m.platform, screen: m.screen.trim(), note: m.note, pieces: ps.map((p) => ({ ...p, ...(p.from ? { from: roundRect(p.from) } : {}), ...(p.to ? { to: roundRect(p.to) } : {}) })),
        ...extra, ...(after_id !== undefined ? { after_id } : {}),
      });
      setLayout((old) => (old ? { ...old, status: next.status, after_id: next.after_id, updated_at: next.updated_at } : old));
      if (extra.status) setMeta((x) => ({ ...x, status: next.status }));
      setSaveState(dirty.current ? "dirty" : "saved");
    } catch (e) {
      dirty.current = true;
      setSaveState("error");
      setSaveErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (saveState !== "dirty") return;
    const t = setTimeout(() => void save(), 1200);
    return () => clearTimeout(t);
  }, [saveState, pieces, meta, save]);
  // Leaving the screen saves what is not saved yet.
  useEffect(() => () => { if (dirty.current) void save(); }, [save]);

  const setMetaField = <K extends keyof typeof meta>(key: K, v: (typeof meta)[K]) => {
    setMeta((m) => ({ ...m, [key]: v }));
    dirty.current = true;
    setSaveState("dirty");
  };

  // ---- pointer work on the board ----
  const toPic = (e: { clientX: number; clientY: number }) => {
    const r = boardRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / k + bounds.x, y: (e.clientY - r.top) / k + bounds.y };
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (mode === "pan" || e.button > 0 || !layout) return;
    const t = e.target as HTMLElement;
    if (t.closest(".ly-float")) return;
    const p = toPic(e);
    const handle = t.closest<HTMLElement>("[data-handle]");
    const pieceEl = t.closest<HTMLElement>("[data-piece]");
    const holeEl = t.closest<HTMLElement>("[data-hole]");
    boardRef.current!.setPointerCapture(e.pointerId);
    e.preventDefault();
    setFrozen(bounds);
    if (handle || pieceEl) {
      const pid = (handle ?? pieceEl)!.closest<HTMLElement>("[data-piece]")!.dataset.piece!;
      const piece = cur.current.find((x) => x.id === pid);
      if (!piece?.to) return;
      setSelected(pid);
      setHint(null);
      drag.current = { kind: handle ? "resize" : "move", id: pid, sx: p.x, sy: p.y, orig: piece.to, before: cur.current, moved: false, keep: e.shiftKey };
      return;
    }
    if (holeEl) {
      setSelected(holeEl.dataset.hole!);
      drag.current = null;
      return;
    }
    setSelected(null);
    if (mode === "cut" || mode === "box") {
      drag.current = { kind: "band", sx: p.x, sy: p.y, x: p.x, y: p.y, box: mode === "box" };
      return;
    }
    const under = partsAt(parts, p.x, p.y);
    const inHint = hint !== null && under.includes(hint);
    if (!under.length) {
      setHint(null);
      drag.current = { kind: "band", sx: p.x, sy: p.y, x: p.x, y: p.y, box: false };
      return;
    }
    drag.current = { kind: "lift", sx: p.x, sy: p.y, part: inHint ? hint! : under[0], cx: e.clientX, cy: e.clientY };
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    let d = drag.current;
    if (!layout) return;
    const p = toPic(e);
    if (!d) {
      if (mode === "pick" && e.pointerType === "mouse") {
        const under = partsAt(parts, p.x, p.y);
        setHover(hint !== null && under.includes(hint) ? hint : under[0] ?? null);
      }
      return;
    }
    if (d.kind === "lift") {
      if (Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 5) return;
      const part = parts[d.part];
      const from = roundRect(part);
      const piece: LayoutPiece = { id: newId(), from, to: { ...from } };
      const before = cur.current;
      put([...before, piece]);
      setSelected(piece.id);
      setHint(null);
      setHover(null);
      d = drag.current = { kind: "move", id: piece.id, sx: d.sx, sy: d.sy, orig: from, before, moved: true, keep: false };
    }
    if (d.kind === "band") {
      d.x = p.x; d.y = p.y;
      setBand(rectFrom(d.sx, d.sy, p.x, p.y));
      return;
    }
    const dx = p.x - d.sx, dy = p.y - d.sy;
    if (!d.moved && Math.hypot(dx * k, dy * k) < 3) return;
    d.moved = true;
    let to: LayoutRect;
    if (d.kind === "move") {
      to = clampRect({ ...d.orig, x: d.orig.x + dx, y: d.orig.y + dy }, limit);
    } else {
      const min = 8 / k;
      let w = Math.max(min, d.orig.w + dx), h = Math.max(min, d.orig.h + dy);
      if (d.keep || e.shiftKey) { const s = Math.max(w / d.orig.w, h / d.orig.h); w = d.orig.w * s; h = d.orig.h * s; }
      to = { x: d.orig.x, y: d.orig.y, w, h };
    }
    const id = d.id;
    put(cur.current.map((x) => (x.id === id ? { ...x, to } : x)));
  };

  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    setFrozen(null);
    try { boardRef.current?.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (!d || !layout) return;
    if (d.kind === "lift") {
      // A tap: pick the part, or on the picked part the bigger part around it.
      const under = partsAt(parts, d.sx, d.sy);
      if (hint !== null && under.includes(hint)) {
        const i = under.indexOf(hint);
        setHint(under[(i + 1) % under.length]);
      } else {
        setHint(under[0] ?? null);
      }
      return;
    }
    if (d.kind === "band") {
      setBand(null);
      const r = rectFrom(d.sx, d.sy, d.x, d.y);
      if (r.w * k < 6 || r.h * k < 6) return;
      if (d.box) {
        const piece: LayoutPiece = { id: newId(), from: null, to: roundRect(clampRect(r, limit)), label: "" };
        change([...cur.current, piece]);
        setSelected(piece.id);
        setMode("pick");
        setTimeout(() => document.getElementById("ly-label")?.focus(), 30);
      } else {
        const from = onPicture(r, W, H);
        if (!from) return;
        const piece: LayoutPiece = { id: newId(), from: roundRect(from), to: roundRect(from) };
        change([...cur.current, piece]);
        setSelected(piece.id);
      }
      return;
    }
    if (d.kind === "move" || d.kind === "resize") {
      const after = cur.current.map((x) => (x.id === d.id && x.to ? { ...x, to: roundRect(x.to) } : x));
      if (d.moved || d.before.length !== after.length) commit(after, d.before);
    }
  };

  /** The browser took the touch over (a swipe that scrolls): nothing is picked; a move under way is kept. */
  const onCancel = () => {
    const d = drag.current;
    drag.current = null;
    setFrozen(null);
    setBand(null);
    if (d && (d.kind === "move" || d.kind === "resize") && d.moved) commit(cur.current.map((x) => (x.id === d.id && x.to ? { ...x, to: roundRect(x.to) } : x)), d.before);
  };

  // ---- keys ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (e.key === "Escape") { setSelected(null); setHint(null); return; }
      if (!sel) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (!sel.from) change(cur.current.filter((p) => p.id !== sel.id));
        else change(cur.current.map((p) => (p.id === sel.id ? { ...p, to: null } : p)));
        return;
      }
      const step = (e.shiftKey ? 10 : 1) / k;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (d && sel.to) {
        e.preventDefault();
        change(cur.current.map((p) => (p.id === sel.id && p.to ? { ...p, to: roundRect({ ...p.to, x: p.to.x + d[0], y: p.to.y + d[1] }) } : p)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (err) return <div className="col"><a className="ly-back" href="#/layouts">{"‹"} Layout sketches</a><div className="error">{err}</div></div>;
  if (!layout) return <div className="muted">Loading</div>;

  const at = (r: LayoutRect) => ({ left: (r.x - bounds.x) * k, top: (r.y - bounds.y) * k, width: r.w * k, height: r.h * k });
  const liftPart = () => {
    if (hint === null) return;
    const from = roundRect(parts[hint]);
    const piece: LayoutPiece = { id: newId(), from, to: { ...from } };
    change([...cur.current, piece]);
    setSelected(piece.id);
    setHint(null);
  };
  const setStatus = (status: Layout["status"]) => { setMeta((m) => ({ ...m, status })); void save({ status }); };
  const duplicate = async () => {
    const c = engine.client;
    if (!c) return;
    try {
      const copy = await c.createLayout({ title: `${meta.title} (another try)`.slice(0, 120), platform: meta.platform, screen: meta.screen, picture_id: layout.picture_id, note: meta.note, pieces });
      go(`/layouts/${copy.id}`);
    } catch (e) { setSaveErr((e as Error).message); }
  };
  const remove = async () => {
    if (!confirm("Delete this sketch?")) return;
    try { await engine.client?.deleteLayout(layout.id); dirty.current = false; go("/layouts"); } catch (e) { setSaveErr((e as Error).message); }
  };

  const modeHelp: Record<Mode, string> = {
    pick: touch
      ? "Tap a part to pick it (tap again for the bigger part around it), then Pick up and drag it. Swipe on the picture to scroll."
      : "Click a part to pick it (click again for the bigger part around it), then drag it. Drag on an empty spot to cut out any area.",
    cut: "Drag over any area to cut it out, then drag it where it goes.",
    box: "Drag to draw a box for something that is not on the screen yet, then say what it is.",
    pan: "Drag to look around the zoomed picture.",
  };

  return (
    <div className="col ly-page">
      <a className="ly-back" href="#/layouts">{"‹"} Layout sketches</a>
      <div className="row wrap ly-head">
        <input className="ly-title" value={meta.title} onChange={(e) => setMetaField("title", e.target.value)} aria-label="Title" maxLength={120} />
        <span className={`chip static${meta.status === "ready" ? " tone-ok" : meta.status === "done" ? " tone-muted" : ""}`}>{STATUS_LABEL[meta.status]}</span>
        <span className="muted small" aria-live="polite">{saveState === "saving" ? "Saving" : saveState === "dirty" ? "Not saved yet" : saveState === "error" ? "Not saved" : "Saved"}</span>
      </div>
      <div className="ly-editor">
        <div className="col" style={{ minWidth: 0 }}>
          <div className="ly-toolbar">
            <div className="seg" role="radiogroup" aria-label="Tool">
              {(["pick", "cut", "box"] as Mode[]).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => { setMode(m); setHint(null); }}>
                  {{ pick: "Pick", cut: "Cut out", box: "New box", pan: "Pan" }[m]}
                </button>
              ))}
              {zoom > 1 && <button type="button" role="radio" aria-checked={mode === "pan"} className={mode === "pan" ? "on" : ""} onClick={() => setMode("pan")}>Pan</button>}
            </div>
            <button type="button" className="small" onClick={undo} disabled={!past.length} title="Undo (Cmd or Ctrl Z)">Undo</button>
            <button type="button" className="small" onClick={redo} disabled={!future.length} title="Redo">Redo</button>
            <span className="ly-zoom">
              <button type="button" className="small" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}>{"−"}</button>
              <button type="button" className="small" onClick={() => { setZoom(1); if (mode === "pan") setMode("pick"); }}>Fit</button>
              <button type="button" className="small" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))}>+</button>
            </span>
            <label className="row small ly-toggle"><input type="checkbox" checked={showParts} onChange={(e) => setShowParts(e.target.checked)} /> Show parts</label>
          </div>
          {/* One line that never changes height, so the board does not jump under the pointer. */}
          <div className="ly-help small">
            {hint !== null ? (
              <>
                <span>Part picked: drag it, or tap it again for the bigger part around it.</span>
                <button type="button" className="small primary" onClick={liftPart}>Pick it up</button>
                <button type="button" className="small" onClick={() => setHint(null)}>Clear</button>
              </>
            ) : <span className="muted">{modeHelp[mode]}</span>}
          </div>
          <div className="ly-stage" ref={stageRef}>
            <div
              ref={boardRef}
              className={`ly-board${mode === "pan" ? " pan" : ""}${mode === "pick" ? " pick" : ""}`}
              style={{ width: bounds.w * k, height: bounds.h * k }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onCancel}
              onPointerLeave={() => setHover(null)}
            >
              {pic.url && <img className="ly-pic" src={pic.url} alt={meta.title} draggable={false} style={at({ x: 0, y: 0, w: W, h: H })} />}
              <div className="ly-edge" style={at({ x: 0, y: 0, w: W, h: H })} />
              {showParts && parts.map((p, i) => <div key={i} className="ly-part" style={at(p)} />)}
              {pieces.map((p) => {
                if (!p.from) return null;
                const src = onPicture(p.from, W, H);
                if (!src || (p.to && rectEq(p.from, p.to))) return null;
                return <div key={`h${p.id}`} data-hole={p.id} className={`ly-hole${p.to ? "" : " removed"}${selected === p.id ? " sel" : ""}`} style={at(src)} />;
              })}
              {hover !== null && hover !== hint && parts[hover] && <div className="ly-hover" style={at(parts[hover])} />}
              {hint !== null && parts[hint] && <div className="ly-hint" style={at(parts[hint])} />}
              {hint !== null && parts[hint] && (
                <button
                  type="button"
                  className="small primary ly-float"
                  style={{ left: Math.max(0, (parts[hint].x - bounds.x) * k), top: Math.max(0, (parts[hint].y - bounds.y) * k - 34) }}
                  onClick={liftPart}
                >
                  Pick up
                </button>
              )}
              {pieces.map((p) => {
                if (!p.to) return null;
                const style: CSSProperties = at(p.to);
                if (p.from && pic.url) {
                  const sx = (p.to.w / p.from.w) * k, sy = (p.to.h / p.from.h) * k;
                  style.backgroundImage = `url(${pic.url})`;
                  style.backgroundSize = `${W * sx}px ${H * sy}px`;
                  style.backgroundPosition = `${-p.from.x * sx}px ${-p.from.y * sy}px`;
                }
                const still = !!p.from && rectEq(p.from, p.to);
                const n = nums.get(p.id);
                return (
                  <div key={p.id} data-piece={p.id} className={`ly-piece${p.from ? "" : " box"}${still ? " still" : ""}${selected === p.id ? " sel" : ""}`} style={style}>
                    {!p.from && <span className="ly-label" style={{ fontSize: Math.max(10, Math.min(16, p.to.h * k * 0.4)) }}>{p.label}</span>}
                    {n && <span className="ly-badge">{n}</span>}
                    {selected === p.id && <span className="ly-handle" data-handle="se" aria-label="Resize" />}
                  </div>
                );
              })}
              {band && <div className="ly-band" style={at(band)} />}
            </div>
          </div>
          {pic.err && <div className="error small">{pic.err}</div>}
        </div>
        <aside className="col ly-side">
          {sel ? (
            <section className="card col">
              <div className="row between">
                <strong>{sel.from ? (nums.get(sel.id) ? `Part ${nums.get(sel.id)}` : "Part") : "New box"}</strong>
                <span className="muted small">{describePiece(sel)}</span>
              </div>
              <label className="col small">
                {sel.from ? "Name (if it helps)" : "What it is"}
                <input id="ly-label" value={sel.label ?? ""} maxLength={200} onChange={(e) => editText(sel.id, { label: e.target.value })} placeholder={sel.from ? "Capture button" : "Search field"} />
              </label>
              <label className="col small">
                What should change
                <textarea rows={3} value={sel.note ?? ""} maxLength={2000} onChange={(e) => editText(sel.id, { note: e.target.value })} placeholder="Bigger, always visible, only on iPhone..." />
              </label>
              <div className="row wrap">
                {sel.from && sel.to && !rectEq(sel.from, sel.to) && <button type="button" className="small" onClick={() => change(pieces.map((p) => (p.id === sel.id ? { ...p, to: { ...p.from! } } : p)))}>Put back</button>}
                {sel.from && sel.to && <button type="button" className="small danger" onClick={() => change(pieces.map((p) => (p.id === sel.id ? { ...p, to: null } : p)))}>Take away</button>}
                {sel.from && !sel.to && <button type="button" className="small" onClick={() => change(pieces.map((p) => (p.id === sel.id ? { ...p, to: { ...p.from! } } : p)))}>Bring back</button>}
                <button type="button" className="small" onClick={() => { change(pieces.filter((p) => p.id !== sel.id)); setSelected(null); }}>{sel.from ? "Drop this change" : "Delete box"}</button>
              </div>
              <div className="muted small">Drag the round handle to resize (hold Shift to keep its shape). Arrow keys nudge it.</div>
            </section>
          ) : (
            <section className="card col small muted">Pick up a part or draw a box to say what should change about it.</section>
          )}
          {pieces.length > 0 && (
            <section className="col">
              <h2 className="section-h">Changes</h2>
              <ul className="ly-pieces">
                {pieces.map((p) => (
                  <li key={p.id}>
                    <button type="button" className={`small ghost${selected === p.id ? " on" : ""}`} onClick={() => setSelected(p.id)}>
                      {nums.get(p.id) ? <span className="ly-num">{nums.get(p.id)}</span> : null}
                      <span>{p.label?.trim() || (p.from ? "Part" : "New box")}: {describePiece(p)}</span>
                      {p.note?.trim() && <span className="muted"> · {p.note.trim().slice(0, 60)}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <label className="col small">
            About this screen
            <textarea rows={3} value={meta.note} maxLength={4000} onChange={(e) => setMetaField("note", e.target.value)} placeholder="Anything that is not about one part" />
          </label>
          <div className="row wrap small">
            <label className="col small">
              Device
              <select value={meta.platform} onChange={(e) => setMetaField("platform", e.target.value as LayoutPlatform)}>
                {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}
              </select>
            </label>
            <label className="col small grow">
              Screen
              <input value={meta.screen} maxLength={80} onChange={(e) => setMetaField("screen", e.target.value)} />
            </label>
          </div>
          <div className="row wrap">
            {meta.status !== "ready" ? (
              <button type="button" className="primary" onClick={() => setStatus("ready")} disabled={saveState === "saving"}>Mark ready</button>
            ) : (
              <button type="button" onClick={() => setStatus("draft")} disabled={saveState === "saving"}>Back to draft</button>
            )}
            <button type="button" onClick={() => void duplicate()}>Try another way</button>
            <button type="button" className="danger" onClick={() => void remove()}>Delete</button>
          </div>
          {saveErr && <div className="error small">{saveErr}</div>}
        </aside>
      </div>
    </div>
  );
}
