import type { LayoutPiece, LayoutPlatform, LayoutRect } from "../sync/api";

/**
 * Layout sketches: finding the parts of a screen picture, and drawing the arranged result.
 * Everything here works in picture pixels (the picture's own size), except `suggestParts`, which works on whatever
 * pixels it is given (a scaled-down copy) and leaves the scaling back to the caller.
 */

export const PLATFORM_LABEL: Record<LayoutPlatform, string> = {
  iphone: "iPhone", ipad: "iPad", mac: "Mac", watch: "Watch", windows: "Windows", web: "Web", other: "Other",
};

/** A likely platform for a picture of this size (a guess the owner can change). */
export function guessPlatform(w: number, h: number): LayoutPlatform {
  if (w <= 520 && h <= 620 && Math.abs(w / h - 0.82) < 0.15) return "watch";
  if (h / w > 1.7) return "iphone";
  if (h / w > 1.15) return "ipad";
  return "web";
}

/** A part found in a picture: a box and the bigger part it sits in (-1 for none). */
export interface Part extends LayoutRect { parent: number; depth: number }

interface Rgb { r: number; g: number; b: number }
interface Region { x0: number; y0: number; x1: number; y1: number }

const dist = (a: Rgb, b: Rgb) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);

/**
 * Split a screen picture into the parts a person would move (cards, rows, buttons, lines of text), as a tree.
 * XY-cut: a region splits along the empty bands that run all the way across it, the widest gaps first, so rows of a
 * list group before the lines inside a row; a part filled with its own colour (a card) is split again inside that
 * colour. Thin lines (separators) count as gap. `px` is RGBA, row by row.
 */
