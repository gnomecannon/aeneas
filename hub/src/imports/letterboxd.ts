import type { Hub } from "../hub.js";
import { StoreError } from "../store.js";
import { fetchWithTimeout, norm, stableId } from "./util.js";

/**
 * Letterboxd has no open API: films come from the member's public diary feed (letterboxd.com/<user>/rss/, about the
 * newest 50 entries), read every hour, each landing on one `film` entity per title and year.
 */

export interface FilmInput {
  title: string;
  year?: number;
  watched_on?: string[];
  watched?: boolean;
  watchlist?: boolean;
  rating?: number;
  liked?: boolean;
  review?: string;
  tags?: string[];
  url?: string;
  tmdb_id?: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const yearOf = (s: string | undefined) => (s && /^\d{4}$/.test(s.trim()) ? Number(s.trim()) : undefined);
const ratingOf = (s: string | undefined) => {
  const n = Number(s);
  return Number.isFinite(n) && n >= 0.5 && n <= 5 ? Math.round(n * 2) / 2 : undefined;
};
export const filmKey = (title: string, year?: number) => `film:${norm(title)}:${year ?? ""}`;

/** Fold several partial records of one film together (later ones win for rating, review and url). */
function fold(into: FilmInput, add: FilmInput): FilmInput {
  return {
    title: into.title || add.title,
    year: into.year ?? add.year,
    watched_on: [...new Set([...(into.watched_on ?? []), ...(add.watched_on ?? [])])].filter((d) => DAY.test(d)).sort(),
    watched: into.watched || add.watched || undefined,
    watchlist: add.watchlist ?? into.watchlist,
    rating: add.rating ?? into.rating,
    liked: add.liked ?? into.liked,
    review: add.review ?? into.review,
    tags: [...new Set([...(into.tags ?? []), ...(add.tags ?? [])])],
    url: add.url ?? into.url,
    tmdb_id: add.tmdb_id ?? into.tmdb_id,
  };
}

/** Write films, merging with what is there. Returns how many were created and changed. */
export function upsertFilms(hub: Hub, films: FilmInput[]): { created: number; updated: number } {
  let created = 0;
  let updated = 0;
  // Films the owner added by hand (or the assistant did), by title: Letterboxd's copy of one fills it in instead of
  // making a second entry for the same film.
  let byHand: Map<string, { id: string; year?: number }[]> | null = null;
  const handMade = (title: string, year?: number) => {
    if (!byHand) {
      byHand = new Map();
      for (const e of hub.store.list({ kind: "film", limit: 100000 })) {
        if (e.fields.source === "letterboxd") continue;
        const k = norm(String(e.fields.title ?? ""));
        byHand.set(k, [...(byHand.get(k) ?? []), { id: e.id, year: typeof e.fields.year === "number" ? e.fields.year : undefined }]);
      }
    }
    const list = byHand.get(norm(title)) ?? [];
    return list.find((x) => x.year === year) ?? list.find((x) => x.year === undefined || year === undefined);
  };
  for (const f of films) {
    if (!f.title.trim()) continue;
    const own = hub.store.get(stableId(filmKey(f.title, f.year)));
    const hand = own ? undefined : handMade(f.title, f.year);
    const id = hand?.id ?? stableId(filmKey(f.title, f.year));
    const cur = hand ? hub.store.get(hand.id) : own;
    if (cur?.deleted_at) continue;
    const prev = (cur?.fields ?? {}) as FilmInput & { watched_on?: string[] };
    const m = fold({ ...prev, title: prev.title ?? f.title }, f);
    const watchedOn = m.watched_on ?? [];
    const fields: Record<string, unknown> = {
      title: m.title.trim(),
      ...(m.year ? { year: m.year } : {}),
      watched_on: watchedOn,
      ...(watchedOn.length ? { last_watched: watchedOn[watchedOn.length - 1] } : {}),
      watched: !!(m.watched || watchedOn.length),
      ...(m.watchlist !== undefined ? { watchlist: m.watchlist } : {}),
      ...(m.rating !== undefined ? { rating: m.rating } : {}),
      ...(m.liked !== undefined ? { liked: m.liked } : {}),
      ...(m.review ? { review: m.review } : {}),
      tags: m.tags ?? [],
      ...(m.url ? { url: m.url } : {}),
      ...(m.tmdb_id ? { tmdb_id: m.tmdb_id } : {}),
      source: "letterboxd",
    };
    if (!cur) {
      hub.store.create("film", fields, "personal", id);
      created++;
      continue;
    }
    // On a film the owner made, what they wrote (a rating, a review, the title's spelling) stays; the diary adds to it.
    const theirs = (k: string) => !!hand && cur.fields[k] !== undefined && !["watched_on", "last_watched", "watched", "tags"].includes(k);
    const changed = Object.fromEntries(Object.entries(fields).filter(([k, v]) => k !== "source" || !hand).filter(([k]) => !theirs(k)).filter(([k, v]) => JSON.stringify(cur.fields[k]) !== JSON.stringify(v)));
    if (Object.keys(changed).length) {
      hub.store.patch(id, changed);
      updated++;
    }
  }
  return { created, updated };
}

// ---------- diary feed ----------

const decode = (s: string) =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const tag = (block: string, name: string) => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? decode(m[1]).trim() : undefined;
};

