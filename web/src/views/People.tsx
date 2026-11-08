import { useState } from "react";
import { factsAbout } from "@everythingapp/shared";
import { useEntities, useEntity } from "../sync/hooks";
import { softDelete } from "../sync/edits";
import { Related } from "./Item";

type Labeled = { label?: string; value: string };
type Address = { label?: string; street?: string; city?: string; state?: string; postal_code?: string };

const norm = (s: unknown) => String(s ?? "").toLowerCase().trim();

function Person({ id }: { id: string }) {
  const p = useEntity(id);
  const facts = useEntities("fact");
  const everyone = useEntities("person");
  if (!p || p.deleted_at) return <div className="empty">This person was removed.</div>;
  const f = p.fields as Record<string, any>;
  const phones = (f.phones ?? []) as Labeled[];
  const emails = (f.emails ?? []) as Labeled[];
  const addresses = (f.addresses ?? []) as Address[];
  const known = factsAbout(p, everyone, facts);
  const sub = [f.nickname ? `"${f.nickname}"` : "", f.relationship, [f.job_title, f.organization].filter(Boolean).join(", ")].filter(Boolean);
  return (
    <div>
      <a href="#/people" className="small">All people</a>
      <h1>{f.name}</h1>
      {sub.length > 0 && <div className="muted">{sub.join("  ·  ")}</div>}
      <div className="list" style={{ marginTop: 16 }}>
        {phones.map((x, i) => <a key={`p${i}`} className="item" href={`tel:${x.value.replace(/[^\d+]/g, "")}`}><div className="body"><div className="meta">{x.label ?? "phone"}</div><div className="t">{x.value}</div></div></a>)}
        {emails.map((x, i) => <a key={`e${i}`} className="item" href={`mailto:${x.value}`}><div className="body"><div className="meta">{x.label ?? "email"}</div><div className="t">{x.value}</div></div></a>)}
        {addresses.map((a, i) => {
          const line = [a.street, a.city, a.state, a.postal_code].filter(Boolean).join(", ");
          return <a key={`a${i}`} className="item" href={`https://maps.apple.com/?q=${encodeURIComponent(line)}`} target="_blank" rel="noreferrer"><div className="body"><div className="meta">{a.label ?? "address"}</div><div className="t">{line}</div></div></a>;
        })}
        {f.birthday && <div className="item"><div className="body"><div className="meta">birthday</div><div className="t">{String(f.birthday).replace(/^--/, "")}</div></div></div>}
        {(Array.isArray(f.dates) ? (f.dates as { label?: string; date: string }[]) : []).map((d, i) => (
          <div key={`date${i}`} className="item"><div className="body"><div className="meta">{d.label && d.label !== "other" ? d.label : "date"}</div><div className="t">{String(d.date).replace(/^--/, "")}</div></div></div>
        ))}
      </div>
      <section style={{ marginTop: 20 }}>
        <h2>What you've told me</h2>
        {!known.length && <div className="empty">Tell the assistant or capture things about {f.given_name || f.name} and they show here.</div>}
        <div className="list">
          {known.map((k) => (
            <div key={k.id} className="item">
              <div className="body"><div className="t">{String(k.fields.value)}</div></div>
              <button className="small ghost danger" onClick={() => softDelete(k)}>Forget</button>
            </div>
          ))}
        </div>
      </section>
      <Related id={p.id} exclude={["About them"]} />
    </div>
  );
}

/** People: contacts (synced both ways with Apple Contacts by the Mac) and what the owner has said about each. */
export function People({ id }: { id?: string }) {
  const people = useEntities("person").sort((a, b) => String(a.fields.name).localeCompare(String(b.fields.name)));
  const [q, setQ] = useState("");
  if (id) return <Person id={id} />;
  const shown = people.filter((p) => !q || [p.fields.name, p.fields.nickname, p.fields.organization, p.fields.relationship].some((v) => norm(v).includes(norm(q))));
  return (
    <div>
      <h1>People</h1>
      <input type="search" placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%", marginBottom: 12 }} />
      {!people.length && <div className="empty">No contacts yet. Turn on Settings, People, "Sync Apple Contacts" in the Mac app.</div>}
      <div className="list">
        {shown.map((p) => (
          <a key={p.id} className="item" href={`#/people/${p.id}`}>
            <div className="body">
              <div className="t">{String(p.fields.name)}</div>
              <div className="meta">{[p.fields.nickname, p.fields.relationship, p.fields.organization].filter(Boolean).map(String).join("  ·  ")}</div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
