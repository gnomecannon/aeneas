import { useEffect, useState } from "react";
import type { OwnKeyGuide as Guide } from "../../sync/api";
import { engine } from "../../sync/engine";
import { errorText } from "./common";

type Msg = { ok: boolean; text: string } | null;

/**
 * A service that needs the person's own key or app (Gmail, Confluence, Steam playtime): the hub's guide for it, one
 * step at a time, with this hub's own values to copy, a link to the service's page, and at the end the fields to
 * paste, saved to the hub and checked. Shown folded, as a different level of setup, until someone opens it.
 */
export function OwnKeyGuide({ service, onDone }: { service: "google" | "atlassian" | "steam"; onDone: () => void }) {
  const client = engine.client;
  const [guide, setGuide] = useState<Guide | null>(null);
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [copied, setCopied] = useState("");
  const [anyway, setAnyway] = useState(false);
  useEffect(() => { if (open && !guide) void client?.ownKeyGuide(service).then(setGuide).catch((e) => setMsg({ ok: false, text: errorText(e) })); }, [open, guide, client, service]);
  if (!client) return null;
  if (!open) {
    return (
      <div className="col">
        <div className="muted small"><strong>Advanced setup.</strong> This needs your own {service === "google" ? "Google app" : service === "atlassian" ? "Atlassian app" : "Steam key"}, made once by you on the service's own site; there is no server of ours in between. A guide takes you through it.</div>
        <div><button type="button" className="primary" onClick={() => setOpen(true)}>Set it up with the guide</button></div>
      </div>
    );
  }
  if (!guide) return msg ? <div className="error small">{msg.text}</div> : <div className="muted small">Loading the guide.</div>;
  // The hub's address stops this service from working: say so first, instead of ten minutes of steps that end in a
  // sign-in the service refuses. The steps stay one tap away for someone who is about to change the address.
  if (guide.warning && !anyway) {
    return (
      <div className="col card" style={{ gap: 10 }}>
        <strong>{guide.title}</strong>
        <div className="error small">Not on this hub yet. {guide.warning}</div>
        <div className="muted small">Everything else works without it. Once the hub has a Tailscale address, open this guide from that address and the steps fill in the right values.</div>
        <div className="row">
          <button type="button" className="ghost" onClick={() => setAnyway(true)}>Show the steps anyway</button>
          <button type="button" className="ghost" onClick={() => setOpen(false)}>Close</button>
        </div>
      </div>
    );
  }
  const step = guide.steps[i];
  const last = i === guide.steps.length - 1;
  const copy = (v: string) => void navigator.clipboard.writeText(v).then(() => { setCopied(v); setTimeout(() => setCopied(""), 1500); });
  const save = async () => {
    if (!step.save) return;
    setBusy(true);
    setMsg(null);
    try {
      await client.ownKeySave(step.save.path, Object.fromEntries((step.fields ?? []).map((f) => [f.id, (values[f.id] ?? "").trim()])));
      let text = "Saved. ";
      if (step.test) {
        const t = await client.ownKeyTest(step.test.path);
        if (!t.ok) { setMsg({ ok: false, text: t.message }); return; }
        text = `${t.message} `;
      }
      setValues({});
      setMsg({ ok: true, text: text + guide.after });
      onDone();
    } catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { setBusy(false); }
  };
  return (
    <div className="col card" style={{ gap: 10 }}>
      <div className="row" style={{ alignItems: "baseline" }}>
        <strong className="grow">{guide.title}</strong>
        <span className="muted small">Step {i + 1} of {guide.steps.length}, about {guide.minutes} minutes in all</span>
      </div>
      {guide.warning && <div className="error small">{guide.warning}</div>}
      <strong>{step.title}</strong>
      <div className="small">{step.text}</div>
      {step.link && <div><a href={step.link.url} target="_blank" rel="noreferrer">{step.link.label}</a> <span className="muted small">(opens the service's own page)</span></div>}
      {step.copy?.map((c) => (
        <div key={c.label} className="col" style={{ gap: 2 }}>
          <span className="muted small">{c.label}</span>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <code className="grow" style={{ wordBreak: "break-all", userSelect: "all" }}>{c.value}</code>
            <button type="button" className="ghost small" onClick={() => copy(c.value)}>{copied === c.value ? "Copied" : "Copy"}</button>
          </div>
        </div>
      ))}
      {step.fields && (
        <form className="col" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {step.fields.map((f) => (
            <label key={f.id} className="col small" style={{ gap: 2 }}>
              {f.label}
              <input type={f.secret ? "password" : "text"} autoComplete="off" spellCheck={false} placeholder={f.placeholder} value={values[f.id] ?? ""} onChange={(e) => setValues({ ...values, [f.id]: e.target.value })} />
            </label>
          ))}
          <div><button type="submit" className="primary" disabled={busy || step.fields.some((f) => !(values[f.id] ?? "").trim())}>{busy ? "Checking" : step.test ? "Save and check" : "Save"}</button></div>
        </form>
      )}
      {msg && <div className={msg.ok ? "ok small" : "error small"}>{msg.text}</div>}
      <div className="row">
        <button type="button" className="ghost small" disabled={i === 0} onClick={() => { setI(i - 1); setMsg(null); }}>Back</button>
        {!last && <button type="button" onClick={() => { setI(i + 1); setMsg(null); }}>Next</button>}
        <button type="button" className="ghost small" onClick={() => { setOpen(false); setI(0); setMsg(null); }}>Close</button>
      </div>
    </div>
  );
}
