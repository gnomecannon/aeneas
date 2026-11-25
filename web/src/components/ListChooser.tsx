import { NO_LIST, listChosen, withListChosen, withNoListChosen } from "@everythingapp/shared";
import { sourceAccount, type KeptList } from "../lib/sources";

/** What the boxes say: the same words as the Apple apps' (EACore `TodayText`). */
export const LIST_CHOOSER_TEXT = {
  noList: "No list",
  noListNote: "Tasks made in Aeneas that are in no Reminders list.",
  noListsYet: "No Reminders lists yet. They appear once an iPhone, iPad or Mac syncs Apple Reminders.",
  work: "Work",
} as const;

/** The lists a chooser offers: those that are on, by account and then by name. */
export function choosableLists(lists: readonly KeptList[]): KeptList[] {
  const account = (l: KeptList) => sourceAccount(l.account ?? "", l.kind ?? "");
  return lists.filter((l) => l.on).sort((a, b) => account(a).localeCompare(account(b)) || a.title.localeCompare(b.title));
}

/**
 * A box for each Reminders list that is on (its account under it, and Work for a list in Work) and one for the tasks in
 * no list, for a choice of lists (taskLists.ts in packages/shared): Lists in To do, and a group's lists on Tasks.
 * Entries for lists not shown (switched off, or forgotten) stay in the choice.
 */
export function ListBoxes({ chosen, lists, onChange, label }: { chosen: readonly string[]; lists: readonly KeptList[]; onChange: (next: string[]) => void; label: string }) {
  const shown = choosableLists(lists);
  const box = (key: string, title: string, note: string, checked: boolean, change: (on: boolean) => string[]) => (
    <li key={key} className="item today-part">
      <label className="today-part-label">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(change(e.target.checked))} />
        <span className="body">
          <span className="t">{title}</span>
          {note && <span className="meta">{note}</span>}
        </span>
      </label>
    </li>
  );
  return (
    <>
      <ul className="list rows today-parts" aria-label={label}>
        {shown.map((l) => box(l.key, l.title, `${sourceAccount(l.account ?? "", l.kind ?? "")}${l.space === "work" ? `, ${LIST_CHOOSER_TEXT.work}` : ""}`, listChosen(chosen, l), (on) => withListChosen(chosen, l, on)))}
        {box(NO_LIST, LIST_CHOOSER_TEXT.noList, LIST_CHOOSER_TEXT.noListNote, chosen.includes(NO_LIST), (on) => withNoListChosen(chosen, on))}
      </ul>
      {!shown.length && <div className="muted small">{LIST_CHOOSER_TEXT.noListsYet}</div>}
    </>
  );
}