export function suggestParts(
  px: Uint8ClampedArray, width: number, height: number,
  o: { threshold?: number; rowGap?: number; colGap?: number; thin?: number; maxParts?: number } = {},
): Part[] {
  const threshold = o.threshold ?? 28;
  const rowGap = o.rowGap ?? 3;
  const colGap = o.colGap ?? 5;
  const thin = o.thin ?? 3;
  const maxParts = o.maxParts ?? 400;
  const parts: Part[] = [];

  const at = (x: number, y: number): Rgb => { const i = (y * width + x) * 4; return { r: px[i], g: px[i + 1], b: px[i + 2] }; };

  /** The commonest colour along a region's edge. */
  const bgOf = (g: Region): Rgb => {
    const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
    const add = (x: number, y: number) => {
      const c = at(x, y);
      const k = ((c.r >> 4) << 8) | ((c.g >> 4) << 4) | (c.b >> 4);
      const e = buckets.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += c.r; e.g += c.g; e.b += c.b;
      buckets.set(k, e);
    };
    const w = g.x1 - g.x0, h = g.y1 - g.y0;
    const sx = Math.max(1, Math.floor(w / 120)), sy = Math.max(1, Math.floor(h / 120));
    for (let x = g.x0; x < g.x1; x += sx) { add(x, g.y0); add(x, g.y1 - 1); }
    for (let y = g.y0; y < g.y1; y += sy) { add(g.x0, y); add(g.x1 - 1, y); }
    let best = { n: 0, r: 0, g: 0, b: 0 };
    for (const e of buckets.values()) if (e.n > best.n) best = e;
    return best.n ? { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n } : { r: 255, g: 255, b: 255 };
  };

  const isInk = (x: number, y: number, bg: Rgb) => {
    const i = (y * width + x) * 4;
    return Math.abs(px[i] - bg.r) + Math.abs(px[i + 1] - bg.g) + Math.abs(px[i + 2] - bg.b) > threshold;
  };

  const profile = (g: Region, bg: Rgb, axis: "rows" | "cols"): Int32Array => {
    const out = new Int32Array(axis === "rows" ? g.y1 - g.y0 : g.x1 - g.x0);
    for (let y = g.y0; y < g.y1; y++) {
      for (let x = g.x0; x < g.x1; x++) {
        if (isInk(x, y, bg)) out[axis === "rows" ? y - g.y0 : x - g.x0]++;
      }
    }
    return out;
  };

  /** Runs of ink along one axis, thin runs dropped, joined across gaps narrower than the widest ones. */
  const groups = (counts: Int32Array, minGap: number): [number, number][] => {
    const runs: [number, number][] = [];
    let s = -1;
    for (let i = 0; i <= counts.length; i++) {
      const ink = i < counts.length && counts[i] > 0;
      if (ink && s < 0) s = i;
      if (!ink && s >= 0) { runs.push([s, i]); s = -1; }
    }
    const solid = runs.filter((r) => r[1] - r[0] >= thin);
    if (solid.length <= 1) return solid;
    let widest = 0;
    for (let i = 1; i < solid.length; i++) widest = Math.max(widest, solid[i][0] - solid[i - 1][1]);
    if (widest < minGap) return [[solid[0][0], solid[solid.length - 1][1]]];
    const cut = Math.max(minGap, Math.floor(widest * 0.7));
    const out: [number, number][] = [[...solid[0]]];
    for (let i = 1; i < solid.length; i++) {
      const last = out[out.length - 1];
      if (solid[i][0] - last[1] < cut) last[1] = solid[i][1];
      else out.push([...solid[i]]);
    }
    return out;
  };

  /** The box around the ink in a region, or null when there is none worth keeping. */
  const trim = (g: Region, bg: Rgb): Region | null => {
    const rows = profile(g, bg, "rows"), cols = profile(g, bg, "cols");
    let y0 = 0, y1 = rows.length, x0 = 0, x1 = cols.length;
    while (y0 < y1 && rows[y0] === 0) y0++;
    while (y1 > y0 && rows[y1 - 1] === 0) y1--;
    while (x0 < x1 && cols[x0] === 0) x0++;
    while (x1 > x0 && cols[x1 - 1] === 0) x1--;
    if (x1 - x0 < 4 || y1 - y0 < thin) return null;
    return { x0: g.x0 + x0, y0: g.y0 + y0, x1: g.x0 + x1, y1: g.y0 + y1 };
  };

  const same = (a: Region, b: Region) => a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;

  const visit = (g: Region, bg: Rgb, parent: number, depth: number): void => {
    if (depth > 8 || parts.length >= maxParts) return;
    for (const axis of ["rows", "cols"] as const) {
      const gs = groups(profile(g, bg, axis), axis === "rows" ? rowGap : colGap);
      if (gs.length < 2) continue;
      for (const [a, b] of gs) {
        const sub = axis === "rows" ? { x0: g.x0, x1: g.x1, y0: g.y0 + a, y1: g.y0 + b } : { x0: g.x0 + a, x1: g.x0 + b, y0: g.y0, y1: g.y1 };
        const t = trim(sub, bg);
        if (!t || parts.length >= maxParts) continue;
        parts.push({ x: t.x0, y: t.y0, w: t.x1 - t.x0, h: t.y1 - t.y0, parent, depth });
        visit(t, bg, parts.length - 1, depth + 1);
      }
      return;
    }
    // One block: a card filled with its own colour is split again inside it.
    const inset = 3;
    if (g.x1 - g.x0 < 24 || g.y1 - g.y0 < 14) return;
    const inner = { x0: g.x0 + inset, y0: g.y0 + inset, x1: g.x1 - inset, y1: g.y1 - inset };
    const ibg = bgOf(inner);
    if (dist(ibg, bg) <= threshold) return;
    const t = trim(inner, ibg);
    if (!t) return;
    if (!same(t, inner) && (t.x1 - t.x0) * (t.y1 - t.y0) < (inner.x1 - inner.x0) * (inner.y1 - inner.y0) * 0.97) {
      parts.push({ x: t.x0, y: t.y0, w: t.x1 - t.x0, h: t.y1 - t.y0, parent, depth });
      visit(t, ibg, parts.length - 1, depth + 1);
    } else {
      visit(t, ibg, parent, depth);
    }
  };

  const all = { x0: 0, y0: 0, x1: width, y1: height };
  const bg = bgOf(all);
  const root = trim(all, bg);
  if (root) {
    if (!same(root, all) && (root.x1 - root.x0) * (root.y1 - root.y0) < width * height * 0.9) {
      parts.push({ x: root.x0, y: root.y0, w: root.x1 - root.x0, h: root.y1 - root.y0, parent: -1, depth: 0 });
      visit(root, bg, 0, 1);
    } else {
      visit(root, bg, -1, 0);
    }
  }
  return parts;
}

/** Scale parts found on a smaller copy back to picture pixels. */
export function scaleParts(parts: Part[], k: number): Part[] {
  return parts.map((p) => ({ ...p, x: p.x / k, y: p.y / k, w: p.w / k, h: p.h / k }));
}

