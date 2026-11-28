import { createContext, Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent, type PointerEvent as RPointerEvent } from "react";
import { fixPath, mailboxKey } from "../lib/connectionProblems";
import { openExternal } from "../tauri/bridge";
import { saveBlob } from "../lib/download";
import { engine } from "../sync/engine";
import { HubError, type HubClient } from "../sync/api";
import { useEntities } from "../sync/hooks";
import type { Entity } from "@everythingapp/shared";
import { completeTask, snoozeReminder } from "../sync/actions";
import { usePoll } from "../lib/usePoll";
import { useModules } from "../lib/modules";
import { plainError } from "../lib/errors";
import { fmtDateTime } from "../lib/time";
import {
  blockUndo,
  bundleClass,
  bundleRow,
  CARD_ICON,
  swipeAction,
  swipeLock,
  cardTime,
  tripDates,
  tripsOf,
  type Trip,
  cardLine,
  cardLink,
  type MailCard,
  type SearchHit,
  selectAll,
  type FoldNote,
  foldedLines,
  type UnsubscribeOptions,
  httpsLink,
  type MailAddress,
  whereLabel,
  type MailDraft,
  draftRequest,
  type DraftFor,
  DRAFT_FILES_BYTES,
  DRAFT_FILES_MAX,
  type FolderMail,
  type MailFolder,
  type MailMailbox,
  type MoveTarget,
  type MailAttachment,
  fileSize,
  previewSrc,
  riskyFile,
  FOLDER_ICONS,
  folderActs,
  folderCount,
  folderLabel,
  folderRow,
  folderWho,
  flatScreen,
  type FlatScreen,
  fromChoice,
  bundleOf,
  deliveryAt,
  dueReminders,
  type DueReminder,
  checkFrameLinks,
  frameClick,
  givesFocusBack,
  hitRow,
  inboxAt,
  inboxPlace,
  inboxScreen,
  type InboxScreen,
  inboxSections,
  initials,
  inProvider,
  isUnread,
  keyFocus,
  keyTarget,
  logoSrc,
  MAIL_KEYS,
  mailApp,
  mailboxOf,
  readOnlyBox,
  writableBoxes,
  folderGroups,
  askBeforeLeaving,
  mailKeyAction,
  type MailKey,
  matches,
  moveFolders,
  nameHidesAddress,
  personLabel,
  reminderRow,
  rowKind,
  rowTakes,
  screenRows,
  sendersLine,
  type ShownList,
  shownBundles,
  snoozeChoices,
  SNOOZE_DEFAULTS,
  textParts,
  threadRows,
  threadToFollow,
  triageRow,
  viewMessages,
  whenLabel,
  WRITING_BOX,
  canSend,
  outboxFace,
  outboxLine,
  previewNote,
  SEND_TEXTS,
  UNSUBSCRIBE_TEXTS,
  unsubscribeNote,
  unsubscribeSent,
  writeNote,
  type OutboxItem,
  type Bundle,
  type BundleDelivery,
  type CustomBundle,
  type MailList,
  NOTIFY_DEFAULTS,
  type MailNotify,
  type MailMessage,
  type MailSummary,
  type MailThread,
  type MailView,
  type SnoozeTimes,
  QUOTE_SELECTOR,
  batches,
  OPEN_UNREAD_MAX,
  type TextPart,
} from "../lib/mail";

/**
 * Mail (module mail_inbox): the linked mailboxes' Inbox in the app's own look, with Pin, Done and Snooze. Mail grouped
 * by day, kinds of mail gathered into colored bundles, and a side list of Inbox, Snoozed, Done, the mailbox's other
 * folders and the bundles; the bar at the top takes the color of where you are. A thread (a back-and-forth, the owner's
 * replies in it) is one row, and opens in place as a card with its messages, the newest open.
 *
 * Mail is hostile input: its HTML only as the hub cleaned it, in a frame where nothing runs (MailFrame), else as text
 * with links only through textParts, which checks them; the sender's real address on every open message; and a brand's
 * logo only when iCloud verified it (the hub checks iCloud's verdict).
 */

/**
 * What the rows and cards need from the screen: the verified logos, the bundles shown, and `act`, which asks the hub to
 * do something to a mail (Pin) and then loads the list again so every row shows it.
 */
interface LookValue {
  logos: Record<string, string>; shown: Bundle[]; act: (run: (c: NonNullable<typeof engine.client>) => Promise<unknown>) => Promise<void>;
  /** Done (to Archive) or back to the Inbox, with an Undo bar afterwards. */
  move: (ids: string[], to: "done" | "inbox") => Promise<void>;
  /** Snooze until a time (with Undo), or bring back now. */
  snooze: (m: MailThread, until: Date) => Promise<void>;
  unsnooze: (m: MailThread) => Promise<void>;
  /** The open thread whose snooze choices show (a row's Snooze opens the thread with them), by its key. */
  snoozeFor: string | null; setSnoozeFor: (key: string | null) => void; openMail: (key: string) => void;
  /** The owner's snooze times, from the hub. */
  snoozeTimes: SnoozeTimes;
  /** When each bundle's mail shows in the Inbox, from the hub. */
  delivery: Record<string, BundleDelivery>;
  /** Which new mail notifies, from the hub. */
  notifyOn: MailNotify;
  /**
   * The keyboard's highlighted row, by its id (a thread's key, `bundle:<day>:<bundle>`, `rem:<task>`, `folder:<id>`,
   * `hit:<id>`), and the keys of the selected threads that are on the screen.
   */
  cursor: string | null;
  selected: Set<string>;
  /** Select or unselect a thread; `range`: everything from the last one picked (Shift-click). */
  pick: (key: string, range: boolean) => void;
  /**
   * Delete, Spam, Not spam or Move to (POST /mail/move), with an Undo bar that sends the mail `back` when it can go back
   * (null: no Undo, as for Sent and Drafts, where nothing may be moved). Undone, the hub puts the mail back as it was
   * (in the Inbox, snoozed again or done again), and the list is loaded again.
   */
  /** `undo`: this move takes back one just made, so the hub puts the mail back as it was. */
  relocate: (ids: string[], to: MoveTarget, said: string, back: MoveTarget | null, undo?: boolean) => Promise<void>;
  /** The mailboxes' other folders, for Move to. */
  folders: MailFolder[];
  /** The linked mailboxes: who keeps each one, for the screen's words and for where its mail can move. */
  boxes: MailMailbox[];
  /** The Undo bar for an action done elsewhere (a pin, a read mark, a block): its words, and what undoes it. */
  offerUndo: (text: string, run: () => Promise<void>) => void;
  /** All mail with one person (the people view), and going to a mail where it is (from a search hit). */
  showPerson: (who: MailAddress) => void;
  showInPlace: (h: SearchHit) => void;
}
const Look = createContext<LookValue>({ logos: {}, shown: [], act: async () => {}, move: async () => {}, snooze: async () => {}, unsnooze: async () => {}, snoozeFor: null, setSnoozeFor: () => {}, openMail: () => {}, snoozeTimes: SNOOZE_DEFAULTS, delivery: {}, notifyOn: NOTIFY_DEFAULTS, cursor: null, selected: new Set(), pick: () => {}, relocate: async () => {}, folders: [], boxes: [], showPerson: () => {}, showInPlace: () => {}, offerUndo: () => {} });

/** Which writing box is open: a reply to the sender (`one`) or to all, a forward, a kept draft being changed, a new mail. */
type BoxKind = "one" | "all" | "forward" | "draft" | "new";
/**
 * What a writing box holds while it is written. `touched`: the owner changed the greeting or the sign-off, so a
 * suggestion arriving later leaves it alone; `suggested`: the hub's suggestions were asked for once. For a kept draft
 * being changed: `ready` once its words are read, `html` when it has formatting from another mail app, `kept` its old
 * attachments still on it (null: not read yet). `dirty`: the owner typed words or attached a file, so Discard asks
 * first. `outbox`: the mail was sent (since 2026-11-24) and is in the hub's outbox under this id: the box shows how
 * that goes (Sending with Undo, Sent, or Not sent), and keeps what was written until it is sent, so Undo and Edit put
 * it back as it was.
 */
interface Typed {
  to: string; cc?: string; subject: string; text: string; greeting: string | null; signoff: string | null;
  touched: { greeting: boolean; signoff: boolean }; suggested: boolean; smart: string[];
  files: File[]; withTheirs: boolean; from: string;
  ready: boolean; html: boolean; kept: MailAttachment[] | null;
  dirty: boolean; outbox?: string | null;
}
const NEW_MAIL = "new";
/** The Mail screen with no mailbox linked, above Add an account (EACore Mail.noMailboxText, kept the same). */
export const NO_MAILBOX = "No mailbox is linked yet. iCloud, Gmail and other mail accounts are added in Settings, Accounts, with an app password. Their mail then shows here.";
/**
 * What is being written on the Mail screen, kept here and not in the writing box: which box is open under each mail
 * (by the mail's id; a new mail under NEW_MAIL), and what each box holds (`reply:<id>`, shared by Reply and Reply all,
 * `forward:<id>`, `draft:<id>`, NEW_MAIL). A box that closes and opens again (Reply all in place of Reply, a thread
 * closed with Esc and opened again, a list that changed under it, New mail pressed twice) shows what was typed; only
 * Save draft, a mail sent, Discard, and moving the mail it was written on (after a question) let it go. Kept while the
 * page is open, on this device only.
 *
 * `lost`: a box that went away while the owner was typing in it (the focus was in it, and none of its own buttons
 * closed it): the mail it was under, and when. The screen then shows that mail where it is now (see Mail).
 */
const WRITING: { open: Map<string, BoxKind>; typed: Map<string, Typed>; lost: { id: string; at: number } | null } = { open: new Map(), typed: new Map(), lost: null };
const WRITTEN_TO = ["reply", "forward", "draft"];
/** Whether words written to a mail (a reply, a forward, a changed draft) are not saved yet. */
const hasUnsaved = (id: string) => WRITTEN_TO.some((k) => WRITING.typed.get(`${k}:${id}`)?.dirty);
// A reload or a closed tab: the browser asks first while anything typed (to a mail, or a new mail) is not saved. Set
// once for as long as the page is open, since what is typed outlives the Mail screen (it is there again on coming back).
if (typeof window !== "undefined") window.addEventListener("beforeunload", askBeforeLeaving(() => [...WRITING.typed.values()].some((t) => t.dirty)));
/**
 * A mail the assistant wrote, opened by its card's Edit (since 2026-11-24): New mail's box filled with it, its pictures
 * as files, to send or save as a draft from there. Not marked as typed: Discard asks only once the owner changes it.
 * The Mail screen opens the box when it shows (WRITING.open).
 */
export function openNewMail(m: { from: string; to: string[]; cc: string[]; subject: string; text: string; files: { name: string; type: string; data: string }[] }): void {
  const files = m.files.map((f) => new File([Uint8Array.from(atob(f.data), (ch) => ch.charCodeAt(0))], f.name, { type: f.type }));
  WRITING.typed.set(NEW_MAIL, {
    to: m.to.join(", "), cc: m.cc.join(", "), subject: m.subject, text: m.text, greeting: null, signoff: null,
    touched: { greeting: false, signoff: false }, suggested: true, smart: [], files, withTheirs: false, from: m.from,
    ready: true, html: false, kept: [], dirty: false,
  });
  WRITING.open.set(NEW_MAIL, "new");
}
/** A mail that moved away takes what was written to it along. */
const forgetWriting = (id: string) => { for (const k of WRITTEN_TO) WRITING.typed.delete(`${k}:${id}`); WRITING.open.delete(id); };
/** The mailbox a new mail went from last time, remembered on this device. */
const FROM_KEY = "ea.mail.from";

/** A folder's kept mail (GET /mail/folders/:key): fetched when the folder shows, and again with each list (`stamp`). */
function useFolderMail(key: string | undefined, stamp: unknown): { mails: FolderMail[] | null; err: string } {
  const [state, setState] = useState<{ key: string; mails: FolderMail[] | null; err: string }>({ key: "", mails: null, err: "" });
  useEffect(() => {
    if (!key) return;
    let live = true;
    engine.client?.mailFolder(key).then((r) => { if (live) setState({ key, mails: r.messages, err: "" }); }).catch((e) => { if (live) setState((s) => ({ key, mails: s.key === key ? s.mails : null, err: plainError(e) })); });
    return () => { live = false; };
  }, [key, stamp]);
  // Another folder's mail is never this folder's.
  return key && state.key === key ? state : { mails: null, err: "" };
}

/**
 * Search hits from the hub (GET /mail/search): every kept mail with the search's words, or all mail with one person.
 * Asked a moment after the search stops changing, and again with each list (`stamp`); not at all while not `wanted`.
 */
