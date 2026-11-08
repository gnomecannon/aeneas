import crypto from "node:crypto";
import { StoreError } from "../store.js";

/**
 * Helpers for synced data: a stable id per synced thing, name matching, and fetching with a timeout.
 */

/** A UUID (version 5 layout, SHA-1) for an imported thing, so importing it again finds the same entity. */
export function stableId(key: string): string {
  const h = crypto.createHash("sha1").update(`everythingapp:${key}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Lower case, accents, apostrophes and punctuation gone, single spaces: for matching names typed by hand with imported ones. */
export function norm(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/['\u2019]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Fetch with a timeout; a network failure is a 502 naming the service. */
export async function fetchWithTimeout(f: typeof fetch, url: string, service: string, init: RequestInit = {}, ms = 20_000): Promise<Response> {
  try {
    return await f(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    throw new StoreError(502, `${service} could not be reached: ${(e as Error).message}`);
  }
}