/** The parts under a point, smallest first (a tap picks the first, the next tap on the same spot the one around it). */
export function partsAt(parts: Part[], x: number, y: number): number[] {
  const hits: number[] = [];
  parts.forEach((p, i) => { if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) hits.push(i); });
  return hits.sort((a, b) => parts[a].w * parts[a].h - parts[b].w * parts[b].h);
}

export const rectEq = (a: LayoutRect | null, b: LayoutRect | null, tol = 0.5) =>
  !!a && !!b && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;

/** A rect from two corners, in any order. */
export function rectFrom(ax: number, ay: number, bx: number, by: number): LayoutRect {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

/** Keep a rect inside a bound (moved back in, made smaller only when it is bigger than the bound). */
export function clampRect(r: LayoutRect, b: LayoutRect): LayoutRect {
  const w = Math.min(r.w, b.w), h = Math.min(r.h, b.h);
  return { x: Math.min(Math.max(r.x, b.x), b.x + b.w - w), y: Math.min(Math.max(r.y, b.y), b.y + b.h - h), w, h };
}

/** The part of a rect that lies on the picture, or null. */
export function onPicture(r: LayoutRect, w: number, h: number): LayoutRect | null {
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y), x1 = Math.min(w, r.x + r.w), y1 = Math.min(h, r.y + r.h);
  return x1 - x0 >= 1 && y1 - y0 >= 1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export const roundRect = (r: LayoutRect): LayoutRect => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.max(1, Math.round(r.w)), h: Math.max(1, Math.round(r.h)) });

/** What a piece does, in words ("moved down 120", "taken away", "new box"). */
export function describePiece(p: LayoutPiece): string {
  if (!p.from) return "new box";
  if (!p.to) return "taken away";
  const moved = !rectEq(p.from, { ...p.from, x: p.to.x, y: p.to.y });
  const sized = Math.abs(p.from.w - p.to.w) > 0.5 || Math.abs(p.from.h - p.to.h) > 0.5;
  if (!moved && !sized) return "picked, not moved";
  const bits: string[] = [];
  if (moved) {
    const dx = Math.round(p.to.x - p.from.x), dy = Math.round(p.to.y - p.from.y);
    if (dy) bits.push(`${dy > 0 ? "down" : "up"} ${Math.abs(dy)}`);
    if (dx) bits.push(`${dx > 0 ? "right" : "left"} ${Math.abs(dx)}`);
  }
  if (sized) bits.push(`resized to ${Math.round(p.to.w)} x ${Math.round(p.to.h)}`);
  return bits.join(", ");
}

/** The area the board shows: the picture with room around it, grown to take in every piece. */
export function boardBounds(w: number, h: number, pieces: LayoutPiece[]): LayoutRect {
  const mx = Math.round(Math.max(w, h) * 0.12), my = Math.round(h * 0.06);
  let x0 = -mx, y0 = -my, x1 = w + mx, y1 = h + my;
  for (const p of pieces) {
    if (!p.to) continue;
    x0 = Math.min(x0, p.to.x - 8); y0 = Math.min(y0, p.to.y - 8);
    x1 = Math.max(x1, p.to.x + p.to.w + 8); y1 = Math.max(y1, p.to.y + p.to.h + 8);
  }
  return { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1 - x0), h: Math.ceil(y1 - y0) };
}

/** The picture of the result: the screen grown to take in pieces placed outside it, with no extra room. */
export function arrangedBounds(w: number, h: number, pieces: LayoutPiece[]): LayoutRect {
  let x0 = 0, y0 = 0, x1 = w, y1 = h;
  for (const p of pieces) {
    if (!p.to) continue;
    x0 = Math.min(x0, p.to.x); y0 = Math.min(y0, p.to.y);
    x1 = Math.max(x1, p.to.x + p.to.w); y1 = Math.max(y1, p.to.y + p.to.h);
  }
  return { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1 - Math.floor(x0)), h: Math.ceil(y1 - Math.floor(y0)) };
}

/** Where a drag may take a piece: the picture with half its size again on every side. */
export function dragLimit(w: number, h: number): LayoutRect {
  return { x: -w / 2, y: -h / 2, w: w * 2, h: h * 2 };
}

/** Numbers shown on pieces with a note or a label, in list order (1-based), so the picture and the notes line up. */
export function noteNumbers(pieces: LayoutPiece[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of pieces) if (p.note?.trim() || (!p.from && p.label?.trim())) out.set(p.id, out.size + 1);
  return out;
}

/**
 * Draw the arranged screen: the picture, the places parts left (hatched; crossed out when taken away), each part at
 * its new place and size, new boxes dashed with their text, and a number on every piece with a note.
 */