function useHits(q: string, person: string, stamp: unknown, wanted: boolean): { hits: SearchHit[] | null; err: string } {
  const [state, setState] = useState<{ person: string; hits: SearchHit[] | null; err: string }>({ person: "", hits: null, err: "" });
  useEffect(() => {
    if (!wanted) { setState((s) => (s.hits || s.err ? { person: "", hits: null, err: "" } : s)); return; }
    let live = true;
    const t = setTimeout(() => {
      // One row a mail: a mail the hub lists twice is one hit here, so every row has its own id for the keys.
      engine.client?.mailSearch(q, person).then((r) => { if (live) setState({ person, hits: r.hits.filter((h, i) => r.hits.findIndex((x) => x.id === h.id) === i), err: "" }); }).catch((e) => { if (live) setState((s) => ({ person, hits: s.person === person ? s.hits : null, err: plainError(e) })); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [q, person, stamp, wanted]);
  // One person's mail is never another's, and a search no longer shown has no hits.
  return wanted && state.person === person ? state : { hits: null, err: "" };
}

export function Mail() {
  const list = usePoll((c) => c.mailList(), 60_000);
  const { on } = useModules();
  const [view, setView] = useState<MailView>("inbox");
  const [q, setQ] = useState("");
  const [pinnedOnly, setPinnedOnly] = useState(false);
  // The open mail, by its row's id (a thread's key, a folder's mail, a search hit): one at a time.
  const [open, setOpen] = useState<string | null>(null);
  const [openBundles, setOpenBundles] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState(false);
  const shown = shownBundles(on, list.data?.custom_bundles ?? []);
  const boxes = list.data?.mailboxes ?? [];
  // A bundle of the owner's being made ("new") or changed, shown in place of the list.
  const [editing, setEditing] = useState<CustomBundle | "new" | null>(null);
  const folder = view.startsWith("f:") ? list.data?.folders?.find((f) => f.key === view.slice(2)) : undefined;
  // A view of a bundle whose module was switched off, or of a folder that is gone, goes back to the Inbox.
  useEffect(() => {
    if (view.startsWith("b:") && !shown.some((b) => b.id === view.slice(2))) setView("inbox");
    if (view.startsWith("f:") && list.data && !folder) setView("inbox");
  }, [view, shown, list.data, folder]);

  const threads = useMemo(() => threadRows(list.data?.messages ?? []), [list.data]);
  const byKey = useMemo(() => new Map(threads.map((t) => [t.key, t])), [threads]);
  // The owner's reminders that are due, among the mail in the Inbox (tasks are on every device already).
  const tasks = useEntities("task");
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setClock(Date.now()), 60_000); return () => clearInterval(t); }, []);
  const reminders = useMemo(() => dueReminders(tasks, new Date(clock)), [tasks, clock]);
  const [remindFor, setRemindFor] = useState<string | null>(null);
  const delivery = list.data?.bundle_delivery ?? {};
  // Search: a thread shows when any of its messages has every word.
  const searching = !!q.trim();
  const messages = useMemo(() => (q.trim() ? threads.filter((t) => t.members.some((m) => matches(m, q))) : threads), [threads, q]);
  // The people view: all mail with one person, in the list's place until closed or another view is chosen.
  const [person, setPerson] = useState<MailAddress | null>(null);
  // A folder lists its mail 100 at a time.
  const [folderShown, setFolderShown] = useState(100);
  const go = (v: MailView) => { setView(v); setOpen(null); setMenu(false); setSelected(new Set()); setCursor(null); setPerson(null); setFolderShown(100); };
  // Keyboard and selection: the highlighted row, the selected threads, the "?" list, Snooze for several.
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [help, setHelp] = useState(false);
  // New mail's writing box: open again when it was open the last time the screen showed.
  const [composing, setComposing] = useState(() => WRITING.open.has(NEW_MAIL));
  const newMailPressed = useRef(false);
  const setNewMail = (on: boolean) => { newMailPressed.current = true; if (on) WRITING.open.set(NEW_MAIL, "new"); else WRITING.open.delete(NEW_MAIL); setComposing(on); };
  // The phone layout's search: a button that opens a search field across the bar (open while a search is typed).
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = () => { setSearchOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); };
  const closeSearch = () => { setQ(""); setSearchOpen(false); };
  const [multiSnooze, setMultiSnooze] = useState(false);
  const anchor = useRef<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Refresh, in the top bar: its result shows at the top of the list for a few seconds.
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!refreshMsg) return;
    const t = setTimeout(() => setRefreshMsg(null), 6000);
    return () => clearTimeout(t);
  }, [refreshMsg]);
  const refresh = async () => {
    const client = engine.client;
    if (!client) return;
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const r = await client.mailRefresh();
      const kept = r.mailboxes.reduce((n, m) => n + ("kept" in m ? m.kept : 0), 0);
      const failed = r.mailboxes.filter((m) => "error" in m).length;
      setRefreshMsg(failed ? { ok: false, text: `${failed === 1 ? "A mailbox" : `${failed} mailboxes`} could not be refreshed. The i at the bottom of the side list has why.` } : { ok: true, text: kept ? `${kept} new.` : "Nothing new." });
      await list.reload();
    } catch (e) {
      setRefreshMsg({ ok: false, text: plainError(e) });
    } finally {
      setRefreshing(false);
    }
  };
  // While the hub's model sorts new mail and the Inbox is on the screen, the list is asked for again every 4 seconds,
  // so Needs you fills in and the count goes down; the timer stops with the run, and when the screen closes.
  const sorting = list.data?.triage !== false && !!list.data?.triage_state?.running && view === "inbox" && !person && !editing;
  const reload = list.reload;
  useEffect(() => {
    if (!sorting) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") void reload(); }, 4000);
    return () => clearInterval(t);
  }, [sorting, reload]);
  const toggleBundle = (id: string) => setOpenBundles((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const here = view.startsWith("b:") ? shown.find((b) => b.id === view.slice(2)) : null;
  /** Pinned only works in the Inbox and in each bundle (2026-11-22): there it keeps only the bundle's pinned mail. */
  const pinnable = view === "inbox" || !!here;
  /** A view's mail as listed, with Pinned only applied in a bundle. */
  const viewed = (all: MailThread[]) => (here && pinnedOnly ? all.filter((m) => m.pinned) : all);
  const title = folder ? folderLabel(folder) : here?.name ?? (view === "snoozed" ? "Snoozed" : view === "done" ? "Done" : "Inbox");
  const barClass = folder ? "v-folder" : here ? bundleClass(here) : `v-${view}`;

  const [actErr, setActErr] = useState("");
  // The last Done or Sweep, for its Undo bar (gone after a few seconds, or with the next one).
  const [undo, setUndo] = useState<{ text: string; run: () => Promise<void> } | null>(null);
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 10_000);
    return () => clearTimeout(t);
  }, [undo]);

  // What the list shows now. A folder's mail and the search's hits are fetched here, not by their lists, and every
  // list is drawn from `shownList`: the rows the keys walk (`rows`) are then exactly the rows on the screen.
  const loaded = !!list.data?.mailboxes.length;
  const folderMail = useFolderMail(folder?.key, list.data);
  const everywhere = loaded && !person && !editing && q.trim().length >= 3;
  const found = useHits(person ? "" : q.trim(), person?.address ?? "", list.data, loaded && (!!person || everywhere));
  const folderHits = folderMail.mails && !folderMail.err ? (searching ? folderMail.mails.filter((m) => matches(m, q)) : folderMail.mails) : [];
  const folderList = folderHits.slice(0, folderShown);
  const flatMails = viewed(viewMessages(messages, view, shown));
  const shownList: ShownList = !loaded || editing || person ? { kind: "none" }
    : folder ? { kind: "folder", mails: folderList }
    : view === "inbox" ? { kind: "inbox", inbox: inboxScreen(messages, shown, { pinnedOnly, searching, reminders, delivery }), openBundles }
    : { kind: "flat", flat: flatScreen(flatMails, here?.id ?? null) };
  const rows = screenRows(shownList, found.err ? [] : found.hits ?? []);
  const rowsKey = rows.join("\n");
  const move: LookValue["move"] = async (ids, to) => {
    const c = engine.client;
    if (!c || !ids.length) return;
    setActErr("");
    try {
      // A selection of any size: the hub takes 500 at a time.
      const r: { moved: string[]; error?: string } = { moved: [] };
      for (const part of batches(ids)) {
        const one = to === "done" ? await c.mailDone(part) : await c.mailUndo(part);
        r.moved.push(...one.moved);
        if (one.error) { r.error = one.error; break; }
      }
      if (r.error) setActErr(r.error);
      if (r.moved.length && to === "done") {
        const ids2 = r.moved;
        setUndo({ text: r.moved.length === 1 ? "Marked done" : `${r.moved.length} marked done`, run: () => move(ids2, "inbox") });
      } else if (to === "inbox") setUndo(null);
    } catch (e) { setActErr(plainError(e)); }
    await list.reload();
  };
  const relocate: LookValue["relocate"] = async (ids, to, said, back, undo = false) => {
    const c = engine.client;
    if (!c || !ids.length) return;
    // Words written under one of them, or under another mail of its thread (a reply, a forward), cannot follow the
    // mail to where it goes: ask first.
    const written = ids.flatMap((id) => threads.find((t) => t.members.some((m) => m.id === id))?.members.map((m) => m.id) ?? [id]).filter(hasUnsaved);
    if (written.length && !window.confirm("What you wrote here is not saved to Drafts. Move the mail and discard what you wrote?")) return;
    setActErr("");
    try {
      const moved: string[] = [];
      const kept: string[] = [];
      let error: string | undefined;
      for (const part of batches(ids)) {
        const one = await c.mailMove(part, to, undo);
        moved.push(...one.moved);
        kept.push(...one.moved.map((id) => one.to[id]).filter((x): x is string => !!x));
        if (one.error) { error = one.error; break; }
      }
      if (error) setActErr(error);
      if (moved.length) {
        written.forEach(forgetWriting);
        setSelected(new Set());
        // Undo only where the mail can go back, and only for mail the hub knows the new place of. The hub puts each
        // one back as it was (in the Inbox, snoozed again or done again); the list loaded below shows where.
        if (back && kept.length) setUndo({ text: moved.length === 1 ? said : `${moved.length} ${said.charAt(0).toLowerCase()}${said.slice(1)}`, run: () => relocate(kept, back, "Moved back", null, true) });
        else setUndo(null);
      }
    } catch (e) { setActErr(plainError(e)); }
    await list.reload();
  };
  const unsnooze: LookValue["unsnooze"] = async (m) => {
    setActErr("");
    try { await engine.client?.mailUnsnooze(m.id); } catch (e) { setActErr(plainError(e)); }
    setSnoozeFor(null);
    await list.reload();
  };
  const snooze: LookValue["snooze"] = async (m, until) => {
    const c = engine.client;
    if (!c) return;
    setActErr("");
    try {
      await c.mailSnooze(m.id, until.toISOString());
      setSnoozeFor(null);
      // Closed here: a thread snoozed until later today stays on the screen (Back later today).
      setOpen((x) => (x === m.key ? null : x));
      setUndo({ text: `Snoozed until ${until.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`, run: () => unsnooze(m) });
    } catch (e) { setActErr(plainError(e)); }
    await list.reload();
  };
  const act: LookValue["act"] = async (run) => {
    if (!engine.client) return;
    setActErr("");
    try { await run(engine.client); } catch (e) { setActErr(plainError(e)); }
    await list.reload();
  };

  // The threads shown now, for Select all: the rows in sight (a closed bundle's mail is not).
  const shownIds = rows.filter((id) => rowKind(id) === "thread");
  // The selection: only threads that are on the screen (one that left it is let go above).
  const chosen = shownIds.filter((id) => selected.has(id)).map((id) => byKey.get(id)).filter((t): t is MailThread => !!t);
  const picked = new Set(chosen.map((t) => t.key));
  const selAll = selectAll(shownIds, picked);
  const pick: LookValue["pick"] = (key, range) => {
    setSelected((s) => {
      const n = new Set(s);
      const from = anchor.current ? rows.indexOf(anchor.current) : -1;
      const to = rows.indexOf(key);
      if (range && from >= 0 && to >= 0) {
        for (const x of rows.slice(Math.min(from, to), Math.max(from, to) + 1)) if (rowKind(x) === "thread") n.add(x);
      } else if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
    anchor.current = key;
  };
  const doneAll = async (ts: MailThread[]) => {
    const back = ts.every((t) => t.state === "done");
    await move(ts.flatMap((t) => (back ? t.ids.done : t.ids.open)), back ? "inbox" : "done");
    setSelected(new Set());
  };
  const pinAll = (ts: MailThread[]) => {
    const to = !ts.every((t) => t.pinned);
    const was = ts.map((t) => [t.id, t.pinned] as const);
    void act(async (c) => { for (const t of ts) await c.mailPin(t.id, to); });
    setUndo({ text: ts.length === 1 ? (to ? "Pinned" : "Unpinned") : `${ts.length} ${to ? "pinned" : "unpinned"}`, run: () => act(async (c) => { for (const [id, p] of was) if (p !== to) await c.mailPin(id, p); }) });
  };
  const readAll = (ts: MailThread[], read: boolean) => {
    if (!read && open && ts.some((t) => t.key === open)) setOpen(null);
    const ids = ts.flatMap((t) => (read ? t.ids.unread : [t.id]));
    if (!ids.length) return;
    void act(async (c) => { for (const part of batches(ids)) await c.mailSeenMany(part, read); });
    // Undo: the same mail marked back (those that were unread, or the ones just marked unread).
    setUndo({ text: `${ts.length === 1 ? "Marked" : `${ts.length} marked`} ${read ? "read" : "unread"}`, run: () => act(async (c) => { for (const part of batches(ids)) await c.mailSeenMany(part, !read); }) });
  };
  const snoozeAll = async (ts: MailThread[], until: Date) => {
    const c = engine.client;
    if (!c) return;
    setActErr("");
    try { for (const t of ts) await c.mailSnooze(t.id, until.toISOString()); } catch (e) { setActErr(plainError(e)); }
    setUndo({ text: `${ts.length} snoozed until ${until.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`, run: async () => { for (const t of ts) await engine.client?.mailUnsnooze(t.id); await list.reload(); } });
    setSelected(new Set());
    setMultiSnooze(false);
    await list.reload();
  };

  // A mail opened from somewhere else on the screen (Needs you, a search hit) is brought into view.
  const [reveal, setReveal] = useState<string | null>(null);
  useEffect(() => {
    if (!reveal) return;
    document.querySelector(`[data-nav="${CSS.escape(reveal)}"]`)?.scrollIntoView({ block: "start" });
    setReveal(null);
  }, [reveal]);
  /**
   * Open a thread where it is listed, and bring it into view: in Snoozed or Done; in the Inbox, with the bundle's row
   * it is inside opened first; or, when its bundle holds it back from the Inbox, in that bundle's own view.
   */
  const showThread = (t: MailThread) => {
    setPerson(null); setQ(""); setSearchOpen(false); setEditing(null); setPinnedOnly(false); setMenu(false); setSelected(new Set()); setCursor(null);
    if (t.state !== "inbox") setView(t.state === "snoozed" ? "snoozed" : "done");
    else {
      const place = inboxPlace(inboxSections(threads, shown, { delivery }), t.key);
      if (place?.row) { const row = place.row; setOpenBundles((s) => new Set(s).add(row)); }
      setView(place || !t.bundle ? "inbox" : (`b:${t.bundle}` as MailView));
    }
    setOpen(t.key);
    setReveal(t.key);
  };

  // What left the screen is let go: an open mail closes, and the highlight, the snooze choices and the selection come
  // off it. (A thread keeps its key while mail comes and goes in it: without this, a thread marked done would open by
  // itself, and be marked read, when new mail brought it back.)
  useEffect(() => {
    const on = new Set(rowsKey ? rowsKey.split("\n") : []);
    // One exception: a thread that left the list by itself while the owner was typing in it (new mail brought it back
    // from Snoozed or Done, or put it in another day's bundle) is shown where it is now, and its writing box takes the
    // focus again. Otherwise the typing would go on as the list's keys.
    const follow = threadToFollow(open, rows, WRITING.lost, byKey);
    WRITING.lost = null;
    if (follow) { showThread(follow); return; }
    setOpen((x) => (x && !on.has(x) ? null : x));
    setCursor((x) => (x && !on.has(x) ? null : x));
    setSnoozeFor((x) => (x && !on.has(x) ? null : x));
    setSelected((s) => ([...s].every((k) => on.has(k)) ? s : new Set([...s].filter((k) => on.has(k)))));
  }, [rowsKey, open, cursor, snoozeFor]);

  // The keys, before the app's own one-letter keys (this listens first, in the capture phase, and keeps the keys it uses).
  const onKey = (a: MailKey, target: EventTarget | null): boolean => {
    // The highlighted row, only while it is on the screen.
    const at = cursor ? rows.indexOf(cursor) : -1;
    const on = at >= 0 ? cursor : null;
    const moveTo = (i: number, extend: boolean) => {
      const next = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!next) return;
      if (extend) setSelected((s) => new Set([...s, ...[on, next].filter((x): x is string => !!x && rowKind(x) === "thread")]));
      setCursor(next);
    };
    switch (a) {
      case "escape": {
        // Out of a field or a writing box first (what was typed stays); then whatever is open closes.
        const focus = keyFocus(target);
        if (focus === "field" || focus === "writing") { (target as HTMLElement).blur(); return true; }
        if (help) { setHelp(false); return true; }
        if (multiSnooze) { setMultiSnooze(false); return true; }
        if (snoozeFor) { setSnoozeFor(null); return true; }
        if (open) { setOpen(null); return true; }
        if (selected.size) { setSelected(new Set()); return true; }
        return false;
      }
      case "down": case "extend-down": moveTo(at < 0 ? 0 : at + 1, a === "extend-down"); return true;
      case "up": case "extend-up": moveTo(at < 0 ? 0 : at - 1, a === "extend-up"); return true;
      case "open": {
        if (!on) return false;
        const kind = rowKind(on);
        if (kind === "reminder") window.location.hash = `#/tasks?focus=${encodeURIComponent(on.slice(4))}`;
        else if (kind === "bundle") toggleBundle(on.slice(7));
        else setOpen(open === on ? null : on);
        return true;
      }
      case "select": if (!on || rowKind(on) !== "thread") return false; pick(on, false); return true;
      case "search": searchRef.current?.focus(); return true;
      case "help": setHelp((h) => !h); return true;
    }
    // D, S, P, U, R, Delete and !: on the selection, else the open mail, else the highlighted row, and only on what
    // is on the screen. With nothing to act on, the key is left to the rest of the app.
    const ids = keyTarget(rows, { selected, open, cursor });
    if (!ids.length) return false;
    const kind = rowKind(ids[0]);
    // The key is this row's from here on, and does nothing where its action does not apply to the row.
    if (kind === "reminder") {
      // A reminder row: D marks its task done, S shows its snooze choices.
      const r = tasks.find((t) => t.id === ids[0].slice(4));
      if (r && a === "done") void completeTask(r);
      else if (r && a === "snooze") setRemindFor(remindFor === r.id ? null : r.id);
      return true;
    }
    if (kind === "folder") {
      // A folder's mail: Delete, where the folder's own Delete button has an Undo.
      const m = folder && folderMail.mails?.find((x) => folderRow(x.id) === ids[0]);
      if (m && folder && rowTakes(kind, a, folder.role)) void relocate([m.id], "trash", "Moved to Trash", folder.role === "own" ? folder.key : folder.role);
      return true;
    }
    const ts = ids.map((id) => byKey.get(id)).filter((t): t is MailThread => !!t);
    if (!ts.length || !rowTakes(kind, a)) return true;
    if (a === "done") void doneAll(ts);
    else if (a === "pin") pinAll(ts);
    else if (a === "read" || a === "unread") readAll(ts, a === "read");
    else if (a === "delete") void relocate(ts.flatMap(threadIds), "trash", "Moved to Trash", "inbox");
    else if (a === "spam") void relocate(ts.flatMap(threadIds), "junk", "Moved to Spam", "inbox");
    else if (a === "snooze") {
      // Done mail is not snoozed.
      const can = ts.filter((t) => t.state !== "done");
      if (can.length > 1) setMultiSnooze(true);
      else if (can.length) { setOpen(can[0].key); setSnoozeFor(can[0].key); }
    }
    return true;
  };
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!window.matchMedia("(min-width: 768px)").matches) return;
      // A key pressed in a field, in a writing box or on a button, link or menu is that control's own: only Escape acts there.
      const a = mailKeyAction(e, keyFocus(e.target));
      if (a && keyRef.current(a, e.target)) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);
  // The highlighted row stays in view.
  useEffect(() => {
    if (cursor) document.querySelector(`[data-nav="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  // A button clicked with the mouse gives the focus back, so the list's keys go on working after a click
  // (givesFocusBack); a writing box's buttons send the focus to its text instead.
  const release = (e: RMouseEvent) => {
    const b = e.target instanceof Element ? e.target.closest("button") : null;
    if (b && b === document.activeElement && givesFocusBack(e.detail, b)) b.blur();
  };
  const sort = shownList.kind === "inbox" && !searching && !pinnedOnly ? triageRow(list.data?.triage, list.data?.triage_state) : null;

  return (
    <Look.Provider value={{ logos: list.data?.logos ?? {}, shown, act, move, snooze, unsnooze, snoozeFor, setSnoozeFor, openMail: (key) => setOpen(key), relocate, folders: list.data?.folders ?? [], boxes, offerUndo: (text, run) => setUndo({ text, run }), showPerson: (who) => { setPerson(who); setOpen(null); setMenu(false); setSelected(new Set()); setCursor(null); }, showInPlace: (h) => { const t = threads.find((x) => x.members.some((m) => m.id === h.id)); if (t) showThread(t); }, snoozeTimes: list.data?.snooze_times ?? SNOOZE_DEFAULTS, delivery, notifyOn: list.data?.mail_notify ?? NOTIFY_DEFAULTS, cursor, selected: picked, pick }}>
    <div className={`mailx${menu ? " menu-open" : ""}${chosen.length ? " selecting" : ""}`} onClick={release}>
      <div className={`mailx-bar ${barClass}${chosen.length ? " selecting" : ""}${searchOpen || q ? " search-open" : ""}`}>
        <div className="mailx-bar-left">
        <button type="button" className="mailx-menu" aria-label="Show Inbox, Snoozed, Done and the bundles" aria-expanded={menu} onClick={() => setMenu((x) => !x)}>
          <Icon name="menu" />
        </button>
        {/* The view's name stays in sight while mail is selected, the selection's actions after it. */}
        <h1 title={title}>{title}</h1>
        {!!chosen.length && (
          <div className="mailx-selbar" role="toolbar" aria-label="Selected mail">
            <button type="button" className="mailx-selall" role="checkbox" aria-checked={selAll.state === "all" ? true : "mixed"} aria-label={selAll.state === "all" ? "Select none" : `Select all shown (${shownIds.length})`} title={selAll.state === "all" ? "Select none" : `Select all shown (${shownIds.length})`} onClick={() => { setSelected(selAll.next); if (!selAll.next.size) setMultiSnooze(false); }}>
              <Icon name={selAll.state === "all" ? "check" : "minus"} />
            </button>
            <span className="mailx-selcount">{chosen.length} selected</span>
            <button type="button" onClick={() => void doneAll(chosen)}><Icon name={view === "done" ? "inbox" : "check"} /><span>{view === "done" ? "Move to Inbox" : "Done"}</span></button>
            {view !== "done" && <button type="button" onClick={() => setMultiSnooze((x) => !x)}><Icon name="clock" /><span>Snooze</span></button>}
            <button type="button" onClick={() => pinAll(chosen)}><Icon name="pin" /><span>{chosen.every((t) => t.pinned) ? "Unpin" : "Pin"}</span></button>
            <button type="button" onClick={() => readAll(chosen, true)}><span>Mark read</span></button>
            <button type="button" onClick={() => readAll(chosen, false)}><span>Mark unread</span></button>
            <button type="button" onClick={() => void relocate(chosen.flatMap(threadIds), "trash", "Moved to Trash", "inbox")}><Icon name="trash" /><span>Delete</span></button>
            <button type="button" onClick={() => void relocate(chosen.flatMap(threadIds), "junk", "Moved to Spam", "inbox")}><Icon name="spam" /><span>Spam</span></button>
            <button type="button" className="mailx-selclear" onClick={() => { setSelected(new Set()); setMultiSnooze(false); }} aria-label="Clear the selection">✕</button>
          </div>
        )}
        </div>
        {!chosen.length && (
          <div className="mailx-bar-mid">
            <button type="button" className={`mailx-refresh${refreshing ? " busy" : ""}`} aria-label={refreshing ? "Refreshing" : "Refresh"} title="Refresh" disabled={refreshing || !engine.client} onClick={() => void refresh()}>
              <Icon name="refresh" />
            </button>
            <button type="button" className="mailx-search-btn" aria-label="Search mail" title="Search mail" onClick={openSearch}><Icon name="search" /></button>
            <input ref={searchRef} type="search" className="mailx-search" placeholder="Search mail" aria-label="Search mail" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => { if (!q) setSearchOpen(false); }} />
            <button type="button" className="mailx-search-close" aria-label="Close the search" title="Close the search" onClick={closeSearch}>✕</button>
            {/* The Inbox and each bundle have it; elsewhere an unseen stand-in of its size keeps the search box in the same place. */}
            <button type="button" className={`mailx-switch${pinnable ? "" : " placeholder"}`} aria-pressed={pinnedOnly} aria-label="Pinned only" title="Pinned only" aria-hidden={!pinnable || undefined} tabIndex={pinnable ? undefined : -1} onClick={() => setPinnedOnly((x) => !x)}>
              <span className="sw" aria-hidden="true"><span className="knob"><Icon name="pin" /></span></span>
            </button>
          </div>
        )}
        {!chosen.length && (
          <div className="mailx-bar-right">
            {writableBoxes(boxes).length > 0 && <button type="button" className="mailx-compose-btn" aria-expanded={composing} onClick={() => setNewMail(!composing)} title={writableBoxes(boxes).some(canSend) ? "Write a new mail, to send or save as a draft" : "Write a new mail, saved to Drafts in your mailbox"}><Icon name="pencil" /><span>New mail</span></button>}
          </div>
        )}
      </div>
      <div className="mailx-body">
        <nav className="mailx-rail" aria-label="Mail views">
          <Nav view="inbox" current={view} go={go} icon="inbox" label="Inbox" count={threads.filter((m) => m.state === "inbox" && isUnread(m) && inboxAt(m, shown, delivery)).length} />
          <Nav view="snoozed" current={view} go={go} icon="clock" label="Snoozed" count={threads.filter((m) => m.state === "snoozed").length} />
          <Nav view="done" current={view} go={go} icon="check" label="Done" />
          {/* The other folders, between Done and the bundles: Drafts, Sent, Spam, Trash, then the owner's own. */}
          {boxes.length > 1
            ? folderGroups(list.data?.folders ?? [], boxes).map((g) => (
              <div key={g.email} className="mailx-group" role="group" aria-label={`Folders of ${g.email}`}>
                <div className="mailx-label box" title={g.email}>{g.email}</div>
                {g.folders.map((f) => <FolderNav key={f.key} f={f} current={view} go={go} many />)}
              </div>
            ))
            : (list.data?.folders ?? []).map((f) => <FolderNav key={f.key} f={f} current={view} go={go} many={false} />)}
          <div className="mailx-label">Bundles</div>
          {shown.filter((b) => !b.module && b.custom === undefined).map((b) => <BundleNav key={b.id} b={b} current={view} go={(v) => { setEditing(null); go(v); }} threads={threads} />)}
          {shown.some((b) => b.module) && <div className="mailx-label">From your modules</div>}
          {shown.filter((b) => b.module).map((b) => <BundleNav key={b.id} b={b} current={view} go={(v) => { setEditing(null); go(v); }} threads={threads} />)}
          <div className="mailx-label">Your bundles</div>
          {shown.filter((b) => b.custom !== undefined).map((b) => <BundleNav key={b.id} b={b} current={view} go={(v) => { setEditing(null); go(v); }} threads={threads} />)}
          <button type="button" className="mailx-nav mailx-newbundle" onClick={() => { setEditing("new"); setMenu(false); }}><span className="ico"><Icon name="plus" /></span>New bundle</button>
          {list.data && <Mailboxes data={list.data} showKeys={() => setHelp(true)} />}
        </nav>
        {menu && <div className="mailx-scrim" onClick={() => setMenu(false)} aria-hidden="true" />}
        <div className="mailx-main">
          {actErr && <div className="error mailx-acterr" role="alert">{actErr}</div>}
          <SignInStopped boxes={list.data?.mailboxes ?? []} />
          <OutboxNotices items={list.data?.outbox ?? []} composing={composing} />
          {/* Open from before the screen showed, it does not take the focus (on a phone that would raise the keyboard). */}
          {composing && <Composer focus={newMailPressed.current} close={() => setNewMail(false)} />}
          {refreshMsg && <div className={`small mailx-refreshmsg ${refreshMsg.ok ? "ok" : "error"}`} role="status">{refreshMsg.text}</div>}
          {help && (
            <div className="mailx-help" role="dialog" aria-label="Keyboard keys">
              <b>Keyboard keys</b>
              <dl>{MAIL_KEYS.map((k) => <Fragment key={k.keys}><dt>{k.keys}</dt><dd>{k.does}</dd></Fragment>)}</dl>
              <button type="button" className="link" onClick={() => setHelp(false)}>Close</button>
            </div>
          )}
          {multiSnooze && chosen.length > 0 && <MultiSnooze count={chosen.length} pick={(until) => void snoozeAll(chosen.filter((t) => t.state !== "done"), until)} close={() => setMultiSnooze(false)} />}
          {!list.data && list.error ? <div className="error">{list.error}</div>
            : !list.data ? <div className="muted small">Loading</div>
            : !list.data.mailboxes.length ? (
              <div className="empty col" style={{ alignItems: "center", gap: 10 }}>
                <span>{NO_MAILBOX}</span>
                <button type="button" className="primary" onClick={() => { location.hash = "#/settings/accounts/add"; }}>Add an account</button>
              </div>
            )
            : editing
              ? <BundleForm key={editing === "new" ? "new" : editing.id} start={editing === "new" ? null : editing} close={() => setEditing(null)}
                  saved={async (id) => { setEditing(null); await list.reload(); if (id) go(`b:${id}` as MailView); else go("inbox"); }} />
            : person
              ? <HitList title={`With ${personLabel(person)}`} sub={person.address} person found={found} open={open} setOpen={setOpen} close={() => setPerson(null)} />
            : shownList.kind === "folder"
              ? folder && <FolderView f={folder} mails={folderList} loading={!folderMail.mails} err={folderMail.err} more={folderHits.length - folderList.length} showMore={() => setFolderShown((n) => n + 100)} searching={searching} open={open} setOpen={setOpen} />
            : shownList.kind === "inbox"
              ? <InboxList screen={shownList.inbox} sort={sort} tasks={tasks} remindFor={remindFor} setRemindFor={setRemindFor} pinnedOnly={pinnedOnly} open={open} setOpen={setOpen} openBundles={openBundles} toggleBundle={toggleBundle} searching={searching} waiting={!list.data.mailboxes.some((m) => m.last_refresh)} show={showThread} />
            : shownList.kind === "flat"
              ? <Flat flat={shownList.flat} messages={flatMails} view={view} bundle={here ?? null} pinnedOnly={!!here && pinnedOnly} open={open} setOpen={setOpen}
                  edit={here?.custom !== undefined ? () => setEditing(list.data?.custom_bundles?.find((c) => c.id === here.id) ?? null) : undefined} />
            : null}
          {/* Typing a search: beside the view's own matches, every kept mail's (whole texts, folders too). */}
          {everywhere && <HitList title="In all your mail" found={found} open={open} setOpen={setOpen} />}
          {list.data?.mailboxes.some((m) => m.more) && <div className="muted small mailx-hint">Bringing in more of your Inbox. The rest arrives over the next few minutes.</div>}
          {/* Last in the scrolling column: it sticks to the bottom of what is in view (styles.css), wherever the list is
              scrolled to. Above the list, it was out of sight for anything done to a mail further down. */}
          {undo && (
            <div className="mailx-undo" role="status">
              <span>{undo.text}</span>
              <button type="button" onClick={() => { const run = undo.run; setUndo(null); void run(); }}>Undo</button>
            </div>
          )}
        </div>
      </div>
    </div>
    </Look.Provider>
  );
}

function Nav({ view, current, go, icon, label, count }: { view: MailView; current: MailView; go: (v: MailView) => void; icon: string; label: string; count?: number }) {
  return (
    <button type="button" className={`mailx-nav v-${view}`} aria-current={current === view ? "page" : undefined} onClick={() => go(view)}>
      <span className="ico"><Icon name={icon} /></span>{label}{!!count && <span className="n">{count}</span>}
    </button>
  );
}

/**
 * Search hits from the hub (useHits): every kept mail with the search's words, or all mail with one person (`person`).
 * Each row says where the mail is; opened, it shows whole, with Show it in its place for the Inbox, Snoozed and Done.
 * The arrow keys walk these rows after the list's own, and Enter opens one; no other key acts on a hit.
 */
function HitList({ title, sub, person = false, found, open, setOpen, close }: { title: string; sub?: string; person?: boolean; found: { hits: SearchHit[] | null; err: string }; open: string | null; setOpen: (id: string | null) => void; close?: () => void }) {
  const { showPerson, showInPlace, cursor } = useContext(Look);
  const { hits, err } = found;
  const mineTo = (h: SearchHit) => (h.mine || h.where === "drafts") && h.to?.length;
  return (
    <section className="mailx-col mailx-hits" aria-label={title}>
      <h2 className="mailx-hits-head">
        <span>{title}{hits ? ` (${hits.length}${hits.length >= 200 ? "+" : ""})` : ""}</span>
        {sub && <span className="muted small">{sub}</span>}
        {close && <button type="button" className="link small" onClick={close}>Close</button>}
      </h2>
      {err ? <div className="error">{err}</div> : !hits ? <div className="muted small">Searching</div> : !hits.length ? <div className="muted small">Nothing found.</div> : (
        <div className="mailx-list">
          {hits.map((h) => open === hitRow(h.id) ? (
            <article key={h.id} className="mailx-card" data-nav={hitRow(h.id)}>
              <button type="button" className="mailx-card-head" onClick={() => setOpen(null)} aria-expanded="true">
                <span className="mailx-av" aria-hidden="true">{initials(h.from)}</span>
                <span className="mailx-what">
                  <span className="subject">{h.subject || "(no subject)"}</span>
                  <span className="meta"><b>{personLabel(h.from)}</b> &lt;{h.from.address}&gt; · {fmtDateTime(h.at)} · {whereLabel(h)}</span>
                </span>
              </button>
              <div className="mailx-card-acts mailx-card-pad">
                {(h.where === "inbox" || h.where === "snoozed" || h.where === "done") && <button type="button" className="mailx-act" onClick={() => showInPlace(h)}><Icon name="inbox" /><span>Show it in its place</span></button>}
                {!h.mine && !person && <button type="button" className="mailx-act" onClick={() => showPerson(h.from)}><Icon name="person" /><span>All mail with {personLabel(h.from).split(/\s+/)[0]}</span></button>}
              </div>
              <Message m={h} />
            </article>
          ) : (
            <div key={h.id} className={`mailx-item${cursor === hitRow(h.id) ? " cursor" : ""}`} data-nav={hitRow(h.id)}>
              <button type="button" className="mailx-row" onClick={() => setOpen(hitRow(h.id))}>
                <span className="mailx-dotcol" />
                <span className="mailx-av" aria-hidden="true">{initials(mineTo(h) ? h.to![0] : h.from)}</span>
                <span className="mailx-what">
                  <span className="who"><b>{mineTo(h) ? `To: ${h.to!.map(personLabel).join(", ")}` : personLabel(h.from)}</b><span className="chip">{whereLabel(h)}</span></span>
                  <span className="line"><span className="subj">{h.subject || "(no subject)"}</span>{h.snippet && <> · {h.snippet}</>}</span>
                </span>
                <span className="when">{whenLabel(h.at)}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** A folder in the side list: its icon, its name, and its drafts or unread mail. */
function FolderNav({ f, current, go, many }: { f: MailFolder; current: MailView; go: (v: MailView) => void; many: boolean }) {
  const view = `f:${f.key}` as MailView;
  const n = folderCount(f);
  return (
    // A long name is cut with an ellipsis, so the tooltip always has it whole; with several mailboxes the row stands
    // under its mailbox's address (the side list's group), which the tooltip says too.
    <button type="button" className="mailx-nav v-folder" aria-current={current === view ? "page" : undefined} title={folderLabel(f, many)} onClick={() => go(view)}>
      <span className="ico"><Icon name={FOLDER_ICONS[f.role]} /></span><span className="name">{folderLabel(f)}</span>{!!n && <span className="n">{n}</span>}
    </button>
  );
}

/**
 * One of the other folders: its kept mail, newest first, each opening as in the Inbox (its own words, the page as sent
 * without web pictures), with what its folder lets it do (FolderActions). The mail comes from the screen, which
 * fetches it again with each list and shows it 100 at a time (`more`: how many are not shown yet).
 */
function FolderView({ f, mails, loading, err, more, showMore, searching, open, setOpen }: { f: MailFolder; mails: FolderMail[]; loading: boolean; err: string; more: number; showMore: () => void; searching: boolean; open: string | null; setOpen: (id: string | null) => void }) {
  const { cursor, boxes } = useContext(Look);
  if (err) return <div className="error">{err}</div>;
  if (loading) return <div className="muted small">Loading</div>;
  if (!mails.length) return <Empty title={searching ? "No mail matches" : `Nothing in ${folderLabel(f)}`} text={f.role === "junk" ? "Mail your provider takes for spam gathers here." : "Mail in this folder shows here."} />;
  return (
    <div className="mailx-col">
      {f.role === "junk" && <div className="muted small mailx-folder-note">Your mail provider put this mail in Spam. Its pictures are never loaded, and its links may not be safe.</div>}
      {f.role === "drafts" && <div className="muted small mailx-folder-note">{canSend(mailboxOf(boxes, f.email)) ? "Edit opens a draft here, to send it or save it again." : `A draft is sent from ${mailApp(mailboxOf(boxes, f.email))}. Edit changes it here.`}</div>}
      <div className="mailx-list">
        {mails.map((m) => open === folderRow(m.id)
          ? <FolderCard key={m.id} m={m} f={f} close={() => setOpen(null)} />
          : (
            <div key={m.id} className={`mailx-item${cursor === folderRow(m.id) ? " cursor" : ""}`} data-nav={folderRow(m.id)}>
              <button type="button" className={`mailx-row${m.seen ? "" : " unread"}`} onClick={() => setOpen(folderRow(m.id))}>
                <span className="mailx-dotcol">{!m.seen && <span className="mailx-dot" title="Unread" />}</span>
                <span className="mailx-av" aria-hidden="true">{initials(m.folder_role === "sent" || m.folder_role === "drafts" ? m.to[0] ?? m.from : m.from)}</span>
                <span className="mailx-what">
                  <span className="who"><b>{folderWho(m)}</b>{!!m.attachments && <span className="clipmark" title={m.attachments === 1 ? "An attachment" : `${m.attachments} attachments`}><Icon name="clip" /></span>}</span>
                  <span className="line"><span className="subj">{m.subject || "(no subject)"}</span>{m.preview && <> · {m.preview}</>}</span>
                </span>
                <span className="when">{whenLabel(m.at)}</span>
              </button>
            </div>
          ))}
      </div>
      {more > 0 && <button type="button" className="mailx-more" onClick={showMore}>Show more ({more})</button>}
    </div>
  );
}

/** A folder's mail open: its sender (and for what the owner wrote, who it went to), then the message as in the Inbox. */
function FolderCard({ m, f, close }: { m: FolderMail; f: MailFolder; close: () => void }) {
  // The writing box under it (Forward, or Edit for a draft): open again when it was open before.
  const [box, setBoxState] = useState<"forward" | "draft" | null>(() => { const k = WRITING.open.get(m.id); return k === "forward" || k === "draft" ? k : null; });
  const setBox = (k: "forward" | "draft" | null) => { if (k) WRITING.open.set(m.id, k); else WRITING.open.delete(m.id); setBoxState(k); };
  const mine = m.folder_role === "sent" || m.folder_role === "drafts";
  const { boxes } = useContext(Look);
  const ro = readOnlyBox(boxes, f.email);
  return (
    <article className="mailx-card" data-nav={folderRow(m.id)}>
      <button type="button" className="mailx-card-head" onClick={close} aria-expanded="true">
        <span className="mailx-av" aria-hidden="true">{initials(mine ? m.to[0] ?? m.from : m.from)}</span>
        <span className="mailx-what">
          <span className="subject">{m.subject || "(no subject)"}</span>
          <span className="meta">{mine ? <>To {m.to.map((a) => `${personLabel(a)} <${a.address}>`).join(", ") || "no one yet"}</> : <><b>{personLabel(m.from)}</b> &lt;{m.from.address}&gt;</>} · {fmtDateTime(m.at)}</span>
        </span>
      </button>
      <div className="mailx-card-acts mailx-card-pad"><FolderActions m={m} f={f} />
        {!ro && <button type="button" className={`mailx-act${box === "forward" ? " on" : ""}`} aria-expanded={box === "forward"} onClick={() => setBox(box === "forward" ? null : "forward")}><Icon name="forward" /><span>Forward</span></button>}
        {f.role === "drafts" && !ro && <button type="button" className={`mailx-act${box === "draft" ? " on" : ""}`} aria-expanded={box === "draft"} onClick={() => setBox(box === "draft" ? null : "draft")}><Icon name="pencil" /><span>Edit</span></button>}
      </div>
      {box === "forward" && !ro && <Composer forward={m} mailbox={f.email} close={() => setBox(null)} />}
      {box === "draft" && f.role === "drafts" && !ro && <Composer draft={{ m, email: f.email }} close={() => setBox(null)} />}
      {m.folder_role === "junk" && <div className="warn small mailx-card-pad">This mail is in Spam. Be careful with its links, and never sign in or pay through them.</div>}
      <Message m={m} />
    </article>
  );
}

function BundleNav({ b, current, go, threads }: { b: Bundle; current: MailView; go: (v: MailView) => void; threads: MailThread[] }) {
  const view = `b:${b.id}` as MailView;
  const n = threads.filter((m) => m.state === "inbox" && m.bundle === b.id && isUnread(m)).length;
  return (
    <button type="button" className={`mailx-nav ${bundleClass(b)}`} aria-current={current === view ? "page" : undefined} onClick={() => go(view)}>
      <span className="ico"><Icon name={b.custom !== undefined ? "own" : b.id} /></span>{b.name}{!!n && <span className="n">{n}</span>}
    </button>
  );
}

/** Notifications for new mail from people, and what they say (a bundle's switch is in its own view). */
function NotifySettings() {
  const { notifyOn, act } = useContext(Look);
  return (
    <div className="mailx-notify small">
      <label><input type="checkbox" checked={notifyOn.people} onChange={(e) => void act((c) => c.mailNotify({ people: e.target.checked }))} /> Notify me of mail from people</label>
      <label>Notifications show
        <select value={notifyOn.detail} onChange={(e) => void act((c) => c.mailNotify({ detail: e.target.value as MailNotify["detail"] }))}>
          <option value="full">sender and subject</option>
          <option value="sender">sender only</option>
          <option value="count">only a count</option>
        </select>
      </label>
    </div>
  );
}

/**
 * A mailbox whose provider refused its password: the hub stopped signing in to it, so its mail stops coming in. That
 * was said only in the mailbox's info under the i button, and the Mail screen looked as if no new mail had come. Now
 * it is said above the mail, with the button to the account's page with Replace open.
 */
function SignInStopped({ boxes }: { boxes: MailList["mailboxes"] }) {
  const stopped = boxes.filter((m) => m.signin_refused);
  if (!stopped.length) return null;
  return (
    <>
      {stopped.map((m) => (
        <div key={m.email} className="mailx-signin" role="status">
          <span className="grow"><strong>{m.email} stopped signing in.</strong> Its new mail does not come in until you replace its password.</span>
          <button type="button" className="small primary" onClick={() => { location.hash = `#${fixPath({ fix: "account", account: mailboxKey(m) })}`; }}>Replace password</button>
        </div>
      ))}
    </>
  );
}

