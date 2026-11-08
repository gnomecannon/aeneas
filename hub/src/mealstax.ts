import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { StoreError } from "./store.js";

/**
 * The meals tax for the bill splitter, from where the device is. The device sends an approximate position (rounded to
 * about a kilometre) to its own hub only; the hub finds the state with the US Census state outlines in
 * `hub/assets/us-states.json` (public domain, simplified) and answers with that state's rate on restaurant meals. No
 * map service is asked, and the position is not stored or logged.
 *
 * Rates: the state's own rate on a restaurant meal as of 2026-07-01 (Tax Foundation's state sales tax table, with the
 * states that tax meals at their own rate: CT, DC, ME, NH, RI, VT). Cities and counties can add their own, so the
 * answer says it is the state's part.
 */
export const MEALS_TAX: Record<string, { name: string; pct: number }> = {
  AL: { name: "Alabama", pct: 4 }, AK: { name: "Alaska", pct: 0 }, AZ: { name: "Arizona", pct: 5.6 },
  AR: { name: "Arkansas", pct: 6.5 }, CA: { name: "California", pct: 7.25 }, CO: { name: "Colorado", pct: 2.9 },
  CT: { name: "Connecticut", pct: 7.35 }, DE: { name: "Delaware", pct: 0 }, DC: { name: "District of Columbia", pct: 10 },
  FL: { name: "Florida", pct: 6 }, GA: { name: "Georgia", pct: 4 }, HI: { name: "Hawaii", pct: 4 },
  ID: { name: "Idaho", pct: 6 }, IL: { name: "Illinois", pct: 6.25 }, IN: { name: "Indiana", pct: 7 },
  IA: { name: "Iowa", pct: 6 }, KS: { name: "Kansas", pct: 6.5 }, KY: { name: "Kentucky", pct: 6 },
  LA: { name: "Louisiana", pct: 5 }, ME: { name: "Maine", pct: 8 }, MD: { name: "Maryland", pct: 6 },
  MA: { name: "Massachusetts", pct: 6.25 }, MI: { name: "Michigan", pct: 6 }, MN: { name: "Minnesota", pct: 6.875 },
  MS: { name: "Mississippi", pct: 7 }, MO: { name: "Missouri", pct: 4.225 }, MT: { name: "Montana", pct: 0 },
  NE: { name: "Nebraska", pct: 5.5 }, NV: { name: "Nevada", pct: 6.85 }, NH: { name: "New Hampshire", pct: 8.5 },
  NJ: { name: "New Jersey", pct: 6.625 }, NM: { name: "New Mexico", pct: 4.875 }, NY: { name: "New York", pct: 4 },
  NC: { name: "North Carolina", pct: 4.75 }, ND: { name: "North Dakota", pct: 5 }, OH: { name: "Ohio", pct: 5.75 },
  OK: { name: "Oklahoma", pct: 4.5 }, OR: { name: "Oregon", pct: 0 }, PA: { name: "Pennsylvania", pct: 6 },
  RI: { name: "Rhode Island", pct: 8 }, SC: { name: "South Carolina", pct: 6 }, SD: { name: "South Dakota", pct: 4.2 },
  TN: { name: "Tennessee", pct: 7 }, TX: { name: "Texas", pct: 6.25 }, UT: { name: "Utah", pct: 6.1 },
  VT: { name: "Vermont", pct: 9 }, VA: { name: "Virginia", pct: 5.3 }, WA: { name: "Washington", pct: 6.5 },
  WV: { name: "West Virginia", pct: 6 }, WI: { name: "Wisconsin", pct: 5 }, WY: { name: "Wyoming", pct: 4 },
};

/** A state's outline: polygons, each a list of rings of [longitude, latitude] (the first ring the outside). */
export type StateShapes = Record<string, number[][][][]>;

const SHAPES_FILE = fileURLToPath(new URL("../assets/us-states.json", import.meta.url));
let cached: StateShapes | null = null;

export function loadShapes(file = SHAPES_FILE): StateShapes | null {
  if (cached && file === SHAPES_FILE) return cached;
  try {
    const shapes = JSON.parse(fs.readFileSync(file, "utf8")) as StateShapes;
    if (file === SHAPES_FILE) cached = shapes;
    return shapes;
  } catch { return null; }
}

/** Even-odd test over every ring of a polygon, so a hole (a lake, an enclave) is outside. */
function inPolygon(lon: number, lat: number, rings: number[][][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** The two-letter code of the state at a position, or null outside every state. */
export function stateAt(lat: number, lon: number, shapes: StateShapes): string | null {
  for (const [code, polygons] of Object.entries(shapes)) {
    for (const rings of polygons) if (inPolygon(lon, lat, rings)) return code;
  }
  return null;
}

/** POST /calc/meals-tax `{ lat, lon }` → `{ state, name, pct, note }`. 404 outside the US states, 503 without the outlines. */
export function mealsTax(body: Record<string, unknown>, shapes: StateShapes | null = loadShapes()): { state: string; name: string; pct: number; note: string } {
  const lat = typeof body.lat === "number" ? body.lat : NaN;
  const lon = typeof body.lon === "number" ? body.lon : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new StoreError(422, "lat and lon must be numbers");
  if (!shapes) throw new StoreError(503, "the state outlines are not installed on this hub");
  // Rounded here too, so a precise position sent by an older app is never used as more than it needs to be.
  const code = stateAt(Math.round(lat * 100) / 100, Math.round(lon * 100) / 100, shapes);
  const rate = code ? MEALS_TAX[code] : undefined;
  if (!code || !rate) throw new StoreError(404, "not in a US state");
  return { state: code, name: rate.name, pct: rate.pct, note: `${rate.name}'s rate on restaurant meals. Your city or county may add its own.` };
}
