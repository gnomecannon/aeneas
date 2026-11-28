import { useCallback, useEffect, useState } from "react";
import { engine } from "../../sync/engine";
import type { AtlassianConnection, AtlassianSpace, Connections as ConnectionsView, KeePassEntry, PasswordManagerProvider, PasswordManagerStatus, PasswordManagerView } from "../../sync/api";
import { spacesChanged } from "../../lib/wiki";
import { fmtDateTime } from "../../lib/time";
import { META } from "../../sync/db";
import { useHubReady, useMeta, useSyncState } from "../../sync/hooks";
import { SubPage, errorText } from "./common";
import { isTauri, openExternal } from "../../tauri/bridge";
import { useModules } from "../../lib/modules";
import { OwnKeyGuide } from "./OwnKeyGuide";
import { connectionSection } from "../../lib/moduleSetup";

type Msg = { ok: boolean; text: string } | null;

/**
 * One line for the Settings list: which services are linked (mail and calendar accounts are in Settings, Accounts
 * since 2026-11-24).
 */
export function connectionsSummary(c: ConnectionsView | null): string {
  if (!c) return "Steam, Letterboxd, Confluence, password manager, calendar link";
  const on = [c.steam.connected && "Steam", c.letterboxd.connected && "Letterboxd", c.atlassian?.connected && "Confluence", c.password_manager?.linked && "Password manager"].filter(Boolean);
  return on.length ? on.join(", ") : "Steam, Letterboxd, Confluence, password manager, calendar link";
}

/**
 * The hub's connections. Loads again when the hub connection comes up (a page opened directly, or after a reload, is
 * drawn before it is ready), and says why when the hub cannot answer instead of showing Loading for ever.
 */
export function useConnections(): [ConnectionsView | null, () => void, string] {
  const sync = useSyncState();
  const [c, setC] = useState<ConnectionsView | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    const client = engine.client;
    if (!client) return;
    client.connections().then((v) => { setC(v); setErr(""); }, (e) => setErr(errorText(e)));
  }, []);
  useEffect(load, [load, sync.status]);
  return [c, load, err];
}

const when = (iso: string | null | undefined) => (iso ? fmtDateTime(iso) : "never");

function Status({ msg }: { msg: Msg }) {
  return msg ? <div className={msg.ok ? "ok small" : "error small"} role="status">{msg.text}</div> : null;
}

function Steam({ c, reload, replaceKey }: { c: ConnectionsView["steam"]; reload: () => void; replaceKey: () => void }) {
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const client = engine.client;
  const run = async (f: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await f() });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      reload();
      setBusy(false);
    }
  };
  // While Steam's page is open in the browser, look for the link to land.
  useEffect(() => {
    if (!waiting || !client) return;
    const started = Date.now();
    const t = setInterval(() => {
      void client.connections().then((v) => {
        if (v.steam.connected) {
          setWaiting(false);
          setMsg({ ok: true, text: `Linked as ${v.steam.persona ?? v.steam.steam_id}, ${v.steam.games} games.` });
          reload();
        } else if (Date.now() - started > 5 * 60_000) setWaiting(false);
      });
    }, 3000);
    return () => clearInterval(t);
  }, [waiting, client, reload]);
  const signIn = () =>
    void run(async () => {
      const { url } = await client!.steamSignIn("web");
      await openExternal(url);
      setWaiting(true);
      return "Sign in on Steam's page; this updates by itself when you are back.";
    });
  return (
    <section className="card col">
      <h2>Steam</h2>
      {c.connected ? (
        <>
          <div>
            Linked to <strong>{c.persona || c.steam_id}</strong>, {c.games} games. Last read {when(c.last_sync)}; it reads again every 6 hours.
          </div>
          {c.last_error && <div className="error small">{c.last_error}</div>}
          {/* Steam stopped taking the hub's key (a Steam password change ends it): this opens the key's guide under App keys. */}
          {c.key_refused && <div><button type="button" className="primary" onClick={replaceKey}>Replace the Steam key</button></div>}
          <div className="row">
            <button type="button" className={c.key_refused ? undefined : "primary"} disabled={busy || !client} onClick={() => void run(async () => { const r = await client!.syncSteam(); return `${r.games} games: ${r.created} new, ${r.updated} changed.`; })}>
              {busy ? "Reading" : "Read now"}
            </button>
            <button type="button" className="ghost danger" disabled={busy || !client} onClick={() => confirm("Unlink Steam? The games stay.") && void run(async () => { await client!.disconnectSteam(); return "Unlinked. The games stay."; })}>
              Unlink
            </button>
          </div>
        </>
      ) : c.hub_key ? (
        <>
          <div className="muted small">Sign in on Steam's own page. The app learns only which account is yours; your Steam password never reaches it. Your profile's Game details need to be public.</div>
          <div>
            <button type="button" className="primary" disabled={busy || waiting || !client} onClick={signIn}>
              {waiting ? "Waiting for Steam" : "Sign in with Steam"}
            </button>
          </div>
        </>
      ) : (
        <NeedsKey what="the hub's own Steam key" />
      )}
      <Status msg={msg} />
    </section>
  );
}

