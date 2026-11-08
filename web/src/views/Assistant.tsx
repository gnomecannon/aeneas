import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db, type ChatMsg, type ChatSession } from "../sync/db";
import { engine } from "../sync/engine";
import { readSse, type AiSession, type AiWorking, type PendingAction } from "../sync/api";
import { uuid } from "../sync/edits";
import { useEntities } from "../sync/hooks";
import { copyText, patchEntity, refetchAll } from "../sync/memory";
import { Markdown } from "../components/Markdown";
import { go } from "../lib/router";
import { fmtDateTime } from "../lib/time";
import { useDictation } from "../lib/useDictation";
import { DictationNotice } from "../components/DictationNotice";
import { useModules } from "../lib/modules";
import { isTauri } from "../tauri/bridge";
import { NO_LOCAL_VOICE, localVoiceAvailable, setSpeakVoiceReplies, speak, speakVoiceReplies, speechSupported, stopSpeaking, useSpeaking } from "../lib/speech";
import { deriveHosts, detectHost, splitPreflight, type LedgerF, type SessionClose } from "../lib/memory";
import type { Entity } from "@everythingapp/shared";

type ChatMeta = { reply: string; model: string; backend: string; redactions: number; rules_applied: string[]; procedure_id?: string; mode?: string; actions?: { tool: string; ok: boolean; writes: boolean }[]; pending_action?: PendingAction; images?: string[] };

/** Plain words for what the assistant is doing with a tool. */
export const TOOL_LABELS: Record<string, string> = {
  get_today: "Checking today", get_week: "Checking the week", search: "Searching your notes", list_items: "Looking it up", get_item: "Looking it up",
  reminders_due: "Checking reminders", ops_status: "Checking the homelab", health_summary: "Checking health logs", pet_summary: "Checking on the pet",
  project_summary: "Opening the project", pick_food: "Picking food", pick_game: "Picking a game", create_task: "Adding a task", update_task: "Updating a task",
  schedule_task: "Scheduling", create_reminder: "Setting a reminder", snooze_or_finish_reminder: "Updating a reminder", save_note: "Saving a note",
  capture: "Capturing", log_health: "Logging", log_pet: "Logging for the pet", toggle_checklist_item: "Ticking the checklist", music_idea: "Saving the idea",
  remember: "Remembering", forget: "Forgetting", ledger_update: "Updating the ledger", runbook_note: "Writing fix notes", journal_entry: "Journaling",
  create_item: "Saving", update_item: "Updating", delete_item: "Deleting", procedure: "Updating the procedure", quiz: "Checking the quiz",
  render_snippet: "Filling a snippet", ops_action: "Checking a monitor", sensors: "Reading sensors", project_plan: "Updating the plan", cover_letter: "Drafting a cover letter",
  calculate: "Calculating", checklist_from_template: "Starting a checklist", draft_in_my_voice: "Drafting in your voice", web_search: "Searching the web",
  read_web_page: "Reading a page", list_hosts: "Listing machines", run_command: "Running a command", approve_command: "Running the approved command",
  wiki_search: "Searching the wiki", wiki_page: "Reading the wiki", library: "Checking your library", food_chosen: "Noting the pick",
  inbox: "Sorting Unsorted Info", record_done: "Recording it", app_status: "Checking the app", sync_now: "Syncing",
  metrics: "Reading your charts", dashboard: "Updating the dashboard", set_injection_day: "Setting the injection day", note_tags: "Tagging the note",
};
const toolLabel = (t: string) => TOOL_LABELS[t] ?? "Working";

async function newSession(id = uuid(), title = "New chat", task_type: ChatSession["task_type"] = "auto"): Promise<ChatSession> {
  const now = new Date().toISOString();
  const s: ChatSession = { id, title, task_type, allow_cloud: false, messages: [], created_at: now, updated_at: now };
  await db.sessions.put(s);
  return s;
}

