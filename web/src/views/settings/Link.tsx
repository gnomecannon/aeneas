import { useEffect, useState } from "react";
import type { LinkMethod, LinkView } from "../../sync/api";
import { engine } from "../../sync/engine";
import { errorText } from "./common";
import { useHubReady } from "../../sync/hooks";

/**
 * How devices reach the hub: Direct link (iroh), Tailscale or the home network only. Each choice names every outside
 * party it involves on the screen itself; the ⓘ opens a short note in place and links to the full comparison.
 */
/** The first app version on every platform that can use the Direct link (older apps cannot read its QR code). */
export const DIRECT_LINK_MIN_APP = "1.0.3";

export const LINK_CHOICES: { method: LinkMethod; title: string; tag?: string; line: string; info: string }[] = [
  {
    method: "direct",
    title: "Direct link",
    tag: "recommended, uses iroh",
    line: "Scan a QR code and you're done. No account. Works at home and away.",
    info: `Your devices connect straight to this hub, encrypted end to end, using iroh, open source networking software from the company n0. If a direct path is blocked, traffic passes through a relay that can't read it or pretend to be your hub. Relays are run by n0, free, with no uptime promise. No account: the QR code is the only key, and only devices that scanned it can connect. It needs Aeneas ${DIRECT_LINK_MIN_APP} or newer on each phone and computer.`,
  },
  {
    method: "tailscale",
    title: "Tailscale",
    line: "For people who already use Tailscale. Needs a free Tailscale account and a sign-in on each device.",
    info: "Tailscale builds a private network of your devices. It's mature and widely audited. You need an account (Google, Apple, Microsoft or GitHub). Tailscale keeps a list of your devices and when they're online, and its server decides which devices belong to your network. Devices sign in again every 180 days unless you turn that off. Choose this if you already use Tailscale or want the hub to reach your other machines.",
  },
  {
    method: "home",
    title: "Home Wi-Fi only",
    line: "Nothing to sign in to. Your devices reach the hub only on your home network.",
    info: "Devices connect over your own network using the hub's own certificate, which the QR code lets them check. Nothing leaves your home. Away from home, the apps can't reach the hub.",
  },
];

function Choice({ c, chosen, available, how, onPick, busy }: { c: (typeof LINK_CHOICES)[number]; chosen: boolean; available: boolean; how?: string; onPick: () => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const id = `link-${c.method}`;
  return (
    <div className={`link-choice${chosen ? " chosen" : ""}${available ? "" : " unavailable"}`}>
      <div className="row" style={{ alignItems: "flex-start", gap: 10 }}>
        <input type="radio" name="link" id={id} checked={chosen} disabled={busy || (!available && !chosen)} onChange={onPick} style={{ marginTop: 4 }} />
        <label htmlFor={id} className="grow col" style={{ gap: 2, cursor: available ? "pointer" : "default" }}>
          <span><strong>{c.title}</strong>{c.tag && <span className="muted"> ({c.tag})</span>}</span>
          <span className="muted small">{c.line}</span>
          {!available && how && <span className="small">{how}</span>}
        </label>
        <button type="button" className="info-btn" aria-expanded={open} aria-controls={`${id}-info`} aria-label={`About ${c.title}`} onClick={() => setOpen(!open)}>ⓘ</button>
      </div>
      {open && (
        <div id={`${id}-info`} className="link-info small">
          {c.info} <a href="#/help/connections">Learn more</a>
        </div>
      )}
    </div>
  );
}

/** The three choices, the one in use, and what the Direct link is doing now. */
export function LinkChoice({ onChanged }: { onChanged?: (v: LinkView) => void }) {
  const [view, setView] = useState<LinkView | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => void engine.client?.link().then(setView).catch((e) => setMsg({ ok: false, text: errorText(e) }));
  const ready = useHubReady();
  useEffect(load, [ready]);
  // While the Direct link starts, ask again until it settles; after a failed start, ask again once the hub has retried.
  useEffect(() => {
    const d = view?.direct;
    const wait = d?.state === "starting" ? 1500 : d?.state === "error" && d.retry_at ? Math.max(1500, Date.parse(d.retry_at) - Date.now() + 1500) : 0;
    if (!wait) return;
    const t = setTimeout(load, Math.min(wait, 5 * 60_000));
    return () => clearTimeout(t);
  }, [view]);
  const pick = async (m: LinkMethod) => {
    if (!view || m === view.method) return;
    if (view.method && !window.confirm(`Switch to ${LINK_CHOICES.find((c) => c.method === m)!.title}? Devices paired over ${LINK_CHOICES.find((c) => c.method === view.method)!.title} will need a new pairing code.`)) return;
    setBusy(true); setMsg(null);
    try { const v = await engine.client!.setLink(m); setView(v); onChanged?.(v); } catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { setBusy(false); }
  };
  if (!view) return msg ? <div className="error small">{msg.text}</div> : <div className="muted small">Asking the hub how devices reach it.</div>;
  const d = view.direct;
  return (
    <div className="col" role="radiogroup" aria-label="How devices reach this hub">
      <div className="muted small">Your hub runs on this computer. Your other devices need a private way to reach it, at home and when you're out. You can change this later in Settings.</div>
      {LINK_CHOICES.map((c) => (
        <Choice key={c.method} c={c} chosen={view.method === c.method} available={view.options[c.method].available} how={view.options[c.method].how} busy={busy} onPick={() => void pick(c.method)} />
      ))}
      {view.method === "direct" && (
        <div className="small" aria-live="polite">
          {d.state === "starting" && <span className="muted">Starting the Direct link.</span>}
          {d.state === "online" && <span className="ok">Direct link is on. Relay: {d.relay_by ?? d.relay}. {d.connected ? `${d.connected} device${d.connected === 1 ? "" : "s"} connected, ${d.direct} directly.` : "No device connected right now."}</span>}
          {d.state === "error" && <span className="error">Direct link didn't start: {d.error}{d.retry_at ? ` Trying again at ${new Date(d.retry_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : ""}</span>}
        </div>
      )}
      {msg && <div className={msg.ok ? "ok small" : "error small"}>{msg.text}</div>}
    </div>
  );
}
