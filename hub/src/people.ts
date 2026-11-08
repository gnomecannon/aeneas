import { factsAbout as aboutPerson, type Entity } from "@everythingapp/shared";
import { StoreError, type Store } from "./store.js";

/** People (contacts) and what the owner knows about them: lookup by name or nickname, and the facts linked to each. */

// Letters and digits of any script, accents dropped: "Zoë" is "zoe" and "李明" stays "李明". Only a-z used to be kept,
// so a name in another script was "" and matched everyone.
const norm = (s: unknown) => String(s ?? "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

export function people(store: Store): Entity[] {
  return store.list({ kind: "person", limit: 100000 });
}

/** Best matches for a name, nickname, company or email, best first. */
export function findPeople(store: Store, query: string): Entity[] {
  const q = norm(query);
  if (!q) return people(store).sort((a, b) => String(a.fields.name).localeCompare(String(b.fields.name)));
  const score = (p: Entity): number => {
    const f = p.fields;
    const names = [f.name, f.nickname, f.given_name, f.family_name].map(norm).filter(Boolean);
    if (names.some((n) => n === q)) return 100;
    if (names.some((n) => n.split(" ").includes(q))) return 80;
    if (names.some((n) => n.startsWith(q))) return 60;
    const rest = [f.organization, f.relationship, ...(Array.isArray(f.emails) ? f.emails.map((e: any) => e.value) : [])].map(norm);
    if (names.some((n) => n.includes(q)) || rest.some((r) => r.includes(q))) return 30;
    return 0;
  };
  return people(store).map((p) => [p, score(p)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([p]) => p);
}

/**
 * One person by id or by a name that is theirs alone, for writing about them (remember person=, save_person). A name
 * counts only whole: their full name, nickname, or given and family name first, then a given name, a family name or
 * the first word of their name. Null when nobody has it. When two people have it, an error names them, so nothing is
 * written to the wrong one: "Alex" with Alex Kim and Alex Park used to go to whichever was updated last, and "Ann"
 * (part of Joanna) wrote Joanna Smith's phone and birthday.
 */
export function resolvePerson(store: Store, ref: string): Entity | null {
  const byId = store.get(ref);
  if (byId?.kind === "person" && !byId.deleted_at) return byId;
  const q = norm(ref);
  if (!q) return null;
  const everyone = people(store);
  const both = (p: Entity) => (p.fields.given_name && p.fields.family_name ? `${p.fields.given_name} ${p.fields.family_name}` : "");
  const whole = (p: Entity) => [p.fields.name, p.fields.nickname, both(p)].map(norm);
  const part = (p: Entity) => [p.fields.given_name, p.fields.family_name, norm(p.fields.name).split(" ")[0]].map(norm);
  for (const names of [whole, part]) {
    const hits = everyone.filter((p) => names(p).includes(q));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      const who = hits.slice(0, 6).map((p) => `${String(p.fields.name)} (id ${p.id})`).join(", ");
      throw new StoreError(409, `${hits.length} people are called ${ref.trim()}: ${who}. Ask which one they mean, then give that id.`);
    }
  }
  return null;
}

/** Facts linked to them, kept with their name, or whose text names them (the shared rule every app uses). */
export function factsAbout(store: Store, person: Entity): Entity[] {
  return aboutPerson(person, people(store), store.list({ kind: "fact", limit: 100000 }));
}

/** Add list entries by value (phones, emails, addresses), keeping what is there. */
export function mergeList<T extends Record<string, unknown>>(current: unknown, add: unknown, key: (x: T) => string): T[] {
  const out = Array.isArray(current) ? [...(current as T[])] : [];
  for (const x of Array.isArray(add) ? (add as T[]) : []) {
    if (!x || typeof x !== "object") continue;
    const i = out.findIndex((o) => norm(key(o)) === norm(key(x)));
    if (i >= 0) out[i] = { ...out[i], ...x }; else out.push(x);
  }
  return out;
}

/**
 * What makes two addresses one: street, city and postal code; for an address with none of those (only a state or a
 * country, as Apple Contacts often has), its state and country. Such an address used to have an empty key, and the
 * tidy and a merge dropped it.
 */
export const addressKey = (a: Record<string, unknown>) => {
  const main = [a.street, a.city, a.postal_code].map((x) => String(x ?? "").trim());
  return main.some(Boolean) ? main.join("|") : `|||${String(a.state ?? "").trim()}|${String(a.country ?? "").trim()}`;
};

const digits = (v: unknown) => { const d = String(v ?? "").replace(/\D+/g, ""); return d.length === 11 && d.startsWith("1") ? d.slice(1) : d; };
/** What makes two entries of a person's list the same value: phones by digits, emails ignoring case, addresses by `addressKey`, dates by date. */
const listKey: Record<string, (x: any) => string> = {
  phones: (x) => digits(x?.value),
  emails: (x) => String(x?.value ?? "").trim().toLowerCase(),
  addresses: (x) => norm(addressKey(x ?? {})),
  dates: (x) => String(x?.date ?? ""),
};
const LISTS = Object.keys(listKey);
const SCALARS = ["given_name", "family_name", "nickname", "organization", "job_title", "birthday", "relationship"];

/** The lists with repeated values dropped (Apple Contacts repeats a number once per linked card); only the lists that changed. */
export function dedupedLists(f: Record<string, unknown>): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const k of LISTS) {
    const list = Array.isArray(f[k]) ? (f[k] as unknown[]) : [];
    const seen = new Set<string>();
    const kept = list.filter((x) => { const key = listKey[k](x); if (!key || seen.has(key)) return false; seen.add(key); return true; });
    if (kept.length !== list.length) out[k] = kept;
  }
  return out;
}

