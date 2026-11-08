import { useEffect, useState } from "react";
import { engine } from "../sync/engine";
import type { ImageShape } from "./prefs";

/**
 * Image shapes fetched once from the hub (the route needs the bearer header) and kept for the session: an ImageBitmap
 * for the shapes canvas and an object URL for Settings. A failed fetch is retried on the next ask after a minute.
 */

interface Entry {
  bitmap: ImageBitmap | null;
  url: string | null;
  failedAt: number;
  loading: Promise<void> | null;
}

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
const RETRY_MS = 60_000;

function changed() {
  for (const l of listeners) l();
}

function load(id: string): Entry {
  let e = cache.get(id);
  if (e && (e.bitmap || e.loading || Date.now() - e.failedAt < RETRY_MS)) return e;
  if (!e) {
    e = { bitmap: null, url: null, failedAt: 0, loading: null };
    cache.set(id, e);
  }
  const entry = e;
  // No hub client yet (still starting): ask again on the next call.
  const c = engine.client;
  if (!c) return entry;
  entry.loading = (async () => {
    try {
      const blob = await c.feelImage(id);
      entry.url = URL.createObjectURL(blob);
      entry.bitmap = typeof createImageBitmap === "function" ? await createImageBitmap(blob) : null;
    } catch {
      entry.failedAt = Date.now();
    } finally {
      entry.loading = null;
      changed();
    }
  })();
  return entry;
}

/** Decoded bitmaps of the enabled images that are ready now; the rest start loading for the next burst. */
export function enabledBitmaps(images: ImageShape[]): ImageBitmap[] {
  const out: ImageBitmap[] = [];
  for (const img of images) {
    if (!img.enabled) continue;
    const e = load(img.id);
    if (e.bitmap) out.push(e.bitmap);
  }
  return out;
}

/** Start fetching every listed image so the first burst after launch already has them. */
export function preloadImages(images: ImageShape[]): void {
  for (const img of images) if (img.enabled) load(img.id);
}

/** Drop a deleted image. */
export function forgetImage(id: string): void {
  const e = cache.get(id);
  if (!e) return;
  if (e.url) URL.revokeObjectURL(e.url);
  e.bitmap?.close?.();
  cache.delete(id);
  changed();
}

/** An object URL for an image shape, for an <img> in Settings. Null while loading or when it cannot be fetched. */
export function useImageUrl(id: string): string | null {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    // The hub client appears a moment after launch; try again then.
    const off = engine.subscribe(l);
    return () => {
      listeners.delete(l);
      off();
    };
  }, []);
  return load(id).url;
}

/**
 * Shrink an image file so its longest side is at most `max` px, keeping transparency, and encode it as PNG. Any type
 * the browser can decode works (JPEG, GIF, SVG, AVIF); the result is always PNG.
 */
export async function shrinkImage(file: Blob, max = 256): Promise<Blob> {
  let src: CanvasImageSource & { width: number; height: number };
  let close = () => {};
  try {
    const bm = await createImageBitmap(file);
    src = bm;
    close = () => bm.close();
  } catch {
    // SVG and a few others decode only through an <img>.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      src = img;
    } catch {
      URL.revokeObjectURL(url);
      throw new Error("That file is not an image this browser can read.");
    }
    close = () => URL.revokeObjectURL(url);
  }
  try {
    const w0 = src.width || max;
    const h0 = src.height || max;
    const k = Math.min(1, max / Math.max(w0, h0));
    const w = Math.max(1, Math.round(w0 * k));
    const h = Math.max(1, Math.round(h0 * k));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("Could not draw the image.");
    g.clearRect(0, 0, w, h);
    g.imageSmoothingQuality = "high";
    g.drawImage(src, 0, 0, w, h);
    return await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("Could not convert the image."))), "image/png"));
  } finally {
    close();
  }
}
