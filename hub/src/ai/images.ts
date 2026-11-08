import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StoreError } from "../store.js";

/**
 * Images attached to assistant chats. Stored once under <data>/ai-images/<id>.<ext>, referenced by id from the
 * session, sent to the vision model as base64. The id is the first 32 hex characters of the SHA-256, so the same
 * screenshot sent twice is stored once.
 */

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const TYPES: { ext: string; mime: string; test: (b: Buffer) => boolean }[] = [
  { ext: "jpg", mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "png", mime: "image/png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "gif", mime: "image/gif", test: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  { ext: "webp", mime: "image/webp", test: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];
const ID = /^[0-9a-f]{32}$/;

export class ImageStore {
  constructor(private dir: string) {}

  /** Decode, check the type by its magic bytes, store. Returns the id. */
  save(input: string): string {
    const b64 = input.replace(/^data:[^;,]+;base64,/, "").replace(/\s+/g, "");
    return this.saveBuffer(Buffer.from(b64, "base64"));
  }

  /** Store raw bytes (gallery uploads may be larger than chat attachments). */
  saveBuffer(buf: Buffer, maxBytes = MAX_IMAGE_BYTES): string {
    if (buf.length < 16) throw new StoreError(422, "image is empty or not base64");
    if (buf.length > maxBytes) throw new StoreError(413, `image is over ${maxBytes / 1024 / 1024} MB`);
    const type = TYPES.find((t) => t.test(buf));
    if (!type) throw new StoreError(422, "image must be JPEG, PNG, GIF or WebP");
    const id = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 32);
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${id}.${type.ext}`);
    // Written beside and renamed: a cut-off write left a short file under the final name, and since an existing
    // file is never written again, the picture stayed broken for good. One of the wrong size is replaced.
    let ok = false;
    try { ok = fs.statSync(file).size === buf.length; } catch { /* not there */ }
    if (!ok) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
    }
    return id;
  }

  private find(id: string): { file: string; mime: string } | null {
    if (!ID.test(id)) return null;
    for (const t of TYPES) {
      const file = path.join(this.dir, `${id}.${t.ext}`);
      if (fs.existsSync(file)) return { file, mime: t.mime };
    }
    return null;
  }

  read(id: string): { data: Buffer; mime: string } | null {
    const f = this.find(id);
    return f ? { data: fs.readFileSync(f.file), mime: f.mime } : null;
  }

  /** Delete an image file. True when one was removed. */
  remove(id: string): boolean {
    const f = this.find(id);
    if (!f) return false;
    fs.rmSync(f.file, { force: true });
    return true;
  }

  base64(id: string): string | null {
    const f = this.read(id);
    return f ? f.data.toString("base64") : null;
  }
}