/**
 * The bottom of the side list: Keyboard keys, and an info button that opens the rest (each mailbox's last refresh,
 * what changes in the mailbox, notifications). A mailbox's problem puts a dot on the info button. Refresh is in the
 * top bar.
 */
function Mailboxes({ data, showKeys }: { data: MailList; showKeys: () => void }) {
  const [info, setInfo] = useState(false);
  const trouble = data.mailboxes.some((m) => m.last_error);
  return (
    <div className="mailx-boxes small">
      <div className="row">
        <button type="button" className="small mailx-keysbtn" onClick={showKeys}>Keyboard keys</button>
        <button type="button" className="small mailx-infobtn" aria-expanded={info} aria-label={trouble ? "Mailboxes and settings (a mailbox has a problem)" : "Mailboxes and settings"} title="Mailboxes and settings" onClick={() => setInfo(!info)}>
          i{trouble && <span className="mailx-alertdot" />}
        </button>
      </div>
      {info && (
        <div className="mailx-info">
          {data.mailboxes.map((m) => (
            <div key={m.email}>
              <span className="muted">{m.email}: {m.last_refresh ? `refreshed ${fmtDateTime(m.last_refresh)}` : "not refreshed yet"}{m.read_only ? ". Read only: Aeneas changes nothing in it (Settings, Accounts)" : ""}</span>
              {m.last_error && <div className="error">{m.last_error}</div>}
            </div>
          ))}
          <div className="muted">Opening a mail marks it read in your mailbox too, and Pin flags it there (a flag in your mail app pins it here); Done moves it to Archive there, and Undo moves it back.</div>
          <NotifySettings />
          {/* Only a hub that sorts mail has the switch (an older one sends no `triage`). */}
          {typeof data.triage === "boolean" && <TriageSwitch on={data.triage} auto={data.triage_state?.auto} />}
          <FoldNotesList />
          <BlockedList blocked={data.blocked ?? []} />
        </div>
      )}
    </div>
  );
}

/**
 * Triage on or off: the hub's model sorting new mail for the Needs you digest; off erases every summary it made. It
 * says when the model runs: when the owner presses Sort new mail, or (`auto`: a hub its owner set up so) after each
 * refresh.
 */
