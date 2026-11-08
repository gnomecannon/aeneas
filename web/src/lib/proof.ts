import type { ProofDay, ProofRun } from "../sync/api";

/** Whether a task was in Now that day: proven at 09:00, or (when the history cannot say) one was there at day's end. */
export const nowHeld = (d: ProofDay) => d.now_at_0900 === true || (d.now_at_0900 === null && d.next_or_doing_eod > 0);

/** The friction lists as one list of links: stale captures, reminders snoozed 3+ times, tasks parked over a week. */
export function frictionItems(f: ProofRun["friction"] | undefined): Array<{ kind: string; id: string; title: string; detail: string }> {
  return [
    ...(f?.captures_stale ?? []).map((c) => ({ kind: "capture", id: c.id, title: c.text, detail: `unsorted for ${c.age_h} h` })),
    ...(f?.reminders_snoozed_3plus ?? []).map((r) => ({ kind: "reminder", id: r.id, title: r.title, detail: `snoozed ${r.snoozes} times` })),
    ...(f?.tasks_parked_7d ?? []).map((t) => ({ kind: "task", id: t.id, title: t.title, detail: `parked ${t.days} days` })),
  ];
}
