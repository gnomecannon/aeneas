import { useState, type ReactNode } from "react";
import { moduleOfScreen, setModules, useModules } from "../lib/modules";

/**
 * A screen of a module that is off (Settings, Modules) shows what the module is and a way to turn it on, instead of
 * a screen whose hub calls all answer "off". Reached from an old link, a keyboard shortcut or another window.
 */
export function ModuleGate({ path, children }: { path: string; children: ReactNode }) {
  const id = moduleOfScreen(path.startsWith("/career") ? "/lists/jobs" : path);
  const { list, on } = useModules();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (on(id)) return <>{children}</>;
  const m = list?.find((x) => x.id === id);
  return (
    <div className="col">
      <h1>{m?.title ?? "Switched off"}</h1>
      <section className="card col">
        <div>{m?.title ?? "This part"} is switched off on every device.</div>
        {m?.summary && <div className="muted small">{m.summary}</div>}
        <div className="row wrap">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setErr("");
              void setModules({ [id!]: true }).catch((e) => setErr((e as Error).message)).finally(() => setBusy(false));
            }}
          >
            {busy ? "Turning on" : "Turn it on"}
          </button>
          <a href="#/settings/modules" className="small">All modules</a>
        </div>
        {err && <div className="error small">{err}</div>}
      </section>
    </div>
  );
}

/** Children only while a module is on (banners, toasts and cards that belong to one). */
export function IfModule({ id, children }: { id: string; children: ReactNode }) {
  const { on } = useModules();
  return on(id) ? <>{children}</> : null;
}
