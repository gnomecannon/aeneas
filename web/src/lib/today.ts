import type { Entity } from "@everythingapp/shared";

const CLOSED = new Set(["rejected", "withdrawn", "accepted"]);

/** Job applications whose next step is due by the end of today, oldest first. */
export function followUpsDue(apps: Entity[], now: Date): Entity[] {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return apps
    .filter((a) => !a.deleted_at && a.fields.next_at && !CLOSED.has(String(a.fields.stage)) && Date.parse(String(a.fields.next_at)) <= end.getTime())
    .sort((a, b) => Date.parse(String(a.fields.next_at)) - Date.parse(String(b.fields.next_at)));
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Meds taken regularly: logged on at least 2 different days in the 7 days before today. Each with whether it was
 * logged today and when. Same rule on the Apple app's Today.
 */
export function regularMeds(logs: Entity[], now: Date): Array<{ name: string; takenAt: string | null }> {
  const today = dayKey(now);
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - 7);
  const days = new Map<string, Set<string>>();
  const display = new Map<string, { name: string; at: string }>();
  const takenToday = new Map<string, string>();
  for (const l of logs) {
    if (l.deleted_at || l.fields.type !== "med") continue;
    const name = String(l.fields.value ?? "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const at = new Date(String(l.fields.at));
    if (Number.isNaN(at.getTime())) continue;
    if (dayKey(at) === today) {
      const prev = takenToday.get(key);
      if (!prev || prev < String(l.fields.at)) takenToday.set(key, String(l.fields.at));
      continue;
    }
    if (at < since || at > now) continue;
    if (!days.has(key)) days.set(key, new Set());
    days.get(key)!.add(dayKey(at));
    // The spelling of the newest log is the one shown.
    if ((display.get(key)?.at ?? "") < String(l.fields.at)) display.set(key, { name, at: String(l.fields.at) });
  }
  return [...days.entries()]
    .filter(([, d]) => d.size >= 2)
    .map(([key]) => ({ name: display.get(key)!.name, takenAt: takenToday.get(key) ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Today's diary note (`Diary/YYYY-MM-DD.md`, every capture timestamped) and its lines, oldest first.
 * Before 4 AM it is still the day before, as on the hub: late night captures go to that day's note. */
export function diaryToday(notes: { id: string; fields: Record<string, unknown> }[], now: Date): { id: string; lines: { time: string; text: string }[] } | null {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = now.getHours() < 4 ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12) : now;
  const path = `diary/${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}.md`;
  const n = notes.find((x) => String(x.fields.path ?? "").toLowerCase() === path);
  if (!n) return null;
  const lines = String(n.fields.body ?? "").split("\n").flatMap((raw) => {
    const m = /^- (\d{2}:\d{2}) (.*)$/.exec(raw.trim());
    return m ? [{ time: m[1], text: m[2] }] : [];
  });
  return { id: n.id, lines };
}
