import { useState } from "react";
import type { ModuleInfo, ModulePermission } from "../../sync/api";
import { doneWithFirstSteps, justSwitchedOn, setModules, useModules } from "../../lib/modules";
import { SubPage, Toggle, errorText } from "./common";
import { MachinesStart } from "./MachinesSetup";

/** The groups in the order they show: device features, then the Library areas in the Library's order. */
const ORDER = ["On your devices", "Plan", "Notes", "People", "Media", "Body and home", "Life admin", "Making", "Tech"];
/** Shown last, after any group this app does not know. */
const LAST = "Assistant";
const GROUP_TITLE: Record<string, string> = { Assistant: "What the assistant may do" };

/** How each device permission is named to the person. */
export const PERMISSION_NAMES: Record<ModulePermission, string> = {
  microphone: "the microphone", speech: "speech recognition", notifications: "notifications", reminders: "Reminders",
  calendar: "Calendar", contacts: "Contacts", health: "Health", photos: "Photos", location: "Location",
  music: "Apple Music",
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
export function ModuleNote({ m, open }: { m: ModuleInfo; open?: boolean }) {
  const more = !!(m.reads || m.permissions?.length || m.setup);
  return (
    <>
      <div>{m.summary}{m.setup && !m.on ? <span className="muted"> Advanced setup for part of it, about {m.setup.minutes} minutes.</span> : null}</div>
      {open && (
        <div id={`module-${m.id}-info`} className="link-info module-info">
          {m.example && <div><strong>For example:</strong> {m.example}</div>}
          {more && <ModuleDetails m={m} />}
        </div>
      )}
      {!open && m.on && <ModuleDetails m={m} />}
    </>
  );
}

/** One module's switch, with an ⓘ that opens what it is for, an example of it in use, and what it reads. */
function ModuleToggle({ m, busy, onFlip }: { m: ModuleInfo; busy: boolean; onFlip: (on: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Toggle checked={m.on} disabled={busy} onChange={onFlip} label={m.title} note={<ModuleNote m={m} open={open} />}
      aside={<button type="button" className="info-btn" aria-expanded={open} aria-controls={`module-${m.id}-info`} aria-label={`About ${m.title}`} onClick={() => setOpen(!open)}>ⓘ</button>} />
  );
}

/**
 * The modules this list switches: not one an older hub says is switched elsewhere (`switch_in`: Apple Reminders, on
 * the iCloud account, from hubs of 1.0.17; since 2026-11-24 every switch is here), so one setting is never in two places.
 */
export const listedHere = (list: ModuleInfo[]) => list.filter((m) => !m.switch_in);

/**
 * One area's modules in the order they show: a module with `under` (since 2026-11-24: Receipts and renewals under
 * Mail) right after the module it sits under, marked `sub` to be drawn indented. It keeps its own switch, so it shows
 * whether that module is on or off. One level only: a module whose parent is not in the list (an older hub, another
 * area, a switch kept elsewhere), or whose parent sits under another itself, shows as a normal row where the hub put
 * it.
 */
export function nestedOrder(mods: ModuleInfo[]): { m: ModuleInfo; sub: boolean }[] {
  const byId = new Map(mods.map((m) => [m.id, m]));
  const parentOf = (m: ModuleInfo) => {
    const p = m.under && m.under !== m.id ? byId.get(m.under) : undefined;
    return p && !(p.under && byId.has(p.under)) ? p : undefined;
  };
  const out: { m: ModuleInfo; sub: boolean }[] = [];
  for (const m of mods) {
    if (parentOf(m)) continue;
    out.push({ m, sub: false });
    for (const s of mods) if (parentOf(s) === m) out.push({ m: s, sub: true });
  }
  return out;
}

/**
 * The groups that have modules, in the order they show: the ones this app knows in its own order, then any other (an
 * area a newer hub added) in the hub's order, under its own heading, then what the assistant may do. A group is never
 * left out, so every module keeps its switch.
 */
export function groupOrder(list: ModuleInfo[]): string[] {
  const named = [...new Set(list.map((m) => m.group))];
  return [...ORDER.filter((g) => named.includes(g)), ...named.filter((g) => !ORDER.includes(g) && g !== LAST), ...named.filter((g) => g === LAST)];
}

/** "4 of 17 on", for the Settings menu row. */
export function modulesSummary(list: ModuleInfo[] | null): string {
  if (!list) return "Choose what this app keeps track of";
  const here = listedHere(list);
  return `${here.filter((m) => m.on).length} of ${here.length} on`;
}

/**
 * Every module with its switch, grouped by Library area, each area folded to one line that names its modules and says
 * how many are on. One setting for every device: a switch takes effect at once here and on the others. Used in
 * Settings, Modules and on Welcome.
 */
export function ModulePicker() {
  const { list: all } = useModules();
  const list = all && listedHere(all);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  if (!list) return <div className="muted small">Asking the hub which modules are on.</div>;
  const groups = groupOrder(list);
  const flip = async (id: string, on: boolean) => {
    setBusy(id);
    setErr("");
    try { await setModules({ [id]: on }); } catch (e) { setErr(errorText(e)); } finally { setBusy(""); }
  };
  return (
    <div className="col">
      {groups.map((g) => {
        const mods = nestedOrder(list.filter((m) => m.group === g));
        const on = mods.filter(({ m }) => m.on).length;
        return (
          <details key={g} className="card col module-group">
            <summary>
              <strong>{GROUP_TITLE[g] ?? g}</strong> <span className="muted small">{on} of {mods.length} on</span>
              <div className="muted small">{mods.map(({ m }) => m.title).join(", ")}</div>
            </summary>
            {mods.map(({ m, sub }) => (
              <div key={m.id} className={sub ? "module-sub" : undefined}>
                <ModuleToggle m={m} busy={busy === m.id} onFlip={(v) => void flip(m.id, v)} />
                {m.on && m.id === "homelab" && justSwitchedOn(m.id) && <MachinesStart onDone={() => doneWithFirstSteps(m.id)} />}
              </div>
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
        Switch off what you do not use. Off hides it on every device and stops its background work; nothing is erased, so switching it back on shows everything again (Mail alone deletes the hub's copy of your mail when switched off, as its own text says, and fetches it again from your mailbox when switched back on). Today, the Assistant, Capture, Search, Tasks, Week, Notes, Memory, People and Lists are always on.
      </div>
      <ModulePicker />
    </SubPage>
  );
}
