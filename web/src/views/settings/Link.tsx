import { useEffect, useState } from "react";
import { HubError, type LinkMethod, type LinkView } from "../../sync/api";
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

/**
 * The three choices, the one in use, and what the Direct link is doing now. Shown on every device, most of which are
 * not the hub's machine, so the words never say where the hub runs. `inSetup` (first run) adds that it can be changed
 * later in Settings.
 */
export function LinkChoice({ onChanged, inSetup = false }: { onChanged?: (v: LinkView) => void; inSetup?: boolean }) {
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
    <div className="col" role="radiogroup" aria-label="How devices reach the hub">
      <div className="muted small">Your hub is the computer that keeps your data. Your phones and computers need a private way to reach it, at home and when you're out.{inSetup ? " You can change this later in Settings." : ""}</div>
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
      <BrowserAccess view={view} onView={(v) => { setView(v); onChanged?.(v); }} />
    </div>
  );
}

/**
 * What a web browser can use, from GET /setup/link (older hubs send neither part): the addresses it opens the hub at,
 * and on a Direct link hub the Tailscale door, as `off`, `on` or `unavailable` with Tailscale's reason. A browser
 * cannot use Direct link itself, so the door is how browsers away from home reach such a hub.
 */
export function browserAccess(view: LinkView): {
  addresses: string[];
  door: null | { state: "off" | "on" | "unavailable"; url: string | null; how: string | null; error: string | null };
} {
  const addresses = [...new Set((view.browser ?? []).filter((a) => /^https?:\/\//i.test(a)))];
  const d = view.tailscale_door;
  if (view.method !== "direct" || !d) return { addresses, door: null };
  const state = d.on ? "on" : d.available ? "off" : "unavailable";
  return { addresses, door: { state, url: d.on ? d.url ?? null : null, how: state === "unavailable" ? d.how ?? null : null, error: d.error ?? null } };
}

/** Why the hub refused to turn the door on or off: Tailscale's reason in a plain sentence. */
export function doorRefusal(e: unknown): string {
  const how = e instanceof HubError ? (e.detail as { how?: unknown } | undefined)?.how : undefined;
  return typeof how === "string" && how ? how : errorText(e);
}

function BrowserAccess({ view, onView }: { view: LinkView; onView: (v: LinkView) => void }) {
  const { addresses, door } = browserAccess(view);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState("");
  const [copied, setCopied] = useState("");
  if (!addresses.length && !door) return null;
  const copy = (a: string) => void navigator.clipboard.writeText(a).then(() => setCopied(a)).catch(() => setCopied(""));
  const turn = async (on: boolean) => {
    setBusy(true); setRefused("");
    try { onView(await engine.client!.setTailscaleDoor(on)); } catch (e) { setRefused(doorRefusal(e)); } finally { setBusy(false); }
  };
  return (
    <div className="col" style={{ gap: 6, marginTop: 8 }}>
      {addresses.length > 0 && (
        <>
          <div><strong>A web browser opens this hub at</strong></div>
          {addresses.map((a) => (
            <div key={a} className="row" style={{ alignItems: "center" }}>
              <code className="grow" style={{ overflowWrap: "anywhere" }}>{a}</code>
              <button type="button" className="ghost small" onClick={() => copy(a)} aria-label={`Copy ${a}`}>{copied === a ? "Copied" : "Copy"}</button>
            </div>
          ))}
        </>
      )}
      {door && door.state !== "unavailable" && (
        <>
          <label className="row" style={{ alignItems: "center", gap: 8 }}>
            <input type="checkbox" role="switch" checked={door.state === "on"} disabled={busy} onChange={(e) => void turn(e.target.checked)} />
            <span>Also answer web browsers on your tailnet</span>
          </label>
          <div className="muted small">Apps keep using Direct link. Browsers on your tailnet use the hub's Tailscale address, with a real certificate.</div>
          {door.url && <div className="small">Browsers on your tailnet open <code>{door.url}</code>.</div>}
        </>
      )}
      {door?.state === "unavailable" && door.how && <div className="muted small">Web browsers on your tailnet: {door.how}</div>}
      {door?.error && <div className="error small">{door.error}</div>}
      {refused && <div className="error small">{refused}</div>}
    </div>
  );
}
