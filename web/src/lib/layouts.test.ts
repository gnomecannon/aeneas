import { describe, expect, it } from "vitest";
import { boardBounds, clampRect, describePiece, guessPlatform, noteNumbers, partsAt, rectFrom, suggestParts } from "./layouts";

/** An RGBA picture filled with one colour, with boxes painted on it. */
function picture(w: number, h: number, bg: [number, number, number], boxes: { x: number; y: number; w: number; h: number; c: [number, number, number] }[]) {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { px[i * 4] = bg[0]; px[i * 4 + 1] = bg[1]; px[i * 4 + 2] = bg[2]; px[i * 4 + 3] = 255; }
  for (const b of boxes) {
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
      const i = (y * w + x) * 4; px[i] = b.c[0]; px[i + 1] = b.c[1]; px[i + 2] = b.c[2];
    }
  }
  return px;
}

const has = (parts: { x: number; y: number; w: number; h: number }[], r: { x: number; y: number; w: number; h: number }) =>
  parts.some((p) => p.x === r.x && p.y === r.y && p.w === r.w && p.h === r.h);

describe("suggestParts", () => {
  it("finds rows on a plain background, and the lines inside a filled card", () => {
    const ink: [number, number, number] = [30, 30, 30];
    const px = picture(200, 200, [245, 244, 241], [
      { x: 10, y: 10, w: 80, h: 20, c: ink },
      { x: 10, y: 50, w: 80, h: 20, c: ink },
      // A white card with two lines of text in it.
      { x: 110, y: 10, w: 80, h: 100, c: [255, 255, 255] },
      { x: 120, y: 20, w: 50, h: 8, c: ink },
      { x: 120, y: 40, w: 40, h: 8, c: ink },
    ]);
    const parts = suggestParts(px, 200, 200);
    expect(has(parts, { x: 10, y: 10, w: 80, h: 20 })).toBe(true);
    expect(has(parts, { x: 10, y: 50, w: 80, h: 20 })).toBe(true);
    expect(has(parts, { x: 110, y: 10, w: 80, h: 100 })).toBe(true);
    const card = parts.findIndex((p) => p.x === 110 && p.y === 10 && p.w === 80);
    const line = parts.findIndex((p) => p.x === 120 && p.y === 20 && p.w === 50 && p.h === 8);
    expect(line).toBeGreaterThanOrEqual(0);
    // The line sits inside the card (through any grouping in between).
    let up = parts[line].parent;
    while (up >= 0 && up !== card) up = parts[up].parent;
    expect(up).toBe(card);
  });

  it("groups by the widest gaps first and treats thin separators as gap", () => {
    const ink: [number, number, number] = [20, 20, 20];
    const sep: [number, number, number] = [200, 200, 200];
    // Two list rows (title and subtitle, 4 px apart), 20 px apart with a 1 px separator between.
    const px = picture(120, 120, [255, 255, 255], [
      { x: 10, y: 10, w: 60, h: 10, c: ink }, { x: 10, y: 24, w: 40, h: 8, c: ink },
      { x: 0, y: 42, w: 120, h: 1, c: sep },
      { x: 10, y: 52, w: 60, h: 10, c: ink }, { x: 10, y: 66, w: 40, h: 8, c: ink },
    ]);
    const parts = suggestParts(px, 120, 120);
    expect(has(parts, { x: 10, y: 10, w: 60, h: 22 })).toBe(true);
    expect(has(parts, { x: 10, y: 52, w: 60, h: 22 })).toBe(true);
    expect(has(parts, { x: 10, y: 10, w: 60, h: 10 })).toBe(true);
    expect(parts.some((p) => p.h === 1)).toBe(false);
  });

  it("does not split a line of text at its word gaps", () => {
    const ink: [number, number, number] = [0, 0, 0];
    const px = picture(100, 40, [255, 255, 255], [
      { x: 5, y: 10, w: 20, h: 10, c: ink }, { x: 28, y: 10, w: 20, h: 10, c: ink }, { x: 51, y: 10, w: 20, h: 10, c: ink },
    ]);
    const parts = suggestParts(px, 100, 40);
    expect(parts.some((p) => p.w === 20)).toBe(false);
  });

  it("returns nothing for an empty picture", () => {
    expect(suggestParts(picture(50, 50, [255, 255, 255], []), 50, 50)).toEqual([]);
  });
});

describe("layout helpers", () => {
  it("picks the smallest part under a point first", () => {
    const parts = [{ x: 0, y: 0, w: 100, h: 100, parent: -1, depth: 0 }, { x: 10, y: 10, w: 20, h: 20, parent: 0, depth: 1 }];
    expect(partsAt(parts, 15, 15)).toEqual([1, 0]);
    expect(partsAt(parts, 50, 50)).toEqual([0]);
    expect(partsAt(parts, 150, 50)).toEqual([]);
  });

  it("makes rects from corners in any order and keeps them in bounds", () => {
    expect(rectFrom(50, 40, 10, 20)).toEqual({ x: 10, y: 20, w: 40, h: 20 });
    expect(clampRect({ x: 90, y: -5, w: 20, h: 10 }, { x: 0, y: 0, w: 100, h: 100 })).toEqual({ x: 80, y: 0, w: 20, h: 10 });
  });

  it("says what a piece does", () => {
    const from = { x: 0, y: 100, w: 50, h: 20 };
    expect(describePiece({ id: "a", from, to: { ...from, y: 300 } })).toBe("down 200");
    expect(describePiece({ id: "a", from, to: null })).toBe("taken away");
    expect(describePiece({ id: "a", from: null, to: from })).toBe("new box");
    expect(describePiece({ id: "a", from, to: { x: 0, y: 100, w: 100, h: 20 } })).toBe("resized to 100 x 20");
  });

  it("numbers pieces with notes and labelled new boxes, and grows the board to take in every piece", () => {
    const pieces = [
      { id: "a", from: { x: 0, y: 0, w: 1, h: 1 }, to: null },
      { id: "b", from: { x: 0, y: 0, w: 1, h: 1 }, to: { x: 0, y: 0, w: 1, h: 1 }, note: "smaller" },
      { id: "c", from: null, to: { x: 500, y: 0, w: 40, h: 20 }, label: "Add" },
    ];
    expect([...noteNumbers(pieces).entries()]).toEqual([["b", 1], ["c", 2]]);
    const b = boardBounds(100, 200, pieces);
    expect(b.x + b.w).toBeGreaterThanOrEqual(548);
    expect(b.x).toBeLessThan(0);
  });

  it("guesses the platform from the picture's shape", () => {
    expect(guessPlatform(1170, 2532)).toBe("iphone");
    expect(guessPlatform(396, 484)).toBe("watch");
    expect(guessPlatform(2880, 1800)).toBe("web");
  });
});