/** A service that needs the hub's own key before anyone can sign in: where it is added (App keys, at the end). */
function NeedsKey({ what }: { what: string }) {
  return (
    <div className="col">
      <div className="muted small">Signing in needs {what} first, added once under App keys at the end of this page.</div>
      <div><button type="button" onClick={() => document.getElementById("app-keys")?.scrollIntoView({ behavior: "smooth", block: "start" })}>Go to App keys</button></div>
    </div>
  );
}

function Letterboxd({ c, reload }: { c: ConnectionsView["letterboxd"]; reload: () => void }) {
  const [user, setUser] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const client = engine.client;
  const run = async (f: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await f() });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
      reload();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card col">
      <h2>Letterboxd</h2>
      {c.connected ? (
        <>
          <div>
            Diary of <strong>{c.username}</strong>, {c.films} films here. Read {when(c.last_sync)}; new entries come in every hour.
          </div>
          {c.last_error && <div className="error small">{c.last_error}</div>}
          <div className="row">
            <button type="button" className="primary" disabled={busy || !client} onClick={() => void run(async () => { const r = await client!.syncLetterboxd(); return `${r.entries} diary entries: ${r.created} new films, ${r.updated} changed.`; })}>
              {busy ? "Reading" : "Read diary now"}
            </button>
            <button type="button" className="ghost danger" disabled={busy || !client} onClick={() => void run(async () => { await client!.disconnectLetterboxd(); return "Unlinked. The films stay."; })}>
              Unlink
            </button>
          </div>
        </>
      ) : (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => { const r = await client!.connectLetterboxd(user.trim()); return `Linked. ${r.sync.entries} recent diary entries read.`; });
          }}
        >
          <input placeholder="Letterboxd username" aria-label="Letterboxd username" value={user} onChange={(e) => setUser(e.target.value)} style={{ flex: 1 }} />
          <button type="submit" className="primary" disabled={busy || !client || !user.trim()}>
            {busy ? "Linking" : "Link diary"}
          </button>
        </form>
      )}
      <div className="muted small">Everything you log on Letterboxd comes in by itself within the hour, starting from your 50 most recent diary entries.</div>
      <Status msg={msg} />
    </section>
  );
}

/**
 * Whether a sign-in with Atlassian has landed: linked, and not waiting for Reconnect. Reconnect starts from a link that
 * is connected already, so "connected" alone said it was back before the person had signed in.
 */
export const atlassianSignedIn = (a: AtlassianConnection | undefined): a is Extract<AtlassianConnection, { connected: true }> => !!a?.connected && !a.expired;

/**
 * Confluence for the game design wiki: the hub's own Atlassian app once, then Sign in with Atlassian and a choice of
 * spaces. A sign-in Atlassian ended shows Reconnect, the same sign-in, which keeps the chosen spaces and the pages
 * (gnomecannon/aeneas#24: Unlink and linking again was the only way, and Unlink drops the spaces and pages).
 */
