import { useEffect, useState } from "react";
import { RetentionSettings } from "./settings/HubPrivacy";
import { HubError, type BackupStatus, type PullState, type SetupDetect, type SetupView } from "../sync/api";
import { engine } from "../sync/engine";
import { go } from "../lib/router";
import { useModules } from "../lib/modules";
import { ModulePicker } from "./settings/Modules";
import { PairDevice } from "./settings/Devices";

type Msg = { ok: boolean; text: string } | null;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const gb = (mib: number) => `${Math.round(mib / 1024)} GB`;

/**
 * First run, in short steps on one page: your name, what you want to use (modules, each saying what it reads and what
 * devices will ask for), the model (the one that fits this machine, in one click), the key that opens your backups,
 * a place for passwords when Homelab is on, and your other devices. Every step can be done again later; nothing here
 * needs a file edited.
 */
export function Welcome() {
  const client = engine.client;
  const [view, setView] = useState<SetupView | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const load = () => void client?.setup().then(setView).catch((e) => setMsg({ ok: false, text: errorText(e) }));
  useEffect(load, [client]);
  const { on } = useModules();
  if (!client) return null;
  // Passwords only matter for commands on your machines, so that step shows only with Homelab on.
  const passwords = on("homelab");
  return (
    <div className="col" style={{ maxWidth: 760 }}>
      <h1>Welcome</h1>
      <div className="muted">A few steps and the assistant is ready, and one more to bring in what you already have. Each one can be changed later in Settings.</div>
      <NameStep view={view} onDone={load} />
      <Step n={2} title="Which modules do you want to use?" done={false}>
        <div className="muted small">Today, the Assistant, Capture, Search, Tasks, Week, Notes, Memory, People and Lists are always there. Tick the rest you want. Each says what it reads, and your iPhone, iPad and Mac ask only for the permissions of the ones ticked here. Anything off stays out of sight on every device and reads nothing. You can change this any time in Settings, Modules.</div>
        <ModulePicker />
        <h3>What the hub keeps</h3>
        <RetentionSettings suggest />
      </Step>
      <ModelStep view={view} onDone={load} />
      <BackupStep n={4} />
      {passwords && <PasswordStep n={5} view={view} onDone={load} />}
      <DevicesStep n={passwords ? 6 : 5} />
      <section className="card col">
        <h2>{passwords ? 7 : 6}. Bring your past in (optional)</h2>
        <div className="muted small">Your ChatGPT history, Google Keep, Contacts, Calendar and Tasks, an Obsidian vault or other notes, or a text dump: the hub files it and can learn about you from it.</div>
        <div><button type="button" onClick={() => go("/settings/import")}>Bring your data in</button></div>
      </section>
      {msg && <div className="error">{msg.text}</div>}
      <div>
        <button type="button" className="primary" onClick={() => { try { sessionStorage.setItem("ea-welcome-skip", "1"); } catch { /* private window */ } go("/today"); }}>
          {view?.named && view.model_ready ? "Done" : "Later"}
        </button>
      </div>
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: React.ReactNode }) {
  return (
    <section className="card col">
      <h2>{done ? "✓" : `${n}.`} {title}</h2>
      {children}
    </section>
  );
}

function NameStep({ view, onDone }: { view: SetupView | null; onDone: () => void }) {
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  useEffect(() => { if (view?.named) setName(view.owner); }, [view?.named, view?.owner]);
  const save = async () => {
    try { await engine.client!.setProfile(name.trim()); setMsg({ ok: true, text: "Saved." }); onDone(); } catch (e) { setMsg({ ok: false, text: errorText(e) }); }
  };
  return (
    <Step n={1} title="Your name" done={!!view?.named}>
      <div className="muted small">What the assistant calls you.</div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="First name" aria-label="Your name" />
        <button type="submit" className="primary" disabled={!name.trim()}>Save</button>
      </form>
      {msg && <div className={msg.ok ? "ok small" : "error small"}>{msg.text}</div>}
    </Step>
  );
}