/** Diary entries from the feed. List posts and other items without a film title are skipped. */
export function filmsFromRss(xml: string): FilmInput[] {
  const out: FilmInput[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const title = tag(b, "letterboxd:filmTitle");
    if (!title) continue;
    const day = tag(b, "letterboxd:watchedDate");
    // The description is the poster, then the review in paragraphs, or "Watched on <date>." when there is none.
    const html = tag(b, "description") ?? "";
    const paras = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((p) => p[1].replace(/<[^>]+>/g, "").trim()).filter((t) => t && !/^Watched on /.test(t));
    const tmdb = Number(tag(b, "tmdb:movieId"));
    out.push({
      title,
      year: yearOf(tag(b, "letterboxd:filmYear")),
      watched_on: day && DAY.test(day) ? [day] : [],
      watched: true,
      rating: ratingOf(tag(b, "letterboxd:memberRating")),
      ...(tag(b, "letterboxd:memberLike") === "Yes" ? { liked: true } : {}),
      ...(paras.length ? { review: paras.join("\n\n") } : {}),
      url: tag(b, "link"),
      ...(Number.isInteger(tmdb) && tmdb > 0 ? { tmdb_id: tmdb } : {}),
    });
  }
  return out;
}

async function fetchRss(hub: Hub, username: string): Promise<string> {
  const r = await fetchWithTimeout(hub.fetch, `https://letterboxd.com/${encodeURIComponent(username)}/rss/`, "Letterboxd", { headers: { "user-agent": "Aeneas/0.1 (personal diary sync)", accept: "application/rss+xml, application/xml" } });
  if (r.status === 404) throw new StoreError(422, `Letterboxd has no member called "${username}"`);
  if (!r.ok) throw new StoreError(502, `Letterboxd answered ${r.status}`);
  return r.text();
}

export async function connectLetterboxd(hub: Hub, body: Record<string, unknown>) {
  const raw = typeof body.username === "string" ? body.username.trim() : "";
  const username = (/letterboxd\.com\/([^/?#\s]+)/i.exec(raw)?.[1] ?? raw).replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{2,30}$/.test(username)) throw new StoreError(422, "use your Letterboxd username");
  await fetchRss(hub, username);
  hub.connections.update((c) => { c.letterboxd = { ...c.letterboxd, username }; });
  const sync = await syncLetterboxd(hub);
  return { connection: hub.connections.view().letterboxd, sync };
}

export function disconnectLetterboxd(hub: Hub) {
  hub.connections.update((c) => { if (c.letterboxd) delete c.letterboxd.username; });
  return hub.connections.view().letterboxd;
}

export async function syncLetterboxd(hub: Hub) {
  const username = hub.connections.get().letterboxd?.username;
  if (!username) throw new StoreError(409, "Letterboxd is not connected");
  try {
    const films = filmsFromRss(await fetchRss(hub, username));
    const r = upsertFilms(hub, films);
    hub.connections.update((c) => { if (c.letterboxd) { c.letterboxd.last_sync = new Date().toISOString(); c.letterboxd.films = hub.store.list({ kind: "film", limit: 1_000_000 }).length; delete c.letterboxd.last_error; } });
    return { entries: films.length, ...r };
  } catch (e) {
    hub.connections.update((c) => { if (c.letterboxd) c.letterboxd.last_error = (e as Error).message; });
    throw e;
  }
}
