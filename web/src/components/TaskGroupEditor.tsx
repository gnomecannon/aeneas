import { useState, type FormEvent } from "react";
import { TASK_GROUP_NAME_MAX, newTaskGroupId, taskGroupsProblem, withTaskGroup, withoutTaskGroup, type TaskGroup } from "@everythingapp/shared";
import { engine } from "../sync/engine";
import { keepSources, type KeptList } from "../lib/sources";
import { plainError } from "../lib/errors";
import { ListBoxes } from "./ListChooser";

/** What the Tasks selector and the group editor say: the same words as the Apple apps' (EACore `TaskGroupText`). */
export const TASK_GROUP_TEXT = {
  personal: "Personal",
  work: "Work",
  show: "Show",
  newGroup: "New group",
  editGroup: "Edit group",
  name: "Name",
  namePlaceholder: "School",
  lists: "Lists",
  note: "A group shows the tasks of the lists in it, from Personal and Work. It changes nothing about where they are kept or synced.",
  save: "Save",
  cancel: "Cancel",
  delete: "Delete group",
  deleteAsk: "Delete this group? Its lists and their tasks stay as they are.",
  empty: "This group has no lists yet. Choose them with Edit group.",
  offline: "Connect to your hub to change groups.",
} as const;

/**
 * Making or changing a group on the Tasks screen (gnomecannon/aeneas#26): its name and its lists, or Delete group. The
 * whole set of groups is sent to the hub (`PUT /prefs/sources`, `groups`), checked first by the same rules the hub
 * keeps (`taskGroupsProblem`). `onDone` hears the group saved, null once it is deleted, and undefined on Cancel.
 */
export function TaskGroupEditor({ group, groups, lists, onDone }: {
  group: TaskGroup | null;
  groups: readonly TaskGroup[];
  lists: readonly KeptList[];
  onDone: (saved: TaskGroup | null | undefined) => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [chosen, setChosen] = useState<string[]>(group?.lists ?? []);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (next: TaskGroup[], result: TaskGroup | null) => {
    const problem = taskGroupsProblem(next);
    if (problem) return setErr(problem);
    const c = engine.client;
    if (!c) return setErr(TASK_GROUP_TEXT.offline);
    setBusy(true);
    setErr(null);
    try {
      keepSources(await c.setSources({ groups: next }));
      onDone(result);
    } catch (e) {
      setErr(plainError(e));
    } finally {
      setBusy(false);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const g: TaskGroup = { id: group?.id ?? newTaskGroupId(name, groups), name: name.trim(), lists: chosen };
    void send(withTaskGroup(groups, g), g);
  };

  const remove = () => {
    if (!group || !confirm(TASK_GROUP_TEXT.deleteAsk)) return;
    void send(withoutTaskGroup(groups, group.id), null);
  };

  return (
    <form className="card group-edit col" onSubmit={save} aria-label={group ? TASK_GROUP_TEXT.editGroup : TASK_GROUP_TEXT.newGroup}>
      <h2 style={{ margin: 0 }}>{group ? TASK_GROUP_TEXT.editGroup : TASK_GROUP_TEXT.newGroup}</h2>
      <div>
        <label htmlFor="task-group-name">{TASK_GROUP_TEXT.name}</label>
        <input id="task-group-name" value={name} placeholder={TASK_GROUP_TEXT.namePlaceholder} maxLength={TASK_GROUP_NAME_MAX} autoFocus onChange={(e) => setName(e.target.value)} />
      </div>
      <h3 className="settings-h">{TASK_GROUP_TEXT.lists}</h3>
      <ListBoxes chosen={chosen} lists={lists} label={TASK_GROUP_TEXT.lists} onChange={setChosen} />
      <div className="muted small">{TASK_GROUP_TEXT.note}</div>
      {err && <div className="error" role="alert">{err}</div>}
      <div className="row">
        <button className="primary" type="submit" disabled={busy || !name.trim()}>{TASK_GROUP_TEXT.save}</button>
        <button type="button" disabled={busy} onClick={() => onDone(undefined)}>{TASK_GROUP_TEXT.cancel}</button>
        {group && <button type="button" className="ghost danger" disabled={busy} onClick={remove}>{TASK_GROUP_TEXT.delete}</button>}
      </div>
    </form>
  );
}
