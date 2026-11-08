import { useEffect, type ReactNode } from "react";

/** Page titles by path, for headings and the "‹ Parent" back links (the Shell's phone top bar uses them too). */
export const SETTINGS_TITLES: Record<string, string> = {
  "/settings": "Settings",
  "/settings/theme": "Theme",
  "/settings/theme/colors": "App colors",
  "/settings/theme/taps": "Tap effects",
  "/settings/theme/sounds": "Note sounds",
  "/settings/connection": "Connection",
  "/settings/connections": "Connections",
  "/settings/notifications": "Notifications",
  "/settings/work": "Work space",
  "/settings/planner": "Planner",
  "/settings/data": "Data",
  "/settings/import": "Bring your data in",
  "/settings/modules": "Modules",
  "/settings/windows": "Windows app",
  "/settings/about": "About",
  "/settings/people": "People on this machine",
};

/** The page one level up from a Settings sub-page, or null outside them. */
export function settingsBack(path: string): { path: string; label: string } | null {
  if (!path.startsWith("/settings/")) return null;
  const parent = path.slice(0, path.lastIndexOf("/"));
  return { path: parent, label: SETTINGS_TITLES[parent] ?? "Settings" };
}

/** A Settings sub-page: a back link (desktop; the phone's top bar has its own) and a heading. */
export function SubPage({ path, title, children }: { path: string; title?: string; children: ReactNode }) {
  const back = settingsBack(path);
  // Each page opens at its top, not at the scroll position of the page before it.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [path]);
  return (
    <div className="settings-page col">
      {back && (
        <a className="sub-back" href={`#${back.path}`}>
          {"‹"} {back.label}
        </a>
      )}
      <h1>{title ?? SETTINGS_TITLES[path] ?? "Settings"}</h1>
      {children}
    </div>
  );
}

/** One row of a menu: a name, what it is set to now, and the way in. */
export function NavRow({ href, title, summary, extra }: { href: string; title: string; summary?: string; extra?: ReactNode }) {
  return (
    <a href={`#${href}`} className="item library-row settings-row">
      <span className="body">
        <span className="t">{title}</span>
        {summary && <span className="meta">{summary}</span>}
      </span>
      {extra}
      <span className="chev" aria-hidden="true">
        {"›"}
      </span>
    </a>
  );
}

/** A labelled on/off switch, with an optional line under it. */
export function Toggle({ checked, onChange, label, note, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; note?: ReactNode; disabled?: boolean }) {
  return (
    <div className="toggle">
      <label className="toggle-row">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span>{label}</span>
      </label>
      {note && <div className="muted small toggle-note">{note}</div>}
    </div>
  );
}

/** A small set of buttons where one is chosen. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A plain-words message from an error. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