/** Hub session to the local shape the screen renders and caches for offline reading. */
function fromHub(h: AiSession, prev?: ChatSession): ChatSession {
  return {
    id: h.session_id, title: h.title, task_type: (h.task_type as ChatSession["task_type"]) ?? "auto", allow_cloud: prev?.allow_cloud ?? false,
    created_at: h.created_at, updated_at: h.last_at,
    messages: h.messages.map((m) => ({ role: m.role, content: m.content, at: m.at ?? h.last_at, ...(m.images?.length ? { images: m.images } : {}), ...(m.actions?.length ? { actions: m.actions } : {}), ...(m.approval ? { approval: m.approval } : {}) })),
  };
}

/** Shrink a picked or pasted image to at most 2000 px on the long side as JPEG, so uploads stay small and text stays readable. */
async function encodeImage(file: Blob): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const g = canvas.getContext("2d");
  if (!g) throw new Error("canvas unavailable");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.88);
}

/** A chat image from the hub (needs the bearer header, so it is fetched as a blob). */
export function HubImage({ id }: { id: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let u = "";
    let live = true;
    engine.client?.aiImage(id).then((b) => { if (!live) return; u = URL.createObjectURL(b); setUrl(u); }, () => undefined);
    return () => { live = false; if (u) URL.revokeObjectURL(u); };
  }, [id]);
  return url ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="attached" className="chat-image" /></a> : <span className="chip static">image</span>;
}

