import type { Context } from "hono";
import { StoreError } from "./store.js";

/** Parse the request body as a JSON object. Invalid JSON and non-object bodies are a 400, consistently. */
export async function readJsonObject<T extends Record<string, unknown> = Record<string, unknown>>(c: Context): Promise<T> {
  let body: unknown;
  try { body = await c.req.json(); } catch { throw new StoreError(400, "invalid JSON body"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new StoreError(400, "JSON body must be an object");
  return body as T;
}
