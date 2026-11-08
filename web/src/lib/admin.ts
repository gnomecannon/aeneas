import type { Entity } from "@everythingapp/shared";

/** Module 7 helpers: checklists, the states grid, the career board, friends for the game picker. */

export type ChecklistItem = { text: string; done_at?: string; note?: string };
export type ChecklistF = { title: string; kind?: "packing" | "states" | "generic"; items: ChecklistItem[]; template?: boolean; from_template?: string; tags?: string[]; archived?: boolean };

export function checklistProgress(f: Pick<ChecklistF, "items">): { done: number; total: number } {
  const items = f.items ?? [];
  return { done: items.filter((i) => !!i.done_at).length, total: items.length };
}

/** The items with one done_at flipped, exactly what POST /checklists/:id/toggle does. */
export function toggleItem(items: ChecklistItem[], index: number, at: string): ChecklistItem[] {
  return items.map((it, i) => {
    if (i !== index) return it;
    if (it.done_at) {
      const { done_at: _drop, ...rest } = it;
      void _drop;
      return rest;
    }
    return { ...it, done_at: at };
  });
}

/** A template copy, as POST /checklists/:id/instantiate makes it: every done_at cleared, from_template set. */
export function instantiateFields(template: Entity, title?: string): Record<string, unknown> {
  const f = template.fields as ChecklistF;
  return {
    title: title?.trim() || f.title,
    kind: f.kind ?? "generic",
    items: (f.items ?? []).map(({ text, note }) => (note ? { text, note } : { text })),
    template: false,
    from_template: template.id,
    tags: f.tags ?? [],
  };
}

export const STATES: Array<[string, string]> = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"],
  ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"], ["FL", "Florida"], ["GA", "Georgia"],
  ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"], ["IA", "Iowa"],
  ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"], ["MD", "Maryland"],
  ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"], ["MO", "Missouri"],
  ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"], ["NJ", "New Jersey"],
  ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"], ["OH", "Ohio"],
  ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"], ["SC", "South Carolina"],
  ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"], ["VT", "Vermont"],
  ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"], ["WY", "Wyoming"],
];
const BY_NAME = new Map(STATES.map(([c, n]) => [n.toLowerCase(), c]));
const BY_CODE = new Map(STATES.map(([c, n]) => [c, n]));

/** Two-letter code for an item text like "Massachusetts", "massachusetts ", "MA" or "- [x] Massachusetts"; null when not a state. */
export function stateCode(text: string): string | null {
  const t = text.replace(/^\s*[-*]\s*(\[[ xX]\]\s*)?/, "").replace(/\.$/, "").trim();
  if (/^[A-Za-z]{2}$/.test(t) && BY_CODE.has(t.toUpperCase())) return t.toUpperCase();
  return BY_NAME.get(t.toLowerCase().replace(/\s+/g, " ")) ?? null;
}

export interface StateChip {
  index: number;
  code: string;
  name: string;
  done: boolean;
}

/** One chip per item that names a state, in item order (alphabetical when seeded); items that are not states are left out. */
export function statesGrid(items: ChecklistItem[]): StateChip[] {
  const out: StateChip[] = [];
  items.forEach((it, index) => {
    const code = stateCode(it.text);
    if (code) out.push({ index, code, name: BY_CODE.get(code)!, done: !!it.done_at });
  });
  return out;
}

// ---------- career ----------
export const STAGES = ["saved", "applied", "screen", "interview", "offer", "rejected", "withdrawn", "accepted"] as const;
export type Stage = (typeof STAGES)[number];
export const ACTIVE_STAGES: Stage[] = ["saved", "applied", "screen", "interview", "offer"];
export const CLOSED_STAGES: Stage[] = ["accepted", "rejected", "withdrawn"];
export type ApplicationF = {
  company: string;
  role: string;
  stage: Stage;
  applied_at?: string;
  next_step?: string;
  next_at?: string;
  reminder_id?: string;
  salary?: string;
  remote?: "remote" | "hybrid" | "onsite";
  url?: string;
  notes?: string;
  letter_note_id?: string;
};

export interface BoardColumn {
  stage: Stage;
  count: number;
  items: Entity[];
}

/**
 * Applications by stage, every stage present in pipeline order. Within a stage: a next_at first (soonest first), then most recently
 * updated. followUps: active applications with a next_at, soonest first.
 */
export function groupBoard(apps: Entity[]): { columns: BoardColumn[]; followUps: Entity[]; active: number } {
  const by = new Map<Stage, Entity[]>(STAGES.map((s) => [s, []]));
  for (const a of apps) {
    const s = (a.fields as ApplicationF).stage;
    (by.get(STAGES.includes(s) ? s : "saved") as Entity[]).push(a);
  }
  const key = (e: Entity) => (e.fields as ApplicationF).next_at ?? "";
  const cmp = (a: Entity, b: Entity) => {
    const x = key(a);
    const y = key(b);
    if (x && y && x !== y) return x < y ? -1 : 1;
    if (!!x !== !!y) return x ? -1 : 1;
    return a.updated_at > b.updated_at ? -1 : a.updated_at < b.updated_at ? 1 : 0;
  };
  const columns = STAGES.map((stage) => {
    const items = by.get(stage)!.sort(cmp);
    return { stage, count: items.length, items };
  });
  const activeApps = apps.filter((a) => ACTIVE_STAGES.includes((a.fields as ApplicationF).stage));
  const followUps = activeApps.filter((a) => !!key(a)).sort((a, b) => (key(a) < key(b) ? -1 : 1));
  return { columns, followUps, active: activeApps.length };
}

// ---------- games ----------
export type GameF = { name: string; min_players?: number; max_players?: number; coop?: boolean; genres?: string[]; owned_by?: string[]; session_hours?: number; last_played?: string; rating?: number; notes?: string };

/** Every name in any owned_by, the owner (`me`, their name in owned_by) first, then alphabetical. */
export function friendsOf(games: Entity[], me: string): string[] {
  const set = new Set<string>([me]);
  for (const g of games) for (const n of (g.fields as GameF).owned_by ?? []) if (n.trim()) set.add(n.trim());
  return [me, ...[...set].filter((n) => n !== me).sort((a, b) => a.localeCompare(b))];
}

/** Names the hub's 422 cover-letter guard reported, from whichever shape the detail has. */
export function guardNames(detail: unknown): string[] {
  if (Array.isArray(detail)) return detail.map(String);
  const d = detail as Record<string, unknown> | null;
  for (const k of ["invented", "names", "employers"]) if (d && Array.isArray(d[k])) return (d[k] as unknown[]).map(String);
  return [];
}
