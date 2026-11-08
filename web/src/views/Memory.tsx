import { useEffect, useMemo, useState } from "react";
import type { Entity } from "@everythingapp/shared";
import { useEntities } from "../sync/hooks";
import { createEntity, updateEntity, softDelete } from "../sync/edits";
import { engine } from "../sync/engine";
import type { LedgerF } from "../lib/memory";
import { fmtDateTime } from "../lib/time";

type FactF = { category: string; key: string; value: string; source?: string; confidence?: number; private?: boolean };
type RuleF = { text: string; enforce: string; pattern?: string; active: boolean };
const CATS = ["identity", "constraint", "preference", "health", "relationship", "host", "project", "gear", "history"];

/** Open ledgers from the hub, else the local copy. */
function Ledgers() {
  const local = useEntities("ledger", (e) => e.fields.open !== false);
  const [hub, setHub] = useState<Entity[] | null>(null);
  useEffect(() => {
    let alive = true;
    engine.client
      ?.ledgers(true)
      .then((l) => alive && setHub(l))
      .catch(() => alive && setHub(null));
    return () => {
      alive = false;
    };
  }, [local.length]);
  const ledgers = (hub ?? local).slice().sort((a, b) => (a.updated_at > b.updated_at ? -1 : 1));
  return (
    <section style={{ marginTop: 20 }}>
      <h2>Open ledgers</h2>
      {!ledgers.length && <div className="empty">No open troubleshooting sessions.</div>}
      <div className="list">
        {ledgers.map((l) => {
          const f = l.fields as LedgerF;
          return (
            <div key={l.id} className="item">
              <div className="body">
                <div className="t">{f.topic}</div>
                <div className="meta">
                  <span>{(f.tried ?? []).length} tried</span>
                  <span>{(f.ruled_out ?? []).length} ruled out</span>
                  <span>{(f.confirmed ?? []).length} confirmed</span>
                  <span>{fmtDateTime(l.updated_at)}</span>
                  <a href={`#/assistant/${encodeURIComponent(f.session_id)}`}>open in Assistant</a>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function Memory() {
  const facts = useEntities("fact");
  const rules = useEntities("rule");
  const [seen, setSeen] = useState<{ facts: Entity[]; rules: Entity[] } | null>(null);
  const [seenErr, setSeenErr] = useState("");
  const [nf, setNf] = useState({ category: "preference", key: "", value: "" });
  const [nr, setNr] = useState("");

  useEffect(() => {
    let alive = true;
    engine.client
      ?.aiMemory()
      .then((m) => alive && setSeen(m))
      .catch((e) => alive && setSeenErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [facts.length, rules.length]);

  const grouped = useMemo(() => {
    const m = new Map<string, Entity[]>();
    for (const f of facts) {
      const c = (f.fields as FactF).category;
      m.set(c, [...(m.get(c) ?? []), f]);
    }
    return CATS.filter((c) => m.has(c)).map((c) => [c, m.get(c)!.sort((a, b) => String(a.fields.key).localeCompare(String(b.fields.key)))] as const);
  }, [facts]);

  return (
    <div>
      <h1>Memory</h1>
      <section>
        <h2>Facts</h2>
        <form
          className="row"
          style={{ marginBottom: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!nf.key.trim() || !nf.value.trim()) return;
            void createEntity("fact", { ...nf, key: nf.key.trim(), value: nf.value.trim(), source: "user", confidence: 1 }).then(() => setNf({ ...nf, key: "", value: "" }));
          }}
        >
          <select value={nf.category} onChange={(e) => setNf({ ...nf, category: e.target.value })} style={{ width: "auto" }} aria-label="Category">
            {CATS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <input placeholder="key" value={nf.key} onChange={(e) => setNf({ ...nf, key: e.target.value })} style={{ width: 160 }} aria-label="Key" />
          <input placeholder="value" className="grow" value={nf.value} onChange={(e) => setNf({ ...nf, value: e.target.value })} aria-label="Value" />
          <button type="submit" disabled={!nf.key.trim() || !nf.value.trim()}>
            Add
          </button>
        </form>
        {!facts.length && <div className="empty">No facts.</div>}
        {grouped.map(([cat, items]) => (
          <div key={cat} className="card">
            <h3>{cat}</h3>
            <div className="col">
              {items.map((f) => {
                const x = f.fields as FactF;
                return (
                  <div key={f.id} className="kv">
                    <input className="inline-edit mono" value={x.key} onChange={(e) => updateEntity(f, { key: e.target.value })} aria-label="Key" />
                    <input className="inline-edit" value={x.value} onChange={(e) => updateEntity(f, { value: e.target.value })} aria-label="Value" />
                    <div className="row" style={{ flexWrap: "nowrap" }}>
                      <label className="small" style={{ margin: 0, whiteSpace: "nowrap" }}>
                        <input type="checkbox" checked={!!x.private} onChange={(e) => updateEntity(f, { private: e.target.checked })} /> private
                      </label>
                      <button className="small ghost danger" onClick={() => confirm("Delete this fact") && softDelete(f)}>
                        Delete
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </section>
      <section style={{ marginTop: 20 }}>
        <h2>Rules</h2>
        <form
          className="row"
          style={{ marginBottom: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!nr.trim()) return;
            void createEntity("rule", { text: nr.trim(), enforce: "prompt", active: true }).then(() => setNr(""));
          }}
        >
          <input placeholder="New rule" className="grow" value={nr} onChange={(e) => setNr(e.target.value)} aria-label="New rule" />
          <button type="submit" disabled={!nr.trim()}>
            Add
          </button>
        </form>
        {!rules.length && <div className="empty">No rules.</div>}
        <div className="list">
          {rules.map((r) => {
            const x = r.fields as RuleF;
            return (
              <div key={r.id} className="item">
                <input type="checkbox" checked={x.active !== false} onChange={(e) => updateEntity(r, { active: e.target.checked })} title="active" aria-label="Active" style={{ marginTop: 8 }} />
                <div className="body">
                  <input className="inline-edit" value={x.text} onChange={(e) => updateEntity(r, { text: e.target.value })} aria-label="Rule text" />
                  <div className="meta">
                    <select value={x.enforce} onChange={(e) => updateEntity(r, { enforce: e.target.value })} className="inline-edit" style={{ width: "auto" }} aria-label="Enforce">
                      <option value="prompt">prompt</option>
                      <option value="filter">filter</option>
                      <option value="both">both</option>
                    </select>
                    {x.pattern && <span className="mono">/{x.pattern}/</span>}
                    <button className="small ghost danger" onClick={() => confirm("Delete this rule") && softDelete(r)}>
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
      <Ledgers />
      <section style={{ marginTop: 20 }}>
        <h2>What the assistant sees</h2>
        {seenErr && <div className="error">{seenErr}</div>}
        {!seen && !seenErr && <div className="muted small">Needs the hub.</div>}
        {seen && (
          <div className="card">
            <div className="small muted">
              {seen.facts.length} facts, {seen.rules.length} rules injected
            </div>
            <ul className="small" style={{ paddingLeft: 18, margin: "6px 0" }}>
              {seen.facts.map((f) => (
                <li key={f.id}>
                  <span className="mono">
                    {String(f.fields.category)}:{String(f.fields.key)}
                  </span>{" "}
                  {String(f.fields.value)}
                </li>
              ))}
            </ul>
            <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
              {seen.rules.map((r) => (
                <li key={r.id}>{String(r.fields.text)}</li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