/**
 * Merge duplicates into one person: lists are joined by value, empty fields filled from the others, facts about them
 * moved over, and each duplicate deleted with `merged_into` (its Apple card is then removed by the syncing device once
 * the kept card holds everything on it). When only a duplicate is linked to Apple Contacts, the kept person takes its link.
 */
export function mergePeople(store: Store, keepId: string, dropIds: string[]): Entity {
  const keep = store.get(keepId);
  if (!keep || keep.kind !== "person" || keep.deleted_at) throw new StoreError(404, "no person with that id to keep");
  const drops = [...new Set(dropIds)].filter((id) => id !== keepId).map((id) => store.get(id));
  if (!drops.length) throw new StoreError(422, "give at least one other person to merge");
  for (const d of drops) if (!d || d.kind !== "person" || d.deleted_at || d.space !== keep.space) throw new StoreError(404, "every person to merge must exist in the same space");
  const all = [keep, ...(drops as Entity[])];
  const set: Record<string, unknown> = {};
  for (const k of LISTS) {
    const joined = all.flatMap((p) => (Array.isArray(p.fields[k]) ? (p.fields[k] as unknown[]) : []));
    const seen = new Set<string>();
    const list = joined.filter((x) => { const key = listKey[k](x); if (!key || seen.has(key)) return false; seen.add(key); return true; });
    if (JSON.stringify(list) !== JSON.stringify(keep.fields[k] ?? [])) set[k] = list;
  }
  for (const k of SCALARS) {
    if (String(keep.fields[k] ?? "").trim()) continue;
    const v = (drops as Entity[]).map((d) => String(d.fields[k] ?? "").trim()).find(Boolean);
    if (v) set[k] = v;
  }
  const linked = (p: Entity) => !!(p.fields.apple as { id?: string } | undefined)?.id;
  const donor = linked(keep) ? null : (drops as Entity[]).find(linked);
  if (donor) set.apple = donor.fields.apple;
  const kept = Object.keys(set).length ? store.patch(keep.id, set) : keep;
  const ids = new Set(drops.map((d) => d!.id));
  // Facts kept with a duplicate's name (saved before they were in People) move too. Only facts with a person_id used
  // to, and the others showed on nobody once the duplicate was gone. A name someone outside the merge is also called
  // stays as it is, since the fact may be about them.
  const calledBy = (p: Entity) => [p.fields.name, p.fields.nickname, p.fields.given_name].map(norm).filter(Boolean);
  const theirs = new Set((drops as Entity[]).flatMap(calledBy));
  const group = new Set([keep.id, ...ids]);
  for (const p of people(store)) if (!group.has(p.id)) for (const n of calledBy(p)) theirs.delete(n);
  for (const f of store.list({ kind: "fact", includeDeleted: true, limit: 100000 })) {
    const byName = !f.fields.person_id && theirs.has(norm(f.fields.person));
    if (ids.has(String(f.fields.person_id ?? "")) || byName) store.patch(f.id, { person_id: keep.id, person: String(kept.fields.name) });
  }
  const now = new Date().toISOString();
  for (const d of drops as Entity[]) store.patch(d.id, { merged_into: keep.id, deleted_at: now, ...(d === donor ? { apple: null } : {}) });
  return kept;
}

