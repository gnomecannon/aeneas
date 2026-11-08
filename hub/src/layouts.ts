import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { StoreError } from "./store.js";
import { ImageStore } from "./ai/images.js";
import { imageInfo } from "./gallery.js";
import { errCode } from "./logsafe.js";

/**
 * Layout sketches: a picture of a screen (from any device) with parts of it lifted and moved, resized, taken away,
 * or new boxes added, to show how the screen should be laid out. Kept under <data>/layouts/: one <id>.json each and
 * the pictures (the screen and the arranged result) in pictures/, stored once by their hash like chat images.
 * Not entities: they never sync to devices, and a few megabytes of screenshots stay on the hub.
 */

export const MAX_PICTURE_BYTES = 20 * 1024 * 1024;
export const MAX_PIECES = 300;
export const PLATFORMS = ["iphone", "ipad", "mac", "watch", "windows", "web", "other"] as const;
export const STATUSES = ["draft", "ready", "done"] as const;

const num = z.number().finite();
const Rect = z.object({ x: num, y: num, w: num.positive(), h: num.positive() }).strict();
export type LayoutRect = z.infer<typeof Rect>;

const Piece = z.object({
  id: z.string().min(1).max(40),
  /** The part of the picture it is; null for a new box the screen does not have yet. */
  from: Rect.nullable(),
  /** Where it goes; null to take it away. */
  to: Rect.nullable(),
  /** Text on a new box, or a name for a part. */
  label: z.string().max(200).optional(),
  note: z.string().max(2000).optional(),
}).strict();
export type LayoutPiece = z.infer<typeof Piece>;

const PICTURE_ID = z.string().regex(/^[0-9a-f]{32}$/);

const Create = z.object({
  title: z.string().trim().min(1).max(120),
  platform: z.enum(PLATFORMS),
  screen: z.string().trim().max(80).default(""),
  picture_id: PICTURE_ID,
  note: z.string().max(4000).default(""),
  pieces: z.array(Piece).max(MAX_PIECES).default([]),
}).strict();

const Update = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  platform: z.enum(PLATFORMS).optional(),
  screen: z.string().trim().max(80).optional(),
  note: z.string().max(4000).optional(),
  pieces: z.array(Piece).max(MAX_PIECES).optional(),
  status: z.enum(STATUSES).optional(),
  /** The arranged result as a picture (uploaded first), or null to drop it. */
  after_id: PICTURE_ID.nullable().optional(),
}).strict();

export interface Layout {
  id: string;
  title: string;
  platform: (typeof PLATFORMS)[number];
  screen: string;
  status: (typeof STATUSES)[number];
  picture_id: string;
  width: number;
  height: number;
  after_id: string | null;
  note: string;
  pieces: LayoutPiece[];
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
export type LayoutSummary = Omit<Layout, "pieces" | "deleted_at"> & { pieces_count: number };

const ID = /^[0-9a-f]{16}$/;

function zodMessage(e: z.ZodError): string {
  return e.issues.slice(0, 3).map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
}

export class LayoutStore {
  readonly pictures: ImageStore;
  constructor(private dir: string) {
    this.pictures = new ImageStore(path.join(dir, "pictures"));
  }

  /** Store a picture (PNG, JPEG or WebP) and say how big it is. */
  savePicture(buf: Buffer): { picture_id: string; width: number; height: number } {
    const info = imageInfo(buf);
    if (!info.mime || info.mime === "image/gif") throw new StoreError(422, "the picture must be PNG, JPEG or WebP");
    if (!info.width || !info.height || info.width > 16384 || info.height > 16384) throw new StoreError(422, "the picture's size could not be read");
    const picture_id = this.pictures.saveBuffer(buf, MAX_PICTURE_BYTES);
    return { picture_id, width: info.width, height: info.height };
  }

  private size(pictureId: string): { width: number; height: number } {
    const p = this.pictures.read(pictureId);
    if (!p) throw new StoreError(422, "no such picture: upload it to /layouts/pictures first");
    const info = imageInfo(p.data);
    if (!info.width || !info.height) throw new StoreError(422, "the picture's size could not be read");
    return { width: info.width, height: info.height };
  }

  private file(id: string): string { return path.join(this.dir, `${id}.json`); }

  private write(l: Layout): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const f = this.file(l.id);
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(l, null, 1), { mode: 0o600 });
    fs.renameSync(`${f}.tmp`, f);
  }

  get(id: string): Layout | null {
    if (!ID.test(id)) return null;
    try {
      const l = JSON.parse(fs.readFileSync(this.file(id), "utf8")) as Layout;
      return l.deleted_at ? null : l;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new StoreError(500, `layout ${id} could not be read: ${(e as Error).message}`);
    }
  }

  /** Every sketch not deleted, the latest change first. A damaged file is skipped (and logged), not the whole list. */
  list(): LayoutSummary[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir).filter((n) => /^[0-9a-f]{16}\.json$/.test(n)); } catch { return []; }
    const out: LayoutSummary[] = [];
    for (const n of names) {
      try {
        const l = JSON.parse(fs.readFileSync(path.join(this.dir, n), "utf8")) as Layout;
        if (l.deleted_at) continue;
        const { pieces, deleted_at: _d, ...rest } = l;
        out.push({ ...rest, pieces_count: pieces.length });
      } catch (e) {
        console.error(`[layouts] ${n} skipped: ${errCode(e)}`);
      }
    }
    return out.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  }

  create(body: unknown): Layout {
    const p = Create.safeParse(body);
    if (!p.success) throw new StoreError(422, zodMessage(p.error));
    const at = new Date().toISOString();
    const l: Layout = { id: crypto.randomBytes(8).toString("hex"), ...p.data, ...this.size(p.data.picture_id), status: "draft", after_id: null, created_at: at, updated_at: at, deleted_at: null };
    checkPieces(l.pieces);
    this.write(l);
    return l;
  }

  update(id: string, body: unknown): Layout {
    const l = this.get(id);
    if (!l) throw new StoreError(404, "layout not found");
    const p = Update.safeParse(body);
    if (!p.success) throw new StoreError(422, zodMessage(p.error));
    if (p.data.after_id) this.size(p.data.after_id);
    if (p.data.pieces) checkPieces(p.data.pieces);
    const next: Layout = { ...l, ...p.data, updated_at: new Date().toISOString() } as Layout;
    this.write(next);
    return next;
  }

  remove(id: string): void {
    const l = this.get(id);
    if (!l) throw new StoreError(404, "layout not found");
    this.write({ ...l, deleted_at: new Date().toISOString() });
  }
}

function checkPieces(pieces: LayoutPiece[]): void {
  const ids = new Set<string>();
  for (const p of pieces) {
    if (ids.has(p.id)) throw new StoreError(422, `pieces: id ${p.id} is used twice`);
    ids.add(p.id);
    if (!p.from && !p.to) throw new StoreError(422, `pieces: ${p.id} has neither from nor to`);
  }
}
