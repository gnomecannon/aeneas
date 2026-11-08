import type { ShapeName } from "./theory";

/**
 * Geometric bursts on one canvas, full-screen by default. The animation frame loop runs only while something is alive,
 * so an idle app draws nothing. Uploaded images fly with the shapes, keeping their own colors.
 */

/** What a burst is made of: colors for the shapes, which shapes and images, and the size and amount (1 is normal). */
export interface BurstStyle {
  colors: string[];
  shapes: ShapeName[];
  images: ImageBitmap[];
  size: number;
  density: number;
}

interface Bit {
  x: number;
  y: number;
  angle: number;
  dist: number;
  size: number;
  rot: number;
  spin: number;
  kind: ShapeName;
  img: ImageBitmap | null;
  filled: boolean;
  color: string;
  born: number;
  life: number;
  gravity: number;
}

interface Ring {
  x: number;
  y: number;
  r: number;
  color: string;
  born: number;
  life: number;
  rays: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
/** Images are drawn larger than the shapes so their detail shows. */
const IMAGE_SCALE = 2.6;
const MAX_BITS = 600;

export class ShapeLayer {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D | null;
  private bits: Bit[] = [];
  private rings: Ring[] = [];
  private raf = 0;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private fixed: boolean;

  /** `fixed`: size to the canvas element itself (a preview inside a page) instead of the window. */
  constructor(canvas: HTMLCanvasElement, fixed = false) {
    this.canvas = canvas;
    this.g = canvas.getContext("2d");
    this.fixed = fixed;
  }

  /** Match the canvas to its box and the device pixel ratio. Cheap when nothing changed. */
  private fit() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.fixed ? this.canvas.clientWidth : window.innerWidth;
    const h = this.fixed ? this.canvas.clientHeight : window.innerHeight;
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  private add(x: number, y: number, n: number, size: [number, number], dist: [number, number], life: number, gravity: number, s: BurstStyle) {
    const t = performance.now();
    const off = Math.random() * Math.PI * 2;
    const count = Math.max(1, Math.round(n * s.density));
    const kinds = s.shapes.length ? s.shapes : s.images.length ? [] : (["circle"] as ShapeName[]);
    const pool = kinds.length + s.images.length;
    const colors = s.colors.length ? s.colors : ["#7C5CFF"];
    for (let i = 0; i < count; i++) {
      const k = Math.floor(Math.random() * pool);
      const img = k >= kinds.length ? s.images[k - kinds.length] : null;
      this.bits.push({
        x,
        y,
        angle: off + (i / count) * Math.PI * 2 + rand(-0.35, 0.35),
        dist: rand(dist[0], dist[1]) * (0.6 + 0.4 * s.size),
        size: rand(size[0], size[1]) * s.size,
        rot: rand(0, Math.PI * 2),
        spin: rand(-6, 6) * (img ? 0.4 : 1),
        kind: img ? "circle" : kinds[k],
        img,
        filled: Math.random() < 0.6,
        color: pick(colors),
        born: t,
        life: life * rand(0.85, 1.1),
        gravity,
      });
    }
    if (this.bits.length > MAX_BITS) this.bits.splice(0, this.bits.length - MAX_BITS);
  }

  /** A small burst under a tap. */
  tap(x: number, y: number, s: BurstStyle) {
    this.add(x, y, 6 + Math.floor(Math.random() * 5), [6, 14], [30, 70], 550, 0, s);
    this.start();
  }

  /** One small shape left behind along a bent note's path. */
  trail(x: number, y: number, s: BurstStyle) {
    this.add(x, y, 1, [5, 9], [8, 20], 480, 0, { ...s, density: 1 });
    this.start();
  }

  /** Something new: a bigger burst that falls a little, with an expanding ring. */
  create(x: number, y: number, s: BurstStyle) {
    this.add(x, y, 24 + Math.floor(Math.random() * 13), [7, 16], [80, 180], 900, 90, s);
    this.rings.push({ x, y, r: 120, color: pick(s.colors), born: performance.now(), life: 800, rays: 0 });
    this.start();
  }

  /** Something finished: a ring and a starburst of rays. */
  complete(x: number, y: number, s: BurstStyle) {
    const t = performance.now();
    this.rings.push({ x, y, r: 90, color: pick(s.colors), born: t, life: 750, rays: 0 });
    this.rings.push({ x, y, r: 130, color: pick(s.colors), born: t, life: 700, rays: 14 });
    this.add(x, y, 12, [6, 11], [50, 110], 700, 0, s);
    this.start();
  }