export function drawArranged(
  ctx: CanvasRenderingContext2D, img: CanvasImageSource, w: number, h: number, pieces: LayoutPiece[], bounds: LayoutRect,
  colors: { outside: string; hole: string; hatch: string; accent: string; danger: string; text: string; badgeText: string },
): void {
  const unit = Math.max(1, Math.round(Math.max(w, h) / 600));
  ctx.save();
  ctx.translate(-bounds.x, -bounds.y);
  ctx.fillStyle = colors.outside;
  ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
  ctx.drawImage(img, 0, 0, w, h);
  const hatch = (r: LayoutRect) => {
    ctx.save();
    ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
    ctx.fillStyle = colors.hole; ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = colors.hatch; ctx.lineWidth = unit;
    for (let d = -r.h; d < r.w; d += 8 * unit) { ctx.beginPath(); ctx.moveTo(r.x + d, r.y + r.h); ctx.lineTo(r.x + d + r.h, r.y); ctx.stroke(); }
    ctx.restore();
  };
  for (const p of pieces) {
    if (!p.from) continue;
    const src = onPicture(p.from, w, h);
    if (!src) continue;
    if (!p.to) {
      // Taken away: still readable under a red tint and a cross, so it is clear what goes.
      ctx.save();
      ctx.globalAlpha = 0.14; ctx.fillStyle = colors.danger; ctx.fillRect(src.x, src.y, src.w, src.h);
      ctx.restore();
      ctx.strokeStyle = colors.danger; ctx.lineWidth = 2 * unit;
      ctx.strokeRect(src.x, src.y, src.w, src.h);
      ctx.beginPath(); ctx.moveTo(src.x, src.y); ctx.lineTo(src.x + src.w, src.y + src.h); ctx.moveTo(src.x + src.w, src.y); ctx.lineTo(src.x, src.y + src.h); ctx.stroke();
    } else if (!rectEq(p.from, p.to)) {
      hatch(src);
    }
  }
  const nums = noteNumbers(pieces);
  for (const p of pieces) {
    if (!p.to) continue;
    if (p.from) {
      const src = onPicture(p.from, w, h);
      if (!src) continue;
      // The part of `from` that is on the picture lands on the same share of `to`.
      const kx = p.to.w / p.from.w, ky = p.to.h / p.from.h;
      const dst = { x: p.to.x + (src.x - p.from.x) * kx, y: p.to.y + (src.y - p.from.y) * ky, w: src.w * kx, h: src.h * ky };
      ctx.drawImage(img, src.x, src.y, src.w, src.h, dst.x, dst.y, dst.w, dst.h);
      if (!rectEq(p.from, p.to) || nums.has(p.id)) {
        ctx.strokeStyle = colors.accent; ctx.lineWidth = 2 * unit;
        ctx.strokeRect(p.to.x, p.to.y, p.to.w, p.to.h);
      }
    } else {
      ctx.save();
      ctx.globalAlpha = 0.14; ctx.fillStyle = colors.accent; ctx.fillRect(p.to.x, p.to.y, p.to.w, p.to.h);
      ctx.restore();
      ctx.setLineDash([6 * unit, 4 * unit]); ctx.strokeStyle = colors.accent; ctx.lineWidth = 2 * unit;
      ctx.strokeRect(p.to.x, p.to.y, p.to.w, p.to.h);
      ctx.setLineDash([]);
      if (p.label?.trim()) {
        const size = Math.max(10 * unit, Math.min(p.to.h * 0.4, 18 * unit));
        ctx.font = `600 ${size}px system-ui, -apple-system, sans-serif`;
        ctx.fillStyle = colors.text; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(p.label.trim(), p.to.x + p.to.w / 2, p.to.y + p.to.h / 2, p.to.w - 8 * unit);
      }
    }
  }
  for (const p of pieces) {
    const n = nums.get(p.id);
    const r = p.to ?? p.from;
    if (!n || !r) continue;
    const rad = 9 * unit;
    ctx.beginPath(); ctx.arc(r.x + rad, r.y + rad, rad, 0, Math.PI * 2);
    ctx.fillStyle = p.to ? colors.accent : colors.danger; ctx.fill();
    ctx.font = `700 ${11 * unit}px system-ui, -apple-system, sans-serif`;
    ctx.fillStyle = colors.badgeText; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(n), r.x + rad, r.y + rad + 0.5);
  }
  ctx.restore();
}
