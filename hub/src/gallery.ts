import type { Entity } from "@everythingapp/shared";
import type { Hub } from "./hub.js";
import type { ImageStore } from "./ai/images.js";
import type { Store } from "./store.js";
import { imageJob, imageJobs, imagesEnabled, type ImageJob } from "./imagegen.js";
import { errCode } from "./logsafe.js";

/**
 * The Image Gallery: one synced `image` record per picture, in two bins. Generated images arrive by themselves (a
 * finished job is collected even when no screen is open); attached chat images and uploads land in Saved. A generated
 * record the owner deleted is never brought back; a picture they add again is filed again. Bytes stay in the hub's image
 * store, shared with chats.
 */

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

type Source = "generated" | "attached" | "uploaded" | "downloaded" | "photos";

/** Width, height and type from the file header (PNG, JPEG, GIF, WebP); empty when unknown. */
export function imageInfo(b: Buffer): { width?: number; height?: number; mime?: string } {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { mime: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 10 && b.subarray(0, 4).toString("latin1") === "GIF8") return { mime: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length > 30 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") {
    const c = b.subarray(12, 16).toString("latin1");
    if (c === "VP8X") return { mime: "image/webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (c === "VP8 ") return { mime: "image/webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (c === "VP8L") { const n = b.readUInt32LE(21); return { mime: "image/webp", width: (n & 0x3fff) + 1, height: ((n >> 14) & 0x3fff) + 1 }; }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { mime: "image/jpeg", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
    return { mime: "image/jpeg" };
  }
  return {};
}

/** What recording needs: the store and the image bytes (the assistant gateway has both without the whole hub). */
export type GalleryHost = { store: Store; ai: { images: ImageStore } };

function existing(hub: GalleryHost, match: (e: Entity) => boolean, includeDeleted = true): Entity | undefined {
  return hub.store.list({ kind: "image", includeDeleted, limit: 100000 }).find(match);
}

/**
 * Add a picture to the gallery once. Returns the record: for a generated picture an earlier one wins, even a deleted
 * one (the collector must not bring back what the owner deleted). A picture the owner uploads or attaches again after
 * deleting it is filed again: the image id is the hash of the bytes, so the deleted record used to win and the same
 * picture could never be added back.
 */
export function recordImage(hub: GalleryHost, imageId: string, source: Source, extra: Record<string, unknown> = {}): Entity {
  const generated = source === "generated";
  const same = existing(hub, (e) => e.fields.image_id === imageId && (generated ? e.fields.source === "generated" : e.fields.source !== "generated"), generated);
  if (same) return same;
  const img = hub.ai.images.read(imageId);
  const info = img ? imageInfo(img.data) : {};
  return hub.store.create("image", { image_id: imageId, source, ...(info.width ? { width: info.width, height: info.height } : {}), ...(img ? { mime: img.mime, bytes: img.data.length } : {}), ...extra });
}

export function recordGenerated(hub: GalleryHost, job: ImageJob): Entity | null {
  if (!job.image_id) return null;
  const done = existing(hub, (e) => e.fields.job_id === job.id);
  if (done) return done;
  const p = job.plan ?? {};
  const m = (job.measured ?? {}) as Record<string, any>;
  const prompt = String(p.prompt_original ?? "");
  return recordImage(hub, job.image_id, "generated", {
    title: prompt.split("\n")[0].slice(0, 80) || "Generated image", prompt, job_id: job.id,
    ...(m.upsampled_prompt ? { caption: String(m.upsampled_prompt) } : {}),
    ...(p.workflow ? { workflow: String(p.workflow) } : {}), ...(m.worker ? { worker: String(m.worker) } : {}),
    ...(typeof p.seed === "number" ? { seed: p.seed } : {}),
  });
}

/** Collect finished jobs into the gallery. Runs on a timer; also safe to call any time. */
export async function collectGenerated(hub: Hub): Promise<number> {
  if (!imagesEnabled(hub)) return 0;
  let added = 0;
  const known = new Set(hub.store.list({ kind: "image", includeDeleted: true, limit: 100000 }).map((e) => String(e.fields.job_id ?? "")));
  for (const j of await imageJobs(hub, 30)) {
    if (j.status !== "succeeded" || !j.result_asset || known.has(j.id)) continue;
    // One job whose picture is gone (or cannot be read) is skipped; it stopped every job listed after it.
    try {
      const full = await imageJob(hub, j.id);
      if (recordGenerated(hub, full)) added++;
    } catch (e) { console.error(`[gallery] job ${j.id} skipped: ${errCode(e)}`); }
  }
  return added;
}

export function startGalleryJob(hub: Hub, everyMs = 20_000): () => void {
  let busy = false;
  const t = setInterval(() => {
    if (busy || !hub.modules.on("images")) return;
    busy = true;
    collectGenerated(hub).catch((e) => console.error(`[gallery] collect failed: ${errCode(e)}`)).finally(() => { busy = false; });
  }, everyMs);
  return () => clearInterval(t);
}
