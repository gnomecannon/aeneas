import { useState } from "react";
import { factsAbout, personFactGroups, personFactKey, type Entity, type PersonFactGroup } from "@everythingapp/shared";
import { useEntities, useEntity } from "../sync/hooks";
import { createEntity, softDelete, updateEntity } from "../sync/edits";
import { DraftTextarea } from "../components/DraftField";
import { localDate, parseLocalDate } from "../lib/planner";
import { Related } from "./Item";

type Labeled = { label?: string; value: string };
type Address = { label?: string; street?: string; city?: string; state?: string; postal_code?: string };

const norm = (s: unknown) => String(s ?? "").toLowerCase().trim();

/** Which sections of a person's page the owner opened or closed, kept on this device. The others start open when they
 * hold something and closed when empty. */
const SECTIONS_KEY = "people.sections";

function readSections(): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(SECTIONS_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, b]) => typeof b === "boolean")) as Record<string, boolean> : {};
  } catch {
    return {};
  }
}

const givenDay = (day: string) => parseLocalDate(day).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** One thing remembered about them: its words, typed over to change it (as on Memory), and Forget. A gift idea also
 * says what it is for and is marked Given (today's date) or not, on a line of its own so a phone has room; a given
 * one is dimmed, with the day. */
function FactRow({ f, gift }: { f: Entity; gift: boolean }) {
  const given = String(f.fields.given_at ?? "");
  const occasion = String(f.fields.occasion ?? "");
  const forget = <button className="small ghost danger" onClick={() => void softDelete(f)}>Forget</button>;
  return (
    <div className={`item${given ? " given" : ""}`}>
      <div className="body">
        {/* A text box that grows with its words: a long one was cut off at the edge on a phone. Enter ends the edit. */}
        <DraftTextarea item={f} field="value" rows={1} className="inline-edit grow" aria-label={gift ? "Gift idea" : "What you told me"}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); } }} />
        {gift && (
          <div className="row between">
            <div className="meta">
              {occasion && <span>For {occasion}</span>}
              {given && <span>Given {givenDay(given)}</span>}
            </div>
            <div className="row" style={{ gap: 4 }}>
              <button className="small ghost" aria-pressed={!!given} onClick={() => void updateEntity(f, { given_at: given ? null : localDate(new Date()) })}>
                {given ? "Mark not given" : "Mark given"}
              </button>
              {forget}
            </div>
          </div>
        )}
      </div>
      {!gift && forget}
    </div>
  );
}

const ADD_WORDS: Record<string, { placeholder: string; label: (name: string) => string }> = {
  like: { placeholder: "Something they like", label: (n) => `Add something ${n} likes` },
  dislike: { placeholder: "Something they dislike", label: (n) => `Add something ${n} dislikes` },
  gift_idea: { placeholder: "A gift idea", label: (n) => `Add a gift idea for ${n}` },
};

/** One section of what you've told me (Likes, Gift ideas...): its heading opens and closes it; Likes, Dislikes and Gift
 * ideas also have a field that adds one to this person. */
