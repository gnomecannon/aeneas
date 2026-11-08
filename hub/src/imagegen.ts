import { randomUUID } from "node:crypto";
import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";

/**
 * Client for the shared image service (a separate gateway, which several projects can share). The hub holds this
 * project's token; devices never see it. Results are copied into the hub's image store, so chats and screens show
 * them through `GET /ai/images/:id` like any other image, and the gateway keeps the original.
 */

export interface ImageJob {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  status_label: string;
  reason: string | null;
  progress: number | null;
  error: string | null;
  result_asset: string | null;
  measured: Record<string, unknown> | null;
  plan: Record<string, any>;
  /** The hub image id of the result, once it is copied over. */
  image_id?: string;
}

const TIMEOUT_MS = 20_000;

export function imagesEnabled(hub: Hub): boolean {
  return !!hub.cfg.imageServiceUrl && !!hub.cfg.imageServiceToken;
}

async function call(hub: Hub, method: string, path: string, body?: unknown, extra: Record<string, string> = {}, raw?: Uint8Array): Promise<any> {
  if (!imagesEnabled(hub)) throw new StoreError(503, "image generation is not set up on this hub (EA_IMAGE_SERVICE_URL)");
  let res: Response;
  try {
    res = await hub.fetch(`${hub.cfg.imageServiceUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${hub.cfg.imageServiceToken}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra },
      body: raw ? Buffer.from(raw) : body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new StoreError(503, "the image service is not answering", (e as Error).message);
  }
  if (path.startsWith("/v1/assets/") && method === "GET" && res.ok) return new Uint8Array(await res.arrayBuffer());
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A refused plan names each control that cannot run as asked; the message carries them so every client shows why.
    const detail = (data as any).detail;
    const why = Array.isArray(detail) ? detail.map((d: any) => String(d.message)).join(" ") : "";
    throw new StoreError(res.status === 401 || res.status === 403 ? 502 : res.status, why || String((data as any).message ?? `image service ${res.status}`), detail);
  }
  return data;
}

export const imageCapabilities = (hub: Hub) => call(hub, "GET", "/v1/capabilities");
export const imagePlan = (hub: Hub, req: Record<string, unknown>) => call(hub, "POST", "/v1/plan", req);

export async function imageSubmit(hub: Hub, req: Record<string, unknown>, idempotencyKey?: string): Promise<ImageJob[]> {
  const out = await call(hub, "POST", "/v1/jobs", req, idempotencyKey ? { "idempotency-key": idempotencyKey } : {});
  return out.jobs as ImageJob[];
}

/** Result asset to hub image id, so a finished job polled again is not downloaded again. */
const resultIds = new Map<string, string>();

/** One job; a finished one gets its result copied into the hub's image store (once). */
export async function imageJob(hub: Hub, id: string): Promise<ImageJob> {
  if (!/^[0-9a-f]{32}$/.test(id)) throw new StoreError(404, "no such image job");
  const job = (await call(hub, "GET", `/v1/jobs/${id}`)) as ImageJob;
  if (job.status === "succeeded" && job.result_asset) {
    const known = resultIds.get(job.result_asset);
    if (known && hub.ai.images.read(known)) { job.image_id = known; return job; }
    const bytes = (await call(hub, "GET", `/v1/assets/${job.result_asset}`)) as Uint8Array;
    job.image_id = hub.ai.images.save(Buffer.from(bytes).toString("base64"));
    resultIds.set(job.result_asset, job.image_id);
  }
  return job;
}

export const imageJobs = async (hub: Hub, limit = 30): Promise<ImageJob[]> => (await call(hub, "GET", `/v1/jobs?limit=${limit}`)).jobs;
export const imageCancel = (hub: Hub, id: string) => call(hub, "POST", `/v1/jobs/${id}/cancel`, {});

/** The service takes references as PNG, JPEG or WebP up to 20 MB (SERVICE_HANDOFF.md). */
const REFERENCE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const REFERENCE_MAX_BYTES = 20 * 1024 * 1024;
export const MAX_REFERENCES = 8;
/** Hub image id to the service's asset id: a picture used again as a reference is not uploaded again. */
const uploaded = new Map<string, string>();

/** A reference image (a hub image id) uploaded to the service; returns the service's asset id. */
export async function imageUploadReference(hub: Hub, hubImageId: string): Promise<string> {
  const known = uploaded.get(hubImageId);
  if (known) return known;
  const img = hub.ai.images.read(hubImageId);
  if (!img) throw new StoreError(404, `image ${hubImageId} not found`);
  // Checked here, before anything is sent: a GIF or a 21 MB picture was uploaded and only then refused.
  if (!REFERENCE_TYPES.has(img.mime)) throw new StoreError(422, `reference ${hubImageId} is ${img.mime}; the image service takes PNG, JPEG or WebP`);
  if (img.data.length > REFERENCE_MAX_BYTES) throw new StoreError(422, `reference ${hubImageId} is over 20 MB`);
  const out = await call(hub, "POST", "/v1/assets", undefined, { "content-type": img.mime }, new Uint8Array(img.data));
  uploaded.set(hubImageId, out.id as string);
  return out.id as string;
}

/** References for one request: each picture once, at most MAX_REFERENCES, uploaded one at a time. */
export async function uploadReferences(hub: Hub, ids: unknown[]): Promise<string[]> {
  const unique = [...new Set(ids.map(String))];
  if (unique.length > MAX_REFERENCES) throw new StoreError(422, `at most ${MAX_REFERENCES} reference images`);
  const out: string[] = [];
  for (const id of unique) out.push(await imageUploadReference(hub, id));
  return out;
}

/** Submit and wait up to `waitMs` (the assistant waits; screens poll instead). */
export async function imageGenerateAndWait(hub: Hub, req: Record<string, unknown>, waitMs: number, onStatus?: (label: string) => void): Promise<ImageJob[]> {
  // The handoff asks every submit for an Idempotency-Key, so a retried request never starts a second job.
  const jobs = await imageSubmit(hub, req, randomUUID());
  const deadline = Date.now() + waitMs;
  let current = jobs;
  let last = "";
  while (Date.now() < deadline) {
    current = await Promise.all(current.map((j) => (j.status === "succeeded" && j.image_id) || j.status === "failed" || j.status === "canceled" ? j : imageJob(hub, j.id)));
    const label = current.map((j) => j.status_label).join("; ");
    if (label !== last) { onStatus?.(label); last = label; }
    if (current.every((j) => j.status !== "queued" && j.status !== "running")) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return current;
}