/** A host command waiting for approval, with the pre-flight when it is destructive. */
function ApprovalCard({ action, busy, onRun, onCancel }: { action: PendingAction; busy: boolean; onRun: () => void; onCancel: () => void }) {
  return (
    <div className={`card col approval${action.risk === "high" ? " danger" : ""}`} role="group" aria-label="Command waiting for approval">
      <div className="small muted">Waiting for your approval{action.host ? ` on ${action.host}` : ""}{action.purpose ? `: ${action.purpose}` : ""}</div>
      <pre className="command">{action.command}</pre>
      {action.preflight && (
        <div className="callout preflight small">
          <div>{action.preflight.backup}</div>
          <div>{action.preflight.verify}</div>
          <div>{action.preflight.rollback}</div>
        </div>
      )}
      <div className="row">
        <button className="primary" disabled={busy} onClick={onRun}>Run it</button>
        <button disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** An assistant reply with every Pre-flight block (a paragraph starting with "Pre-flight") as a callout. */
export function Reply({ text }: { text: string }) {
  const segs = splitPreflight(text);
  if (segs.length === 1 && !segs[0].preflight) return <Markdown text={text} images="link" />;
  return (
    <div className="col">
      {segs.map((s, i) =>
        s.preflight ? (
          <div key={i} className="callout preflight" role="note" aria-label="Pre-flight">
            <Markdown text={s.text} images="link" />
          </div>
        ) : (
          <Markdown key={i} text={s.text} images="link" />
        ),
      )}
    </div>
  );
}

/** An editable string list on the ledger (confirmed, ruled_out), written with PATCH /entities/:id. */
function LedgerLines({ ledger, field, label }: { ledger: Entity; field: "confirmed" | "ruled_out"; label: string }) {
  const items = ((ledger.fields as LedgerF)[field] ?? []) as string[];
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const write = (next: string[]) =>
    patchEntity(ledger, { [field]: next })
      .then(() => setErr(""))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  return (
    <div>
      <strong>{label}</strong>
      <ul className="plain ledger-lines">
        {items.map((t, i) => (
          <li key={`${i}:${t}`} className="row between">
            <span className="grow">{t}</span>
            <button className="small ghost" onClick={() => void write(items.filter((_, j) => j !== i))} aria-label={`Remove ${t} from ${label}`}>
              x
            </button>
          </li>
        ))}
      </ul>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (!t) return;
          void write([...items, t]).then(() => setText(""));
        }}
      >
        <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Add to ${label.toLowerCase()}`} aria-label={`Add to ${label}`} />
        <button className="small" type="submit" disabled={!text.trim()}>
          Add
        </button>
      </form>
      {err && <div className="error">{err}</div>}
    </div>
  );
}

const OUTCOMES = ["fixed", "abandoned", "parked"] as const;

function CloseDialog({ session, hosts, projects, onClose }: { session: ChatSession; hosts: string[]; projects: Entity[]; onClose: () => void }) {
  const detected = detectHost(session.messages.map((m) => m.content).join("\n"), hosts);
  const [outcome, setOutcome] = useState<(typeof OUTCOMES)[number]>("fixed");
  const [note, setNote] = useState("");
  const [host, setHost] = useState(detected ?? "");
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<SessionClose | null>(null);
  const [copied, setCopied] = useState(false);

  const close = async () => {
    if (!engine.client) {
      setErr("Needs the hub.");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const body: Parameters<typeof engine.client.sessionClose>[1] = { outcome };
      if (note.trim()) body.note = note.trim();
      if (host.trim()) body.host = host.trim();
      if (project) body.project_id = project;
      const r = await engine.client.sessionClose(session.id, body);
      setResult(r);
      await refetchAll([r.runbook_id, r.journal_id, ...(r.journal_ids ?? []), ...(r.snippet_ids ?? [])]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const journalIds = result ? [...new Set([result.journal_id, ...(result.journal_ids ?? [])].filter((x): x is string => !!x))] : [];
  return (
    <div className="card col close-dialog" role="dialog" aria-label="Close session">
      <div className="row between">
        <strong>Close session</strong>
        <button className="small ghost" onClick={onClose} aria-label="Dismiss">
          x
        </button>
      </div>
      {!result && (
        <>
          <div className="row">
            <div className="grow">
              <label htmlFor="cl-outcome">Outcome</label>
              <select id="cl-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as (typeof OUTCOMES)[number])}>
                {OUTCOMES.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </div>
            <div className="grow">
              <label htmlFor="cl-host">Host{detected ? " (detected)" : ""}</label>
              <input id="cl-host" list="cl-hosts" value={host} onChange={(e) => setHost(e.target.value)} placeholder="optional" className="mono" autoCapitalize="off" />
              <datalist id="cl-hosts">
                {hosts.map((h) => (
                  <option key={h} value={h} />
                ))}
              </datalist>
            </div>
          </div>
          <div>
            <label htmlFor="cl-project">Project</label>
            <select id="cl-project" value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">none</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {String(p.fields.name)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="cl-note">Note</label>
            <textarea id="cl-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="optional" />
          </div>
          {err && <div className="error">{err}</div>}
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => void close()}>
              {busy ? "Closing" : "Close session"}
            </button>
            <button className="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
          </div>
          <div className="muted small">Writes what broke and how it was fixed into the machine's fix notes, logs each change, and closes the troubleshooting log.</div>
        </>
      )}
      {result && (
        <div className="col small">
          <div className="row between">
            <strong>Summary</strong>
            <button
              className="small ghost"
              onClick={() =>
                copyText(result.summary).then((ok) => {
                  setCopied(ok);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? "copied" : "Copy"}
            </button>
          </div>
          <Markdown text={result.summary} images="link" />
          <div className="row">
            {result.runbook_id && (
              <a href={`#/hosts/${encodeURIComponent(host || detected || "")}?runbook=${encodeURIComponent(result.runbook_id)}`} className="chip static">
                runbook
              </a>
            )}
            {journalIds.map((jid, i) => (
              <a key={jid} href={`#/journal?focus=${encodeURIComponent(jid)}`} className="chip static">
                journal {journalIds.length > 1 ? i + 1 : ""}
              </a>
            ))}
            {(result.snippet_ids ?? []).map((sid, i) => (
              <a key={sid} href={`#/snippets/${encodeURIComponent(sid)}`} className="chip static">
                snippet {result.snippet_ids.length > 1 ? i + 1 : ""}
              </a>
            ))}
            {result.resume_card_written && <span className="muted">resume card written</span>}
          </div>
          <div>
            <button className="small" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** "the 1 chat" or "all 5 chats", for the erase-all wording. */
const chatCount = (n: number) => (n === 1 ? "the 1 chat" : `all ${n} chats`);

/** Chats this window is waiting on a reply for. Module level, so it survives leaving the screen and coming back. */
const inFlight = new Set<string>();