function FactSection({ group, person, name, called, open, toggle }: { group: PersonFactGroup<Entity>; person: Entity; name: string; called: string; open: boolean; toggle: () => void }) {
  const [draft, setDraft] = useState("");
  const add = group.add;
  return (
    <div className="card person-facts">
      <h3 style={{ margin: 0 }}>
        <button className="fold-head" onClick={toggle} aria-expanded={open}>
          <span aria-hidden="true">{open ? "▾" : "▸"}</span> {group.title} <span className="muted small">{group.items.length}</span>
        </button>
      </h3>
      {open && (
        <div style={{ marginTop: 8 }}>
          {!group.items.length && group.empty && <div className="muted small" style={{ marginBottom: 6 }}>{group.empty}</div>}
          {group.items.length > 0 && (
            <div className="list rows">
              {group.items.map((f) => <FactRow key={f.id} f={f} gift={group.id === "gift_ideas"} />)}
            </div>
          )}
          {add && (
            <form
              className="row"
              style={{ marginTop: 8, flexWrap: "nowrap" }}
              onSubmit={(e) => {
                e.preventDefault();
                const value = draft.trim();
                if (!value) return;
                void createEntity("fact", { category: add, key: personFactKey(add, value), value, person_id: person.id, person: name, source: "user", confidence: 1 }).then(() => setDraft(""));
              }}
            >
              <input className="grow" placeholder={ADD_WORDS[add].placeholder} aria-label={ADD_WORDS[add].label(called)} value={draft} onChange={(e) => setDraft(e.target.value)} />
              <button type="submit" disabled={!draft.trim()}>Add</button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

function Person({ id }: { id: string }) {
  const p = useEntity(id);
  const facts = useEntities("fact");
  const everyone = useEntities("person");
  const [chosen, setChosen] = useState<Record<string, boolean>>(readSections);
  if (!p || p.deleted_at) return <div className="empty">This person was removed.</div>;
  const f = p.fields as Record<string, any>;
  const phones = (f.phones ?? []) as Labeled[];
  const emails = (f.emails ?? []) as Labeled[];
  const addresses = (f.addresses ?? []) as Address[];
  const known = factsAbout(p, everyone, facts);
  // Likes, Dislikes and Gift ideas always show, so there is somewhere to add one; the others only when they hold something.
  const groups = personFactGroups(p, known).filter((g) => g.add || g.items.length);
  const isOpen = (g: PersonFactGroup<Entity>) => chosen[g.id] ?? g.items.length > 0;
  const toggle = (g: PersonFactGroup<Entity>) =>
    setChosen((prev) => {
      const next = { ...prev, [g.id]: !(prev[g.id] ?? g.items.length > 0) };
      try {
        localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
      } catch {
        /* private window: kept until the page reloads */
      }
      return next;
    });
  const called = String(f.given_name || f.name || "");
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
        {!known.length && <div className="muted small" style={{ marginBottom: 8 }}>Tell the assistant or capture things about {called} and they show here, or add them below.</div>}
        {groups.map((g) => <FactSection key={g.id} group={g} person={p} name={String(f.name ?? "")} called={called} open={isOpen(g)} toggle={() => toggle(g)} />)}
      </section>
      <Related id={p.id} exclude={["About them"]} />
    </div>
  );
}

/**
 * An empty People on any device: add someone by name here, or tell the assistant about them; contacts come in by
 * themselves only from an Apple device, so that is said last instead of being the only way in.
 */
function AddFirstPerson() {
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const add = async () => {
    const n = name.trim();
    if (!n) return;
    setErr("");
    try {
      const p = await createEntity("person", { name: n, dates: [], phones: [], emails: [], addresses: [] });
      window.location.hash = `/people/${p.id}`;
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <div className="empty col">
      <div>No people yet. Add someone by name, or tell the assistant about them, like &quot;Jamie is my sister, her birthday is May 3&quot;.</div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="New person's name" />
        <button type="submit" className="primary" disabled={!name.trim()}>Add</button>
      </form>
      {err && <div className="error small">{err}</div>}
      <div className="muted small">With Contacts switched on in Settings, Accounts on an iPhone, iPad or Mac, your contacts come in too.</div>
    </div>
  );
}

/** People: contacts (synced both ways with Apple Contacts by the one iPhone, iPad or Mac where Contacts is on) and what the owner has said about each. */
export function People({ id }: { id?: string }) {
  const people = useEntities("person").sort((a, b) => String(a.fields.name).localeCompare(String(b.fields.name)));
  const [q, setQ] = useState("");
  if (id) return <Person id={id} />;
  const shown = people.filter((p) => !q || [p.fields.name, p.fields.nickname, p.fields.organization, p.fields.relationship].some((v) => norm(v).includes(norm(q))));
  return (
    <div>
      <h1>People</h1>
      <input type="search" placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%", marginBottom: 12 }} />
      {/* The switch moved to Settings, Accounts, From this iPhone (iPad, Mac), Contacts with Accounts, part 2. */}
      {!people.length && <AddFirstPerson />}
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
