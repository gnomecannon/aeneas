import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { HubRequest, HubsList, PersonHub } from "../../sync/api";
import { engine } from "../../sync/engine";
import { SubPage, errorText } from "./common";

/**
 * Settings, People on this machine: give someone a hub of their own on the machine this hub runs on, in one step.
 * The hub asks deploy/people.sh's root service (hub/src/hubs.ts); this page follows it and then shows the two things
 * left to do: share the machine on Tailscale, and scan the pairing code on their phone.
 */

const TAILSCALE_MACHINES = "https://login.tailscale.com/admin/machines";

/** The Settings row's summary, or null to leave the row out (another person's hub, a Mac hub). */
export function usePeopleSummary(): string | null {
  const [s, setS] = useState<string | null>(null);
  useEffect(() => {
    engine.client?.hubs().then(
      (h) => setS(h.reason === "not_owner" || h.reason === "linux_only" ? null : !h.available ? "Give someone their own hub here" : others(h.hubs) ? `${others(h.hubs)} more besides you` : "Only you so far"),
      () => setS(null),
    );
  }, []);
  return s;
}
const others = (list: PersonHub[]) => list.filter((h) => !h.owner).length;

function Dot({ color }: { color: string }) {
  return <span className="hub-chip-dot" style={{ background: color || "var(--muted)", display: "inline-block" }} aria-hidden="true" />;
}

/** Follows one request until it is done or failed. */
function useRequest(id: string | null): HubRequest | null {
  const [r, setR] = useState<HubRequest | null>(null);
  useEffect(() => {
    setR(null);
    if (!id) return;
    let stop = false;
    const tick = async () => {
      while (!stop) {
        try {
          const now = await engine.client!.hubRequest(id);
          if (stop) return;
          setR(now);
          if (now.state === "done" || now.state === "failed") return;
        } catch (e) {
          if (!stop) setR({ state: "failed", error: errorText(e) });
          return;
        }
        await new Promise((res) => setTimeout(res, 2000));
      }
    };
    void tick();
    return () => { stop = true; };
  }, [id]);
  return r;
}

/** The two steps after a hub is made, or after a new code: share the machine, then scan on their phone. */
function NextSteps({ result, note }: { result: HubRequest; note: string }) {
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  const app = result.pairing?.app;
  useEffect(() => { if (app) void QRCode.toDataURL(app, { margin: 1, width: 220 }).then(setQr); }, [app]);
  const name = result.name ?? "them";
  return (
    <div className="card col">
      <h2>{result.address ? `${name}’s hub is ready` : `A new code for ${name}`}</h2>
      {result.address && (
        <div className="row">
          <Dot color={result.color ?? ""} />
          <code>{result.address}</code>
        </div>
      )}
      <ol className="col" style={{ paddingLeft: "1.2em", margin: 0 }}>
        <li>
          Share this machine with {name} on Tailscale: in the <a href={TAILSCALE_MACHINES} target="_blank" rel="noreferrer">Tailscale admin console</a>,
          open Machines, choose this machine, then Share. They accept with their own Tailscale account, free.
        </li>
        <li>
          On {name}&rsquo;s phone: install Aeneas and Tailscale, then scan this code with the camera.
          {result.pairing?.code ? ` Or type ${result.pairing.code} with the address above.` : ""} It works once, for 10 minutes; if it runs out, press New pairing code beside their name.
        </li>
      </ol>
      {qr && <img src={qr} width={220} height={220} alt={`Pairing code for ${name}'s phone`} style={{ background: "#fff", borderRadius: 8, alignSelf: "flex-start" }} />}
      {result.pairing?.web && (
        <button type="button" className="ghost small" style={{ alignSelf: "flex-start" }} onClick={() => void navigator.clipboard.writeText(result.pairing!.web!).then(() => setCopied(true))}>
          {copied ? "Copied" : "Copy a link for a computer"}
        </button>
      )}
      <div className="muted small">{note}</div>
    </div>
  );
}

