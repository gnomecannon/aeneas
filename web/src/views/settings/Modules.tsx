import { useState } from "react";
import type { ModuleInfo, ModulePermission } from "../../sync/api";
import { setModules, useModules } from "../../lib/modules";
import { SubPage, Toggle, errorText } from "./common";

const ORDER = ["On your devices", "Plan", "Body and home", "Making", "Life admin", "Homelab", "Assistant"];
const GROUP_TITLE: Record<string, string> = { Assistant: "What the assistant may do" };

/** How each device permission is named to the person. */
export const PERMISSION_NAMES: Record<ModulePermission, string> = {
  microphone: "the microphone", speech: "speech recognition", notifications: "notifications", reminders: "Reminders",
  calendar: "Calendar", contacts: "Contacts", health: "Health", photos: "Photos", location: "Location",
};

function joinWords(words: string[]): string {
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** What a module reads, what devices ask for, and when it needs the person's own key. */
function ModuleDetails({ m }: { m: ModuleInfo }) {
  const asks = (m.permissions ?? []).map((p) => PERMISSION_NAMES[p] ?? p);
  return (
    <>
      {m.reads && <div>Reads: {m.reads}</div>}
      {asks.length > 0 && <div>Your Apple devices ask for {joinWords(asks)} once, after setup, and only while this is on.</div>}
      {m.setup && <div><strong>Advanced setup:</strong> {m.setup.needs}, about {m.setup.minutes} minutes. The rest works without it.</div>}
    </>
  );
}

/**
 * Under a module's switch: one line on what it does. What it reads and asks for shows as soon as it is ticked, and
 * before that behind "What it reads", so the list stays short but nothing is hidden when it matters (release rule 2).
 * A module that needs the person's own key says so up front.
 */
export function ModuleNote({ m }: { m: ModuleInfo }) {
  const more = !!(m.reads || m.permissions?.length || m.setup);
  return (
    <>
      <div>{m.summary}{m.setup && !m.on ? <span className="muted"> Advanced setup for part of it, about {m.setup.minutes} minutes.</span> : null}</div>
      {m.on ? <ModuleDetails m={m} /> : more && (
        <details className="module-more">
          <summary>What it reads</summary>
          <ModuleDetails m={m} />
        </details>
      )}
    </>
  );
}

/** "4 of 17 on", for the Settings menu row. */
export function modulesSummary(list: ModuleInfo[] | null): string {
  if (!list) return "Choose what this app keeps track of";
  return `${list.filter((m) => m.on).length} of ${list.length} on`;
}

/**
 * Every module with its switch, grouped by Library area, each area folded to one line that names its modules and says
 * how many are on. One setting for every device: a switch takes effect at once here and on the others. Used in
 * Settings, Modules and on Welcome.
 */
export function ModulePicker() {
  const { list } = useModules();
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  if (!list) return <div className="muted small">Asking the hub which modules are on.</div>;
  const groups = [...new Set([...ORDER, ...list.map((m) => m.group)])].filter((g) => list.some((m) => m.group === g));
  const flip = async (id: string, on: boolean) => {
    setBusy(id);
    setErr("");
    try { await setModules({ [id]: on }); } catch (e) { setErr(errorText(e)); } finally { setBusy(""); }
  };
  return (
    <div className="col">
      {groups.map((g) => {
        const mods = list.filter((m) => m.group === g);
        const on = mods.filter((m) => m.on).length;
        return (
          <details key={g} className="card col module-group">
            <summary>
              <strong>{GROUP_TITLE[g] ?? g}</strong> <span className="muted small">{on} of {mods.length} on</span>
              <div className="muted small">{mods.map((m) => m.title).join(", ")}</div>
            </summary>
            {mods.map((m) => (
              <Toggle key={m.id} checked={m.on} disabled={busy === m.id} onChange={(v) => void flip(m.id, v)} label={m.title} note={<ModuleNote m={m} />} />
            ))}
          </details>
        );
      })}
      {err && <div className="error small">{err}</div>}
    </div>
  );
}

/** Settings, Modules. */
export function ModulesPage() {
  return (
    <SubPage path="/settings/modules">
      <div className="muted small">
        Switch off what you do not use. Off hides it on every device and stops its background work; nothing is erased, so switching it back on shows everything again. Today, the Assistant, Capture, Search, Tasks, Week, Notes, Memory, People and Lists are always on.
      </div>
      <ModulePicker />
    </SubPage>
  );
}