function Confluence({ c, reload }: { c: AtlassianConnection; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [spaces, setSpaces] = useState<AtlassianSpace[] | null>(null);
  const [spacesErr, setSpacesErr] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const client = engine.client;
  const connected = c.connected;
  const expired = c.connected && !!c.expired;
  const run = async (f: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await f() });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      reload();
      setBusy(false);
    }
  };
  const loadSpaces = useCallback(() => {
    if (!client) return;
    setSpacesErr("");
    client.atlassianSpaces().then(
      (r) => {
        setSpaces(r.spaces);
        setChosen(new Set(r.spaces.filter((s) => s.mirrored).map((s) => s.key)));
      },
      (e) => setSpacesErr(errorText(e)),
    );
  }, [client]);
  // An ended sign-in cannot list the spaces: they load once Reconnect lands.
  useEffect(() => {
    if (connected && !expired) loadSpaces();
    else setSpaces(null);
  }, [connected, expired, loadSpaces]);
  // While Atlassian's page is open in the browser, look for the link to land.
  useEffect(() => {
    if (!waiting || !client) return;
    const started = Date.now();
    const t = setInterval(() => {
      void client.connections().then((v) => {
        if (atlassianSignedIn(v.atlassian)) {
          setWaiting(false);
          setMsg({ ok: true, text: expired ? `Reconnected to ${v.atlassian.site_name}. The chosen spaces stay.` : `Linked to ${v.atlassian.site_name}. Choose the spaces to mirror.` });
          reload();
        } else if (Date.now() - started > 5 * 60_000) setWaiting(false);
      });
    }, 3000);
    return () => clearInterval(t);
  }, [waiting, client, reload, expired]);
  const signIn = () =>
    void run(async () => {
      const { url } = await client!.atlassianSignIn("web");
      await openExternal(url);
      setWaiting(true);
      return "Sign in on Atlassian's page; this updates by itself when you are back.";
    });
  const mirrored = c.connected ? c.spaces : [];
  return (
    <section className="card col">
      <h2>Confluence</h2>
      {expired ? (
        <>
          <div>
            Linked to <strong>{c.site_name}</strong>, {c.pages === 1 ? "1 page" : `${c.pages} pages`} in the wiki, last read {when(c.last_sync)}.
          </div>
          <div className="error small">{c.last_error || "Atlassian ended the sign-in."}</div>
          <div className="muted small">Reconnect opens Atlassian's page: sign in with the account that reads {c.site_name}. The pages already in the wiki stay.</div>
          <div className="row">
            <button type="button" className="primary" disabled={busy || waiting || !client} onClick={signIn}>
              {waiting ? "Waiting for Atlassian" : "Reconnect"}
            </button>
            <button type="button" className="ghost danger" disabled={busy || !client} onClick={() => confirm("Unlink Confluence? Its pages leave the wiki; the repo docs stay.") && void run(async () => { await client!.disconnectAtlassian(); return "Unlinked. The Confluence pages left the wiki."; })}>
              Unlink
            </button>
          </div>
        </>
      ) : c.connected ? (
        <>
          <div>
            Linked to <strong>{c.site_name}</strong>, {c.pages === 1 ? "1 page" : `${c.pages} pages`} in the wiki. Last read {when(c.last_sync)}; it reads again every hour.
          </div>
          {c.last_error && <div className="error small">{c.last_error}</div>}
          <div className="col" role="group" aria-label="Spaces to mirror" style={{ gap: 0 }}>
            <div className="muted small">Spaces to mirror into the wiki</div>
            {spacesErr && <div className="error small">{spacesErr}</div>}
            {!spaces && !spacesErr && <div className="muted small">Loading spaces</div>}
            {spaces && !spaces.length && <div className="muted small">This site has no spaces the account can read.</div>}
            {spaces?.map((s) => (
              <label key={s.key} className="toggle-row">
                <input
                  type="checkbox"
                  checked={chosen.has(s.key)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(s.key);
                    else next.delete(s.key);
                    setChosen(next);
                  }}
                />
                <span>
                  {s.name} <span className="muted small">{s.key}</span>
                </span>
              </label>
            ))}
          </div>
          <div className="row">
            <button
              type="button"
              className="primary"
              disabled={busy || !client || !spaces || !spacesChanged(chosen, mirrored)}
              onClick={() =>
                void run(async () => {
                  const r = await client!.setAtlassianSpaces([...chosen]);
                  loadSpaces();
                  return chosen.size ? `Saved. ${r.sync.pages} pages from ${r.sync.spaces} ${r.sync.spaces === 1 ? "space" : "spaces"}.` : "Saved. No spaces are mirrored now.";
                })
              }
            >
              Save spaces
            </button>
            <button type="button" disabled={busy || !client || !mirrored.length} onClick={() => void run(async () => { const r = await client!.syncConfluence(); return `${r.pages} pages: ${r.updated} changed, ${r.removed} removed, ${r.images} images.`; })}>
              {busy ? "Reading" : "Sync now"}
            </button>
            <button type="button" className="ghost danger" disabled={busy || !client} onClick={() => confirm("Unlink Confluence? Its pages leave the wiki; the repo docs stay.") && void run(async () => { await client!.disconnectAtlassian(); return "Unlinked. The Confluence pages left the wiki."; })}>
              Unlink
            </button>
          </div>
        </>
      ) : c.app ? (
        <>
          <div className="muted small">Sign in on Atlassian's own page and choose the spaces to mirror into the wiki. The app asks to read only; your Atlassian password never reaches it.</div>
          <div>
            <button type="button" className="primary" disabled={busy || waiting || !client} onClick={signIn}>
              {waiting ? "Waiting for Atlassian" : "Sign in with Atlassian"}
            </button>
          </div>
        </>
      ) : (
        <NeedsKey what="the hub's own Atlassian app" />
      )}
      <Status msg={msg} />
    </section>
  );
}

/** The plan as a calendar any app can subscribe to: task blocks, events, reminders and renewals. */
function CalendarFeed() {
  const hubUrl = useMeta<string>(META.hubUrl) ?? "";
  const [key, setKey] = useState("");
  const [copied, setCopied] = useState(false);
  const [msg, setMsg] = useState("");
  const ready = useHubReady();
  useEffect(() => { void engine.client?.feeds().then((f) => setKey(f.calendar.key)).catch(() => undefined); }, [ready]);
  if (!hubUrl || !key) return null;
  // The calendar key reads this feed and nothing else, so the link is safe in a calendar app that syncs it elsewhere.
  const https = `${hubUrl.replace(/\/+$/, "")}/calendar.ics?key=${encodeURIComponent(key)}`;
  const webcal = https.replace(/^https?:/, "webcal:");
  return (
    <section className="card col">
      <h2>Calendar feed</h2>
      <div className="muted small">
        Scheduled tasks, events, reminders and renewal dates as a calendar your calendar app keeps up to date by itself (work items stay out, and so do events already in one of your calendars). The link's key only reads this calendar; New link ends the old one.
      </div>
      <div className="row wrap">
        <button type="button" className="primary" onClick={() => void (isTauri ? openExternal(webcal) : Promise.resolve(window.location.assign(webcal))).catch(() => undefined)}>
          Subscribe in calendar app
        </button>
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard.writeText(https).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
          }
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        <button
          type="button"
          className="ghost small"
          onClick={() => {
            if (!confirm("Make a new calendar link? Calendar apps subscribed with the old one stop updating until you subscribe again.")) return;
            void engine.client?.rotateFeed("calendar").then((f) => { setKey(f.calendar.key); setMsg("New link made. Subscribe again with it."); }).catch((e) => setMsg(errorText(e)));
          }}
        >
          New link
        </button>
      </div>
      {msg && <div className="muted small">{msg}</div>}
    </section>
  );
}