  private start() {
    this.fit();
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.bits = [];
    this.rings = [];
    this.g?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private frame = (now: number) => {
    const g = this.g;
    this.raf = 0;
    if (!g) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    this.bits = this.bits.filter((b) => now - b.born < b.life);
    this.rings = this.rings.filter((r) => now - r.born < r.life);

    for (const b of this.bits) {
      const s = Math.max(0, (now - b.born) / b.life);
      const p = easeOut(s);
      const sec = (now - b.born) / 1000;
      const x = b.x + Math.cos(b.angle) * b.dist * p;
      const y = b.y + Math.sin(b.angle) * b.dist * p + b.gravity * sec * sec;
      g.save();
      g.translate(x, y);
      g.rotate(b.rot + b.spin * sec);
      g.globalAlpha = 1 - s * s;
      const r = (b.size / 2) * (1 - 0.35 * s);
      if (b.img) {
        const side = r * IMAGE_SCALE;
        const k = side / Math.max(b.img.width, b.img.height, 1);
        const w = b.img.width * k;
        const h = b.img.height * k;
        g.drawImage(b.img, -w / 2, -h / 2, w, h);
      } else {
        paintShape(g, b.kind, r, b.color, b.filled);
      }
      g.restore();
    }

    for (const r of this.rings) {
      const s = Math.max(0, (now - r.born) / r.life);
      const rad = 8 + r.r * easeOut(s);
      g.save();
      g.globalAlpha = 1 - s;
      g.strokeStyle = r.color;
      if (r.rays) {
        g.lineWidth = 3;
        g.lineCap = "round";
        g.beginPath();
        for (let i = 0; i < r.rays; i++) {
          const a = (i / r.rays) * Math.PI * 2;
          const inner = rad * 0.55;
          g.moveTo(r.x + Math.cos(a) * inner, r.y + Math.sin(a) * inner);
          g.lineTo(r.x + Math.cos(a) * rad, r.y + Math.sin(a) * rad);
        }
        g.stroke();
      } else {
        g.lineWidth = 3 * (1 - s) + 1;
        g.beginPath();
        g.arc(r.x, r.y, rad, 0, Math.PI * 2);
        g.stroke();
      }
      g.restore();
    }

    if (this.bits.length || this.rings.length) this.raf = requestAnimationFrame(this.frame);
    else g.clearRect(0, 0, this.w, this.h);
  };
}

/** Draw one shape of radius `r` centred on the origin. Rings and sparks are always outlines. */
export function paintShape(g: CanvasRenderingContext2D, kind: ShapeName, r: number, color: string, filled: boolean) {
  g.beginPath();
  switch (kind) {
    case "circle":
    case "ring":
      g.arc(0, 0, r, 0, Math.PI * 2);
      break;
    case "square":
      g.rect(-r, -r, r * 2, r * 2);
      break;
    case "diamond":
      g.moveTo(0, -r * 1.3);
      g.lineTo(r, 0);
      g.lineTo(0, r * 1.3);
      g.lineTo(-r, 0);
      g.closePath();
      break;
    case "triangle":
    case "hexagon": {
      const n = kind === "triangle" ? 3 : 6;
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
        if (i) g.lineTo(Math.cos(a) * r * 1.15, Math.sin(a) * r * 1.15);
        else g.moveTo(Math.cos(a) * r * 1.15, Math.sin(a) * r * 1.15);
      }
      g.closePath();
      break;
    }
    case "star": {
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
        const rr = i % 2 ? r * 0.5 : r * 1.25;
        if (i) g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
        else g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      g.closePath();
      break;
    }
    case "spark":
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        g.moveTo(Math.cos(a) * r * 0.25, Math.sin(a) * r * 0.25);
        g.lineTo(Math.cos(a) * r * 1.3, Math.sin(a) * r * 1.3);
      }
      break;
  }
  if (filled && kind !== "ring" && kind !== "spark") {
    g.fillStyle = color;
    g.fill();
  } else {
    g.strokeStyle = color;
    g.lineWidth = kind === "spark" ? 2.2 : 2;
    g.lineCap = "round";
    g.stroke();
  }
}