export function PeoplePage() {
  const [data, setData] = useState<HubsList | null>(null);
  const [msg, setMsg] = useState<string>("");
  const [name, setName] = useState("");
  const [reqId, setReqId] = useState<string | null>(null);
  const [busyAccount, setBusyAccount] = useState("");
  const [op, setOp] = useState<"add" | "pair" | "stop" | null>(null);
  const req = useRequest(reqId);
  const load = () => void engine.client?.hubs().then(setData, (e) => setMsg(errorText(e)));
  useEffect(load, []);
  const finished = useRef<string | null>(null);
  useEffect(() => {
    if (req && (req.state === "done" || req.state === "failed") && finished.current !== reqId) { finished.current = reqId; setBusyAccount(""); load(); }
  }, [req?.state, reqId]);

  const add = async () => {
    setMsg("");
    try { setOp("add"); setReqId((await engine.client!.addHub(name.trim())).request_id); setName(""); } catch (e) { setMsg(errorText(e)); }
  };
  const newCode = async (h: PersonHub) => {
    setMsg("");
    setBusyAccount(h.account);
    try { setOp("pair"); setReqId((await engine.client!.pairHub(h.account)).request_id); } catch (e) { setMsg(errorText(e)); setBusyAccount(""); }
  };
  const stop = async (h: PersonHub) => {
    if (!window.confirm(`Stop ${h.name}’s hub? Their devices stop syncing and its address goes off. Their data stays on this machine, in their own account.`)) return;
    setMsg("");
    setBusyAccount(h.account);
    try { setOp("stop"); setReqId((await engine.client!.stopHub(h.account)).request_id); } catch (e) { setMsg(errorText(e)); setBusyAccount(""); }
  };

  const working = req && (req.state === "queued" || req.state === "working");

  return (
    <SubPage path="/settings/people">
      <p className="muted">
        Give someone a hub of their own on this machine: their own notes, chats, settings and devices, apart from yours.
        They use the model this machine runs; when you both ask at once, the hubs take turns.
      </p>
      {data && <div className="card small">{data.admin_note}</div>}
      {!data && !msg && <div className="muted small">Asking the hub.</div>}

      {data && !data.available && data.reason === "not_set_up" && (
        <div className="card col">
          <h2>One step first</h2>
          <div className="small">Run this once on the hub&rsquo;s machine, in a terminal (it asks for your password there). Then come back here.</div>
          <pre className="small" style={{ whiteSpace: "pre-wrap" }}><code>{data.setup_command}</code></pre>
        </div>
      )}
      {data && !data.available && data.reason === "not_owner" && <div className="muted">Only the machine owner&rsquo;s hub adds people.</div>}

      {data?.available && (
        <>
          <div className="card col">
            <h2>Hubs here</h2>
            {data.hubs.map((h) => (
              <div key={h.account} className="row wrap" style={{ alignItems: "center", gap: 8 }}>
                <Dot color={h.color} />
                <strong>{h.name}{h.owner ? " (you)" : ""}</strong>
                <span className="muted small">{h.address ?? `port ${h.port}`}</span>
                <span className={h.up ? "ok small" : "error small"}>{h.up ? "running" : "not answering"}</span>
                {!h.owner && (
                  <span className="row" style={{ marginLeft: "auto", gap: 6 }}>
                    <button type="button" className="small" disabled={!!working} onClick={() => void newCode(h)}>{busyAccount === h.account && working ? "Working" : "New pairing code"}</button>
                    <button type="button" className="ghost small" disabled={!!working} onClick={() => void stop(h)}>Stop</button>
                  </span>
                )}
              </div>
            ))}
          </div>

          <form className="card col" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <h2>Add a person</h2>
            <div className="row">
              <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="Their first name" aria-label="Their name" maxLength={30} disabled={!!working} />
              <button type="submit" className="primary" disabled={!name.trim() || !!working}>Add</button>
            </div>
            <div className="muted small">It takes a minute or two. Their hub gets its own address and color on this machine.</div>
          </form>
        </>
      )}

      {working && <div className="card small" role="status">{req?.step ?? "Waiting for the machine to start on it"}</div>}
      {req?.state === "failed" && <div className="error">{req.error ?? "That did not work."}</div>}
      {req?.state === "done" && op !== "stop" && req.pairing && <NextSteps result={req} note={data?.admin_note ?? req.note ?? ""} />}
      {req?.state === "done" && op === "stop" && <div className="ok small">{req.name}&rsquo;s hub is stopped. Their data stays on this machine.</div>}
      {msg && <div className="error small">{msg}</div>}
    </SubPage>
  );
}