function ModelStep({ view, onDone }: { view: SetupView | null; onDone: () => void }) {
  const client = engine.client!;
  const [d, setD] = useState<SetupDetect | null>(null);
  const [looking, setLooking] = useState(true);
  const [cloud, setCloud] = useState<"" | "openai" | "anthropic">("");
  const [url, setUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [pull, setPull] = useState<PullState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const detect = () => {
    setLooking(true);
    void client.setupDetect().then(setD).catch((e) => setMsg({ ok: false, text: errorText(e) })).finally(() => setLooking(false));
  };
  useEffect(detect, [client]);
  // While a model downloads, follow it.
  useEffect(() => {
    if (!pull || pull.done) return;
    const t = setInterval(() => void client.pullState().then((r) => { setPull(r.pull); if (r.pull?.done) { detect(); onDone(); } }), 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pull?.done, pull?.model]);
  const act = async (f: () => Promise<string | void>) => {
    setBusy(true);
    setMsg(null);
    try { const t = await f(); if (t) setMsg({ ok: true, text: t }); onDone(); } catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { setBusy(false); setKey(""); }
  };
  const use = (kind: "ollama" | "openai", u: string, m: string) => act(async () => {
    const r = await client.setupAi({ kind, url: u, model: m });
    detect();
    return r.note || `Using ${m}.`;
  });
  const fetchModel = (m: string) => act(async () => { setPull(await client.pullModel(m)); });
  /** The one confirmation: use the model that fits, downloading it first when it is not there yet. */
  const auto = (m: string, url: string) => act(async () => {
    try {
      const r = await client.setupModelAuto(m);
      if (r.pull) setPull(r.pull);
      detect();
      return r.pull && !r.pull.done ? "" : `Using ${m}.`;
    } catch (e) {
      // An older hub has no one-step route: choose, then fetch.
      if (!(e instanceof HubError && e.status === 404)) throw e;
      await client.setupAi({ kind: "ollama", url, model: m });
      if (!(d?.servers.find((s) => s.url === url)?.models ?? []).some((x) => x === m || x === `${m}:latest`)) setPull(await client.pullModel(m));
      detect();
      return "";
    }
  });
  const best = d?.gpus.reduce((a, g) => (g.vram_mib > a.vram_mib ? g : a), d.gpus[0]);
  const ollama = d?.servers.find((s) => s.kind === "ollama");
  const current = view?.ai;
  const rec = d?.recommended.model ?? "";
  const hasRec = !!ollama?.models.some((m) => m === rec || m === `${rec}:latest`);
  return (
    <Step n={3} title="The model" done={!!view?.model_ready}>
      {looking && !d && <div className="muted small">Looking at this machine...</div>}
      {d && (
        <div className="small">
          {best ? <>This machine has {best.kind === "apple" ? `an ${best.name} with ${gb(best.vram_mib)} for models` : `${best.name} with ${gb(best.vram_mib)}`}. </> : <>No graphics card was found on the hub's machine{d.memory_mib ? `; it has ${gb(d.memory_mib)} of memory` : ""}. </>}
          The model that fits best: <strong>{d.recommended.model}</strong> ({d.recommended.size_gb} GB download{d.recommended.license ? `, ${d.recommended.license} license` : ""}); {d.recommended.why}. It runs on the hub's machine, so what you ask never leaves it.
        </div>
      )}
      {d && ollama && rec && !(current?.ollama?.model === rec) && (
        <div>
          <button type="button" className="primary" disabled={busy || (!!pull && !pull.done)} onClick={() => void auto(rec, ollama.url)}>
            {hasRec ? `Use ${rec}` : `Download ${rec} (${d.recommended.size_gb} GB) and use it`}
          </button>
        </div>
      )}
      {/* Ollama counts only once a model is named: the installer sets its address before any model exists. */}
      {current && ((current.ollama && current.ollama.model) || current.openai || current.anthropic) && (
        <div className="col small">
          <strong>{view?.model_ready ? "In use" : "Chosen, not downloaded yet"}</strong>
          {current.ollama && current.ollama.model && <div className="row"><span className="grow">Ollama: {current.ollama.model} at {current.ollama.url}</span><button type="button" className="ghost small" disabled={busy} onClick={() => void act(async () => { await client.removeSetupAi("ollama"); return "Ollama is off."; })}>Stop using</button></div>}
          {current.openai && <div className="row"><span className="grow">{current.openai.model} at {current.openai.url}{current.openai.key_set ? " (with a key)" : ""}</span><button type="button" className="ghost small" disabled={busy} onClick={() => void act(async () => { await client.removeSetupAi("openai"); return "Stopped."; })}>Stop using</button></div>}
          {current.anthropic && <div className="row"><span className="grow">Anthropic: {current.anthropic.model}</span><button type="button" className="ghost small" disabled={busy} onClick={() => void act(async () => { await client.removeSetupAi("anthropic"); return "Stopped."; })}>Stop using</button></div>}
        </div>
      )}
      {!!d?.servers.length && (
      <details>
        <summary className="small">Other models and servers on this machine</summary>
      {d?.servers.map((s) => (
        <div key={s.url} className="col">
          <strong className="small">{s.label} is running at {s.url}</strong>
          <div className="chips">
            {s.models.map((m) => {
              const inUse = (s.kind === "ollama" && current?.ollama?.model === m && current.ollama.url === s.url) || (s.kind === "openai" && current?.openai?.model === m && current.openai.url === s.url);
              return (
                <button key={m} type="button" className={inUse ? "chip primary" : "chip"} disabled={busy || inUse} onClick={() => void use(s.kind, s.url, m)} title={inUse ? "In use" : `Use ${m}`}>
                  {inUse ? "✓ " : ""}{m}{m === rec ? " (fits best)" : ""}
                </button>
              );
            })}
            {!s.models.length && <span className="muted small">No models in it yet.</span>}
          </div>
        </div>
      ))}
      </details>
      )}
      {pull && (
        <div className="small">
          {pull.error ? <span className="error">Fetching {pull.model} failed: {pull.error}</span>
            : pull.done ? <span className="ok">{pull.model} is ready.</span>
            : <>Fetching {pull.model}: {pull.total ? `${Math.round((pull.completed / pull.total) * 100)}%` : pull.status}</>}
          {pull.done && pull.error && <button type="button" className="ghost small" onClick={() => void fetchModel(pull.model)}>Try again</button>}
        </div>
      )}
      {d && !ollama && (
        <div className="muted small">
          No model server was found on the hub's machine. Run the hub's installer again and it sets up Ollama for you, with no root password; or install Ollama yourself from <a href="https://ollama.com/download" target="_blank" rel="noreferrer">ollama.com/download</a>. Then <button type="button" className="ghost small" onClick={detect} disabled={looking}>look again</button>. LM Studio, llama.cpp, vLLM and Jan are found too when they run.
        </div>
      )}
      <details open={!!cloud}>
        <summary className="small">Use a cloud model instead (or as well)</summary>
        <div className="muted small">The cloud company sees what goes to it: your chats, and your quick captures when it is your only model. Work items, mail, imports and background note sorting never go to a cloud model; those wait for a model on your own machine.</div>
        <div className="row wrap">
          <select value={cloud} onChange={(e) => { const v = e.target.value as typeof cloud; setCloud(v); setModel(v === "anthropic" ? "claude-sonnet-5-5" : ""); }} aria-label="Cloud provider">
            <option value="">Choose...</option>
            <option value="openai">OpenAI, OpenRouter or another OpenAI-compatible service</option>
            <option value="anthropic">Anthropic (Claude)</option>
          </select>
        </div>
        {cloud && (
          <form className="col" onSubmit={(e) => { e.preventDefault(); void act(async () => { await client.setupAi({ kind: cloud, url: cloud === "openai" ? url.trim() : undefined, model: model.trim(), key: key.trim() }); return "Saved. The assistant uses it now."; }); }}>
            {cloud === "openai" && <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.openai.com/v1" aria-label="Address" autoComplete="off" spellCheck={false} />}
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={cloud === "openai" ? "Model, like gpt-5-mini or openrouter/auto" : "Model"} aria-label="Model" autoComplete="off" spellCheck={false} />
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="API key" aria-label="API key" autoComplete="off" spellCheck={false} />
            <div><button type="submit" className="primary" disabled={busy || !model.trim() || !key.trim()}>Check and use</button></div>
          </form>
        )}
      </details>
      {msg && <div className={msg.ok ? "ok small" : "error small"}>{msg.text}</div>}
    </Step>
  );
}

/**
 * Backups are encrypted (age); the key that opens them is shown once here to save in a password manager, because a
 * backup cannot be opened on a new machine without it. Hidden on a hub that has no encrypted backups yet.
 */
function BackupStep({ n }: { n: number }) {
  const client = engine.client!;
  const [b, setB] = useState<BackupStatus | null>(null);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<Msg>(null);
  useEffect(() => { void client.backupStatus().then(setB).catch(() => setB(null)); }, [client]);
  if (!b) return null;
  const reveal = async () => { try { setKey((await client.revealRecoveryKey()).recovery_key); } catch (e) { setMsg({ ok: false, text: errorText(e) }); } };
  const saved = async () => {
    try {
      await client.markRecoverySaved();
      setB(await client.backupStatus());
      setKey("");
      setMsg({ ok: true, text: "Saved. You can show it again here, in Settings, Set up." });
    } catch (e) { setMsg({ ok: false, text: errorText(e) }); }
  };
  return (
    <Step n={n} title="The key to your backups" done={b.recovery_saved}>
      <div className="muted small">
        Every backup and every copy sent to another machine is encrypted. The recovery key opens them: save it in your password manager. If the hub's machine is lost, a backup cannot be opened without it, by you or anyone else.
      </div>
      <div className="small">
        {b.disk.encrypted === true ? "This machine's disk is encrypted, so the live database is protected too."
          : b.disk.encrypted === false ? <span className="muted" title={b.disk.detail}>A note, nothing to do now: the hub's disk is not encrypted. Backups are encrypted either way; someone who took the disk itself could read the hub's data. If that matters to you, turn on FileVault (Mac), or choose disk encryption the next time you install Linux there.</span>
          : <>Whether this machine's disk is encrypted could not be checked ({b.disk.detail}).</>}
      </div>
      {!key && <div className="row wrap"><button type="button" className={b.recovery_saved ? "" : "primary"} onClick={() => void reveal()}>{b.recovery_saved ? "Show the recovery key again" : "Show the recovery key"}</button></div>}
      {key && (
        <div className="col">
          <code style={{ wordBreak: "break-all", userSelect: "all" }}>{key}</code>
          <div className="row wrap">
            <button type="button" onClick={() => void navigator.clipboard.writeText(key).then(() => setMsg({ ok: true, text: "Copied. Paste it into your password manager, then clear the clipboard." }))}>Copy</button>
            <button type="button" className="primary" onClick={() => void saved()}>I saved it</button>
            <button type="button" className="ghost small" onClick={() => setKey("")}>Hide</button>
          </div>
        </div>
      )}
      {msg && <div className={msg.ok ? "ok small" : "error small"}>{msg.text}</div>}
    </Step>
  );
}

function PasswordStep({ n, view, onDone }: { n: number; view: SetupView | null; onDone: () => void }) {
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try { await engine.client!.linkPasswordManager("keepass", ""); setMsg({ ok: true, text: "The vault is ready. Add logins in Settings, Connections, Password manager." }); onDone(); } catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { setBusy(false); }
  };
  return (
    <Step n={n} title="Passwords (optional)" done={!!view?.password_manager}>
      <div className="muted small">
        So the assistant can log in to your machines in a command you approve, without seeing the password. Use Bitwarden, Vaultwarden, 1Password or LastPass, or the built-in vault: a KeePass file on the hub that any KeePass app opens.
      </div>
      {!view?.password_manager && (
        <div className="row wrap">
          <button type="button" className="primary" disabled={busy} onClick={() => void make()}>Make the built-in vault</button>
          <button type="button" onClick={() => go("/settings/connections")}>Use another password manager</button>
        </div>
      )}
      {msg && <div className={msg.ok ? "ok small" : "error small"}>{msg.text}</div>}
    </Step>
  );
}

function DevicesStep({ n }: { n: number }) {
  return (
    <Step n={n} title="Your other devices" done={false}>
      <div className="muted small">Install Aeneas on your iPhone, iPad or Mac, then make a code here. Scan the QR code with the iPhone or iPad camera and it connects; on a Mac, open the link; on another computer, open the web link. Each device gets its own key, and the code works once, for 10 minutes.</div>
      <PairDevice />
    </Step>
  );
}