/** The name two people must share to be the same person: given and family name when the card has them (so "Mr. Aiden Kong" is Aiden Kong), else the whole name. */
const personKey = (p: Entity) => (norm(`${p.fields.given_name ?? ""} ${p.fields.family_name ?? ""}`) || norm(p.fields.name)).replace(/ /g, "");

/**
 * Groups of people that are surely one person, best record first: the same name and a shared phone or email, or the
 * same name where one has neither, or the same company name (organization cards).
 */
export function duplicatePeople(list: Entity[]): Entity[][] {
  const values = (p: Entity) => new Set([...(Array.isArray(p.fields.phones) ? p.fields.phones : []).map(listKey.phones), ...(Array.isArray(p.fields.emails) ? p.fields.emails : []).map(listKey.emails)].filter(Boolean));
  // An organization card: no given or family name, and named by its company (Apple names such a card by its
  // organization). Any person with only a name used to count, so two different "Jamie Lee" with their own phones and
  // relationships were merged into one.
  const company = (p: Entity) => !String(p.fields.given_name ?? "").trim() && !String(p.fields.family_name ?? "").trim()
    && !!norm(p.fields.organization) && norm(p.fields.organization) === norm(p.fields.name);
  const same = (a: Entity, b: Entity) => {
    const va = values(a), vb = values(b);
    return !va.size || !vb.size || [...va].some((v) => vb.has(v)) || (company(a) && company(b));
  };
  const richness = (p: Entity) => (p.fields.apple as { me?: boolean } | undefined)?.me ? 1e6
    : LISTS.reduce((n, k) => n + (Array.isArray(p.fields[k]) ? (p.fields[k] as unknown[]).length : 0), 0) + SCALARS.filter((k) => String(p.fields[k] ?? "").trim()).length;
  const byName = new Map<string, Entity[]>();
  for (const p of list) {
    const k = `${p.space}|${personKey(p)}`;
    if (personKey(p)) byName.set(k, [...(byName.get(k) ?? []), p]);
  }
  const groups: Entity[][] = [];
  for (const named of byName.values()) {
    const left = [...named].sort((a, b) => richness(b) - richness(a) || a.created_at.localeCompare(b.created_at));
    while (left.length > 1) {
      const head = left.shift()!;
      const group = [head, ...left.filter((p) => same(head, p))];
      if (group.length > 1) groups.push(group);
      for (const p of group.slice(1)) left.splice(left.indexOf(p), 1);
    }
  }
  return groups;
}

/**
 * Nightly: drop repeated phones and emails, and merge people that are surely the same. Only people whose Apple link
 * belongs to a device whose build understands it (feature "contacts-merge"); an older build would write the
 * repeats back, or keep importing the merged cards.
 */
export function tidyPeople(store: Store): { cleaned: number; merged: number } {
  let cleaned = 0, merged = 0;
  const ready = new Set(store.list({ kind: "device", limit: 1000 }).filter((d) => Array.isArray(d.fields.features) && d.fields.features.includes("contacts-merge")).map((d) => d.id));
  const ok = (p: Entity) => { const a = p.fields.apple as { id?: string; device?: string } | undefined; return !a?.id || ready.has(String(a.device ?? "")); };
  const everyone = () => people(store).filter(ok);
  for (const p of everyone()) {
    const lists = dedupedLists(p.fields);
    if (Object.keys(lists).length) { store.patch(p.id, lists); cleaned++; }
  }
  for (const [keep, ...drops] of duplicatePeople(everyone())) { mergePeople(store, keep.id, drops.map((d) => d.id)); merged += drops.length; }
  return { cleaned, merged };
}
