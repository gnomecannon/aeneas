import { useEffect, useState } from "react";
import { engine } from "../../sync/engine";
import type { HubMachine } from "../../sync/api";
import { errorText } from "./common";
import { useHubReady } from "../../sync/hooks";

const label = (d: number) => (d === 0 ? "Forever" : d === 365 ? "1 year" : `${d} days`);

/**
 * How long the hub keeps chats and the output of commands it ran. Nothing is deleted unless a number of days is chosen.
 * `suggest` (the Welcome page of a new hub): a hub still keeping everything is set to 90 and 30 days once, shown here.
 */
export function RetentionSettings({ suggest = false }: { suggest?: boolean }) {
  const [v, setV] = useState<{ chat_keep_days: number; command_output_keep_days: number; choices: number[] } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    const c = engine.client;
    if (!c) return;
    c.retention().then(async (r) => {
      if (suggest && r.chat_keep_days === 0 && r.command_output_keep_days === 0) {
        const s = await c.setRetention({ chat_keep_days: 90, command_output_keep_days: 30 });
        setV({ ...r, ...s });
      } else setV(r);
    }, (e) => setErr(errorText(e)));
  }, [suggest]);
  const save = (patch: { chat_keep_days?: number; command_output_keep_days?: number }) => {
    const c = engine.client;
    if (!c || !v) return;
    setErr("");
    c.setRetention(patch).then((s) => setV({ ...v, ...s }), (e) => setErr(errorText(e)));
  };
  if (!v) return err ? <div className="error">{err}</div> : null;
  const pick = (id: string, text: string, value: number, key: "chat_keep_days" | "command_output_keep_days") => (
    <label className="row" htmlFor={id}>
      <span>{text}</span>
      <select id={id} value={value} onChange={(e) => save({ [key]: Number(e.target.value) })}>
        {[...new Set([...v.choices, value])].sort((a, b) => (a || 1e9) - (b || 1e9)).map((d) => <option key={d} value={d}>{label(d)}</option>)}
      </select>
    </label>
  );
  return (
    <div className="col">
      {pick("keep-chats", "Keep chats", v.chat_keep_days, "chat_keep_days")}
      {pick("keep-output", "Keep command output", v.command_output_keep_days, "command_output_keep_days")}
      <div className="muted small">Older chats and the output of commands the assistant ran are deleted from the hub each night. Forever deletes nothing. Notes, tasks and everything you saved are never affected.</div>
      {err && <div className="error">{err}</div>}
    </div>
  );
}

/**
 * The machines the assistant may run commands on and the sensors read. Only machines listed here are reached; names from
 * the hub machine's SSH config can be added with one tap.
 */
export function MachinesSettings() {
  const [list, setList] = useState<HubMachine[] | null>(null);
  const [ssh, setSsh] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const ready = useHubReady();
  useEffect(() => {
    engine.client?.machines().then((r) => { setList(r.machines); setSsh(r.ssh_config); }, (e) => setErr(errorText(e)));
  }, [ready]);
  const save = (next: HubMachine[]) => {
    setErr("");
    engine.client?.setMachines(next).then((r) => setList(r.machines), (e) => setErr(errorText(e)));
  };
  if (!list) return err ? <div className="error">{err}</div> : null;
  const have = new Set(list.map((m) => m.name));
  const offer = ssh.filter((n) => !have.has(n.toLowerCase()));
  return (
    <div className="col">
      <div className="muted small">The assistant runs read-only commands on these at once; anything that changes a machine waits for your approval. With Sensors on, the hub also reads their temperature and disk every 10 minutes. No other machine is contacted.</div>
      {list.length === 0 && <div className="muted">No machines yet.</div>}
      {list.map((m) => (
        <div key={m.name} className="row between">
          <span>{m.name}{m.ssh && m.ssh !== m.name ? <span className="muted small"> ({m.ssh})</span> : null}{m.local ? <span className="muted small"> (the hub machine)</span> : null}</span>
          <button type="button" className="small ghost" onClick={() => save(list.filter((x) => x.name !== m.name))}>Remove</button>
        </div>
      ))}
      {offer.length > 0 && (
        <div className="chips" role="group" aria-label="Add from the hub's SSH config">
          {offer.map((n) => <button key={n} type="button" className="chip" onClick={() => save([...list, { name: n.toLowerCase(), ssh: n }])}>Add {n}</button>)}
        </div>
      )}
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) { save([...list, { name: name.trim().toLowerCase(), ssh: name.trim() }]); setName(""); } }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name or SSH host" aria-label="Machine name or SSH host" autoCapitalize="off" spellCheck={false} />
        <button type="submit" disabled={!name.trim()}>Add</button>
      </form>
      {err && <div className="error">{err}</div>}
    </div>
  );
}