function TriageSwitch({ on, auto }: { on: boolean; auto: boolean | undefined }) {
  const { act } = useContext(Look);
  return (
    <label className="mailx-check">
      <input type="checkbox" checked={on} onChange={(e) => void act((c) => c.mailTriage(e.target.checked))} />
      <span>Sort new mail with your hub's model (Needs you). {auto === undefined ? "" : auto ? "It runs after each refresh. " : "It runs when you press Sort new mail. "}Its one-line summaries are kept a week; turning this off erases them.</span>
    </label>
  );
}

/**
 * New mail the hub's model has not sorted yet, above the Inbox: how much waits, with Sort new mail (the model runs
 * only when the owner asks, here); while a run is going, how much is left; after a run that ended early, why.
 */
function SortRow({ row }: { row: { text: string; button: boolean } }) {
  const { act } = useContext(Look);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mailx-sort small">
      <span>{row.text}</span>
      {row.button && <button type="button" className="small" disabled={busy} onClick={async () => { setBusy(true); await act((c) => c.mailTriageNow()); setBusy(false); }}>Sort new mail</button>}
    </div>
  );
}

/** The blocked senders (their mail goes to Spam), each with Unblock. */
function BlockedList({ blocked }: { blocked: string[] }) {
  const { act } = useContext(Look);
  if (!blocked.length) return null;
  return (
    <div className="mailx-blocked">
      <b>Blocked senders</b>
      <span className="muted">Their mail goes to Spam.</span>
      {blocked.map((b) => <div key={b} className="row"><span>{b}</span><button type="button" className="link small" onClick={() => void act((c) => c.mailUnblock(b))}>Unblock</button></div>)}
    </div>
  );
}

/**
 * The Inbox, drawn from what the screen worked out (inboxScreen): the mail not sorted yet (`sort`), Needs you, snoozed
 * mail back later today, then the day groups with the due reminders leading the first.
 */
