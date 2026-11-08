import { useEffect, useState } from "react";
import { engine } from "../sync/engine";
import { MEALS_STATES, locationNotice, stateNote } from "../lib/mealsTax";
import { isTauri } from "../tauri/bridge";
import { HubError } from "../sync/api";
import { useEntities } from "../sync/hooks";
import { viaHub } from "../sync/admin";
import {
  money,
  payoff,
  readPayoff,
  readSplit,
  readSubs,
  readTakeHome,
  readUnit,
  split,
  subscriptions,
  takeHome,
  unitPrices,
  TAX_YEAR,
  type Filing,
  type Frequency,
  type PayLines,
  type PayoffResult,
  type SplitResult,
  type SubsResult,
  type TakeHomeResult,
  type UnitRow,
} from "../lib/calc";

const num = (v: string): number | null => (v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Posts to /calc/<kind> a moment after the inputs settle. When the hub is unreachable (or predates Module 7) the same math runs
 * here and the result says "local". A hub 4xx is shown as the error.
 */
function useCalc<T>(kind: "split" | "payoff" | "unit" | "takehome", body: unknown | null, local: () => T, read: (raw: unknown, fb: T) => T) {
  const [out, setOut] = useState<{ value: T; local: boolean } | null>(null);
  const [err, setErr] = useState("");
  const key = JSON.stringify(body);
  useEffect(() => {
    if (body == null) {
      setOut(null);
      setErr("");
      return;
    }
    let fb: T;
    try {
      fb = local();
    } catch (e) {
      setOut(null);
      setErr(e instanceof Error ? e.message : String(e));
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      viaHub((c) => c.calc(kind, body))
        .then((raw) => {
          if (cancelled) return;
          setErr("");
          setOut(raw === undefined ? { value: fb, local: true } : { value: read(raw, fb), local: false });
        })
        .catch((e) => {
          if (cancelled) return;
          setOut(null);
          setErr(e instanceof HubError ? e.message : String(e));
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [key]);
  return { out, err };
}

function Local({ on }: { on?: boolean }) {
  return on ? <span className="chip static tone-muted" title="Hub unreachable, worked out here">local</span> : null;
}

function NumIn({ id, label, value, onChange, width = 100, step = "0.01" }: { id: string; label: string; value: string; onChange: (v: string) => void; width?: number; step?: string }) {
  return (
    <div style={{ width }}>
      <label htmlFor={id}>{label}</label>
      <input id={id} type="number" inputMode="decimal" step={step} min={0} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

const TIPS = [15, 18, 20, 22];

function Split() {
  const [sub, setSub] = useState("");
  // Blank until known: a state picked from the list, the state you are in when this browser may use your location, or
  // what you typed last (kept in this browser). A typed or picked rate always wins over the one from your location.
  const [tax, setTaxState] = useState(() => { try { return localStorage.getItem("ea.calc.taxPct") ?? ""; } catch { return ""; } });
  const [taxNote, setTaxNote] = useState("");
  const [locAsk, setLocAsk] = useState(false);
  const keep = (v: string, from: "typed" | "location" | "state") => {
    setTaxState(v);
    try { localStorage.setItem("ea.calc.taxPct", v); localStorage.setItem("ea.calc.taxFrom", from); } catch { /* private mode */ }
  };
  const setTax = (v: string) => { setTaxNote(""); keep(v, "typed"); };
  const pickState = (code: string) => {
    const st = MEALS_STATES.find((x) => x.code === code);
    if (!st) return;
    keep(String(st.pct), "state");
    setTaxNote(stateNote(st.name));
  };
  // The browser, not the hub, works out the position, and the big browsers ask their company to: said once first.
  const askLocation = () => {
    let told = false;
    try { told = localStorage.getItem("ea.calc.locationNotice") === "yes"; } catch { /* private mode */ }
    if (told) fromLocation(true); else setLocAsk(true);
  };
  const locationOk = () => {
    try { localStorage.setItem("ea.calc.locationNotice", "yes"); } catch { /* private mode: asks again next time */ }
    setLocAsk(false);
    fromLocation(true);
  };
  const fromLocation = (ask: boolean) => {
    const c = engine.client;
    if (!c || !("geolocation" in navigator)) { if (ask) setTaxNote("This browser cannot share a location. Type the rate instead."); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        c.mealsTax(pos.coords.latitude, pos.coords.longitude)
          .then((m) => { keep(String(m.pct), "location"); setTaxNote(m.note); })
          .catch((e) => { if (ask) setTaxNote(e instanceof HubError && e.status === 404 ? "That location is not in a US state. Type the rate instead." : "The hub could not look up your state. Type the rate instead."); });
      },
      () => { if (ask) setTaxNote("Location is off for this site. Type the rate instead, and it is kept here."); },
      { enableHighAccuracy: false, maximumAge: 6 * 3600_000, timeout: 15_000 },
    );
  };
  // Without asking: only when this site already has location access and no rate was typed here.
  useEffect(() => {
    let typed = false;
    try { typed = ["typed", "state"].includes(localStorage.getItem("ea.calc.taxFrom") ?? "") && !!localStorage.getItem("ea.calc.taxPct"); } catch { /* private mode */ }
    if (typed || !navigator.permissions) return;
    navigator.permissions.query({ name: "geolocation" }).then((p) => { if (p.state === "granted") fromLocation(false); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [tip, setTip] = useState(20);
  const [people, setPeople] = useState("2");
  const [shares, setShares] = useState("");
  const s = num(sub);
  const p = num(people);
  const sh = shares.trim() ? shares.split(",").map((x) => Number(x.trim())) : undefined;
  const body = s != null && p != null ? { subtotal: s, tax_pct: num(tax) ?? 0, tip_pct: tip, people: p, ...(sh ? { shares: sh } : {}) } : null;
  const { out, err } = useCalc<SplitResult>("split", body, () => split(body!), readSplit);
  const r = out?.value;
  const even = r && r.per_person.every((x) => x === r.per_person[0]);
  return (
    <section className="card col calc" aria-label="Split">
      <div className="row between">
        <h2>Split</h2>
        <Local on={out?.local} />
      </div>
      <div className="row">
        <NumIn id="sp-sub" label="Subtotal" value={sub} onChange={setSub} />
        <NumIn id="sp-tax" label="Tax %" value={tax} onChange={setTax} width={80} />
        <select aria-label="Your state" value="" onChange={(e) => pickState(e.target.value)} style={{ width: 130 }}>
          <option value="">Pick your state</option>
          {MEALS_STATES.map((st) => <option key={st.code} value={st.code}>{st.name}</option>)}
        </select>
        <button type="button" className="small ghost" onClick={askLocation} title="Fill in your state's meals tax">Use my location</button>
        <NumIn id="sp-people" label="People" value={people} onChange={setPeople} width={70} step="1" />
      </div>
      <div className="chips" role="group" aria-label="Tip percent">
        {TIPS.map((t) => (
          <button key={t} type="button" className={`chip ${tip === t ? "on" : ""}`} aria-pressed={tip === t} onClick={() => setTip(t)}>
            {t}%
          </button>
        ))}
      </div>
      <input placeholder="Uneven shares, like 30, 20, 10" value={shares} onChange={(e) => setShares(e.target.value)} aria-label="Uneven shares, comma separated" />
      {locAsk && (
        <div className="card col small" role="alertdialog" aria-label="Before using your location">
          <span>{locationNotice(isTauri, navigator.userAgent)}</span>
          <div className="row">
            <button type="button" className="small primary" onClick={locationOk}>Use my location</button>
            <button type="button" className="small ghost" onClick={() => setLocAsk(false)}>Not now</button>
          </div>
        </div>
      )}
      {taxNote && <div className="muted small">{taxNote}</div>}
      {err && <div className="error">{err}</div>}
      {r && (
        <div>
          <div className="calc-out">{even ? `${money(r.per_person[0])} each` : `${money(r.total)} total`}</div>
          <div className="muted small">
            {money(r.subtotal)} + tax {money(r.tax)} + tip {money(r.tip)} = {money(r.total)}
          </div>
          {!!r.remainder_cents && (
            <div className="muted small">
              First person covers the extra {r.remainder_cents} {r.remainder_cents === 1 ? "cent" : "cents"}.
            </div>
          )}
          {!even && (
            <ol className="per-person">
              {r.per_person.map((x, i) => (
                <li key={i}>{money(x)}</li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

function Payoff() {
  const [bal, setBal] = useState("");
  const [apr, setApr] = useState("");
  const [mode, setMode] = useState<"payment" | "months">("payment");
  const [v, setV] = useState("");
  const b = num(bal);
  const a = num(apr);
  const x = num(v);
  const body = b != null && a != null && x != null && x > 0 ? { balance: b, apr_pct: a, [mode]: x } : null;
  const { out, err } = useCalc<PayoffResult>("payoff", body, () => payoff(body!), readPayoff);
  const r = out?.value;
  return (
    <section className="card col calc" aria-label="Payoff">
      <div className="row between">
        <h2>Payoff</h2>
        <Local on={out?.local} />
      </div>
      <div className="row">
        <NumIn id="po-bal" label="Balance" value={bal} onChange={setBal} />
        <NumIn id="po-apr" label="APR %" value={apr} onChange={setApr} width={80} />
        <NumIn id="po-v" label={mode === "payment" ? "Payment" : "Months"} value={v} onChange={setV} width={90} step={mode === "payment" ? "0.01" : "1"} />
      </div>
      <div className="chips" role="group" aria-label="Solve for">
        <button type="button" className={`chip ${mode === "payment" ? "on" : ""}`} aria-pressed={mode === "payment"} onClick={() => setMode("payment")}>
          I pay this much
        </button>
        <button type="button" className={`chip ${mode === "months" ? "on" : ""}`} aria-pressed={mode === "months"} onClick={() => setMode("months")}>
          Done in months
        </button>
      </div>
      {err && <div className="error">{err}</div>}
      {r && (
        <div>
          {r.months === "never" ? (
            <div className="calc-out warn">Never. The payment does not cover the interest.</div>
          ) : mode === "months" ? (
            <div className="calc-out">{money(r.payment)} a month</div>
          ) : (
            <div className="calc-out">{r.months} months</div>
          )}
          {r.total_interest != null && <div className="muted small">{money(r.total_interest)} total interest</div>}
          {r.preview.length > 0 && (
            <details className="small" style={{ marginTop: 6 }}>
              <summary>First {r.preview.length} months</summary>
              <table className="amort">
                <thead>
                  <tr>
                    <th>Mo</th>
                    <th>Paid</th>
                    <th>Interest</th>
                    <th>Left</th>
                  </tr>
                </thead>
                <tbody>
                  {r.preview.map((row) => (
                    <tr key={row.month}>
                      <td>{row.month}</td>
                      <td>{money(row.payment)}</td>
                      <td>{money(row.interest)}</td>
                      <td>{money(row.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

type URow = { name: string; price: string; qty: string; unit: string };
const blankRow = (): URow => ({ name: "", price: "", qty: "", unit: "oz" });

function Unit() {
  const [rows, setRows] = useState<URow[]>([blankRow(), blankRow()]);
  const items = rows
    .map((r, i) => ({ name: r.name.trim() || `Item ${i + 1}`, price: num(r.price), qty: num(r.qty), unit: r.unit.trim() }))
    .filter((r): r is { name: string; price: number; qty: number; unit: string } => r.price != null && r.qty != null && r.qty > 0);
  const body = items.length ? { items } : null;
  const { out, err } = useCalc<UnitRow[]>("unit", body, () => unitPrices(items), readUnit);
  const set = (i: number, k: keyof URow, v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const r = out?.value;
  return (
    <section className="card col calc" aria-label="Unit price">
      <div className="row between">
        <h2>Unit price</h2>
        <Local on={out?.local} />
      </div>
      {rows.map((row, i) => (
        <div key={i} className="unit-row">
          <input placeholder="Name" value={row.name} onChange={(e) => set(i, "name", e.target.value)} aria-label={`Name ${i + 1}`} />
          <input placeholder="Price" type="number" inputMode="decimal" min={0} step="0.01" value={row.price} onChange={(e) => set(i, "price", e.target.value)} aria-label={`Price ${i + 1}`} />
          <input placeholder="Qty" type="number" inputMode="decimal" min={0} value={row.qty} onChange={(e) => set(i, "qty", e.target.value)} aria-label={`Quantity ${i + 1}`} />
          <input placeholder="Unit" value={row.unit} onChange={(e) => set(i, "unit", e.target.value)} aria-label={`Unit ${i + 1}`} />
        </div>
      ))}
      <div className="row">
        <button type="button" className="small" onClick={() => setRows([...rows, blankRow()])}>
          Add row
        </button>
        {rows.length > 2 && (
          <button type="button" className="small ghost" onClick={() => setRows(rows.slice(0, -1))}>
            Remove last
          </button>
        )}
      </div>
      {err && <div className="error">{err}</div>}
      {r && r.length > 0 && (
        <ol className="unit-out">
          {r.map((x, i) => (
            <li key={i} className={i === 0 ? "best" : ""}>
              <span>{x.name}</span>
              <span className="mono">
                ${x.per_unit.toFixed(x.per_unit < 1 ? 4 : 2)} / {x.base}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const STATE_KEY = "calc.takehome.state_pct";
const readStatePct = () => {
  try {
    return localStorage.getItem(STATE_KEY) ?? "";
  } catch {
    return "";
  }
};

const FREQ: Array<[Frequency, string]> = [
  ["weekly", "Weekly"],
  ["biweekly", "Every 2 weeks"],
  ["semimonthly", "Twice a month"],
  ["monthly", "Monthly"],
];
const FILING: Array<[Filing, string]> = [
  ["single", "Single"],
  ["married", "Married, joint"],
  ["head", "Head of household"],
];
const PAY_ROWS: Array<[keyof PayLines, string]> = [
  ["gross", "Gross"],
  ["federal", "Federal income tax"],
  ["social_security", "Social Security"],
  ["medicare", "Medicare"],
  ["state", "State"],
  ["k401", "401k"],
  ["health", "Health and HSA"],
];

function TakeHome() {
  const [salary, setSalary] = useState("");
  const [bonus, setBonus] = useState("");
  const [freq, setFreq] = useState<Frequency>("biweekly");
  const [filing, setFiling] = useState<Filing>("single");
  const [kMode, setKMode] = useState<"pct" | "amount">("pct");
  const [k401, setK401] = useState("");
  const [health, setHealth] = useState("");
  const [statePct, setStatePct] = useState(readStatePct);
  useEffect(() => {
    try {
      localStorage.setItem(STATE_KEY, statePct);
    } catch {
      /* private window: not remembered */
    }
  }, [statePct]);
  const s = num(salary);
  const k = num(k401);
  const body =
    s != null && s > 0
      ? {
          salary: s,
          frequency: freq,
          filing,
          ...(num(bonus) ? { bonus: num(bonus)! } : {}),
          ...(k != null ? (kMode === "pct" ? { k401_pct: k } : { k401_amount: k }) : {}),
          ...(num(health) ? { health: num(health)! } : {}),
          ...(num(statePct) ? { state_pct: num(statePct)! } : {}),
        }
      : null;
  const { out, err } = useCalc<TakeHomeResult>("takehome", body, () => takeHome(body!), readTakeHome);
  const r = out?.value;
  return (
    <section className="card col calc" aria-label="Take-home pay">
      <div className="row between">
        <h2>Take-home pay</h2>
        <Local on={out?.local} />
      </div>
      <div className="row">
        <NumIn id="th-salary" label="Salary a year" value={salary} onChange={setSalary} width={120} />
        <NumIn id="th-bonus" label="Bonus a year" value={bonus} onChange={setBonus} width={110} />
      </div>
      <div className="chips" role="group" aria-label="Paid">
        {FREQ.map(([v, label]) => (
          <button key={v} type="button" className={`chip ${freq === v ? "on" : ""}`} aria-pressed={freq === v} onClick={() => setFreq(v)}>
            {label}
          </button>
        ))}
      </div>
      <div className="chips" role="group" aria-label="Filing status">
        {FILING.map(([v, label]) => (
          <button key={v} type="button" className={`chip ${filing === v ? "on" : ""}`} aria-pressed={filing === v} onClick={() => setFiling(v)}>
            {label}
          </button>
        ))}
      </div>
      <div className="row">
        <NumIn id="th-k401" label={kMode === "pct" ? "401k %" : "401k each check"} value={k401} onChange={setK401} width={110} />
        <NumIn id="th-health" label="Health, HSA each check" value={health} onChange={setHealth} width={150} />
        <NumIn id="th-state" label="State tax %" value={statePct} onChange={setStatePct} width={90} />
      </div>
      <div className="chips" role="group" aria-label="401k as">
        <button type="button" className={`chip ${kMode === "pct" ? "on" : ""}`} aria-pressed={kMode === "pct"} onClick={() => setKMode("pct")}>
          401k as percent
        </button>
        <button type="button" className={`chip ${kMode === "amount" ? "on" : ""}`} aria-pressed={kMode === "amount"} onClick={() => setKMode("amount")}>
          401k as amount
        </button>
      </div>
      {err && <div className="error">{err}</div>}
      {r && (
        <div>
          <div className="calc-out">
            {money(r.per_paycheck.net)} a paycheck <span className="muted">{money(r.per_year.net)} a year</span>
          </div>
          <table className="amort">
            <thead>
              <tr>
                <th></th>
                <th>Paycheck</th>
                <th>Year</th>
              </tr>
            </thead>
            <tbody>
              {PAY_ROWS.filter(([key]) => key === "gross" || r.per_year[key] > 0 || key === "federal").map(([key, label]) => (
                <tr key={key}>
                  <td>{key === "medicare" && r.per_year.additional_medicare > 0 ? `${label} (with 0.9% extra)` : label}</td>
                  <td>{key === "gross" ? money(r.per_paycheck[key]) : `-${money(r.per_paycheck[key])}`}</td>
                  <td>{key === "gross" ? money(r.per_year[key]) : `-${money(r.per_year[key])}`}</td>
                </tr>
              ))}
              <tr>
                <th>Net</th>
                <th>{money(r.per_paycheck.net)}</th>
                <th>{money(r.per_year.net)}</th>
              </tr>
            </tbody>
          </table>
          {r.bonus && (
            <div style={{ marginTop: 8 }}>
              <div>
                Bonus {money(r.bonus.gross)}: {money(r.bonus.net)} after tax
              </div>
              <div className="muted small">
                Federal {r.bonus.federal_rate}% {money(r.bonus.federal)}, Social Security {money(r.bonus.social_security)}, Medicare {money(r.bonus.medicare)}
                {r.bonus.state > 0 ? `, state ${money(r.bonus.state)}` : ""}. Salary and bonus together: {money(r.year_net_with_bonus)} a year.
              </div>
            </div>
          )}
          {r.notes.map((n) => (
            <div key={n} className="muted small">
              {n}
            </div>
          ))}
          <div className="muted small">
            {TAX_YEAR} federal brackets and standard deduction, spread evenly over the year. An estimate of withholding, not the return.
          </div>
        </div>
      )}
    </section>
  );
}

function Subscriptions() {
  const watches = useEntities("watch", (e) => e.fields.category === "subscription");
  const [hub, setHub] = useState<SubsResult | null>(null);
  useEffect(() => {
    let off = false;
    viaHub((c) => c.subscriptions())
      .then((raw) => !off && setHub(raw === undefined ? null : readSubs(raw)))
      .catch(() => !off && setHub(null));
    return () => {
      off = true;
    };
  }, [watches.length]);
  const r = hub ?? subscriptions(watches);
  return (
    <section className="card col calc" aria-label="Subscriptions">
      <div className="row between">
        <h2>Subscriptions</h2>
        <Local on={!hub && !!engine.client} />
      </div>
      <div className="calc-out">
        {money(r.monthly_total)} a month <span className="muted">{money(r.yearly_total)} a year</span>
      </div>
      <div className="list">
        {r.items.map((s, i) => (
          <a key={s.id ?? i} href={s.id ? `#/renewals?focus=${s.id}` : "#/renewals"} className="item" style={{ color: "inherit" }}>
            <div className="body row between">
              <span className="t">{s.title}</span>
              <span className="muted small">
                {money(s.cost)} {s.repeat.replace(/^every 1 (\w+)s$/, "a $1").replace(/^every /, "every ")}, {money(s.monthly)}/mo
              </span>
            </div>
          </a>
        ))}
        {!r.items.length && <div className="muted small">No subscription watches with a cost and repeat. Add them in Renewals.</div>}
        {r.skipped.length > 0 && (
          <div className="muted small">
            Skipped: {r.skipped.map((x) => `${x.title} (${x.reason})`).join(", ")}
          </div>
        )}
      </div>
    </section>
  );
}

export function Calc() {
  return (
    <div className="calc-view">
      <h1>Calculators</h1>
      <div className="calc-grid">
        <Split />
        <Payoff />
        <Unit />
        <TakeHome />
        <Subscriptions />
      </div>
    </div>
  );
}