/** A small dropdown built on <details>; it closes when you click outside it. */
function Dropdown({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) ref.current.open = false; };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  return (
    <details ref={ref} className="dropdown">
      <summary className="small" title={title}>{label}</summary>
      <div className="dropdown-pop" onClick={(e) => { if ((e.target as HTMLElement).closest("button")) ref.current!.open = false; }}>{children}</div>
    </details>
  );
}

/**
 * Shown from the moment a message is sent until the reply is stored, so a slow model or a long tool call never looks
 * like nothing is happening. The seconds keep counting even while the hub sends nothing.
 */
function Working({ status, since }: { status: string; since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="working">
      <span className="spinner" aria-hidden="true" />
      <span>
        <span role="status">{status}</span>
        <span aria-hidden="true">, {Math.max(0, Math.round((now - since) / 1000))} s</span>
      </span>
    </div>
  );
}

export function Assistant({ id }: { id?: string }) {
  const loaded = useLiveQuery(() => db.sessions.orderBy("updated_at").reverse().toArray(), []);
  const sessions = loaded ?? [];
  const session = sessions.find((s) => s.id === id);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [busySince, setBusySince] = useState(0);
  /** A reply the hub is working on that this screen is not streaming (another device, or started before leaving the screen). */
  const [remote, setRemote] = useState<AiWorking | null>(null);
  const [partial, setPartial] = useState("");
  const [err, setErr] = useState("");
  const [toolStatus, setToolStatus] = useState("");
  const [cloudAvailable, setCloudAvailable] = useState(false);
  const [imagesOk, setImagesOk] = useState(true);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const abort = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** Set when dictation put words in the box, so the reply to that message is read aloud. */
  const voiceTurn = useRef(false);
  const dictation = useDictation((t) => { voiceTurn.current = true; setInput((cur) => (cur.trim() ? `${cur.trimEnd()} ${t}` : t)); }, isTauri);
  const { on } = useModules();
  const talkOk = dictation.supported && on("voice");
  // Answers are read only with a voice that runs on this device; online voices would send the text away.
  const [localVoice, setLocalVoice] = useState(true);
  useEffect(() => { void localVoiceAvailable().then(setLocalVoice); }, []);
  const speaking = useSpeaking();
  const [speakReplies, setSpeakReplies] = useState(speakVoiceReplies);
  useEffect(() => () => stopSpeaking(), []);
  // The hub reads the shared start of every chat into the model's cache while the owner types (it skips it when warm).
  useEffect(() => { engine.client?.warmAssistant().catch(() => {}); }, [engine.client]);
  useEffect(() => {
    if (!engine.client) return;
    engine.client.health().then((h) => { setCloudAvailable(h.ai?.cloud === true); setImagesOk(h.ai?.images !== false); }, () => setCloudAvailable(false));
  }, [engine.client]);
  const ledgers = useEntities("ledger", (e) => e.fields.session_id === id, [id]);
  const runbooks = useEntities("runbook");
  const journal = useEntities("journal");
  const snippets = useEntities("snippet");
  const hostFacts = useEntities("fact", (e) => /^host:/.test(String(e.fields.key ?? "")));
  const hostNames = useMemo(() => deriveHosts([...runbooks, ...journal, ...snippets, ...hostFacts]).map((h) => h.host), [runbooks, journal, snippets, hostFacts]);
  const projects = useEntities("project", (e) => e.fields.status === "active");
  const [closing, setClosing] = useState(false);

  /** Pull the chat list from the hub; chats started on other devices appear here too. */
  const syncList = async () => {
    if (!engine.client) return;
    try {
      const { sessions: remote } = await engine.client.aiSessions();
      const ids = new Set(remote.map((r) => r.session_id));
      await db.transaction("rw", db.sessions, async () => {
        for (const r of remote) {
          const local = await db.sessions.get(r.session_id);
          if (!local) await db.sessions.put({ id: r.session_id, title: r.title, task_type: "auto", allow_cloud: false, messages: [], created_at: r.created_at, updated_at: r.last_at });
          else if (local.updated_at < r.last_at || local.title !== r.title) await db.sessions.update(r.session_id, { title: r.title, updated_at: r.last_at });
        }
        // A chat deleted on another device goes here too; never-sent local drafts stay.
        for (const l of await db.sessions.toArray()) if (!ids.has(l.id) && l.messages.length && !inFlight.has(l.id)) await db.sessions.delete(l.id);
      });
    } catch { /* offline: keep the cached list */ }
  };

  /** Load one chat from the hub (the source of truth) into the local cache. */
  const load = async (sid: string) => {
    if (!engine.client) return;
    const local = await db.sessions.get(sid);
    if (local && !local.messages.length && local.task_type === "auto" && Date.now() - Date.parse(local.created_at) < 86_400_000 && local.created_at === local.updated_at) return; // a new chat the hub has not seen yet
    try {
      const h = await engine.client.aiSession(sid);
      const prev = await db.sessions.get(sid);
      await db.sessions.put(fromHub(h, prev));
      setPending(h.pending_action);
      setRemote(h.working ?? null);
    } catch { setPending(null); }
  };

  // While another device's reply is in progress, re-read the chat until it lands.
  useEffect(() => {
    if (!remote || !id) return;
    const t = setInterval(() => void load(id), 2500);
    return () => clearInterval(t);
  }, [remote, id]);
  useEffect(() => { setRemote(null); }, [id]);

  useEffect(() => { void syncList(); const f = () => void syncList(); window.addEventListener("focus", f); return () => window.removeEventListener("focus", f); }, [engine.client]);
  // The newest conversation, not a capture's filing thread: a question typed there would join that capture.
  const latest = sessions.find((s) => !s.id.startsWith("capture-"));
  useEffect(() => {
    if (id || !loaded) return;
    if (latest) go(`/assistant/${latest.id}`);
    else void create();
  }, [id, latest?.id, !!loaded]);
  useEffect(() => { setClosing(false); setPending(null); setImages([]); if (id) void load(id); }, [id]);

  const create = async () => {
    const s = await newSession();
    go(`/assistant/${s.id}`);
  };

  const patch = async (p: Partial<ChatSession>) => {
    if (!session) return;
    await db.sessions.update(session.id, { ...p, updated_at: new Date().toISOString() });
  };

  const addFiles = async (files: FileList | File[]) => {
    const picked = [...files].filter((f) => f.type.startsWith("image/")).slice(0, 4 - images.length);
    try {
      const encoded = await Promise.all(picked.map(encodeImage));
      setImages((cur) => [...cur, ...encoded].slice(0, 4));
    } catch (e) { setErr(`Could not read the image: ${e instanceof Error ? e.message : String(e)}`); }
  };

  /** One streamed turn: a message (with images) or an approval. The hub stores both sides. */
  const run = async (body: Record<string, unknown>, optimistic?: ChatMsg, spoken = false) => {
    if (!session || busy) return;
    if (!engine.client) { setErr("Hub not configured."); return; }
    setErr("");
    setBusy(true);
    setBusySince(Date.now());
    setRemote(null);
    inFlight.add(session.id);
    setPending(null);
    if (optimistic) {
      await db.sessions.update(session.id, { messages: [...session.messages, optimistic], title: session.messages.length ? session.title : optimistic.content.slice(0, 60) || "Image", updated_at: optimistic.at });
    }
    const ac = new AbortController();
    abort.current = ac;
    let meta: ChatMeta | null = null;
    let streamed = "";
    const full = { session_id: session.id, allow_cloud: session.allow_cloud, ...(session.task_type !== "auto" ? { task_type: session.task_type } : {}), ...body };
    try {
      try {
        const res = await engine.client.sse("/ai/chat/stream", { method: "POST", body: full, signal: ac.signal });
        await readSse(res, (ev) => {
          if (ev.event === "token") {
            let tok = ev.data;
            try {
              const j = JSON.parse(ev.data);
              tok = typeof j === "string" ? j : (j.token ?? j.text ?? j.delta ?? "");
            } catch {
              /* raw token */
            }
            streamed += tok;
            setPartial(streamed);
          } else if (ev.event === "tool") {
            try {
              const a = JSON.parse(ev.data) as { tool: string; ok: boolean };
              setToolStatus(toolLabel(a.tool) + (a.ok ? "" : " (failed)"));
            } catch { /* ignore */ }
          } else if (ev.event === "status") {
            try { setToolStatus((JSON.parse(ev.data) as { text: string }).text); } catch { /* ignore */ }
          } else if (ev.event === "approval") {
            try { setPending((JSON.parse(ev.data) as { action: PendingAction }).action); } catch { /* ignore */ }
          } else if (ev.event === "done") {
            meta = JSON.parse(ev.data) as ChatMeta;
          } else if (ev.event === "error") {
            let msg = ev.data;
            try { msg = (JSON.parse(ev.data) as { error?: string }).error ?? msg; } catch { /* raw */ }
            throw new Error(msg);
          }
        });
        if (!meta) throw new Error("stream ended without done");
      } catch (e) {
        if (ac.signal.aborted) throw e;
        if (!(e instanceof Error) || !/stream ended|sse \d|Failed to fetch|network/i.test(e.message)) throw e;
        // The connection dropped. If the hub already has this turn it is still answering (or has answered), so do not
        // send it twice: load() shows the reply, or the working indicator until it lands.
        const h = await engine.client.aiSession(session.id).catch(() => null);
        if (!h || h.messages.length <= session.messages.length) meta = await engine.client.chat(full) as ChatMeta;
      }
      const m = meta as ChatMeta | null;
      if (m?.pending_action) setPending(m.pending_action);
      inFlight.delete(session.id);
      await load(session.id);
      // A dictated message gets its answer spoken: the user's turn and the reply follow the messages shown before.
      const reply = m?.reply || streamed;
      if (spoken && speakReplies && reply) speak(`${session.id}:${session.messages.length + 1}`, reply);
      if (m?.procedure_id) await refetchAll([m.procedure_id]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      void load(session.id);
    } finally {
      setPartial("");
      setToolStatus("");
      setBusy(false);
      inFlight.delete(session.id);
      abort.current = null;
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!session || (!text && !images.length) || busy) return;
    if (dictation.listening) dictation.stop();
    const spoken = voiceTurn.current;
    voiceTurn.current = false;
    const imgs = images;
    setInput("");
    setImages([]);
    await run({ message: text, ...(imgs.length ? { images: imgs } : {}) }, { role: "user", content: text, at: new Date().toISOString() }, spoken);
  };

  const approve = (a: PendingAction) => run({ approve_action_id: a.id }, { role: "user", content: "Yes, run it.", at: new Date().toISOString(), approval: { action_id: a.id, host: a.host, command: a.command, status: "running" } });
  const decline = async (a: PendingAction) => {
    try { await engine.client?.cancelAction(a.id); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setPending(null);
    if (session) void load(session.id);
  };

  const ledgerEntity = ledgers[0];
  const ledger = ledgerEntity?.fields as LedgerF | undefined;
  const showLedger = !!ledgerEntity || session?.task_type === "troubleshoot";

  return (
    <div className={showLedger ? "split" : ""} style={{ gridTemplateColumns: showLedger ? "1fr 260px" : undefined }}>
      <div>
        <div className="row between" style={{ marginBottom: 10 }}>
          <div className="row">
            <select value={id ?? ""} onChange={(e) => go(`/assistant/${e.target.value}`)} style={{ width: "auto", maxWidth: 260 }} aria-label="Chat">
              {!session && <option value="">no chat</option>}
              {/* Conversations first; each capture's filing chat under its own heading, so they do not crowd them out. */}
              {sessions.filter((s) => !s.id.startsWith("capture-")).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
              {sessions.some((s) => s.id.startsWith("capture-")) && (
                <optgroup label="Captures">
                  {sessions.filter((s) => s.id.startsWith("capture-")).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title.replace(/^Capture: /, "")}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <button className="small" onClick={create} disabled={busy}>
              New chat
            </button>
            {/* Erasing every chat sits two menus deep and asks again, well away from erasing the open one. */}
            {sessions.length > 0 && (
              <Dropdown label="All chats">
                <details className="submenu">
                  <summary>Erase all chats</summary>
                  <button
                    className="small danger"
                    disabled={busy}
                    onClick={() => {
                      if (!confirm(`Erase ${chatCount(sessions.length)} on every device, with their images, command output and troubleshooting ledgers? Saved facts, runbooks and journal stay. This cannot be undone.`)) return;
                      void (async () => {
                        try {
                          await engine.client?.wipeAiSessions();
                          await db.sessions.clear();
                          go("/assistant");
                        } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
                      })();
                    }}
                  >
                    Erase {chatCount(sessions.length)}
                  </button>
                </details>
              </Dropdown>
            )}
          </div>
          {session && (
            <div className="row">
              {cloudAvailable && (
                <label className="small" style={{ margin: 0 }} title="Sends this chat to Claude in the cloud, with private details removed. Work items are never sent.">
                  <input type="checkbox" checked={session.allow_cloud} onChange={(e) => patch({ allow_cloud: e.target.checked })} /> use Claude
                </label>
              )}
              {session.messages.length > 0 && !closing && (
                <button className="small" onClick={() => setClosing(true)} title="Write fix notes, the change log and snippets from this chat">
                  Wrap up
                </button>
              )}
              <Dropdown label="This chat">
                <button
                  className="small danger"
                  disabled={busy}
                  onClick={() => {
                    if (!confirm(`Erase "${session.title}" on every device? This cannot be undone.`)) return;
                    void (async () => {
                      try { if (session.messages.length) await engine.client?.deleteAiSession(session.id); } catch { /* not on the hub yet */ }
                      await db.sessions.delete(session.id);
                      go("/assistant");
                    })();
                  }}
                >
                  Erase this chat
                </button>
              </Dropdown>
            </div>
          )}
        </div>
        {!session && (
          <div className="empty">
            No chat. <button onClick={create}>New chat</button>
          </div>
        )}
        {session && closing && <CloseDialog session={session} hosts={hostNames} projects={projects} onClose={() => setClosing(false)} />}
        {session && (
          <div className="chat">
            {session.messages.map((m, i) => (
              <div key={i} className={`msg ${m.role}`}>
                {m.role === "assistant" ? <Reply text={m.content} /> : m.content ? <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div> : null}
                {m.images?.length ? <div className="row wrap">{m.images.map((im) => <HubImage key={im} id={im} />)}</div> : null}
                {m.approval && (
                  <div className="meta">
                    {m.role === "user" ? "Approved" : "Proposed"} on {m.approval.host}: <code>{m.approval.command}</code>
                    {m.approval.status && m.approval.status !== "pending" ? ` (${m.approval.status}${m.approval.exit_code != null ? `, exit ${m.approval.exit_code}` : ""})` : ""}
                  </div>
                )}
                {m.procedure_id && (
                  <div style={{ marginTop: 8 }}>
                    <button className="small primary" onClick={() => go(`/procedures/${encodeURIComponent(m.procedure_id!)}`)}>
                      Run as procedure
                    </button>
                  </div>
                )}
                <div className="meta">
                  {m.role === "assistant" && m.content && speechSupported && localVoice && (
                    <button
                      type="button"
                      className="small ghost"
                      style={{ marginRight: 6 }}
                      onClick={() => (speaking === `${session.id}:${i}` ? stopSpeaking() : speak(`${session.id}:${i}`, m.content))}
                      aria-pressed={speaking === `${session.id}:${i}`}
                    >
                      {speaking === `${session.id}:${i}` ? "Stop reading" : "Read aloud"}
                    </button>
                  )}
                  {fmtDateTime(m.at)}
                  {m.role === "assistant" && m.model ? ` ${m.backend ?? ""} ${m.model}` : ""}
                  {m.rules_applied?.length ? ` rules ${m.rules_applied.join(", ")}` : ""}
                </div>
                {m.actions?.some((a) => a.writes) && (
                  <div className="meta">{m.actions.filter((a) => a.writes).map((a) => toolLabel(a.tool) + (a.ok ? "" : " failed")).join(", ")}</div>
                )}
              </div>
            ))}
            {partial && (
              <div className="msg assistant">
                <Reply text={partial} />
              </div>
            )}
            {busy && <Working status={toolStatus || (partial ? "Writing" : "Thinking")} since={busySince} />}
            {!busy && remote && <Working status={remote.status || (remote.tool ? toolLabel(remote.tool) : "Thinking")} since={Date.parse(remote.since)} />}
            {pending && !busy && <ApprovalCard action={pending} busy={busy} onRun={() => void approve(pending)} onCancel={() => void decline(pending)} />}
            {err && <div className="error">{err}</div>}
            {images.length > 0 && (
              <div className="row wrap">
                {images.map((src, i) => (
                  <span key={i} className="thumb">
                    <img src={src} alt={`attachment ${i + 1}`} className="chat-image" />
                    <button className="small ghost" onClick={() => setImages((cur) => cur.filter((_, j) => j !== i))} aria-label={`Remove image ${i + 1}`}>x</button>
                  </span>
                ))}
              </div>
            )}
            <form
              className="row top"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files); }}
            >
              <textarea
                className="grow"
                rows={3}
                value={dictation.listening && dictation.interim ? `${input}${input ? " " : ""}${dictation.interim}` : input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.some((f) => f.type.startsWith("image/"))) { e.preventDefault(); void addFiles(files); } }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={dictation.listening ? "Listening. Tap Stop when you are done." : "Message. Ctrl+Enter sends. Paste or drop a screenshot to attach it."}
                aria-label="Message"
              />
              <div className="col">
                <button className="primary" type="submit" disabled={busy || !!remote || (!input.trim() && !images.length)} aria-busy={busy || !!remote}>
                  {busy || remote ? <><span className="spinner" aria-hidden="true" /> Working</> : "Send"}
                </button>
                {imagesOk && (
                  <>
                    <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }} />
                    <button type="button" className="small" onClick={() => fileRef.current?.click()} disabled={images.length >= 4} aria-label="Attach image">
                      Image
                    </button>
                <button type="button" className="small" onClick={() => { sessionStorage.removeItem("ea.imageRef"); window.location.hash = "/images"; }} aria-label="Create image">Create image</button>
                  </>
                )}
                {talkOk && (
                  <button type="button" className={`small${dictation.listening ? " danger" : ""}`} onClick={() => { if (dictation.listening) dictation.stop(); else { stopSpeaking(); dictation.start(); } }} aria-pressed={dictation.listening}>
                    {dictation.listening ? "Stop" : "Talk"}
                  </button>
                )}
                {talkOk && speechSupported && localVoice && (
                  <label className="small" style={{ margin: 0 }} title="When you talk to it, the answer is read out">
                    <input type="checkbox" checked={speakReplies} onChange={(e) => { setSpeakReplies(e.target.checked); setSpeakVoiceReplies(e.target.checked); if (!e.target.checked) stopSpeaking(); }} /> speak answers
                  </label>
                )}
                {talkOk && speechSupported && !localVoice && <span className="small muted">{NO_LOCAL_VOICE}</span>}
                {dictation.error && <span className="small error">{dictation.error}</span>}
                {busy && (
                  <button type="button" className="small" onClick={() => abort.current?.abort()}>
                    Stop
                  </button>
                )}
              </div>
              <DictationNotice d={dictation} />
            </form>
          </div>
        )}
      </div>
      {showLedger && (
        <aside className="side card">
          <h3>Ledger</h3>
          {!ledger && <div className="muted small">No ledger yet. The hub writes one when this chat turns into troubleshooting.</div>}
          {ledger && ledgerEntity && (
            <div className="small col">
              {ledger.topic && <div>{ledger.topic}</div>}
              {ledger.open === false && <span className="chip static">closed</span>}
              <div>
                <strong>Tried</strong>
                <ul style={{ paddingLeft: 16, margin: "2px 0" }}>
                  {(ledger.tried ?? []).map((t, i) => (
                    <li key={i}>
                      {t.what}: {t.result}
                    </li>
                  ))}
                </ul>
              </div>
              <LedgerLines ledger={ledgerEntity} field="ruled_out" label="Ruled out" />
              <LedgerLines ledger={ledgerEntity} field="confirmed" label="Confirmed" />
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