function InboxList({ screen, sort, tasks, remindFor, setRemindFor, pinnedOnly, open, setOpen, openBundles, toggleBundle, searching, waiting, show }: {
  screen: InboxScreen<MailThread>; sort: { text: string; button: boolean } | null; tasks: Entity[]; remindFor: string | null; setRemindFor: (id: string | null) => void;
  pinnedOnly: boolean; open: string | null; setOpen: (id: string | null) => void;
  openBundles: Set<string>; toggleBundle: (id: string) => void; searching: boolean; waiting: boolean; show: (t: MailThread) => void;
}) {
  const { needs, back, sections } = screen;
  const reminderRows = screen.reminders.map((r) => <ReminderRow key={reminderRow(r.id)} r={r} task={tasks.find((t) => t.id === r.id)} picking={remindFor === r.id} setPicking={(on) => setRemindFor(on ? r.id : null)} />);
  return (
    <div className="mailx-col">
      {/* In the Needs you place, and there when Needs you is empty too. */}
      {sort && <SortRow row={sort} />}
      {!sections.length && !back.length ? (
        searching ? <div className="muted small">No mail has all of those words.</div>
          : waiting ? <div className="empty">Your Inbox arrives with the first refresh, a minute or so after the hub starts. Refresh brings it now.</div>
          : <Empty title={pinnedOnly ? "No pinned mail" : "You're all done"} text={pinnedOnly ? "Pinned mail stays here." : "Nothing left in your Inbox."} />
      ) : (
        <>
          {/* The model's digest: what needs the owner today, or a reply. Each one opens the mail it names, where it is listed. */}
          {!!needs.length && (
            <section className="mailx-needs" aria-label="Needs you">
              <h2>Needs you</h2>
              {needs.map((m) => (
                <button key={m.key} type="button" className="mailx-need" onClick={() => show(m)}>
                  <span className="who"><b>{m.people}</b>{m.triage?.urgency === "today" && <span className="chip">Today</span>}{m.triage?.needs_reply && <span className="chip">Reply</span>}</span>
                  <span className="line">{m.triage?.summary ?? m.subject}</span>
                </button>
              ))}
              <span className="muted small">Sorted by your hub's model from each mail's own words. It can be wrong.</span>
            </section>
          )}
          {!!back.length && (
            <section className="mailx-group mailx-back" aria-label="Back later today">
              <h2>Back later today</h2>
              <div className="mailx-list">
                {back.map((m) => <Row key={m.key} m={m} open={open === m.key} setOpen={setOpen} />)}
              </div>
            </section>
          )}
          {sections.map((s, i) => (
            <section key={s.title} className="mailx-group">
              <h2>{s.title}<Sweep mails={s.rows.flatMap((r) => (r.kind === "mail" ? [r.mail] : r.mails))} /></h2>
              <div className="mailx-list">
                {i === 0 && reminderRows}
                {s.rows.map((r) => r.kind === "mail"
                  ? <Row key={r.mail.key} m={r.mail} open={open === r.mail.key} setOpen={setOpen} />
                  : <BundleRow key={`${s.title}:${r.bundle.id}`} nav={bundleRow(s.title, r.bundle.id)} b={r.bundle} mails={r.mails} isOpen={openBundles.has(`${s.title}:${r.bundle.id}`)} toggle={() => toggleBundle(`${s.title}:${r.bundle.id}`)} open={open} setOpen={setOpen} />)}
              </div>
            </section>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * A reminder that is due, among the mail: its title and when it came due; Done marks the task done, Snooze moves its
 * time (a task that asks why, asks here too), and it opens in Tasks.
 */
function ReminderRow({ r, task, picking, setPicking }: { r: DueReminder; task: Entity | undefined; picking: boolean; setPicking: (on: boolean) => void }) {
  const { cursor, snoozeTimes } = useContext(Look);
  const [err, setErr] = useState("");
  const snooze = async (until: Date) => {
    if (!task) return;
    let reason: string | undefined;
    if (r.friction !== "none") {
      reason = window.prompt(`Why snooze "${r.title}"?`) ?? undefined;
      if (!reason?.trim()) return;
    }
    try { await snoozeReminder(task, until.toISOString(), reason); setPicking(false); } catch (e) { setErr(plainError(e)); }
  };
  return (
    <div className={`mailx-item reminder${cursor === reminderRow(r.id) ? " cursor" : ""}`} data-nav={reminderRow(r.id)}>
      <a className="mailx-row" href={`#/tasks?focus=${encodeURIComponent(r.id)}`}>
        <span className="mailx-dotcol" />
        <span className="mailx-av reminder" aria-hidden="true"><Icon name="bell" /></span>
        <span className="mailx-what">
          <span className="who"><b>{r.title}</b></span>
          <span className="line">Reminder</span>
        </span>
        <span className="when">{whenLabel(r.at)}</span>
      </a>
      <span className="mailx-acts">
        <button type="button" className="mailx-act act-snooze" title="Snooze the reminder" aria-label="Snooze" onClick={() => setPicking(!picking)}><Icon name="clock" /></button>
        <button type="button" className="mailx-act act-done" title="Done: marks the task done" aria-label="Done" onClick={() => task && void completeTask(task).catch((e) => setErr(plainError(e)))}><Icon name="check" /></button>
      </span>
      {picking && (
        <div className="mailx-snooze mailx-remsnooze">
          {snoozeChoices(new Date(), snoozeTimes).map((c) => (
            <button key={c.id} type="button" className="mailx-snooze-choice" onClick={() => void snooze(c.at)}>
              <b>{c.label}</b><span>{c.at.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
            </button>
          ))}
        </div>
      )}
      {err && <div className="error small mailx-card-pad">{err}</div>}
    </div>
  );
}

/** A flat view (Snoozed, Done, a bundle), drawn from what the screen worked out (flatScreen): the trips, then the rest. */
function Flat({ flat, messages, view, bundle, pinnedOnly = false, open, setOpen, edit }: { flat: FlatScreen<MailThread>; messages: MailThread[]; view: MailView; bundle: Bundle | null; pinnedOnly?: boolean; open: string | null; setOpen: (id: string | null) => void; edit?: () => void }) {
  const editButton = edit && <button type="button" className="mailx-act mailx-editbundle" onClick={edit}><Icon name="pencil" /><span>Edit bundle</span></button>;
  // The Trips bundle: each trip's mail as one box, then the mail in no trip as rows.
  const { trips, rest } = flat;
  if (!messages.length) {
    if (view === "snoozed") return <Empty title="Nothing snoozed" text="Snoozed mail waits here until its time." />;
    if (view === "done") return <Empty title="Nothing done yet" text="Mail you mark done shows here." />;
    return <div className="mailx-col">{bundle && <ModuleLink b={bundle} />}{editButton}{bundle && <DeliveryControl b={bundle} mails={messages} />}{pinnedOnly ? <Empty title={`No pinned ${bundle?.name.toLowerCase() ?? ""} mail`} text="Pin a mail here and it shows while Pinned only is on." /> : <Empty title={`No ${bundle?.name.toLowerCase() ?? ""} mail`} text="New mail of this kind gathers here." />}</div>;
  }
  return (
    <div className="mailx-col">
      {bundle && <ModuleLink b={bundle} />}
      {editButton}
      {bundle && <DeliveryControl b={bundle} mails={messages} />}
      {/* A mail with two flights weeks apart can lead two trips: each box is told apart by when its trip starts too. */}
      {trips.map((t) => <TripBox key={`${t.parts[0].mail.key}:${t.start}`} t={t} open={open} setOpen={setOpen} />)}
      {rest.length > 0 && (
        <div className="mailx-list">
          {rest.map((m) => <Row key={m.key} m={m} open={open === m.key} setOpen={setOpen} />)}
        </div>
      )}
    </div>
  );
}

/**
 * A trip as one box (the Trips bundle): its name and days, then its pieces in time order (the flight out, the hotel,
 * the flight back), each opening its own mail in the box. A mail with two pieces (out and back) opens from either, and
 * is one row for the keys: the highlight shows on both, and the first is the one it scrolls to.
 */
function TripBox({ t, open, setOpen }: { t: Trip<MailThread>; open: string | null; setOpen: (id: string | null) => void }) {
  const { cursor } = useContext(Look);
  const opened = t.parts.find((p) => p.mail.key === open)?.mail;
  const past = t.end + 86_400_000 < Date.now();
  return (
    <section className={`mailx-trip b-trips${past ? " past" : ""}`} aria-label={`${t.name}, ${tripDates(t)}`}>
      <div className="mailx-trip-head">
        <span className="mailx-av bundle b-trips" aria-hidden="true"><Icon name="trips" /></span>
        <span><b>{t.name}</b><span className="muted"> · {tripDates(t)}{past ? " · Over" : ""}</span></span>
      </div>
      <ol className="mailx-trip-parts">
        {t.parts.map((p, i) => (
          <li key={i}>
            <button type="button" className={`mailx-trip-part${isUnread(p.mail) ? " unread" : ""}${cursor === p.mail.key ? " cursor" : ""}`} data-nav={t.parts.findIndex((x) => x.mail.key === p.mail.key) === i ? p.mail.key : undefined} aria-expanded={open === p.mail.key} onClick={() => setOpen(open === p.mail.key ? null : p.mail.key)}>
              <span className="when">{cardTime(p.card.at!)}</span>
              <span className="what">{cardLine({ ...p.card, at: undefined })}</span>
            </button>
          </li>
        ))}
      </ol>
      {opened && <Card m={opened} close={() => setOpen(null)} />}
    </section>
  );
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const at12 = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); const d = new Date(); d.setHours(h || 0, m || 0, 0, 0); return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };

/**
 * When this bundle's mail shows in the Inbox: as it arrives, once a day, once a week, or never (only here). Held mail
 * is always listed here; pinned mail always shows in the Inbox. Kept on the hub for every device.
 */
function DeliveryControl({ b, mails }: { b: Bundle; mails: MailThread[] }) {
  const { delivery, act, notifyOn, shown } = useContext(Look);
  const d = delivery[b.id] ?? { mode: "now" };
  const notifies = notifyOn.bundles.includes(b.id);
  const save = (next: BundleDelivery) => void act((c) => c.mailBundleDelivery(b.id, next));
  const held = mails.filter((m) => m.state === "inbox" && !m.pinned && !inboxAt(m, shown, delivery));
  const next = held.map((m) => deliveryAt(m.at, d)).filter((x): x is Date => !!x).sort((x, y) => x.getTime() - y.getTime())[0];
  return (
    <div className={`mailx-delivery ${bundleClass(b)}`}>
      <label>Show in Inbox
        <select value={d.mode} onChange={(e) => {
          const mode = e.target.value as BundleDelivery["mode"];
          save(mode === "daily" ? { mode, time: d.time ?? "07:00" } : mode === "weekly" ? { mode, time: d.time ?? "18:00", day: d.day ?? 0 } : { mode });
        }}>
          <option value="now">as it arrives</option>
          <option value="daily">once a day</option>
          <option value="weekly">once a week</option>
          <option value="never">never (only here)</option>
        </select>
      </label>
      <label title={d.mode === "never" ? "This bundle skips the Inbox, so it never notifies" : d.mode === "now" ? "A notification when new mail arrives in this bundle" : "A notification when this bundle's mail shows in your Inbox"}>
        <input type="checkbox" checked={notifies} disabled={d.mode === "never"} onChange={(e) => void act((c) => c.mailNotify({ bundle: b.id, on: e.target.checked }))} /> Notify me
      </label>
      {d.mode === "weekly" && (
        <label>on <select value={d.day ?? 0} onChange={(e) => save({ ...d, day: Number(e.target.value) })}>{WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}</select></label>
      )}
      {(d.mode === "daily" || d.mode === "weekly") && (
        <label>at <input type="time" value={d.time ?? "07:00"} onChange={(e) => e.target.value && save({ ...d, time: e.target.value })} /></label>
      )}
      <span className="muted">
        {d.mode === "never" ? "This bundle's mail stays out of your Inbox; it is all here."
          : held.length && next ? `${held.length} waiting: ${next.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}.`
          : d.mode === "daily" ? `New mail shows in your Inbox each day at ${at12(d.time ?? "07:00")}.`
          : d.mode === "weekly" ? `New mail shows in your Inbox each ${WEEKDAYS[d.day ?? 0]} at ${at12(d.time ?? "18:00")}.`
          : "Pinned mail always shows in your Inbox."}
      </span>
    </div>
  );
}

/** One rule per line, as typed: blank lines and spaces at the ends left out. */
const lines = (s: string) => s.split(/\r?\n|,/).map((x) => x.trim()).filter(Boolean);

/**
 * A bundle of the owner's, made or changed: a name, one of eight colors, and rules: mail from these addresses, from
 * these domains (and domains under them), or whose subject has these words. Checked before the built-in bundles, so
 * yours wins; a person's mail can be in one.
 */
function BundleForm({ start, close, saved }: { start: CustomBundle | null; close: () => void; saved: (id: string | null) => Promise<void> }) {
  const [name, setName] = useState(start?.name ?? "");
  const [color, setColor] = useState(start?.color ?? 0);
  const [addresses, setAddresses] = useState((start?.addresses ?? []).join("\n"));
  const [domains, setDomains] = useState((start?.domains ?? []).join("\n"));
  const [words, setWords] = useState((start?.words ?? []).join("\n"));
  const [bodyWords, setBodyWords] = useState((start?.body_words ?? []).join("\n"));
  const [to, setTo] = useState((start?.to ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const c = engine.client;
  const save = async () => {
    if (!c) return;
    setBusy(true); setErr("");
    try {
      const b = { name, color, addresses: lines(addresses), domains: lines(domains), words: lines(words), body_words: lines(bodyWords), to: lines(to) };
      const r = start ? await c.mailBundleUpdate({ ...b, id: start.id }) : await c.mailBundleAdd(b);
      await saved(r.id);
    } catch (e) { setErr(plainError(e)); setBusy(false); }
  };
  const remove = async () => {
    if (!c || !start || !window.confirm(`Delete the bundle "${start.name}"? Its mail goes back to the other bundles; nothing in your mailbox changes.`)) return;
    setBusy(true);
    try { await c.mailBundleDelete(start.id); await saved(null); } catch (e) { setErr(plainError(e)); setBusy(false); }
  };
  return (
    <form className="mailx-bundleform" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2>{start ? `Edit ${start.name}` : "New bundle"}</h2>
      <label>Name <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="School" autoFocus /></label>
      <div className="mailx-swatches" role="radiogroup" aria-label="Color">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <button key={i} type="button" role="radio" aria-checked={color === i} aria-label={`Color ${i + 1}`} className={`mailx-swatch b-custom cc${i}${color === i ? " on" : ""}`} onClick={() => setColor(i)} />
        ))}
      </div>
      <p className="muted small">Mail goes in this bundle when it matches any line below. Your bundles are checked before the built-in ones, and a person's mail can be in one.</p>
      <label>From these addresses <textarea rows={3} value={addresses} onChange={(e) => setAddresses(e.target.value)} placeholder={"coach@league.example\nsam@example.com"} /></label>
      <label>From these domains (and any under them) <textarea rows={3} value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="school.example" /></label>
      <label>Subject has these words <textarea rows={3} value={words} onChange={(e) => setWords(e.target.value)} placeholder={"field trip\npermission slip"} /></label>
      <label>The mail's text has these words <textarea rows={3} value={bodyWords} onChange={(e) => setBodyWords(e.target.value)} placeholder={"soccer practice\nreport card"} /></label>
      <label>Sent to these addresses (an alias) <textarea rows={2} value={to} onChange={(e) => setTo(e.target.value)} placeholder="family@northwind.example" /></label>
      <span className="muted small">A mail's text is looked at in its first 3,000 characters, as whole words. Who a mail was sent to is known for mail arriving from now on.</span>
      {err && <div className="error">{err}</div>}
      <div className="row">
        <button type="submit" disabled={busy || !name.trim()}>{start ? "Save" : "Make bundle"}</button>
        <button type="button" className="link" onClick={close}>Cancel</button>
        {start && <button type="button" className="link danger" onClick={() => void remove()}>Delete bundle</button>}
      </div>
    </form>
  );
}

function ModuleLink({ b }: { b: Bundle }) {
  if (!b.module || !b.screen) return null;
  return (
    <div className={`mailx-module ${bundleClass(b)}`}>
      <span>Sorted using your {b.moduleName} records.</span>
      <a href={`#${b.screen}`}>Open {b.moduleName} ›</a>
    </div>
  );
}

function BundleRow({ b, nav, mails, isOpen, toggle, open, setOpen }: { b: Bundle; nav: string; mails: MailThread[]; isOpen: boolean; toggle: () => void; open: string | null; setOpen: (id: string | null) => void }) {
  const { cursor } = useContext(Look);
  const unread = mails.filter(isUnread).length;
  // The Trips row says the next trip not over yet ("Trip to JFK, Dec 3 to 6"), else who the mail is from.
  const soon = b.id === "trips" ? tripsOf(mails)[0] : undefined;
  const next = soon && soon.end + 86_400_000 >= Date.now() ? soon : null;
  return (
    <div className={`mailx-bundle ${bundleClass(b)}${isOpen ? " open" : ""}${cursor === nav ? " cursor" : ""}`} data-nav={nav}>
      <button type="button" className={`mailx-row${unread ? " unread" : ""}`} aria-expanded={isOpen} onClick={toggle}>
        <span className="mailx-dotcol">{!!unread && <span className="mailx-dot" title="Unread mail inside" />}</span>
        <span className="mailx-av bundle"><Icon name={b.custom !== undefined ? "own" : b.id} /></span>
        <span className="mailx-what">
          <span className="who"><b className="bname">{b.name}</b><span className="chip">{unread ? `${unread} new` : mails.length}</span></span>
          <span className="line">{next ? `${next.name}, ${tripDates(next)}` : sendersLine(mails)}</span>
        </span>
        <span className="when">{whenLabel(mails[0].at)}</span>
      </button>
      {isOpen && (
        <>
          <ModuleLink b={b} />
          <div className="mailx-bundle-acts"><Sweep mails={mails} /></div>
          {mails.map((m) => <Row key={m.key} m={m} open={open === m.key} setOpen={setOpen} />)}
        </>
      )}
    </div>
  );
}

/**
 * Swiping a row on a touch screen: right for Done (Move to Inbox in Done), left for Snooze (null: none). Only touch, never
 * a mouse; the row keeps `touch-action: pan-y`, so the list still scrolls and a sideways move comes here. A swipe let go
 * short of swipeAction's distance slides back, and the tap that ends a swipe does not open the mail.
 */
function useSwipe(on: boolean, done: () => void, snooze: (() => void) | null) {
  const [dx, setDx] = useState(0);
  const at = useRef<{ x: number; y: number; id: number; lock: "h" | "v" | null; dx: number; w: number } | null>(null);
  const swiped = useRef(false);
  const handlers = on ? {
    onPointerDown: (e: RPointerEvent<HTMLElement>) => {
      if (e.pointerType !== "touch") return;
      at.current = { x: e.clientX, y: e.clientY, id: e.pointerId, lock: null, dx: 0, w: e.currentTarget.offsetWidth };
    },
    onPointerMove: (e: RPointerEvent<HTMLElement>) => {
      const s = at.current;
      if (!s || e.pointerId !== s.id) return;
      const x = e.clientX - s.x;
      if (!s.lock) { s.lock = swipeLock(x, e.clientY - s.y); if (s.lock === "h") e.currentTarget.setPointerCapture(e.pointerId); }
      if (s.lock !== "h") return;
      s.dx = x < 0 && !snooze ? 0 : x;
      setDx(s.dx);
    },
    onPointerUp: () => {
      const s = at.current;
      at.current = null;
      if (!s || s.lock !== "h") return;
      swiped.current = true;
      setDx(0);
      const a = swipeAction(s.dx, s.w);
      if (a === "done") done();
      else if (a === "snooze") snooze?.();
    },
    onPointerCancel: () => { at.current = null; setDx(0); },
    onClickCapture: (e: RMouseEvent) => { if (swiped.current) { swiped.current = false; e.preventDefault(); e.stopPropagation(); } },
  } : {};
  return { dx, handlers };
}

function Row({ m, open, setOpen }: { m: MailThread; open: boolean; setOpen: (id: string | null) => void }) {
  const { cursor, selected, pick, move, setSnoozeFor, openMail, boxes } = useContext(Look);
  const back = m.state === "done";
  // A Read only mailbox's mail has no Done to swipe to (its Snooze, on the hub only, is on the open mail).
  const swipe = useSwipe(!open && selected.size === 0 && !readOnlyBox(boxes, m.mailbox),
    () => void move(back ? m.ids.done : m.ids.open, back ? "inbox" : "done"),
    back ? null : () => { setSnoozeFor(m.key); openMail(m.key); });
  if (open) return <Card m={m} close={() => setOpen(null)} />;
  const picked = selected.has(m.key);
  const dx = swipe.dx;
  const armed = swipeAction(dx, 400) !== null;
  // The row opens the mail; its actions show when it is pointed at or tabbed to (on a phone, open the mail for them,
  // or swipe). Its circle turns into a checkbox when pointed at, or while anything is selected.
  return (
    <div className={`mailx-item${cursor === m.key ? " cursor" : ""}${picked ? " picked" : ""}${dx ? " swiping" : ""}`} data-nav={m.key} {...swipe.handlers}>
      {dx > 0 && <span className={`mailx-swipe done${armed ? " armed" : ""}`} aria-hidden="true"><Icon name={back ? "inbox" : "check"} />{back ? "Move to Inbox" : "Done"}</span>}
      {dx < 0 && <span className={`mailx-swipe snooze${armed ? " armed" : ""}`} aria-hidden="true">Snooze<Icon name="clock" /></span>}
      <button type="button" className="mailx-pick" role="checkbox" aria-checked={picked} aria-label={`Select ${m.subject || "this mail"}`} onClick={(e) => pick(m.key, e.shiftKey)}>
        <Icon name="check" />
      </button>
      <button type="button" className={`mailx-row${isUnread(m) ? " unread" : ""}`} style={dx ? { transform: `translateX(${dx}px)` } : undefined} onClick={() => setOpen(m.key)}>
        <span className="mailx-dotcol">{isUnread(m) && <span className="mailx-dot" title="Unread" />}</span>
        <Avatar m={m} />
        <span className="mailx-what">
          <span className="who"><b>{m.people}</b>{m.pinned && <span className="pinmark" title="Pinned"><Icon name="pin" /></span>}{!!m.attachments && <span className="clipmark" title={m.attachments === 1 ? "An attachment" : `${m.attachments} attachments`}><Icon name="clip" /></span>}{m.triage?.needs_reply && m.state === "inbox" && <span className="replymark" title="Your hub's model thinks this needs a reply">Reply?</span>}</span>
          <span className="line"><span className="subj">{m.subject || "(no subject)"}</span>{m.preview && <> · {m.preview}</>}</span>
          {/* Its first card's facts, as text (the row is a button: Track is on the open mail). */}
          {m.cards?.[0] && <span className={`mailx-cardline b-${CARD_ICON[m.cards[0].kind]}`}><Icon name={CARD_ICON[m.cards[0].kind]} />{cardLine(m.cards[0])}</span>}
        </span>
        <span className="when">{m.state === "snoozed" && m.snooze_until ? `Until ${whenLabel(m.snooze_until)}` : whenLabel(m.at)}</span>
      </button>
      <span className="mailx-acts"><PinButton m={m} /><SnoozeButton m={m} /><DoneButton m={m} /></span>
    </div>
  );
}

/**
 * A sender's circle: the brand's logo when iCloud verified it; for other mail a system sent, the sender's initials on
 * its bundle's color (NB for Northwind Books on the Transactions color); for a person, or mail in no bundle, initials on gray.
 */
function Avatar({ m }: { m: MailSummary }) {
  const { logos, shown } = useContext(Look);
  const logo = m.logo_domain ? logoSrc(logos[m.logo_domain]) : null;
  if (logo) return <span className="mailx-av logo" aria-hidden="true"><img src={logo} alt="" /></span>;
  const b = m.automated ? bundleOf(m, shown) : null;
  if (b) return <span className={`mailx-av bundle ${bundleClass(b)}`} aria-hidden="true">{initials(m.from)}</span>;
  return <span className="mailx-av" aria-hidden="true">{initials(m.from)}</span>;
}

/** Pin or unpin: the pin filled while pinned. `labelled`: with its word beside it (an open mail's bar). */
function PinButton({ m, labelled = false }: { m: MailThread; labelled?: boolean }) {
  const { act, offerUndo, boxes } = useContext(Look);
  const [busy, setBusy] = useState(false);
  const label = m.pinned ? "Unpin" : "Pin";
  // A pin is the mailbox's flag: none is set in a Read only mailbox.
  if (readOnlyBox(boxes, m.mailbox)) return null;
  return (
    <button type="button" className={`mailx-act act-pin${m.pinned ? " on" : ""}`} aria-pressed={m.pinned} title={label} aria-label={label} disabled={busy}
      onClick={async () => { setBusy(true); const was = m.pinned; await act((c) => c.mailPin(m.id, !was)); offerUndo(was ? "Unpinned" : "Pinned", () => act((c) => c.mailPin(m.id, was))); setBusy(false); }}>
      <Icon name="pin" />{labelled && <span>{label}</span>}
    </button>
  );
}

/** Done (moves the thread's mail to Archive in its mailbox), or for a done thread, Move to Inbox. */
function DoneButton({ m, labelled = false }: { m: MailThread; labelled?: boolean }) {
  const { move, boxes } = useContext(Look);
  const [busy, setBusy] = useState(false);
  const back = m.state === "done";
  const label = back ? "Move to Inbox" : "Done";
  const where = inProvider(mailboxOf(boxes, m.mailbox));
  if (readOnlyBox(boxes, m.mailbox)) return null;
  return (
    <button type="button" className="mailx-act act-done" title={back ? `Move back to the Inbox ${where}` : `Done: moves it to Archive ${where}`} aria-label={label} disabled={busy}
      onClick={async () => { setBusy(true); await move(back ? m.ids.done : m.ids.open, back ? "inbox" : "done"); setBusy(false); }}>
      <Icon name={back ? "inbox" : "check"} />{labelled && <span>{label}</span>}
    </button>
  );
}

/**
 * Snooze: shows the snooze choices on the open mail (a row's button opens it with them). For a snoozed mail, Unsnooze
 * brings it back now; its choices change the time.
 */
function SnoozeButton({ m, labelled = false }: { m: MailThread; labelled?: boolean }) {
  const { snoozeFor, setSnoozeFor, openMail, unsnooze } = useContext(Look);
  if (m.state === "done") return null;
  const showing = snoozeFor === m.key;
  return (
    <>
      <button type="button" className={`mailx-act act-snooze${showing ? " on" : ""}`} aria-expanded={showing} title={m.state === "snoozed" ? "Change when it comes back" : "Snooze: hide it until a time you pick"} aria-label="Snooze"
        onClick={() => { setSnoozeFor(showing ? null : m.key); if (!showing) openMail(m.key); }}>
        <Icon name="clock" />{labelled && <span>{m.state === "snoozed" ? "Change snooze" : "Snooze"}</span>}
      </button>
      {labelled && m.state === "snoozed" && (
        <button type="button" className="mailx-act" onClick={() => void unsnooze(m)}><Icon name="inbox" /><span>Unsnooze</span></button>
      )}
    </>
  );
}

/** The snooze choices (later today, tomorrow, the weekend, next week) and a date and time of your own. */
function SnoozePicker({ m }: { m: MailThread }) {
  const { snooze, snoozeTimes } = useContext(Look);
  const [editing, setEditing] = useState(false);
  const [own, setOwn] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async (at: Date) => { setBusy(true); await snooze(m, at); setBusy(false); };
  const ownAt = own ? new Date(own) : null;
  const ownOk = !!ownAt && !Number.isNaN(ownAt.getTime()) && ownAt.getTime() > Date.now() + 60_000;
  return (
    <div className="mailx-snooze mailx-card-pad" role="group" aria-label="Snooze until">
      {snoozeChoices(new Date(), snoozeTimes).map((c) => (
        <button key={c.id} type="button" className="mailx-snooze-choice" disabled={busy} onClick={() => void go(c.at)}>
          <b>{c.label}</b><span>{c.at.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
        </button>
      ))}
      <label className="mailx-snooze-own">
        <span>Pick a date and time</span>
        <input type="datetime-local" value={own} onChange={(e) => setOwn(e.target.value)} />
        <button type="button" disabled={busy || !ownOk} onClick={() => ownAt && void go(ownAt)}>Snooze</button>
      </label>
      <button type="button" className="link mailx-snooze-edit" aria-expanded={editing} onClick={() => setEditing(!editing)}>{editing ? "Close" : "Change these times"}</button>
      {editing && <SnoozeTimesForm done={() => setEditing(false)} />}
    </div>
  );
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** What "Later today", "Tomorrow", "This weekend" and "Next week" mean, kept on the hub for every device. */
function SnoozeTimesForm({ done }: { done: () => void }) {
  const { snoozeTimes, act } = useContext(Look);
  const [t, setT] = useState<SnoozeTimes>(snoozeTimes);
  const [busy, setBusy] = useState(false);
  const day = (k: "weekend_day" | "week_day") => (
    <select value={t[k]} onChange={(e) => setT({ ...t, [k]: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select>
  );
  const time = (k: "tomorrow" | "weekend_time" | "week_time") => <input type="time" value={t[k]} onChange={(e) => setT({ ...t, [k]: e.target.value })} />;
  return (
    <form className="mailx-snooze-times" onSubmit={async (e) => { e.preventDefault(); setBusy(true); await act((c) => c.mailSnoozeTimes(t)); setBusy(false); done(); }}>
      <label>Later today <input type="number" min={1} max={12} value={t.later_hours} onChange={(e) => setT({ ...t, later_hours: Number(e.target.value) })} /> hours on</label>
      <label>Tomorrow at {time("tomorrow")}</label>
      <label>This weekend: {day("weekend_day")} at {time("weekend_time")}</label>
      <label>Next week: {day("week_day")} at {time("week_time")}</label>
      <div className="row"><button type="submit" disabled={busy}>Save</button><button type="button" className="link" onClick={() => setT(SNOOZE_DEFAULTS)}>Back to the usual times</button></div>
    </form>
  );
}

/** Snooze for several selected threads: the same choices, one task each. */
function MultiSnooze({ count, pick, close }: { count: number; pick: (until: Date) => void; close: () => void }) {
  const { snoozeTimes } = useContext(Look);
  const [own, setOwn] = useState("");
  const ownAt = own ? new Date(own) : null;
  const ok = !!ownAt && !Number.isNaN(ownAt.getTime()) && ownAt.getTime() > Date.now() + 60_000;
  return (
    <div className="mailx-snooze mailx-multisnooze" role="group" aria-label={`Snooze ${count} until`}>
      <b>Snooze {count} until</b>
      {snoozeChoices(new Date(), snoozeTimes).map((c) => (
        <button key={c.id} type="button" className="mailx-snooze-choice" onClick={() => pick(c.at)}>
          <b>{c.label}</b><span>{c.at.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}</span>
        </button>
      ))}
      <label className="mailx-snooze-own"><span>Pick a date and time</span><input type="datetime-local" value={own} onChange={(e) => setOwn(e.target.value)} />
        <button type="button" disabled={!ok} onClick={() => ownAt && pick(ownAt)}>Snooze</button></label>
      <button type="button" className="link mailx-snooze-edit" onClick={close}>Cancel</button>
    </div>
  );
}

/** A thread's mail that Delete, Spam and Move to take: its received mail in the Inbox, snoozed or done (never the owner's replies). */
const threadIds = (m: MailThread) => [...m.ids.open, ...m.ids.done];

/**
 * Delete, Spam (`spam`) and Move to one of the owner's folders, for mail in the Inbox, Snoozed or Done; Undo sends it
 * `back`. `mailbox`: the mailbox the mail is in: only its own folders are offered.
 */
function MoveButtons({ ids, mailbox, back, spam = false }: { ids: string[]; mailbox: string | undefined; back: MoveTarget | null; spam?: boolean }) {
  const { relocate, folders, boxes } = useContext(Look);
  const [busy, setBusy] = useState(false);
  const go = async (to: MoveTarget, said: string) => { setBusy(true); await relocate(ids, to, said, back); setBusy(false); };
  const box = mailboxOf(boxes, mailbox);
  const own = moveFolders(folders, [box?.email]);
  if (box?.read_only) return null;
  return (
    <>
      <button type="button" className="mailx-act" disabled={busy} title={`Delete: moves it to Trash ${inProvider(box)}`} onClick={() => void go("trash", "Moved to Trash")}><Icon name="trash" /><span>Delete</span></button>
      {spam && <button type="button" className="mailx-act" disabled={busy} title={`Spam: moves it to Spam (Junk) ${inProvider(box)}`} onClick={() => void go("junk", "Moved to Spam")}><Icon name="spam" /><span>Spam</span></button>}
      {!!own.length && <MoveMenu folders={own} disabled={busy} pick={(f) => void go(f.key, `Moved to ${folderLabel(f)}`)} />}
    </>
  );
}

/**
 * Move to: one of the owner's folders, chosen in the menu, then Move. Choosing alone moves nothing: a menu that has
 * the focus changes with the arrow keys (on Windows without opening), and that must not move mail.
 */
function MoveMenu({ folders, disabled, pick }: { folders: MailFolder[]; disabled: boolean; pick: (f: MailFolder) => void }) {
  const [to, setTo] = useState("");
  const chosen = folders.find((x) => x.key === to);
  return (
    <span className="mailx-move">
      <select className="mailx-movemenu" aria-label="Move to a folder" disabled={disabled} value={chosen ? to : ""} onChange={(e) => setTo(e.target.value)}>
        <option value="">Move to…</option>
        {folders.map((f) => <option key={f.key} value={f.key}>{folderLabel(f)}</option>)}
      </select>
      <button type="button" className="small" disabled={disabled || !chosen} onClick={() => chosen && pick(chosen)}>Move</button>
    </span>
  );
}

/**
 * A folder mail's actions, by its folder (folderActs): Spam has Not spam and Delete; Trash has Move to Inbox; the
 * owner's folders have Move to Inbox, Delete and Move to another folder of the same mailbox; Sent and Drafts have
 * Delete (no Undo: nothing is moved into Sent or Drafts).
 */
function FolderActions({ m, f }: { m: FolderMail; f: MailFolder }) {
  const { relocate, folders, boxes } = useContext(Look);
  const [busy, setBusy] = useState(false);
  const go = async (to: MoveTarget, said: string, back: MoveTarget | null) => { setBusy(true); await relocate([m.id], to, said, back); setBusy(false); };
  const can = folderActs(f.role);
  const here: MoveTarget = f.role === "own" ? f.key : f.role;
  const others = can.move ? moveFolders(folders, [f.email], f.key) : [];
  if (readOnlyBox(boxes, f.email)) return <span className="muted small">Read only: Aeneas changes nothing in this mailbox.</span>;
  return (
    <>
      {can.inbox && <button type="button" className="mailx-act" disabled={busy} onClick={() => void go("inbox", "Moved to Inbox", here)}><Icon name="inbox" /><span>{f.role === "junk" ? "Not spam" : "Move to Inbox"}</span></button>}
      {can.trash && <button type="button" className="mailx-act" disabled={busy} title={`Delete: moves it to Trash ${inProvider(mailboxOf(boxes, f.email))}`} onClick={() => void go("trash", "Moved to Trash", can.undo ? here : null)}><Icon name="trash" /><span>Delete</span></button>}
      {!!others.length && <MoveMenu folders={others} disabled={busy} pick={(x) => void go(x.key, `Moved to ${folderLabel(x)}`, here)} />}
      {f.role === "trash" && <span className="muted small">Mail in Trash is erased only from {mailApp(mailboxOf(boxes, f.email))}.</span>}
    </>
  );
}

/** Sweep: every unpinned thread here marked done at once (pinned ones stay), with one Undo. */
function Sweep({ mails }: { mails: MailThread[] }) {
  const { move, boxes } = useContext(Look);
  const [busy, setBusy] = useState(false);
  const ids = mails.filter((m) => !m.pinned && m.state !== "done" && !readOnlyBox(boxes, m.mailbox)).flatMap((m) => m.ids.open);
  if (!ids.length) return null;
  return (
    <button type="button" className="mailx-act mailx-sweep" title={`Mark ${ids.length} done (pinned mail stays)`} disabled={busy}
      onClick={async () => { setBusy(true); await move(ids, "done"); setBusy(false); }}>
      <Icon name="check" /><span>Sweep</span>
    </button>
  );
}

/**
 * An open thread: its messages oldest first, the newest and any unread open, the others folded to a line each. A single
 * mail shows whole. Opening reads the thread's unread mail: on the hub and in the mailbox (its read flag only). The card
 * is the same card while mail comes and goes in its thread (the thread's key), so what is being written in it stays.
 */
function Card({ m, close }: { m: MailThread; close: () => void }) {
  const { snoozeFor, act, selected, pick, showPerson, offerUndo } = useContext(Look);
  const picked = selected.has(m.key);
  // The unread messages that open by themselves: the newest few. Each open message is a frame of its own, and a
  // thread of any length opening all at once is more than a page should carry.
  const [openUnread] = useState(() => new Set(m.members.filter(isUnread).slice(-OPEN_UNREAD_MAX).map((x) => x.id)));
  useEffect(() => {
    if (m.ids.unread.length) void act(async (c) => { for (const part of batches(m.ids.unread)) await c.mailSeenMany(part, true); });
    // When it opens, and when new mail arrives in it while it is open (its newest mail's id changes then). Not on
    // every change: Mark unread must not be undone by the card that is closing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m.id]);
  const single = m.members.length === 1;
  // Reply answers the thread's newest mail from someone else (never the owner's own reply).
  const answer = [...m.members].reverse().find((x) => !x.mine);
  const [tools, setTools] = useState(false);
  return (
    <article className={`mailx-card${picked ? " picked" : ""}`} data-nav={m.key}>
      {/* As on a row: the circle turns into a checkbox when pointed at, or while anything is selected. */}
      <button type="button" className="mailx-pick" role="checkbox" aria-checked={picked} aria-label={`Select ${m.subject || "this mail"}`} onClick={(e) => pick(m.key, e.shiftKey)}>
        <Icon name="check" />
      </button>
      <button type="button" className="mailx-card-head" onClick={close} aria-expanded="true">
        <Avatar m={m} />
        <span className="mailx-what">
          <span className="subject">{m.subject || "(no subject)"}</span>
          {/* The real address, always: a display name can say anything. A thread shows each message's below. */}
          <span className="meta">{single ? <><b>{personLabel(m.from)}</b> &lt;{m.from.address}&gt; · {fmtDateTime(m.at)}</> : <>{m.people}</>}</span>
        </span>
      </button>
      <div className="mailx-card-acts mailx-card-pad"><DoneButton m={m} labelled /><SnoozeButton m={m} labelled /><PinButton m={m} labelled />
        <button type="button" className="mailx-act" title="Mark unread, here and in your mail app" onClick={() => { close(); void act((c) => c.mailSeen(m.id, false)); offerUndo("Marked unread", () => act((c) => c.mailSeen(m.id, true))); }}><Icon name="dot" /><span>Mark unread</span></button>
        <MoveButtons ids={threadIds(m)} mailbox={m.mailbox} back="inbox" spam />
        {answer && <button type="button" className={`mailx-act${tools ? " on" : ""}`} aria-expanded={tools} title="Unsubscribe from this sender's mail, or block them" onClick={() => setTools((x) => !x)}><Icon name="spam" /><span>Unsubscribe or block</span></button>}
        {answer && <button type="button" className="mailx-act" title={`All your mail with ${answer.from.address}`} onClick={() => showPerson(answer.from)}><Icon name="person" /><span>All with {personLabel(answer.from).split(/\s+/)[0]}</span></button>}
      </div>
      {tools && answer && <SenderTools m={answer} close={() => setTools(false)} />}
      {m.state === "snoozed" && m.snooze_until && <div className="muted small mailx-card-pad">Snoozed until {fmtDateTime(m.snooze_until)}. It comes back to the top of your Inbox then; its task, called Snoozed mail, is in Tasks and Reminders.</div>}
      {snoozeFor === m.key && <SnoozePicker m={m} />}
      {/* One mail or many, each is drawn the same way, so a mail (and a reply being written under it) stays as it is when another arrives. */}
      {m.members.map((x, i) => (
        <ThreadMessage key={x.id} m={x} single={single} startOpen={i === m.members.length - 1 || openUnread.has(x.id)} />
      ))}
    </article>
  );
}

/** A file's bytes as base64, for a draft. */
const fileB64 = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
  r.onerror = () => reject(r.error);
  r.readAsDataURL(f);
});

const lastFrom = () => { try { return localStorage.getItem(FROM_KEY); } catch { return null; } };
const rememberFrom = (email: string) => { try { localStorage.setItem(FROM_KEY, email); } catch { /* private window: the first mailbox next time */ } };

/** Said in the writing box of a draft that was written with formatting, before it is saved from here. */
const FORMATTED_DRAFT = "This draft has formatting from another mail app. Saving it here keeps its words only. The old version goes to Trash.";

/**
 * Writing mail: a reply to an open mail (the hub sets its recipient, the sender's From; its subject and its thread), a
 * forward, a new mail, or a kept draft being changed. Write, then Preview: the hub answers with the whole mail, shown
 * here as text. Then Send (since 2026-11-24, for a mailbox with a sending server that is not Read only): the mail goes
 * into the hub's outbox, the box says Sending with Undo for 10 seconds, and Undo puts it back here as it was; a mail
 * the server refuses comes back with the hub's words, Try again, Save draft and Edit. Or Save draft: to the mailbox's
 * Drafts folder.
 *
 * What is typed is kept by the screen (WRITING), not by this box, so it is here again when the box closes and opens:
 * Reply all pressed after Reply, the thread closed and opened, the list changed under it, New mail pressed twice. Only
 * Save draft, a mail sent and Discard let it go, and Discard asks first when something was typed. The whole box is marked as a
 * writing box (`data-writing`), where the list's keys do nothing, and after any of its buttons is pressed the focus
 * goes back to its text, so typing goes on there.
 *
 * `mailbox`: the mailbox the mail it answers or forwards is in, when the mail itself does not say; `focus` false: the
 * box was open before the screen showed, and does not take the focus.
 */
function Composer({ reply, all = false, forward, draft, mailbox, focus = true, close }: { reply?: MailSummary; all?: boolean; forward?: MailSummary; draft?: { m: FolderMail; email: string }; mailbox?: string; focus?: boolean; close: () => void }) {
  const { boxes: linked, act } = useContext(Look);
  // A draft is saved to a mailbox: never to a Read only one.
  const boxes = writableBoxes(linked);
  const what: DraftFor = reply ? { reply: reply.id, all } : forward ? { forward: forward.id } : draft ? { draft: draft.m.id, from: draft.email } : { fresh: true };
  const key = reply ? `reply:${reply.id}` : forward ? `forward:${forward.id}` : draft ? `draft:${draft.m.id}` : NEW_MAIL;
  // A new mail goes from one of several mailboxes: the one used last time, until another is chosen.
  const choosesFrom = "fresh" in what && boxes.length > 1;
  const [typed, setTyped] = useState<Typed>(() => WRITING.typed.get(key) ?? {
    to: draft ? draft.m.to.map((a) => a.address).join(", ") : "", subject: draft?.m.subject ?? "", text: "", greeting: "", signoff: "",
    touched: { greeting: false, signoff: false }, suggested: false, smart: [], files: [], withTheirs: !!forward?.attachments,
    from: fromChoice(boxes, lastFrom()), ready: !draft, html: false, kept: draft ? null : [], dirty: false,
  });
  const now = useRef(typed);
  /**
   * Change what the box holds, here and in the screen's keeping. `byTyping` false: no words were typed and no file
   * was attached by it (the hub's suggestion, a draft's own words, a choice or a removal), so Discard has nothing to
   * ask about.
   */
  const set = (patch: Partial<Typed>, byTyping = true) => {
    const next = { ...now.current, ...patch, ...(byTyping ? { dirty: true } : {}) };
    now.current = next;
    WRITING.typed.set(key, next);
    setTyped(next);
  };
  const from = fromChoice(boxes, typed.from);
  const box = mailboxOf(boxes, mailbox ?? (reply ?? forward)?.mailbox ?? draft?.email ?? (choosesFrom ? from : undefined));
  const [preview, setPreview] = useState<MailDraft | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const sends = canSend(box);
  // The mail in the hub's outbox, once sent: asked every second while it waits or is on its way (undefined: not asked yet).
  const [item, setItem] = useState<OutboxItem | null | undefined>(undefined);
  const [sentDone, setSentDone] = useState(false);
  const [looks, setLooks] = useState(0);
  const outboxId = typed.outbox ?? null;
  useEffect(() => {
    const c = engine.client;
    if (!outboxId || !c) { setItem(undefined); return; }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      let got: OutboxItem | null;
      try { got = await c.mailOutbox(outboxId); } catch (e) {
        // Not there: taken back, or long since sent. Out of reach for a moment: asked again.
        if (!(e instanceof HubError && e.status === 404)) { if (live) timer = setTimeout(() => void look(), 2000); return; }
        got = null;
      }
      if (!live) return;
      setItem(got);
      if (got?.state === "sent") {
        // Sent: nothing is left to keep, and the box does not open again by itself.
        WRITING.typed.delete(key);
        WRITING.open.delete(under ?? NEW_MAIL);
        if (choosesFrom) rememberFrom(from);
        setSentDone(true);
        void act(async () => undefined);
        return;
      }
      // Gone from the outbox (taken back on another device, or long since sent): what was written shows again.
      if (got === null) { set({ outbox: null }, false); return; }
      if (got.state === "waiting" || got.state === "sending") timer = setTimeout(() => void look(), 1000);
    };
    void look();
    return () => { live = false; clearTimeout(timer); };
  }, [outboxId, looks]);
  // A preview is of the mail as it was asked for: when Reply all is pressed after Reply (or Reply after Reply all) it
  // is no longer what would be saved, so the box goes back to the text, to be previewed again.
  useEffect(() => { setPreview(null); }, [all]);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const toText = () => textRef.current?.focus();
  // The text takes the focus when the box opens, when Reply all is pressed after Reply (or Reply after Reply all: the
  // box stays, and the button pressed is outside it) and when it comes back from the preview, with the caret after
  // what is there; the preview's Send (or Save draft, for a mailbox that does not send) takes it while the preview shows. The focus is then never left on a
  // button that went away or was switched off while the hub answered, where typing would be the list's keys. A focus
  // that is in one of the box's own fields (To, the subject) stays there.
  const writing = !preview && !saved;
  const opened = useRef(false);
  useEffect(() => {
    const first = !opened.current;
    opened.current = true;
    if ((first && !focus) || busy) return;
    const at = document.activeElement;
    if (at instanceof HTMLElement && at.matches("input, textarea, select") && at.closest(WRITING_BOX)?.getAttribute("data-writing") === key) return;
    const el = textRef.current;
    if (writing && el && typed.ready) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    else if (preview && !saved) saveRef.current?.focus();
  }, [writing, typed.ready, !!preview, busy, all]);
  // The box going away while the focus is in it, and not by its own Discard or Close: the owner was typing, and the
  // list changed under the box. The screen is told (WRITING.lost), before the box leaves the page.
  const closing = useRef(false);
  const under = (reply ?? forward ?? draft?.m)?.id;
  useLayoutEffect(() => () => {
    const at = document.activeElement?.closest(WRITING_BOX);
    if (under && !closing.current && at?.getAttribute("data-writing") === key) WRITING.lost = { id: under, at: Date.now() };
  }, []);

  // A reply's greeting and sign-off: suggested by the hub (its local model, or the plain ones) when the reply first
  // opens, each the owner's to edit or drop (null: dropped). What the owner already changed is never overwritten.
  // Smart replies come with them: tapping one puts it in the text, to edit like anything typed.
  const [suggesting, setSuggesting] = useState(!!reply && !typed.suggested);
  useEffect(() => {
    if (!reply || now.current.suggested) return;
    let live = true;
    engine.client?.mailGreeting(reply.id).then((g) => {
      if (!live) return;
      const t = now.current.touched;
      set({ ...(t.greeting ? {} : { greeting: g.greeting }), ...(t.signoff ? {} : { signoff: g.signoff }), smart: g.replies ?? [], suggested: true }, false);
    }).catch(() => undefined).finally(() => { if (live) setSuggesting(false); });
    return () => { live = false; };
  }, [reply?.id]);

  // A kept draft being changed: its words and its attachments are read from the hub first (the list has only the
  // words' start, and no file's part). Nothing can be previewed or saved before both are here: a save from half of
  // it would drop the rest, since the old draft goes to Trash.
  const [loadErr, setLoadErr] = useState("");
  const [loadTry, setLoadTry] = useState(0);
  useEffect(() => {
    const c = engine.client;
    if (!draft || now.current.ready || !c) return;
    let live = true;
    setLoadErr("");
    Promise.all([c.mailMessage(draft.m.id), draft.m.attachments === undefined ? { attachments: [] as MailAttachment[] } : c.mailAttachments(draft.m.id)])
      // Only what names a file is kept: a picture's preview is the whole picture, and is not needed here.
      .then(([x, a]) => { if (live) set({ text: x.text, html: !!x.html, kept: a.attachments.map(({ part, name, type, size }) => ({ part, name, type, size })), ready: true }, false); })
      .catch((e) => { if (live) setLoadErr(plainError(e)); });
    return () => { live = false; };
  }, [draft?.m.id, loadTry]);

  // Files: a changed draft's own that stay on it (`kept`), and those the owner attaches (read in this browser, sent
  // with the draft); together at most 10 files and 15 MB, the hub's limits.
  const kept = typed.kept ?? [];
  const keptBytes = kept.reduce((n, a) => n + a.size, 0);
  const filesBytes = typed.files.reduce((n, f) => n + f.size, 0) + keptBytes;
  const addFiles = (list: FileList | null) => {
    const next = [...typed.files, ...Array.from(list ?? [])].slice(0, Math.max(0, DRAFT_FILES_MAX - kept.length));
    if (next.reduce((n, f) => n + f.size, 0) + keptBytes > DRAFT_FILES_BYTES) { setErr(box?.kind === "icloud" ? "The files are more than 15 MB together. Send big files from Apple Mail (Mail Drop)." : "The files are more than 15 MB together. Send big files from your mail app."); return; }
    setErr("");
    set({ files: next });
  };
  const ask = async (asPreview: boolean) => {
    const c = engine.client;
    if (!c) return;
    setBusy(true);
    setErr("");
    try {
      const t = now.current;
      const sent = await Promise.all(t.files.map(async (f) => ({ name: f.name, type: f.type, data: await fileB64(f) })));
      const r = await c.mailDraft(draftRequest(what, { ...t, from: choosesFrom ? from : undefined, kept: t.kept ?? [] }, sent, asPreview));
      if (asPreview) setPreview(r);
      else {
        // Saved: nothing is left to keep, and the box does not open again by itself.
        WRITING.typed.delete(key);
        WRITING.open.delete(under ?? NEW_MAIL);
        if (choosesFrom) rememberFrom(from);
        setSaved(true);
        // The new draft is in Drafts now: the list is loaded again for the side list's count. (A changed draft's old
        // row is the one this box is under, so its list is loaded when the box closes.)
        if (!draft) void act(async () => undefined);
      }
    } catch (e) { setErr(plainError(e)); }
    setBusy(false);
  };
  /** Send: the mail into the hub's outbox; the box then shows it Sending, with Undo. */
  const send = async () => {
    const c = engine.client;
    if (!c) return;
    setBusy(true);
    setErr("");
    try {
      const t = now.current;
      const files = await Promise.all(t.files.map(async (f) => ({ name: f.name, type: f.type, data: await fileB64(f) })));
      const r = await c.mailSend(draftRequest(what, { ...t, from: choosesFrom ? from : undefined, kept: t.kept ?? [] }, files, false));
      setItem({ id: r.id, mailbox: r.from.address, to: r.to, subject: r.subject, state: "waiting", send_at: r.send_at });
      set({ outbox: r.id }, false);
      setPreview(null);
    } catch (e) { setErr(plainError(e)); }
    setBusy(false);
  };
  /** Undo (while it waits) or Edit (once it was not sent): out of the outbox, back to the box as it was. */
  const takeBack = async () => {
    const c = engine.client;
    if (!c || !outboxId) return;
    setBusy(true);
    setErr("");
    try { await c.mailOutboxUndo(outboxId); set({ outbox: null }, false); setItem(undefined); }
    catch (e) { setErr(plainError(e)); try { setItem(await c.mailOutbox(outboxId)); } catch { /* the next look says */ } }
    setBusy(false);
  };
  const retry = async () => {
    const c = engine.client;
    if (!c || !outboxId) return;
    setBusy(true);
    setErr("");
    try { setItem(await c.mailOutboxRetry(outboxId)); setLooks((n) => n + 1); } catch (e) { setErr(plainError(e)); }
    setBusy(false);
  };
  /** Save draft, for a mail that was not sent: the hub puts it in Drafts as it is. */
  const outboxDraft = async () => {
    const c = engine.client;
    if (!c || !outboxId) return;
    setBusy(true);
    setErr("");
    try {
      await c.mailOutboxDraft(outboxId);
      WRITING.typed.delete(key);
      WRITING.open.delete(under ?? NEW_MAIL);
      setSaved(true);
      void act(async () => undefined);
    } catch (e) { setErr(plainError(e)); }
    setBusy(false);
  };
  const discard = () => {
    if (now.current.dirty && !window.confirm("Discard what you wrote? It is not saved to Drafts.")) return;
    WRITING.typed.delete(key);
    closing.current = true;
    close();
  };
  const head = reply ? <>{all ? "Reply all to" : "Reply to"} <b>{personLabel(reply.from)}</b> &lt;{reply.from.address}&gt;{all && " and the others on it"}</> : forward ? <>Forward <b>{forward.subject || "(no subject)"}</b></> : draft ? <b>Edit the draft</b> : <b>New mail</b>;
  if (sentDone) {
    return (
      <div className="mailx-compose mailx-card-pad" role="status" data-writing={key}>
        <span>{SEND_TEXTS.sent}</span>
        <button type="button" className="small" autoFocus onClick={() => { closing.current = true; close(); }}>Close</button>
      </div>
    );
  }
  if (outboxId && item !== null) {
    const face = outboxFace(item ?? { id: outboxId, mailbox: "", to: [], subject: "", state: "waiting", send_at: "" });
    if (face.face === "failed") {
      return (
        <div className="mailx-compose mailx-card-pad" role="alert" data-writing={key}>
          <b>{SEND_TEXTS.failed}</b>
          <span className="error small">{face.text}</span>
          <div className="mailx-compose-acts">
            <button type="button" className="primary" disabled={busy} onClick={() => void retry()}>Try again</button>
            <button type="button" disabled={busy} onClick={() => void outboxDraft()}>Save draft</button>
            <button type="button" disabled={busy} onClick={() => void takeBack()}>Edit</button>
            {err && <span className="error small">{err}</span>}
          </div>
        </div>
      );
    }
    return (
      <div className="mailx-compose mailx-card-pad" role="status" data-writing={key}>
        <div className="mailx-compose-acts">
          <b>{face.text}</b>
          {!!item?.to.length && <span className="muted small">To {item.to.join(", ")}</span>}
          {face.undo && <button type="button" className="small" autoFocus disabled={busy} onClick={() => void takeBack()}>Undo</button>}
          {err && <span className="error small" role="alert">{err}</span>}
        </div>
      </div>
    );
  }
  if (saved) {
    return (
      <div className="mailx-compose mailx-card-pad" role="status" data-writing={key}>
        <span>{sends ? `Saved to Drafts ${inProvider(box)}.` : `Saved to Drafts ${inProvider(box)}. Open Drafts in ${mailApp(box)} to send it.`}</span>
        <button type="button" className="small" autoFocus onClick={() => { closing.current = true; if (draft) void act(async () => undefined); close(); }}>Close</button>
      </div>
    );
  }
  if (preview) {
    return (
      <div className="mailx-compose mailx-card-pad" role="group" aria-label={sends ? "The mail as it will be sent" : "The mail as it will be saved"} data-writing={key}>
        <div className="muted small">{previewNote(box)}</div>
        <dl className="mailx-compose-head">
          <dt>From</dt><dd>{preview.from.name ? `${preview.from.name} <${preview.from.address}>` : preview.from.address}</dd>
          <dt>To</dt><dd>{preview.to.join(", ")}</dd>
          {!!preview.cc?.length && <><dt>Cc</dt><dd>{preview.cc.join(", ")}</dd></>}
          {!!preview.bcc?.length && <><dt>Bcc</dt><dd>{preview.bcc.join(", ")}</dd></>}
          {!!preview.files?.length && <><dt>Files</dt><dd>{preview.files.map((f) => `${f.name} (${fileSize(f.size)})`).join(", ")}</dd></>}
          {forward && typed.withTheirs && <><dt>Also</dt><dd>The mail's own attachments, added from your mailbox when it is saved</dd></>}
          <dt>Subject</dt><dd>{preview.subject || "(no subject)"}</dd>
        </dl>
        <div className="mailx-compose-text">{preview.text}</div>
        {draft && typed.html && <div className="muted small">{FORMATTED_DRAFT}</div>}
        <div className="mailx-compose-acts">
          {sends && <button ref={saveRef} type="button" className="primary" disabled={busy} onClick={() => void send()}>{busy ? "Sending" : "Send"}</button>}
          <button ref={sends ? undefined : saveRef} type="button" className={sends ? undefined : "primary"} disabled={busy} onClick={() => void ask(false)}>Save draft</button>
          <button type="button" disabled={busy} onClick={() => setPreview(null)}>Edit</button>
          <button type="button" className="link" onClick={discard}>Discard</button>
          {err && <span className="error small" role="alert">{err}</span>}
        </div>
      </div>
    );
  }
  return (
    <form className="mailx-compose mailx-card-pad" data-writing={key} onSubmit={(e) => { e.preventDefault(); if (typed.ready) void ask(true); }}
      onClick={(e) => { if (e.target instanceof Element && e.target.closest("button[type='button'], .mailx-attach")) toText(); }}>
      <div>{head}</div>
      {/* Which mail this answers: its sender, its time, and its first lines. */}
      {(reply ?? forward) && <div className="mailx-replying"><span className="muted small">{reply ? "Replying to" : "Forwarding"} {personLabel((reply ?? forward)!.from)} · {fmtDateTime((reply ?? forward)!.at)}</span>{(reply ?? forward)!.preview && <blockquote>{(reply ?? forward)!.preview}</blockquote>}</div>}
      {/* The sender asked for replies to go elsewhere: say so, since the reply goes to the address it came from. */}
      {reply?.reply_to && <div className="warn small">This mail asks for replies to go to {reply.reply_to}. Your reply goes to the address it came from, {reply.from.address}.</div>}
      {choosesFrom && (
        <label className="mailx-from small">From
          <select value={from} onChange={(e) => set({ from: e.target.value }, false)}>
            {boxes.map((b) => <option key={b.email} value={b.email}>{b.email}</option>)}
          </select>
        </label>
      )}
      {!reply && (
        <>
          <input value={typed.to} onChange={(e) => set({ to: e.target.value })} placeholder="To: alex@example.com" aria-label="To" autoComplete="off" spellCheck={false} />
          {/* A new mail's Cc: shown while it holds something (a mail the assistant wrote, opened with Edit). */}
          {!forward && !draft && !!typed.cc?.trim() && <label className="mailx-from small">Cc <input value={typed.cc} onChange={(e) => set({ cc: e.target.value })} placeholder="Cc" aria-label="Cc" autoComplete="off" spellCheck={false} /></label>}
          {!forward && <input value={typed.subject} onChange={(e) => set({ subject: e.target.value })} placeholder="Subject" aria-label="Subject" maxLength={200} />}
        </>
      )}
      {forward && <div className="muted small">The mail goes below your words.</div>}
      {forward && !!forward.attachments && <label className="mailx-check small"><input type="checkbox" checked={typed.withTheirs} onChange={(e) => set({ withTheirs: e.target.checked }, false)} /> Include its attachments ({forward.attachments})</label>}
      {draft && !typed.ready && (loadErr
        ? <div className="error small" role="alert">{loadErr} <button type="button" className="small" onClick={() => setLoadTry((n) => n + 1)}>Try again</button></div>
        : <div className="muted small">Reading the draft</div>)}
      {draft && typed.ready && <div className="muted small">{typed.html ? FORMATTED_DRAFT : sends ? "Sending it, or saving this version to Drafts, moves the old one to Trash." : "Saving puts this version in Drafts and moves the old one to Trash."}</div>}
      {reply && !!typed.smart.length && (
        <div className="mailx-smart" role="group" aria-label="Suggested replies">
          {typed.smart.map((r) => <button key={r} type="button" className="mailx-smart-one" onClick={() => set({ text: now.current.text.trim() ? `${now.current.text.trimEnd()}\n${r}` : r })}>{r}</button>)}
        </div>
      )}
      {reply && <AroundLine label="Greeting" value={typed.greeting} rows={1} waiting={suggesting} set={(v) => set({ greeting: v, touched: { ...now.current.touched, greeting: true } }, !!v)} />}
      <textarea ref={textRef} value={typed.text} onChange={(e) => set({ text: e.target.value })} rows={6} disabled={!typed.ready} placeholder={reply ? "Write your reply: just what you want to say" : forward ? "Add a note (optional)" : "Write your mail"} aria-label="Your mail" maxLength={50000} />
      {(!!kept.length || !!typed.files.length) && (
        <ul className="mailx-att-list">
          {/* A changed draft's own files stay on it until removed here. */}
          {kept.map((a) => <li key={`kept-${a.part}`}><Icon name="clip" /><span className="name">{a.name}</span><span className="muted small">{fileSize(a.size)}, kept from the draft</span><button type="button" className="small" onClick={() => set({ kept: kept.filter((x) => x.part !== a.part) }, false)}>Remove</button></li>)}
          {typed.files.map((f, i) => <li key={`${f.name}-${i}`}><Icon name="clip" /><span className="name">{f.name}</span><span className="muted small">{fileSize(f.size)}</span><button type="button" className="small" onClick={() => set({ files: typed.files.filter((_, j) => j !== i) }, false)}>Remove</button></li>)}
          <li className="muted small">{fileSize(filesBytes)} of 15 MB</li>
        </ul>
      )}
      {reply && <AroundLine label="Sign-off" value={typed.signoff} rows={2} waiting={suggesting} set={(v) => set({ signoff: v, touched: { ...now.current.touched, signoff: true } }, !!v)} />}
      <div className="mailx-compose-acts">
        <button type="submit" className="primary" disabled={busy || !typed.ready || (!forward && !typed.text.trim()) || (!reply && !typed.to.trim())}>{busy ? "Checking" : "Preview"}</button>
        <button type="button" className="link" onClick={discard}>Discard</button>
        <label className="mailx-attach" title="Attach files (at most 10, 15 MB in all)"><Icon name="clip" /><span>Attach</span><input type="file" multiple onChange={(e) => { addFiles(e.target.files); e.target.value = ""; toText(); }} /></label>
        <span className="muted small">{writeNote(box)}</span>
        {err && <span className="error small" role="alert">{err}</span>}
      </div>
    </form>
  );
}

/**
 * Mail that was not sent (the hub's outbox, since 2026-11-24), each with the hub's words for why, Try again, Save draft
 * and Discard (asked first): never lost, whether or not the box it was written in is still open. One that an open box
 * shows already is left to that box.
 */
function OutboxNotices({ items, composing }: { items: OutboxItem[]; composing: boolean }) {
  const { act } = useContext(Look);
  const [busy, setBusy] = useState(false);
  const shownInBox = (id: string) => [...WRITING.typed.entries()].some(([k, t]) => t.outbox === id && (k === NEW_MAIL ? composing : WRITING.open.has(k.slice(k.indexOf(":") + 1))));
  const failed = items.filter((x) => x.state === "failed" && !shownInBox(x.id) && !UNSUBSCRIBING.has(x.id));
  if (!failed.length) return null;
  const run = async (f: (c: HubClient) => Promise<unknown>) => { setBusy(true); await act(async (c) => { await f(c); }); setBusy(false); };
  return (
    <>
      {failed.map((x) => (
        <div key={x.id} className="mailx-compose mailx-card-pad" role="alert">
          <b>{outboxLine(x)}</b>
          {x.error && <span className="error small">{x.error}</span>}
          <div className="mailx-compose-acts">
            <button type="button" className="primary small" disabled={busy} onClick={() => void run((c) => c.mailOutboxRetry(x.id))}>Try again</button>
            <button type="button" className="small" disabled={busy} onClick={() => void run((c) => c.mailOutboxDraft(x.id))}>Save draft</button>
            <button type="button" className="link small" disabled={busy} onClick={() => { if (window.confirm(SEND_TEXTS.discard)) void run((c) => c.mailOutboxUndo(x.id)); }}>Discard</button>
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * A reply's greeting or sign-off: a short field (the hub takes at most 2 lines of plain words), with Remove; once
 * removed, Add brings back an empty one, which takes the focus to be typed in. `waiting`: the suggestion is on its way.
 */
function AroundLine({ label, value, rows, waiting, set }: { label: string; value: string | null; rows: number; waiting: boolean; set: (v: string | null) => void }) {
  const field = useRef<HTMLTextAreaElement>(null);
  const added = useRef(false);
  useEffect(() => {
    if (!added.current || value === null) return;
    added.current = false;
    field.current?.focus();
  }, [value]);
  if (value === null) return <button type="button" className="link small mailx-around-add" onClick={() => { added.current = true; set(""); }}>Add a {label.toLowerCase()}</button>;
  return (
    <div className="mailx-around">
      <textarea ref={field} value={value} onChange={(e) => set(e.target.value)} rows={rows} maxLength={130} aria-label={label} placeholder={waiting ? "Suggesting…" : label} />
      <button type="button" className="link small" onClick={() => set(null)} aria-label={`Remove the ${label.toLowerCase()}`}>Remove</button>
    </div>
  );
}

/**
 * Unsubscribe and Block for a mail's sender. Unsubscribe reads the mail's own ways now and says what each does: one
 * click through Tor, or (a hub without Tor) only after the owner accepts that the sender sees the home's address; the
 * sender's own page, opened in the browser with its host shown; or a mail to their unsubscribe address, sent with its
 * Undo (UnsubscribeByMail) or, from a mailbox without a sending server, saved to Drafts. Block sends
 * the sender's (or their domain's) mail to Spam, now and from now on; its Undo unblocks and moves that mail back. A
 * block the hub refuses (the owner's own address, a mail provider's whole domain) shows the hub's sentence.
 */
function SenderTools({ m, close }: { m: MailSummary; close: () => void }) {
  const { act, offerUndo, boxes } = useContext(Look);
  const app = mailApp(mailboxOf(boxes, m.mailbox));
  const [ways, setWays] = useState<UnsubscribeOptions | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [direct, setDirect] = useState(false);
  useEffect(() => {
    let live = true;
    engine.client?.mailUnsubscribeOptions(m.id).then((w) => { if (live) setWays(w); }).catch((e) => { if (live) setErr(plainError(e)); });
    return () => { live = false; };
  }, [m.id]);
  const run = async (f: () => Promise<string>) => {
    setBusy(true); setErr(""); setMsg("");
    try { setMsg(await f()); } catch (e) { setErr(plainError(e)); }
    setBusy(false);
  };
  const domain = m.from.address.split("@")[1] ?? "";
  const linkHost = ways?.link ? httpsLink(ways.link)?.host : undefined;
  /**
   * Block a sender (an address, or `@domain`). The list is loaded again, since their mail left the Inbox, with what
   * did not move said above it; the Undo bar says how many moved, and undoes all of it: the sender is unblocked, then
   * the mail that moved is moved back (the hub puts each one back as it was).
   */
  const block = (sender: string, who: string) => run(async () => {
    const r = await engine.client!.mailBlock(sender);
    const undo = blockUndo(r, who);
    await act(async () => { if (r.error) throw new Error(r.error); });
    offerUndo(undo.text, () => act(async (c) => {
      await c.mailUnblock(sender);
      for (const part of batches(undo.back)) { const one = await c.mailMove(part, "inbox", true); if (one.error) throw new Error(one.error); }
    }));
    return `Blocked ${who}: ${r.moved} moved to Spam, and their new mail goes there too.`;
  });
  return (
    <div className="mailx-compose mailx-card-pad" role="group" aria-label="Unsubscribe or block">
      <b>Unsubscribe</b>
      {!ways && !err && <span className="muted small">Reading the mail's unsubscribe links</span>}
      {ways && !ways.one_click && !ways.link && !ways.mailto && <span className="muted small">This mail has no unsubscribe link. You can block the sender instead.</span>}
      {ways?.one_click && (
        <div className="mailx-compose-acts">
          {ways.tor || direct
            ? <button type="button" className="primary" disabled={busy} onClick={() => void run(async () => { const r = await engine.client!.mailUnsubscribe(m.id, "one_click", !ways.tor); return r.via === "tor" ? "Unsubscribed, through Tor." : "Unsubscribed."; })}>Unsubscribe</button>
            : <button type="button" disabled={busy} onClick={() => setDirect(true)}>Unsubscribe…</button>}
          <span className="muted small">{ways.tor ? `Your hub tells ${ways.one_click.host} through Tor, so it does not see your home's internet address.` : direct ? `Your hub will contact ${ways.one_click.host}, which then sees your home's internet address. Press Unsubscribe to go ahead.` : `One click: your hub contacts ${ways.one_click.host}.`}</span>
        </div>
      )}
      {ways?.link && linkHost && (
        <div className="mailx-compose-acts">
          <button type="button" onClick={() => void openExternal(ways.link!)}>Open their unsubscribe page</button>
          <span className="muted small">Opens {linkHost} in your browser.</span>
        </div>
      )}
      {ways?.mailto && !readOnlyBox(boxes, m.mailbox) && (canSend(mailboxOf(boxes, m.mailbox))
        ? <UnsubscribeByMail m={m} from={mailboxOf(boxes, m.mailbox)!.email} to={ways.mailto.to} subject={ways.mailto.subject} />
        : (
          <div className="mailx-compose-acts">
            <button type="button" disabled={busy} onClick={() => void run(async () => { await engine.client!.mailUnsubscribe(m.id, "mailto"); return `A mail to ${ways.mailto!.to} is in Drafts: send it from ${app}.`; })}>{UNSUBSCRIBE_TEXTS.write}</button>
            <span className="muted small">{unsubscribeNote(ways.mailto.to, false)}</span>
          </div>
        ))}
      <b>Block</b>
      <div className="mailx-compose-acts">
        <button type="button" disabled={busy} onClick={() => void block(m.from.address, m.from.address)}>Block {m.from.address}</button>
        {domain && <button type="button" disabled={busy} onClick={() => void block(`@${domain}`, `everyone at ${domain}`)}>Block everyone at {domain}</button>}
      </div>
      {msg && <div className="small" role="status">{msg}</div>}
      {err && <div className="error small" role="alert">{err}</div>}
      <div><button type="button" className="link small" onClick={close}>Close</button></div>
    </div>
  );
}

/** Unsubscribe mail in the outbox that an open Unsubscribe or block card shows: the screen's notices leave it to that card. */
const UNSUBSCRIBING = new Set<string>();

/**
 * Unsubscribe by mail from a mailbox that sends (since 2026-11-24): the button shows the whole mail (from the mailbox
 * the mail is in, to the address its header gives, the header's subject and the word "unsubscribe"); Send puts it in
 * the hub's outbox, and the card then shows it as a writing box shows a sent mail: Sending with Undo while it waits,
 * Sent, or Not sent with the hub's words, Try again, Save draft and Discard.
 */
function UnsubscribeByMail({ m, from, to, subject }: { m: MailSummary; from: string; to: string; subject: string }) {
  const { act } = useContext(Look);
  const [asking, setAsking] = useState(false);
  const [id, setId] = useState<string | null>(null);
  const [item, setItem] = useState<OutboxItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [looks, setLooks] = useState(0);
  useEffect(() => {
    const c = engine.client;
    if (!id || !c) return;
    UNSUBSCRIBING.add(id);
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = async () => {
      let got: OutboxItem | null;
      try { got = await c.mailOutbox(id); } catch (e) {
        if (!(e instanceof HubError && e.status === 404)) { if (live) timer = setTimeout(() => void look(), 2000); return; }
        got = null;
      }
      if (!live) return;
      // Gone (taken back on another device, or long since sent): the button shows again.
      if (!got) { setId(null); setItem(null); return; }
      setItem(got);
      if (got.state === "waiting" || got.state === "sending") timer = setTimeout(() => void look(), 1000);
    };
    void look();
    // Closed with a mail that was not sent: the screen's notice shows it, with Try again.
    return () => { live = false; clearTimeout(timer); UNSUBSCRIBING.delete(id); void act(async () => undefined); };
  }, [id, looks]);
  const run = async (f: (c: HubClient) => Promise<void>) => {
    const c = engine.client;
    if (!c) return;
    setBusy(true); setErr("");
    try { await f(c); } catch (e) { setErr(plainError(e)); }
    setBusy(false);
  };
  const send = () => run(async (c) => { const r = await c.mailUnsubscribeSend(m.id); setItem(r.outbox); setId(r.outbox.id); setAsking(false); });
  const takeBack = () => run(async (c) => { await c.mailOutboxUndo(id!); setId(null); setItem(null); });
  const retry = () => run(async (c) => { setItem(await c.mailOutboxRetry(id!)); setLooks((n) => n + 1); });
  const draft = () => run(async (c) => { await c.mailOutboxDraft(id!); setId(null); setItem(null); setErr(""); });
  if (id) {
    const face = outboxFace(item);
    if (face.face === "sent") return <div className="small" role="status">{unsubscribeSent(to)}</div>;
    if (face.face === "failed") {
      return (
        <div className="mailx-compose-acts" role="alert">
          <b>{SEND_TEXTS.failed}</b>
          <span className="error small">{face.text}</span>
          <button type="button" className="primary small" disabled={busy} onClick={() => void retry()}>Try again</button>
          <button type="button" className="small" disabled={busy} onClick={() => void draft()}>Save draft</button>
          <button type="button" className="link small" disabled={busy} onClick={() => { if (window.confirm(SEND_TEXTS.discard)) void takeBack(); }}>Discard</button>
          {err && <span className="error small">{err}</span>}
        </div>
      );
    }
    return (
      <div className="mailx-compose-acts" role="status">
        <b>{SEND_TEXTS.sending}</b>
        <span className="muted small">To {to}</span>
        {face.undo && <button type="button" className="small" autoFocus disabled={busy} onClick={() => void takeBack()}>Undo</button>}
        {err && <span className="error small" role="alert">{err}</span>}
      </div>
    );
  }
  if (asking) {
    return (
      <div role="group" aria-label="The unsubscribe mail as it will be sent">
        <div className="muted small">{UNSUBSCRIBE_TEXTS.confirm}</div>
        <dl className="mailx-compose-head">
          <dt>From</dt><dd>{from}</dd>
          <dt>To</dt><dd>{to}</dd>
          <dt>Subject</dt><dd>{subject}</dd>
        </dl>
        <div className="mailx-compose-text">{UNSUBSCRIBE_TEXTS.text}</div>
        <div className="mailx-compose-acts">
          <button type="button" className="primary" autoFocus disabled={busy} onClick={() => void send()}>Send</button>
          <button type="button" disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
          {err && <span className="error small" role="alert">{err}</span>}
        </div>
      </div>
    );
  }
  return (
    <div className="mailx-compose-acts">
      <button type="button" onClick={() => { setErr(""); setAsking(true); }}>{UNSUBSCRIBE_TEXTS.send}</button>
      <span className="muted small">{unsubscribeNote(to, true)}</span>
    </div>
  );
}

/**
 * One message of a thread: a line (who, when, first words) that opens to the whole message; open from the start when
 * a reply or a forward is being written under it. A thread of one mail (`single`) shows it whole, with no line, and
 * is drawn the same way, so the mail and what is written under it stay as they are when a second mail arrives.
 */
function ThreadMessage({ m, single, startOpen }: { m: MailSummary; single: boolean; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen || WRITING.open.has(m.id));
  return (
    <section className={single ? "mailx-msg single" : `mailx-msg${open ? " open" : ""}${m.mine ? " mine" : ""}`}>
      {!single && (
        <button type="button" className="mailx-msg-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="who"><b>{m.mine ? "You" : personLabel(m.from)}</b> &lt;{m.from.address}&gt;</span>
          <span className="when">{fmtDateTime(m.at)}</span>
          {!open && <span className="line">{m.preview}</span>}
        </button>
      )}
      {(single || open) && <Message m={m} write />}
    </section>
  );
}

/**
 * A mail's cards above its body: each one's facts as text, and Track (a package) or Open when it has an https link.
 * The sender wrote all of it: nothing here is HTML, and the link opens outside the app, like any link in a mail.
 */
function MailFacts({ cards }: { cards: MailCard[] }) {
  return (
    <div className="mailx-facts mailx-card-pad">
      {cards.map((c, i) => {
        const href = cardLink(c);
        return (
          <div key={i} className={`mailx-fact b-${CARD_ICON[c.kind]}`}>
            <span className="mailx-av bundle" aria-hidden="true"><Icon name={CARD_ICON[c.kind]} /></span>
            <span className="what">{cardLine(c)}</span>
            {href && <button type="button" className="small" title={new URL(href).hostname} onClick={() => void openExternal(href)}>{c.kind === "package" ? "Track" : "Open"}</button>}
          </div>
        );
      })}
      {cards.some((c) => c.source === "text") && <span className="muted small">Read from the mail's text: check it against the mail.</span>}
    </div>
  );
}

/**
 * An open mail's attachments: read from the mailbox by the hub when the mail opens (the list kept with the mail says
 * whether there are any). Pictures show as previews (real pictures only, checked by the hub and here); each file has
 * Download, which saves it (never opens it here), after a warning for a kind of file that can run a program or hide
 * one (riskyFile). A long name is shortened by the page's own ellipsis, never cut here.
 */
function Attachments({ m }: { m: MailSummary }) {
  const [list, setList] = useState<MailAttachment[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    engine.client?.mailAttachments(m.id).then((r) => { if (live) setList(r.attachments); }).catch((e) => { if (live) setErr(plainError(e)); });
    return () => { live = false; };
  }, [m.id]);
  // Each picture's preview is checked once, when the list arrives (previewSrc: a data: picture and nothing else).
  const pics = useMemo(() => (list ?? []).flatMap((a) => { const src = previewSrc(a.preview); return src ? [{ a, src }] : []; }), [list]);
  const save = async (a: MailAttachment) => {
    const c = engine.client;
    if (!c) return;
    if (riskyFile(a.name) && !window.confirm(`${a.name} is a kind of file that can run a program on your computer, or hide one. Download it only if you expected it from ${m.from.address}.`)) return;
    setBusy(a.part);
    setErr("");
    try { saveBlob(await c.mailAttachment(m.id, a.part), a.name); } catch (e) { setErr(plainError(e)); }
    setBusy(null);
  };
  if (!list && !err) return m.attachments ? <div className="muted small mailx-card-pad">Loading {m.attachments === 1 ? "the attachment" : `${m.attachments} attachments`}</div> : null;
  if (list && !list.length) return null;
  return (
    <div className="mailx-atts mailx-card-pad">
      {!!pics.length && (
        <div className="mailx-att-pics">
          {pics.map(({ a, src }) => <button key={a.part} type="button" className="mailx-att-pic" title={`Download ${a.name}`} onClick={() => void save(a)}><img src={src} alt={a.name} /></button>)}
        </div>
      )}
      {list && (
        <ul className="mailx-att-list">
          {list.map((a) => (
            <li key={a.part}>
              <Icon name="clip" />
              <span className="name">{a.name}</span>
              <span className="muted small">{fileSize(a.size)}</span>
              {riskyFile(a.name) && <span className="warn small">Can run or hide a program</span>}
              <button type="button" className="small" disabled={busy === a.part} onClick={() => void save(a)}>{busy === a.part ? "Downloading" : "Download"}</button>
            </li>
          ))}
        </ul>
      )}
      {err && <div className="error small">{err}</div>}
    </div>
  );
}

/**
 * "Something important missing?": the first lines the fold hides, to mark the ones that matter, and Don't fold this
 * mail. Saved as a note on the mail on the hub (with it, and never sent anywhere), to improve how mail is folded.
 */
function FoldNotePanel({ m, lines, done }: { m: MailSummary; lines: string[]; done: (unfold: boolean) => void }) {
  const { act } = useContext(Look);
  const [marked, setMarked] = useState<string[]>([]);
  const [unfold, setUnfold] = useState(true);
  const [err, setErr] = useState("");
  const save = async () => {
    try {
      await engine.client!.mailFolding(m.id, { lines: marked, no_fold: unfold });
      await act(async () => undefined);
      done(unfold);
    } catch (e) { setErr(plainError(e)); }
  };
  return (
    <div className="mailx-compose mailx-card-pad" role="group" aria-label="Something important missing?">
      <b>Something important folded away?</b>
      {!!lines.length && <span className="muted small">Mark the lines that matter. They stay on your hub as a note for improving how mail is folded.</span>}
      {lines.map((l) => (
        <label key={l} className="mailx-check small"><input type="checkbox" checked={marked.includes(l)} onChange={(e) => setMarked(e.target.checked ? [...marked, l] : marked.filter((x) => x !== l))} /> {l}</label>
      ))}
      <label className="mailx-check small"><input type="checkbox" checked={unfold} onChange={(e) => setUnfold(e.target.checked)} /> Don't fold this mail</label>
      <div className="mailx-compose-acts">
        <button type="button" className="primary" disabled={!marked.length && !unfold} onClick={() => void save()}>Save</button>
        <button type="button" className="link" onClick={() => done(false)}>Cancel</button>
        {err && <span className="error small">{err}</span>}
      </div>
    </div>
  );
}

/** The folding notes the owner made, to look over (and turn into made-up test mail), with Clear. */
function FoldNotesList() {
  const [notes, setNotes] = useState<{ id: string; subject: string; from: string; note: FoldNote }[] | null>(null);
  useEffect(() => { engine.client?.mailFoldNotes().then((r) => setNotes(r.notes)).catch(() => setNotes([])); }, []);
  if (!notes?.length) return null;
  return (
    <div className="mailx-blocked">
      <b>Folding notes ({notes.length})</b>
      <span className="muted">Where folding hid something you marked. Kept with each mail on your hub, never sent anywhere.</span>
      {notes.map((n) => (
        <div key={n.id}>
          <div>{n.subject || "(no subject)"} <span className="muted">· {n.from}{n.note.no_fold ? " · not folded" : ""}</span></div>
          <div className="muted">Folded at: {n.note.cut || "(the page's own fold)"}</div>
          {n.note.lines.map((l) => <div key={l}>✓ {l}</div>)}
        </div>
      ))}
      <button type="button" className="link small" onClick={() => void engine.client?.mailClearFoldNotes().then(() => setNotes([]))}>Clear the notes</button>
    </div>
  );
}

/**
 * A message, with Reply, Reply all and Forward under it (`write`): the writing box opens right below it, and is open
 * again when it was open before (the thread closed and opened, the list changed under it).
 */
function Message({ m, write: asked = false }: { m: MailSummary; write?: boolean }) {
  const { boxes } = useContext(Look);
  // Replies are drafts saved to the mailbox: none for a Read only one.
  const write = asked && !readOnlyBox(boxes, m.mailbox);
  const [w, setWState] = useState<"one" | "all" | "forward" | null>(() => { const k = write ? WRITING.open.get(m.id) : undefined; return k === "one" || k === "all" || k === "forward" ? k : null; });
  const setW = (k: "one" | "all" | "forward" | null) => { if (k) WRITING.open.set(m.id, k); else WRITING.open.delete(m.id); setWState(k); };
  const btn = (k: "one" | "all" | "forward", icon: string, label: string) => (
    <button type="button" className={`mailx-act${w === k ? " on" : ""}`} aria-expanded={w === k} onClick={() => setW(w === k ? null : k)}><Icon name={icon} /><span>{label}</span></button>
  );
  return (
    <>
      <MessageBody m={m} />
      {write && <div className="mailx-card-acts mailx-card-pad mailx-msg-acts">{!m.mine && btn("one", "reply", "Reply")}{!m.mine && btn("all", "replyall", "Reply all")}{btn("forward", "forward", "Forward")}</div>}
      {/* Reply and Reply all are one writing box: what is typed stays when one is pressed after the other. */}
      {w === "forward" ? <Composer key="forward" forward={m} close={() => setW(null)} /> : w ? <Composer key="reply" reply={m} all={w === "all"} close={() => setW(null)} /> : null}
    </>
  );
}

/** One message's body: the mail as sent (the hub's cleaned page), or its text; fetched from the hub when it shows. */
function MessageBody({ m }: { m: MailSummary }) {
  const [full, setFull] = useState<MailMessage | null>(null);
  const [err, setErr] = useState("");
  const [asText, setAsText] = useState(false);
  // The quoted history under a reply: folded until "•••" is pressed (its page marks it, or its text's quote line).
  const [showQuote, setShowQuote] = useState(false);
  const [noting, setNoting] = useState(false);
  const [pageQuote, setPageQuote] = useState(false);
  const asPage = !!full?.html && !asText;
  const hasQuote = asPage ? pageQuote : full?.quote_at !== undefined;
  const text = full && !asPage && full.quote_at !== undefined && !showQuote ? full.text.slice(0, full.quote_at).trimEnd() : full?.text ?? "";
  useEffect(() => {
    let live = true;
    engine.client?.mailMessage(m.id).then((x) => { if (live) { setFull(x); if (x.no_fold) setShowQuote(true); } }).catch((e) => { if (live) setErr(plainError(e)); });
    return () => { live = false; };
  }, [m.id]);
  // Show pictures (a hub without Tor): the hub fetches this mail's pictures from its sender now, and the mail comes
  // back with them written in.
  const [pictures, setPictures] = useState<{ busy: boolean; error: string }>({ busy: false, error: "" });
  const showPictures = async () => {
    const c = engine.client;
    if (!c) return;
    setPictures({ busy: true, error: "" });
    try {
      setFull(await c.mailShowPictures(m.id));
      setPictures({ busy: false, error: "" });
    } catch (e) { setPictures({ busy: false, error: plainError(e) }); }
  };
  const askPictures = asPage && !!full?.pictures_ask;
  return (
    <>
      {nameHidesAddress(m.from) && <div className="warn small mailx-card-pad">The sender's name shows a different address than the one it came from.</div>}
      {!!m.cards?.length && <MailFacts cards={m.cards} />}
      {m.attachments !== undefined && <Attachments m={m} />}
      {askPictures && (
        <div className="mailx-pictures mailx-card-pad small">
          <button type="button" disabled={pictures.busy} onClick={() => void showPictures()}>{pictures.busy ? "Fetching pictures" : "Show pictures"}</button>
          <span className="muted">This mail's pictures are not loaded. Your hub would fetch them from the sender, who then sees your home's internet address. A hub with Tor loads pictures on its own, without showing it.</span>
          {pictures.error && <span className="error" role="alert">{pictures.error}</span>}
        </div>
      )}
      {err ? <div className="error mailx-card-pad">{err}</div>
        : !full ? <div className="muted small mailx-card-pad">Loading</div>
        : asPage ? <div className="mailx-page"><MailFrame doc={full.html!} title={m.subject || "Mail"} showQuote={showQuote} onQuote={setPageQuote} /></div>
        : <div className="mailx-text mailx-card-pad"><Linked text={text} /></div>}
      {full && hasQuote && (
        <div className="mailx-card-pad">
          <button type="button" className="mailx-fold" aria-expanded={showQuote} title={showQuote ? "Hide the quoted text" : "Show the quoted text"} onClick={() => setShowQuote(!showQuote)}>•••</button>
          {m.state !== "folder" && <button type="button" className="link small mailx-foldnote-btn" aria-expanded={noting} onClick={() => setNoting((x) => !x)}>Folded too much?</button>}
        </div>
      )}
      {full && noting && <FoldNotePanel m={m} lines={foldedLines(full.text, full.quote_at)} done={(unfold) => { setNoting(false); if (unfold) { setShowQuote(true); setFull({ ...full, quote_at: undefined, no_fold: true }); } }} />}
      {full && (
        <div className="mailx-card-foot mailx-card-pad muted small">
          {full.html ? (
            <>
              {asText ? "Shown as text." : full.pictures_pending ? "The hub is still fetching this mail's pictures." : full.pictures_ask ? "Shown as sent, without its pictures." : "Shown as sent. Pictures were fetched by the hub, not this device."}
              {" "}<button type="button" className="link" onClick={() => setAsText(!asText)}>{asText ? "Show as sent" : "Show as text"}</button>
            </>
          ) : "Shown as text: this mail has no other version."}
        </div>
      )}
    </>
  );
}

/** The tallest a mail's frame gets, in px (a long newsletter is 10,000 to 15,000). */
const FRAME_MAX = 30_000;

/**
 * The mail as sent, in a frame sandboxed without the permission to run scripts: nothing in it can run, whatever got past the hub's
 * cleaning, and its own policy (mail-html.ts on the hub) loads nothing. `allow-same-origin` only lets this screen's
 * code reach in to size the frame to the mail, check its links and take their clicks: a link opens in the browser
 * (http, https or mailto only), never inside the frame, and shows its real address when pointed at.
 * `allow-popups allow-popups-to-escape-sandbox`: WebKit (Safari) runs none of this screen's listeners inside the frame,
 * so there the browser opens a link itself, in a new tab with no opener and no referrer, once checkFrameLinks has kept
 * only the links frameLink accepts (2026-11-22). Elsewhere the click is still the screen's, through openExternal.
 */
function MailFrame({ doc, title, showQuote, onQuote }: { doc: string; title: string; showQuote: boolean; onQuote: (has: boolean) => void }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const unfold = useRef(showQuote);
  unfold.current = showQuote;
  /** The page has quoted history and something besides it. */
  const foldable = useRef(false);
  // The quoted history: the page folds it (its body's `aeneas-fold`); this screen's code unfolds it on "•••".
  useEffect(() => {
    const d = ref.current?.contentDocument;
    if (!d?.body) return;
    d.body.classList.toggle("aeneas-fold", foldable.current && !showQuote);
    // Measured as the frame's own fit does: at no height first, at most FRAME_MAX.
    const frame = ref.current!;
    frame.style.height = "0px";
    frame.style.height = `${Math.min(Math.max(d.documentElement.scrollHeight, 60), FRAME_MAX)}px`;
  }, [showQuote]);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    // A click, and a middle click (an auxclick), on a link: opened by the app when frameLink allows it, never by the page.
    const onClick = (e: MouseEvent) => {
      const c = frameClick(e);
      if (!c) return;
      e.preventDefault();
      if (c.open) void openExternal(c.open);
    };
    const ready = () => {
      const d = frame.contentDocument;
      if (!d) return;
      // The mail's own height: measured with the frame at no height, then given to the frame. Measured in a frame
      // of its last height, a mail sized by the frame itself (height: 100% all the way up, or 110vh) grew with every
      // measurement: an ordinary newsletter by 24 px a frame without end, a crafted one to millions of px in seconds
      // (2026-11-20). At most FRAME_MAX tall; a longer mail scrolls inside its frame.
      const fit = () => {
        frame.style.height = "0px";
        frame.style.height = `${Math.min(Math.max(d.documentElement.scrollHeight, 60), FRAME_MAX)}px`;
      };
      checkFrameLinks(d.querySelectorAll("a[href], area[href]"));
      // Folded only when something is left to read: a forward (or any mail that is all quote) folded was a blank page.
      d.body?.classList.add("aeneas-fold");
      foldable.current = !!d.querySelector(QUOTE_SELECTOR) && !!d.body && (d.body.innerText.trim().length > 0 || !!d.body.querySelector("img"));
      onQuote(foldable.current);
      d.body?.classList.toggle("aeneas-fold", foldable.current && !unfold.current);
      d.addEventListener("click", onClick);
      d.addEventListener("auxclick", onClick);
      observer = new ResizeObserver(fit);
      observer.observe(d.documentElement);
      fit();
    };
    frame.addEventListener("load", ready);
    return () => { frame.removeEventListener("load", ready); observer?.disconnect(); frame.contentDocument?.removeEventListener("click", onClick); frame.contentDocument?.removeEventListener("auxclick", onClick); };
  }, [doc]);
  return <iframe ref={ref} className="mailx-frame" title={title} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={doc} />;
}

function Empty({ title, text }: { title: string; text: string }) {
  return <div className="mailx-empty"><Icon name="sun" /><b>{title}</b><span>{text}</span></div>;
}

/**
 * Text with the https addresses written in it as links (the address itself is the link's text), opened in the browser.
 * An address in another alphabet's letters has its real host beside it.
 */
function Linked({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <Fragment key={i}>
          {i > 0 && "\n"}
          <Parts parts={textParts(line)} />
        </Fragment>
      ))}
    </>
  );
}

/** A line's pieces from textParts (which checks every link): text, and links opened in the browser. */
function Parts({ parts }: { parts: TextPart[] }) {
  return (
    <>
      {parts.map((p, j) => p.href ? (
        <Fragment key={j}>
          <a href={p.href} target="_blank" rel="noopener noreferrer" onClick={(e) => { e.preventDefault(); void openExternal(p.href!); }}>{p.text}</a>
          {p.host && <span className="muted small"> ({p.host})</span>}
          {p.warnHost && <span className="warn small" title="This address uses letters from another alphabet that look like these."> ({p.warnHost})</span>}
        </Fragment>
      ) : <Fragment key={j}>{p.text}</Fragment>)}
    </>
  );
}

/** The screen's own icons, drawn here (no image or font is loaded for them). */
const ICONS: Record<string, string> = {
  menu: "M4 7h16M4 12h16M4 17h16",
  inbox: "M4 13l2.5-7h11L20 13v5H4zM4 13h4.5l1 2h5l1-2H20",
  clock: "M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16zM12 8v4l3 2",
  check: "m5 12.5 4.5 4.5L19 7.5",
  bell: "M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0",
  refresh: "M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4",
  plus: "M12 5v14M5 12h14",
  pencil: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  reply: "M9 15l-5-5 5-5M4 10h10a6 6 0 0 1 6 6v3",
  send: "M4 12l16-8-6 16-3-7zM11 13l9-9",
  minus: "M6 12h12",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM16 16l4 4",
  spam: "M12 3l8 3v6c0 4.5-3.5 8-8 9-4.5-1-8-4.5-8-9V6zM12 8v5M12 16v.5",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  folder: "M3 6h6l2 2h10v11H3z",
  replyall: "M7 15l-5-5 5-5M12 15l-5-5 5-5M7 10h7a6 6 0 0 1 6 6v3",
  forward: "M15 15l5-5-5-5M20 10H10a6 6 0 0 0-6 6v3",
  person: "M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM4 20c1.5-4 4.5-6 8-6s6.5 2 8 6",
  clip: "M8 12.5l6.5-6.5a3 3 0 0 1 4.2 4.2L10 19a5 5 0 0 1-7-7l8-8",
  own: "M7 4h10v16l-5-4-5 4z",
  dot: "M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z",
  pin: "M9 4h6l-1 6 3 3H7l3-3zM12 13v7",
  sun: "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  // The built-in bundles, by id (lib/mail.ts, BUNDLES): Transactions is `purchases`, Updates `other`, Promotions `promos`.
  purchases: "M4 8h15l-3.5-3.5M20 16H5l3.5 3.5",
  trips: "M10 18 8 21M3 13l7 1 6-8c1-1.3 3-1 3 .5L17 14l3 5-2 1-4-4-4 1z",
  other: "M5 21V4h12l-2.5 4 2.5 4H5",
  promos: "M4 4h7l9 9-7 7-9-9zM8.5 7.2a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6z",
  bills: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3",
  pet: "M7 8.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6zM11 4.7a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6zM15.5 5.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6zM18 9.2a1.8 1.8 0 1 0 0 3.6a1.8 1.8 0 1 0 0-3.6zM8.5 18c0-3 1.8-5.5 4-5.5s4 2.5 4 5.5c0 1.5-1.3 2-2.5 1.6l-1.5-.5-1.5.5C9.8 20 8.5 19.5 8.5 18z",
};
/** Three lines: drawn for a name that has no icon of its own. */
const PLAIN_ICON = "M4 6h16M4 12h16M4 18h10";
function Icon({ name }: { name: string }) {
  return <svg className="mailx-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={ICONS[name] ?? PLAIN_ICON} /></svg>;
}