/** The built-in vault's items: add one (a password left empty is made up), remove one, take the file to a KeePass app, or bring one in. */
function KeePassItems({ busy, run }: { busy: boolean; run: (f: () => Promise<string | void>) => Promise<void> }) {
  const client = engine.client;
  const [entries, setEntries] = useState<KeePassEntry[] | null>(null);
  const [title, setTitle] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [url, setUrl] = useState("");
  const [master, setMaster] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [filePassword, setFilePassword] = useState("");
  const load = () => void client?.keepassEntries().then((r) => setEntries(r.entries)).catch(() => setEntries([]));
  useEffect(load, [client]);
  const add = () => void run(async () => {
    await client!.putKeepassEntry({ title: title.trim(), username: username || undefined, password: password || undefined, url: url || undefined });
    const made = !password;
    setTitle(""); setUsername(""); setPassword(""); setUrl("");
    load();
    return made ? `${title.trim()} saved with a new random password.` : `${title.trim()} saved.`;
  });
  const download = () => void run(async () => {
    const blob = await client!.keepassFile();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "passwords.kdbx";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  const bringIn = () => void run(async () => {
    const bytes = new Uint8Array(await file!.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const r = await client!.importKeepass(btoa(bin), filePassword);
    setFile(null); setFilePassword("");
    load();
    return `Your KeePass file is the vault now (${r.items} items). The old one is kept beside it on the hub. Allow the items the assistant may use below.`;
  });
  return (
    <div className="col">
      <strong className="small">In the vault</strong>
      {entries && !entries.length && <div className="muted small">Nothing yet. Add a login below.</div>}
      {entries?.map((e) => (
        <div key={e.title} className="row">
          <span className="grow">{e.title}{e.username ? <span className="muted"> {e.username}</span> : null}{e.url ? <span className="muted small"> {e.url}</span> : null}</span>
          <button type="button" className="ghost danger small" disabled={busy} onClick={() => confirm(`Remove ${e.title} from the vault?`) && void run(async () => { await client!.removeKeepassEntry(e.title); load(); return `${e.title} removed.`; })} aria-label={`Remove ${e.title}`}>Remove</button>
        </div>
      ))}
      <form className="col" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <div className="row wrap">
          <input className="grow" placeholder="Name, like NAS admin" value={title} onChange={(e) => setTitle(e.target.value)} autoComplete="off" aria-label="Item name" />
          <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" aria-label="Username" />
        </div>
        <div className="row wrap">
          <input className="grow" type="password" placeholder="Password (empty: make a strong one)" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" aria-label="Password" />
          <input placeholder="Address (optional)" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" aria-label="Address" />
        </div>
        <div><button type="submit" className="primary" disabled={busy || !title.trim()}>Add to the vault</button></div>
      </form>
      <div className="muted small">The vault is a KeePass file. Open it in KeePassXC, KeePassDX, Strongbox or KeePassium with its master password to see or change a password.</div>
      <div className="row wrap">
        <button type="button" disabled={busy} onClick={download}>Download the vault file</button>
        {master === null
          ? <button type="button" disabled={busy} onClick={() => void run(async () => { setMaster((await client!.keepassMaster()).password); })}>Show the master password</button>
          : <span className="row"><code>{master}</code><button type="button" className="ghost small" onClick={() => setMaster(null)}>Hide</button></span>}
      </div>
      <details>
        <summary className="small">Use a KeePass file you already have</summary>
        <div className="col">
          <input type="file" accept=".kdbx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="KeePass file" />
          <input type="password" placeholder="Its master password" value={filePassword} onChange={(e) => setFilePassword(e.target.value)} autoComplete="off" aria-label="Its master password" />
          <div><button type="button" disabled={busy || !file || !filePassword} onClick={bringIn}>Use this file</button></div>
        </div>
      </details>
    </div>
  );
}

const PM_NAMES: Record<PasswordManagerProvider, string> = { keepass: "Built-in vault", lastpass: "LastPass", "1password": "1Password", bitwarden: "Bitwarden" };

/**
 * LastPass, 1Password or Bitwarden (also a self-hosted Vaultwarden) through its CLI on the hub's machine (LastPass also
 * on another one it reaches, like a Mac already signed in), or the hub's own KeePass file for someone with no password
 * manager, so the assistant can use a password in a command without seeing it. Every item except the ones left out
 * here (the default), or only the ones chosen here, and the assistant learns only names.
 */
function PasswordManager({ c, reload }: { c: PasswordManagerView; reload: () => void }) {
  const client = engine.client;
  const [hosts, setHosts] = useState<Array<{ name: string; os: string; local: boolean }>>([]);
  const [provider, setProvider] = useState<PasswordManagerProvider>(c.provider ?? "keepass");
  const [server, setServer] = useState("");
  const [host, setHost] = useState(c.host ?? "");
  const [status, setStatus] = useState<PasswordManagerStatus | null>(null);
  const [email, setEmail] = useState(c.account ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [q, setQ] = useState("");
  const [found, setFound] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  useEffect(() => {
    if (!client) return;
    void client.aiHosts().then((r) => setHosts(r.hosts.filter((h) => h.os !== "windows"))).catch(() => undefined);
  }, [client]);
  useEffect(() => {
    if (!client || !host) return;
    setStatus(null);
    void client.passwordManagerStatus(provider, host).then(setStatus).catch((e) => setMsg({ ok: false, text: errorText(e) }));
  }, [client, provider, host, c.linked, c.account]);
  const run = async (f: () => Promise<string | void>) => {
    setBusy(true);
    setMsg(null);
    try {
      const text = await f();
      if (text) setMsg({ ok: true, text });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setPassword("");
      setCode("");
      setToken("");
      reload();
      setBusy(false);
    }
  };
  const name = PM_NAMES[provider];
  const localOnly = provider !== "lastpass";
  const chosen = c.linked && c.provider === provider && (localOnly || c.host === host);
  const signedIn = chosen && !!status?.signed_in;
  const allow = (names: string[]) => void run(async () => { await client!.allowPasswordManagerItems(names); });
  const setAccess = (body: { access?: "all" | "chosen"; excluded?: string[] }) => void run(async () => { await client!.setPasswordManagerAccess(body); });
  return (
    <section className="card col">
      <h2>Password manager</h2>
      <div className="muted small">
        Lets the assistant use a password in a command on your machines without ever seeing it. Only the items you allow below are read, every command that uses one waits for your approval, and the value is hidden from what the command prints. No password manager? The built-in vault is a KeePass file the hub keeps, which any KeePass app opens.
      </div>
      <div className="row wrap">
        <select value={provider} onChange={(e) => setProvider(e.target.value as PasswordManagerProvider)} aria-label="Password manager">
          <option value="keepass">Built-in vault (KeePass, open source)</option>
          <option value="bitwarden">Bitwarden or Vaultwarden</option>
          <option value="1password">1Password</option>
          <option value="lastpass">LastPass</option>
        </select>
        {provider === "lastpass" && (
          <select value={host} onChange={(e) => setHost(e.target.value)} aria-label="Machine its CLI runs on">
            {hosts.map((h) => (
              <option key={h.name} value={h.name}>
                on {h.name}{h.local ? " (the hub)" : ""}
              </option>
            ))}
          </select>
        )}
        {!chosen && (
          <button type="button" className="primary" disabled={busy || !client || (!localOnly && !host)} onClick={() => void run(async () => { await client!.linkPasswordManager(provider, localOnly ? "" : host); return provider === "keepass" ? "The built-in vault is ready." : `${name}${localOnly ? "" : ` on ${host}`} chosen.`; })}>
            {provider === "keepass" ? "Make the vault" : "Use this"}
          </button>
        )}
      </div>
      {status && provider !== "keepass" && (
        <div className="small">
          {status.installed[provider] ? `${name} CLI is installed on ${status.host}` : `${name} CLI is not installed on ${status.host}`}
          {chosen && status.installed[provider] ? (signedIn ? `, signed in${status.account ? ` as ${status.account}` : ""}.` : ", not signed in.") : "."}
          {status.install_hint && !status.installed[provider] && provider !== "bitwarden" && <div className="muted">Install it there: <code>{status.install_hint}</code></div>}
          {!status.installed[provider] && provider === "bitwarden" && (
            <div><button type="button" disabled={busy || !client} onClick={() => void run(async () => { setStatus(await client!.installPasswordManager("bitwarden")); return "The Bitwarden CLI is installed."; })}>{busy ? "Installing..." : "Install the Bitwarden CLI"}</button></div>
          )}
        </div>
      )}
      {chosen && status?.installed.bitwarden && !signedIn && provider === "bitwarden" && (
        <form className="col" onSubmit={(e) => { e.preventDefault(); void run(async () => { await client!.signInPasswordManager({ email: email.trim(), password, code: code.trim() || undefined, server: server.trim() || undefined }); return "Signed in to Bitwarden."; }); }}>
          <div className="muted small">Your master password goes to Bitwarden's own CLI on the hub and is not kept; the app keeps only the session key it answers.</div>
          <input type="email" placeholder="Bitwarden email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" aria-label="Bitwarden email" />
          <input type="password" placeholder="Master password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" aria-label="Master password" />
          <input placeholder="Authenticator code, if you use one" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" aria-label="Authenticator code" />
          <input placeholder="Server, only for Vaultwarden or the EU cloud (https://...)" value={server} onChange={(e) => setServer(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Server address" />
          <div><button type="submit" className="primary" disabled={busy || !password}>Sign in</button></div>
        </form>
      )}
      {chosen && provider === "keepass" && status && !signedIn && (
        <form className="col" onSubmit={(e) => { e.preventDefault(); void run(async () => { await client!.signInPasswordManager({ password }); return "The vault opens."; }); }}>
          <div className="muted small">The vault file is there but its master password is not known here. Type it to open it.</div>
          <input type="password" placeholder="Master password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" aria-label="Master password" />
          <div><button type="submit" className="primary" disabled={busy || !password}>Open</button></div>
        </form>
      )}
      {chosen && provider === "keepass" && signedIn && <KeePassItems busy={busy} run={run} />}
      {chosen && status?.installed[provider] && !signedIn && provider === "lastpass" && (
        <form className="col" onSubmit={(e) => { e.preventDefault(); void run(async () => { await client!.signInPasswordManager({ email: email.trim(), password, code: code.trim() || undefined }); return "Signed in to LastPass."; }); }}>
          <div className="muted small">Your master password goes to LastPass's own CLI on {host} and is not kept by the app.</div>
          <input type="email" placeholder="LastPass email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" aria-label="LastPass email" />
          <input type="password" placeholder="Master password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" aria-label="Master password" />
          <input placeholder="Authenticator code, if you use one" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" aria-label="Authenticator code" />
          <div><button type="submit" className="primary" disabled={busy || !email.trim() || !password}>Sign in</button></div>
        </form>
      )}
      {chosen && status?.installed[provider] && !signedIn && provider === "1password" && (
        <form className="col" onSubmit={(e) => { e.preventDefault(); void run(async () => { await client!.signInPasswordManager({ token: token.trim() }); return "1Password linked."; }); }}>
          <div className="muted small">1Password's CLI signs in without you there through a service account: in 1Password, Developer, Service accounts, make one with read access to the vaults the assistant may use, and paste its token.</div>
          <input type="password" placeholder="ops_..." value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} aria-label="Service account token" />
          <div><button type="submit" className="primary" disabled={busy || !token.trim()}>Save token</button></div>
        </form>
      )}
      {signedIn && (c.access ?? "chosen") === "all" && (
        <div className="col">
          <strong className="small">Items the assistant may use</strong>
          <div className="row wrap">
            <label className="row small"><input type="radio" name="pm-access" checked onChange={() => {}} /> Every item, except the ones left out below</label>
            <label className="row small"><input type="radio" name="pm-access" checked={false} disabled={busy} onChange={() => setAccess({ access: "chosen" })} /> Only items I choose</label>
          </div>
          <div className="muted small">The assistant learns only item names, by searching, never a password, and every command that uses one waits for your approval. An item left out is never read, even if a command names it.</div>
          <strong className="small">Left out</strong>
          {!(c.excluded ?? []).length && <div className="muted small">Nothing yet. Search below to leave out items or whole folders.</div>}
          <div className="chips">
            {(c.excluded ?? []).map((n) => (
              <span key={n} className="chip">
                {n.endsWith("/") ? `Folder ${n}` : n}
                <button className="chip-x" disabled={busy} onClick={() => setAccess({ excluded: (c.excluded ?? []).filter((x) => x !== n) })} aria-label={`Let the assistant use ${n} again`}>{"\u00D7"}</button>
              </span>
            ))}
          </div>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { setFound((await client!.passwordManagerItems(q)).items); }); }}>
            <input className="grow" placeholder={`Search ${name} item names`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search item names" />
            <button type="submit" disabled={busy}>Search</button>
          </form>
          {found && (() => {
            const left = new Set(c.excluded ?? []);
            const folders = [...new Set(found.filter((n) => n.includes("/")).map((n) => n.slice(0, n.lastIndexOf("/") + 1)))].filter((f) => !left.has(f));
            return (
              <div className="chips">
                {folders.map((f) => (
                  <button key={f} type="button" className="chip" disabled={busy} onClick={() => setAccess({ excluded: [...(c.excluded ?? []), f] })} title="Leave out every item in this folder">
                    {"\u2212"} Folder {f}
                  </button>
                ))}
                {found.filter((n) => !left.has(n)).map((n) => (
                  <button key={n} type="button" className="chip" disabled={busy} onClick={() => setAccess({ excluded: [...(c.excluded ?? []), n] })} title="Leave this item out">
                    {"\u2212"} {n}
                  </button>
                ))}
                {!found.length && <span className="muted small">No items match.</span>}
              </div>
            );
          })()}
        </div>
      )}
      {signedIn && (c.access ?? "chosen") === "chosen" && (
        <div className="col">
          <strong className="small">Items the assistant may use</strong>
          {c.access && (
            <div className="row wrap">
              <label className="row small"><input type="radio" name="pm-access" checked={false} disabled={busy} onChange={() => setAccess({ access: "all" })} /> Every item, except the ones left out</label>
              <label className="row small"><input type="radio" name="pm-access" checked onChange={() => {}} /> Only items I choose</label>
            </div>
          )}
          {!c.allowed.length && <div className="muted small">None yet. Search below and allow the ones it should be able to use.</div>}
          <div className="chips">
            {c.allowed.map((n) => (
              <span key={n} className="chip">
                {n}
                <button className="chip-x" onClick={() => allow(c.allowed.filter((x) => x !== n))} aria-label={`Stop allowing ${n}`}>{"\u00D7"}</button>
              </span>
            ))}
          </div>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void run(async () => { setFound((await client!.passwordManagerItems(q)).items); }); }}>
            <input className="grow" placeholder={`Search ${name} item names`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search item names" />
            <button type="submit" disabled={busy}>Search</button>
          </form>
          {found && (
            <div className="chips">
              {found.filter((n) => !c.allowed.includes(n)).map((n) => (
                <button key={n} type="button" className="chip" disabled={busy} onClick={() => allow([...c.allowed, n])} title="Allow the assistant to use this item">
                  + {n}
                </button>
              ))}
              {!found.length && <span className="muted small">No items match.</span>}
            </div>
          )}
        </div>
      )}
      {c.linked && (
        <div>
          <button type="button" className="ghost danger" disabled={busy || !client} onClick={() => confirm(`Unlink ${PM_NAMES[c.provider ?? "keepass"]}? The assistant stops being able to use its items.${c.provider === "keepass" ? " The vault file and its master password stay on the hub." : ""}`) && void run(async () => { await client!.unlinkPasswordManager(); return "Unlinked."; })}>
            Unlink {PM_NAMES[c.provider ?? "keepass"]}
          </button>
        </div>
      )}
      <Status msg={msg} />
    </section>
  );
}

/**
 * An app key: the hub's own registration with a service that lets a program in only once it is registered there, made
 * once by the owner on that service's site with the hub's guide (`service`). What it is, why the service asks for it,
 * what in Aeneas uses it and what works without it, said where it is listed (the Apple apps' AppKey, kept the same).
 */
export interface AppKey {
  service: "google" | "atlassian" | "steam";
  name: string;
  /** The service it is registered with. */
  by: string;
  /** One line on what it is for, beside its name. */
  purpose: string;
  what: string;
  why: string;
  uses: string;
  without: string;
  /** What Replace does, for a key the hub has. */
  replacing: string;
}

/** What App keys says above its rows (the Apple apps' AppKey.intro, kept the same). */
export const APP_KEYS_INTRO = "These are optional. A few services let a program in only once it is registered with them. Aeneas has no server of its own, so your hub holds its own registration, made once by you on that service's site. Each one is used only for the feature it names, and nothing else needs one.";

/** Every app key, in the order they show (the Apple apps' AppKey.all, kept the same). */
export const APP_KEYS: AppKey[] = [
  {
    service: "google", name: "Google app", by: "Google",
    purpose: "For the older Google sign-in, which reads Gmail for Receipts and renewals.",
    what: "An OAuth client made in your own Google Cloud project. It tells Google which program is asking, and that it may only read Gmail (the gmail.readonly permission).",
    why: "Google lets a program sign in to Gmail only once it is registered. Aeneas has no registration with Google, so your hub uses yours, with you as its only user.",
    uses: "Only the older Google sign-in, which no app offers any more. It reads Gmail read-only, for Receipts and renewals, and never sends, changes or deletes mail. The hub deletes this key once no address uses that sign-in.",
    without: "Gmail accounts added with an app password do not need it: they work for Mail and for Receipts and renewals. Adding an app password for an address on the older sign-in moves its receipts there.",
    replacing: "The guide ends by saving the new one in place of the old. The older sign-in cannot be made again, so its addresses then stop reading: add an app password for each instead.",
  },
  {
    service: "atlassian", name: "Atlassian app", by: "Atlassian",
    purpose: "For Confluence pages in the Wiki.",
    what: "An OAuth 2.0 app you make in Atlassian's developer console, allowed only to read Confluence.",
    why: "Atlassian lets a program sign in to Confluence only once it is registered there. Aeneas has no registration with Atlassian, so your hub uses yours.",
    uses: "Sign in with Atlassian, under Confluence in Settings, Connections, so the spaces you pick show in the Wiki, where the assistant can search them.",
    without: "The Wiki still shows a repository's docs, and nothing else uses it.",
    replacing: "The guide ends by saving the new one in place of the old. Confluence then needs Reconnect, to sign in through the new one.",
  },
  {
    service: "steam", name: "Steam key", by: "Steam",
    purpose: "For Steam playtime in Games.",
    what: "A Steam Web API key, which you register at steamcommunity.com/dev/apikey.",
    why: "Steam gives a program your games and playtime only when it asks with a key. Aeneas has no key of its own, so your hub uses yours.",
    uses: "Reading your Steam games and playtime for Games, once you sign in with Steam under Steam in Settings, Connections.",
    without: "Games still keeps the games you add by hand. A key stops working when your Steam password changes: then replace it with a new one.",
    replacing: "The guide ends by saving the new key in place of the old, once Steam accepts it.",
  },
];

/**
 * The app keys to show, each with whether the hub has it: a key only while its module is on (Receipts and renewals,
 * Wiki, Games), and Google's and Atlassian's only from a hub that says. Google's only while a mailbox still uses the
 * older Google sign-in, the one thing it serves.
 */
export function appKeys(c: Pick<ConnectionsView, "google" | "atlassian" | "steam">, on: (m: string) => boolean): Array<AppKey & { added: boolean }> {
  const added: Record<AppKey["service"], boolean | null> = {
    google: on("mail") && c.google?.accounts.length ? c.google.app : null,
    atlassian: on("wiki") && c.atlassian ? c.atlassian.app : null,
    steam: on("games") ? c.steam.hub_key : null,
  };
  return APP_KEYS.flatMap((k) => {
    const a = added[k.service];
    return a === null ? [] : [{ ...k, added: a }];
  });
}

/**
 * App keys (called Keys until 2026-11-24, gnomecannon/aeneas#10, #25): the hub's own registrations a service needs
 * before anyone can sign in, apart from the accounts and services since they are made once and then rarely looked at.
 * Each row says what it is for and whether the hub has it as a status, opens what it is and why it is asked for in
 * place (the ⓘ, as in Settings, Modules), and has one button: the guide to set it up, or Replace for one the hub has.
 */
function AppKeys({ c, on, reload, opening }: { c: ConnectionsView; on: (m: string) => boolean; reload: () => void; opening: AppKey["service"] | null }) {
  const keys = appKeys(c, on);
  if (!keys.length) return null;
  return (
    <section className="card col" id="app-keys">
      <h2>App keys</h2>
      <div className="muted small">{APP_KEYS_INTRO}</div>
      {keys.map((k) => <AppKeyRow key={k.service} k={k} reload={reload} opening={opening === k.service} />)}
    </section>
  );
}

/** One app key: its name, its state, what it is for, what it is (in place) and Set it up or Replace. */
function AppKeyRow({ k, reload, opening }: { k: AppKey & { added: boolean }; reload: () => void; opening: boolean }) {
  const [open, setOpen] = useState(false);
  const info = `app-key-${k.service}-info`;
  return (
    <div className="col account-row" id={`app-key-${k.service}`}>
      <div className="row" style={{ flexWrap: "nowrap", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div className="col grow" style={{ gap: 2 }}>
          <div>
            <strong>{k.name}</strong>{" "}
            {k.added ? <span className="ok small"><span aria-hidden="true">{"\u2713"} </span>Added</span> : <span className="muted small">Not added</span>}
          </div>
          <div className="muted small">{k.purpose}</div>
        </div>
        <button type="button" className="info-btn" aria-expanded={open} aria-controls={info} aria-label={`About the ${k.name}`} onClick={() => setOpen(!open)}>ⓘ</button>
      </div>
      {open && (
        <div id={info} className="link-info module-info">
          <div><strong>What it is:</strong> {k.what}</div>
          <div><strong>Why {k.by} asks for it:</strong> {k.why}</div>
          <div><strong>What uses it:</strong> {k.uses}</div>
          <div><strong>Without it:</strong> {k.without}</div>
          {k.added && <div><strong>Replacing it:</strong> {k.replacing}</div>}
        </div>
      )}
      <OwnKeyGuide service={k.service} onDone={reload} start={k.added ? { label: "Replace" } : { label: "Set it up", primary: true }} opening={opening} />
    </div>
  );
}

/**
 * Settings, Connections (gnomecannon/aeneas#25; since 2026-11-24 services only: mail and calendar accounts, and what
 * comes in from the Apple devices, are in Settings, Accounts): the services each module links (Steam, Letterboxd,
 * Confluence, the password manager), the calendar link, then the app keys they need.
 */
export function ConnectionsPage({ show = null }: { show?: string | null } = {}) {
  const { on } = useModules();
  const [c, reload, loadErr] = useConnections();
  // A link from a module's "Set it up now" or an empty screen (`?show=steam`) opens at that service's section once the
  // page has loaded (SubPage first scrolls every page to its top).
  const section = connectionSection(show);
  useEffect(() => {
    if (!section || !c) return;
    const t = setTimeout(() => document.getElementById(`conn-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    return () => clearTimeout(t);
  }, [section, !!c]);
  // A key a service stopped taking: its button opens that key's guide under App keys (one guide per key, kept there).
  const [opening, setOpening] = useState<AppKey["service"] | null>(null);
  const replaceKey = (service: AppKey["service"]) => {
    setOpening(service);
    setTimeout(() => document.getElementById(`app-key-${service}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  };
  return (
    <SubPage path="/settings/connections">
      {!engine.client && <div className="empty">Set up the hub connection first.</div>}
      {engine.client && !c && !loadErr && <div className="muted">Loading</div>}
      {engine.client && !c && loadErr && <div className="error">{loadErr} <button type="button" className="small" onClick={reload}>Try again</button></div>}
      {c && (
        <>
          <div className="muted small">Mail and calendar accounts are in <a href="#/settings/accounts">Settings, Accounts</a>.</div>
          {on("games") && <div id="conn-steam"><Steam c={c.steam} reload={reload} replaceKey={() => replaceKey("steam")} /></div>}
          {on("films") && <div id="conn-letterboxd"><Letterboxd c={c.letterboxd} reload={reload} /></div>}
          {on("wiki") && c.atlassian && <div id="conn-confluence"><Confluence c={c.atlassian} reload={reload} /></div>}
          {on("homelab") && c.password_manager && <PasswordManager c={c.password_manager} reload={reload} />}
          <CalendarFeed />
          <AppKeys c={c} on={on} reload={reload} opening={opening} />
        </>
      )}
    </SubPage>
  );
}
