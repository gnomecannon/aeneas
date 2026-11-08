import type { Entity } from "@everythingapp/shared";
import type { Hub } from "../hub.js";
import { norm } from "./util.js";

/**
 * Compact, sorted views over games, films and job applications, for the assistant ("my most played games") and for
 * screens that want a ranked list without loading every field.
 */

const clampLimit = (n: unknown, d = 25) => Math.max(1, Math.min(500, Number.isFinite(Number(n)) && Number(n) > 0 ? Math.floor(Number(n)) : d));
const matches = (q: unknown, ...parts: unknown[]) => !q || parts.some((p) => norm(String(p ?? "")).includes(norm(String(q))));
const hours = (min: unknown) => (typeof min === "number" ? Math.round((min / 60) * 10) / 10 : null);

export function gamesLibrary(hub: Hub, o: { sort?: string; limit?: unknown; q?: string; played?: string }) {
  let all = hub.store.list({ kind: "game", limit: 1_000_000 }).filter((e) => matches(o.q, e.fields.name, (e.fields.genres as string[] | undefined)?.join(" ")));
  if (o.played === "yes") all = all.filter((e) => Number(e.fields.playtime_min ?? 0) > 0);
  if (o.played === "no") all = all.filter((e) => !Number(e.fields.playtime_min ?? 0));
  const by: Record<string, (a: Entity, b: Entity) => number> = {
    playtime: (a, b) => Number(b.fields.playtime_min ?? 0) - Number(a.fields.playtime_min ?? 0),
    recent: (a, b) => String(b.fields.last_played ?? "").localeCompare(String(a.fields.last_played ?? "")),
    two_weeks: (a, b) => Number(b.fields.playtime_2w_min ?? 0) - Number(a.fields.playtime_2w_min ?? 0),
    rating: (a, b) => Number(b.fields.rating ?? 0) - Number(a.fields.rating ?? 0),
    name: (a, b) => String(a.fields.name).localeCompare(String(b.fields.name)),
  };
  all.sort(by[o.sort ?? "playtime"] ?? by.playtime);
  const total_hours = Math.round(all.reduce((n, e) => n + Number(e.fields.playtime_min ?? 0), 0) / 6) / 10;
  return {
    total: all.length,
    total_hours,
    games: all.slice(0, clampLimit(o.limit)).map((e) => ({
      id: e.id, name: e.fields.name, hours: hours(e.fields.playtime_min), hours_2_weeks: hours(e.fields.playtime_2w_min),
      last_played: e.fields.last_played ?? null, rating: e.fields.rating ?? null, source: e.fields.source ?? "manual",
      ...(e.fields.steam_appid ? { steam_appid: e.fields.steam_appid } : {}),
    })),
  };
}

export function filmsLibrary(hub: Hub, o: { sort?: string; limit?: unknown; q?: string; year?: unknown; watchlist?: string }) {
  let all = hub.store.list({ kind: "film", limit: 1_000_000 }).filter((e) => matches(o.q, e.fields.title, (e.fields.tags as string[] | undefined)?.join(" ")));
  all = all.filter((e) => (o.watchlist === "yes" ? !!e.fields.watchlist && !e.fields.watched : !!e.fields.watched));
  const y = Number(o.year);
  if (Number.isInteger(y) && y > 1800) all = all.filter((e) => (e.fields.watched_on as string[] | undefined)?.some((d) => d.startsWith(String(y))));
  const by: Record<string, (a: Entity, b: Entity) => number> = {
    recent: (a, b) => String(b.fields.last_watched ?? "").localeCompare(String(a.fields.last_watched ?? "")),
    rating: (a, b) => Number(b.fields.rating ?? 0) - Number(a.fields.rating ?? 0) || String(b.fields.last_watched ?? "").localeCompare(String(a.fields.last_watched ?? "")),
    rewatched: (a, b) => ((b.fields.watched_on as string[])?.length ?? 0) - ((a.fields.watched_on as string[])?.length ?? 0),
    title: (a, b) => String(a.fields.title).localeCompare(String(b.fields.title)),
    year: (a, b) => Number(b.fields.year ?? 0) - Number(a.fields.year ?? 0),
  };
  all.sort(by[o.sort ?? "recent"] ?? by.recent);
  return {
    total: all.length,
    films: all.slice(0, clampLimit(o.limit)).map((e) => ({
      id: e.id, title: e.fields.title, year: e.fields.year ?? null, rating: e.fields.rating ?? null, liked: !!e.fields.liked,
      last_watched: e.fields.last_watched ?? null, times_watched: (e.fields.watched_on as string[] | undefined)?.length ?? 0,
      ...(e.fields.review ? { review: String(e.fields.review).slice(0, 400) } : {}),
    })),
  };
}

export function applicationsList(hub: Hub, o: { stage?: string; limit?: unknown; q?: string; since?: string }) {
  let all = hub.store.list({ kind: "application", limit: 1_000_000 }).filter((e) => matches(o.q, e.fields.company, e.fields.role));
  if (o.stage === "open") all = all.filter((e) => !["rejected", "withdrawn", "accepted"].includes(String(e.fields.stage)));
  else if (o.stage) all = all.filter((e) => e.fields.stage === o.stage);
  if (o.since && !Number.isNaN(Date.parse(o.since))) all = all.filter((e) => String(e.fields.applied_at ?? e.created_at) >= new Date(o.since!).toISOString());
  all.sort((a, b) => String(b.fields.applied_at ?? b.created_at).localeCompare(String(a.fields.applied_at ?? a.created_at)));
  const stages: Record<string, number> = {};
  for (const e of all) stages[String(e.fields.stage)] = (stages[String(e.fields.stage)] ?? 0) + 1;
  return {
    total: all.length,
    stages,
    applications: all.slice(0, clampLimit(o.limit, 50)).map((e) => ({
      id: e.id, company: e.fields.company, role: e.fields.role, stage: e.fields.stage, applied_at: e.fields.applied_at ?? null,
      url: e.fields.url ?? null, source: e.fields.source ?? "manual", next_step: e.fields.next_step ?? null, next_at: e.fields.next_at ?? null,
    })),
  };
}
