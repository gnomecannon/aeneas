import { trafficLight } from "../lib/ops";
import { useEffect, useState, type ReactNode } from "react";
import { HubChip } from "./HubChip";
import { showKeyboardHints } from "../lib/keyboardHints";
import { listedKeys } from "../lib/keys";
import { refreshHubIdentity, useHubTitle } from "../lib/hubIdentity";
import { useLiveQuery } from "dexie-react-hooks";
import { taskAlertAt } from "@everythingapp/shared";
import { go, type Route } from "../lib/router";
import { useEntities } from "../sync/hooks";
import { db } from "../sync/db";
import { StatusDot } from "./StatusDot";
import { ScreenBoundary } from "./ScreenBoundary";
import { SETTINGS_TITLES, settingsBack } from "../views/settings/common";
import { openWindow } from "../tauri/bridge";
import { usePetName } from "../lib/profile";
import { moduleOfScreen, useModules } from "../lib/modules";
import { useOpenAreas } from "../lib/libraryOpen";

/**
 * `also`: other paths that are this screen's own pages (a machine's page is the Overview's), so it shows as the one you
 * are on there. `unless`: a module that, when on, hides this item (Sensors is the Overview's when Machines is on).
 */
type Item = { path: string; label: string; also?: string[]; unless?: string };

/** The main screens: the sidebar's top block on desktop and the tab bar on a phone. */
export const PRIMARY: Item[] = [
  { path: "/today", label: "Today" },
  { path: "/assistant", label: "Assistant" },
  { path: "/capture", label: "Capture" },
];

/** Every other screen, grouped by area of life. The same groups as the Apple app's Library. */
export const AREAS: Array<{ title: string; items: Item[] }> = [
  { title: "Plan", items: [
    { path: "/inbox", label: "Unsorted Info" },
    { path: "/tasks", label: "Tasks" },
    { path: "/week", label: "Week" },
    { path: "/renewals", label: "Renewals" },
    { path: "/dashboard", label: "Dashboard" },
  ] },
  { title: "Notes", items: [
    { path: "/notes", label: "Notes" },
    { path: "/memory", label: "Memory" },
    { path: "/people", label: "People" },
    { path: "/reference", label: "Reference" },
  ] },
  // Since 2026-11-19 one screen: a card per machine, service and place, each opening its page (checks, readings, fix
  // notes, changes, snippets). With Machines off, the home sensors are the Sensors screen.
  { title: "Tech", items: [
    { path: "/ops", label: "Overview", also: ["/hosts", "/journal", "/snippets"] },
    { path: "/sensors", label: "Sensors", unless: "homelab" },
  ] },
  { title: "Making", items: [
    { path: "/projects", label: "Projects" },
    { path: "/procedures", label: "Procedures" },
    { path: "/music", label: "Music" },
    { path: "/wiki", label: "Wiki" },
    { path: "/gallery", label: "Image Gallery" },
    { path: "/quiz", label: "Recall quiz" },
    { path: "/layouts", label: "Layout sketches" },
  ] },
  { title: "Body and home", items: [
    { path: "/health", label: "Health" },
    { path: "/logs", label: "Logs" },
    { path: "/pet", label: "Pet" },
    { path: "/food", label: "Food" },
  ] },
  { title: "Life admin", items: [
    { path: "/mail", label: "Mail" },
    { path: "/lists", label: "Lists" },
    { path: "/games", label: "Games" },
    { path: "/films", label: "Films" },
    { path: "/calc", label: "Calculators" },
  ] },
];

const SYSTEM: Item[] = [{ path: "/status", label: "Status" }];

/** Settings is not a screen in the list: a gear at the foot of the sidebar, and at the top right on a phone. */
const SETTINGS: Item = { path: "/settings", label: "Settings" };

export const NAV: Item[] = [...PRIMARY, ...AREAS.flatMap((a) => a.items), ...SYSTEM, SETTINGS];

/** Screens not in the lists above, by path, for the window title. */
const OTHER: Item[] = [
  { path: "/now", label: "Now" },
  { path: "/hosts", label: "Machine" },
  { path: "/journal", label: "Change journal" },
  { path: "/snippets", label: "Snippets" },
  { path: "/sensors", label: "Sensors" },
  { path: "/search", label: "Search" },
  { path: "/library", label: "Library" },
  { path: "/more", label: "Library" },
  { path: "/plan-rules", label: "Plan rules" },
  { path: "/notes/map", label: "Notes map" },
  { path: "/images", label: "Create image" },
  { path: "/lists/jobs", label: "Job applications" },
  { path: "/career", label: "Job applications" },
  { path: "/reminders", label: "Tasks" },
  { path: "/item", label: "Item" },
  { path: "/welcome", label: "Welcome" },
  { path: "/help/connections", label: "Connections help" },
];

/**
 * The screen a path shows: its name, for the window title, and a key that changes only when the screen does. A note
 * picked in Notes or a chat in the Assistant stays on that screen; each Settings page and each item is one of its own.
 * A path the app does not know shows Now.
 */
export function screenOf(path: string): { key: string; title: string } {
  if (path === "/settings" || path.startsWith("/settings/")) {
    let p = path;
    while (p.length > "/settings".length && !SETTINGS_TITLES[p]) p = p.slice(0, p.lastIndexOf("/"));
    return { key: path, title: SETTINGS_TITLES[p] ?? "Settings" };
  }
  const hit = [...NAV, ...OTHER].filter((n) => path === n.path || path.startsWith(n.path + "/")).sort((a, b) => b.path.length - a.path.length)[0];
  if (!hit) return { key: "/now", title: "Now" };
  return { key: hit.path === "/item" ? path : hit.path, title: hit.label };
}

/** The screen last started (see ScreenStart); kept outside the component, which a switched-off module unmounts. */
let shownScreen: string | null = null;

/**
 * Placed after the screen, inside its loading boundary, so it runs once the new screen has drawn: the screen starts
 * at its top, not part way down where the last one was scrolled, and the keyboard focus moves to its heading (a
 * screen reader says where you are; Tab goes on from the top). The first screen after the app opens keeps the
 * browser's own focus.
 */
export function ScreenStart({ screen }: { screen: string }) {
  useEffect(() => {
    if (shownScreen === screen) return;
    const first = shownScreen === null;
    shownScreen = screen;
    if (first) return;
    window.scrollTo(0, 0);
    const main = document.getElementById("main");
    // A screen that put the focus somewhere itself (Capture's text box) keeps it there.
    if (main?.contains(document.activeElement) && document.activeElement !== main) return;
    const heading = main?.querySelector<HTMLElement>("h1") ?? main;
    if (!heading) return;
    if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [screen]);
  return null;
}

/** The keyboard shortcuts line, naming only screens of modules that are on. */
function keysHint(on: (id: string | undefined) => boolean): string {
  return listedKeys(on).map((k) => `${k.key} ${k.label}`).join(", ");
}

/** The Library areas with only the screens of modules that are on (Settings, Modules); an emptied area goes too. */
export function useAreas(): typeof AREAS {
  const { on } = useModules();
  return AREAS.map((a) => ({ ...a, items: a.items.filter((i) => on(moduleOfScreen(i.path)) && !(i.unless && on(i.unless))) })).filter((a) => a.items.length);
}

function Gear({ active }: { active: boolean }) {
  return (
    <a href={`#${SETTINGS.path}`} className={`gear${active ? " active" : ""}`} aria-label="Settings" title="Settings" aria-current={active ? "page" : undefined}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </a>
  );
}

/** Opens the current screen in its own window, for a second monitor. Desktop sidebar only. */
function PopOut({ route }: { route: Route }) {
  const p = route.path;
  if (p.startsWith("/settings") || p === "/library" || p === "/more") return null;
  const label = NAV.filter((n) => p === n.path || p.startsWith(n.path + "/")).sort((a, b) => b.path.length - a.path.length)[0]?.label ?? "Aeneas";
  const q = route.params.toString();
  return (
    <button type="button" className="popout-btn" title={`Open ${label} in its own window`} aria-label={`Open ${label} in its own window`} onClick={() => void openWindow(q ? `${p}?${q}` : p, label)}>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
      </svg>
    </button>
  );
}

/** Phone tabs. Today carries the Now card; Library holds everything else by area. */
const TABS: Item[] = [...PRIMARY, { path: "/library", label: "Library" }, { path: "/search", label: "Search" }];

/**
 * Marks <html class="kb-open"> while the on-screen keyboard is up (visual viewport much shorter than
 * the layout viewport), so the bottom tab bar gets out of the way of whatever is being typed into.
 */
function useKeyboardOpen() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const open = vv.height < window.innerHeight * 0.75;
      document.documentElement.classList.toggle("kb-open", open);
    };
    vv.addEventListener("resize", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      document.documentElement.classList.remove("kb-open");
    };
  }, []);
}

function useInboxCount(): number {
  return useEntities("capture", (e) => !e.fields.processed).length;
}

function PetLabel() {
  return <>{usePetName()}</>;
}

function RailLink({ item, active, inbox }: { item: Item; active: boolean; inbox: number }) {
  return (
    <a href={`#${item.path}`} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>
      <span>{item.path === "/pet" ? <PetLabel /> : item.label}</span>
      {item.path === "/inbox" && inbox > 0 && (
        <span className="badge" aria-label={`${inbox} to sort`}>
          {inbox}
        </span>
      )}
    </a>
  );
}

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const inbox = useInboxCount();
  const [q, setQ] = useState("");
  const [openAreas, toggleArea] = useOpenAreas();
  const areas = useAreas();
  const { on } = useModules();
  useKeyboardOpen();
  useHubTitle(screenOf(route.path).title);
  useEffect(() => {
    void refreshHubIdentity();
    const again = () => { if (document.visibilityState === "visible") void refreshHubIdentity(); };
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, []);
  const at = (p: string) => route.path === p || route.path.startsWith(p + "/");
  const active = (p: string) => at(p) || !!NAV.find((n) => n.path === p)?.also?.some(at);
  // A closed area opens for as long as it holds the screen you are on (reached by search or a shortcut, say),
  // without being remembered as open; closing it then keeps it closed until you move to another area.
  const here = areas.find((a) => a.items.some((i) => active(i.path)))?.title ?? null;
  const [shut, setShut] = useState<string | null>(null);
  useEffect(() => setShut(null), [here]);
  const isOpen = (title: string) => openAreas.includes(title) || (title === here && shut !== title);
  const toggle = (title: string) => {
    if (!isOpen(title)) return toggleArea(title);
    if (openAreas.includes(title)) toggleArea(title);
    if (title === here) setShut(title);
  };
  // A Settings sub-page leads back to the page above it rather than all the way to Library.
  const back = settingsBack(route.path);
  const inLibrary = AREAS.some((a) => a.items.some((i) => active(i.path))) || SYSTEM.some((i) => active(i.path)) || active("/plan-rules");
  const inSettings = active(SETTINGS.path);
  // Library is the phone's home for every screen that is not a tab.
  const tabActive = (p: string) =>
    p === "/library" ? !PRIMARY.some((x) => active(x.path)) && !active("/search") && !active("/now") : active(p) || (p === "/today" && active("/now"));

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">Aeneas</div>
        <HubChip />
        <form
          className="search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) go(`/search?q=${encodeURIComponent(q.trim())}`);
          }}
        >
          <input placeholder="Search everything" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" data-search="" />
        </form>
        <nav aria-label="Primary">
          {PRIMARY.map((n) => <RailLink key={n.path} item={n} active={active(n.path)} inbox={inbox} />)}
          {areas.map((area) => {
            const open = isOpen(area.title);
            const waiting = !open && area.items.some((i) => i.path === "/inbox") ? inbox : 0;
            return (
              <div key={area.title} className="rail-area">
                <button type="button" className="rail-group" aria-expanded={open} onClick={() => toggle(area.title)}>
                  <span>{area.title}</span>
                  <span className="rail-group-end">
                    {waiting > 0 && <span className="badge" aria-label={`${waiting} to sort`}>{waiting}</span>}
                    <span aria-hidden="true">{open ? "▾" : "▸"}</span>
                  </span>
                </button>
                {open && area.items.map((n) => <RailLink key={n.path} item={n} active={active(n.path)} inbox={inbox} />)}
              </div>
            );
          })}
        </nav>
        <div className="spacer" />
        <nav aria-label="System">
          {SYSTEM.map((n) => <RailLink key={n.path} item={n} active={active(n.path)} inbox={inbox} />)}
        </nav>
        <div className="rail-foot">
          <StatusDot />
          <PopOut route={route} />
          <Gear active={inSettings} />
        </div>
        {showKeyboardHints() && (
          <div className="muted small keys-hint" aria-hidden="true">
            {keysHint(on)}
          </div>
        )}
      </aside>
      {/* Every screen has the whole window beside the sidebar; each lays itself out for the width it gets. */}
      <main className="main" id="main">
        <div className="topbar">
          {/* Phone: the screen names itself, so the bar offers the way back to Library instead of repeating the title. */}
          {back ? (
            <a href={`#${back.path}`} className="back">{"\u2039"} {back.label}</a>
          ) : inLibrary ? (
            <a href="#/library" className="back">{"\u2039"} Library</a>
          ) : inSettings ? (
            <button type="button" className="back link" onClick={() => (history.length > 1 ? history.back() : go("/today"))}>
              {"\u2039"} Back
            </button>
          ) : (
            <span />
          )}
          <span className="topbar-right">
            <HubChip compact />
            <StatusDot compact />
            {!inSettings && <Gear active={false} />}
          </span>
        </div>
        <ScreenBoundary resetKey={route.path}>{children}</ScreenBoundary>
      </main>
      <nav className="tabs" aria-label="Sections">
        {TABS.map((t) => {
          const isActive = tabActive(t.path);
          return (
            <a key={t.path} href={`#${t.path}`} className={isActive ? "active" : ""} aria-current={isActive ? "page" : undefined}>
              {t.label}
              {t.path === "/library" && inbox > 0 && (
                <span className="badge" aria-label={`${inbox} to sort`}>
                  {inbox}
                </span>
              )}
            </a>
          );
        })}
      </nav>
    </div>
  );
}

/** One short line per screen: what is waiting there right now. */
function useSummaries(): Record<string, string> {
  return (
    useLiveQuery(async () => {
      const all = await db.entities.filter((e) => !e.deleted_at).toArray();
      const by = new Map<string, typeof all>();
      for (const e of all) {
        const list = by.get(e.kind);
        if (list) list.push(e);
        else by.set(e.kind, [e]);
      }
      const of = (k: string) => by.get(k) ?? [];
      const n = (c: number, one: string, many: string) => (c === 1 ? `1 ${one}` : `${c} ${many}`);
      const today = new Date().toDateString();
      const soon = Date.now() + 30 * 86_400_000;
      const sortable = of("capture").filter((e) => !e.fields.processed).length;
      const next = of("task").filter((e) => ["next", "doing"].includes(String(e.fields.status))).length;
      const remToday = of("task").filter((e) => { const a = taskAlertAt(e.fields); return !!a && new Date(a).toDateString() === today; }).length;
      const renew = of("watch").filter((e) => Date.parse(String(e.fields.due)) < soon).length;
      const monitors = of("monitor");
      const alerts = of("sensor").filter((e) => e.fields.alert !== false && ["high", "low", "stale"].includes(String(e.fields.state))).length;
      const running = of("procedure").filter((e) => !e.fields.done_at).length;
      const doneToday = of("task").filter((e) => typeof e.fields.done_at === "string" && new Date(e.fields.done_at).toDateString() === today).length;
      const logsToday = of("log").filter((e) => new Date(String(e.fields.at ?? "")).toDateString() === today).length;
      return {
        "/inbox": sortable ? `${sortable} to sort` : "Nothing to sort",
        "/tasks": [next ? `${next} next` : "Nothing next", remToday ? `${remToday} reminder${remToday === 1 ? "" : "s"} today` : ""].filter(Boolean).join(", "),
        "/renewals": renew ? `${renew} due in 30 days` : "Nothing due in 30 days",
        "/dashboard": doneToday || logsToday ? [doneToday ? `${doneToday} done today` : "", logsToday ? n(logsToday, "log today", "logs today") : ""].filter(Boolean).join(", ") : "Charts of logs, tasks and sensors",
        "/notes": n(of("note").length, "note", "notes"),
        "/memory": n(of("fact").length, "fact", "facts"),
        // The checks' light in its own words (off monitors are left out, unknown ones are said), and alerting readings.
        "/ops": [trafficLight(monitors).label, alerts ? n(alerts, "alert", "alerts") : ""].filter(Boolean).join(", "),
        "/projects": n(of("project").filter((e) => e.fields.status === "active").length, "active", "active"),
        "/procedures": running ? `${running} in progress` : "None in progress",
        "/music": n(of("music_idea").length, "idea", "ideas"),
        "/wiki": "Design docs from the repo and Confluence",
        "/quiz": n(of("quiz").length, "quiz", "quizzes"),
        "/gallery": n(of("image").length, "picture", "pictures"),
        "/people": n(of("person").length, "person", "people"),
        "/logs": n(of("log").length, "log", "logs"),
        "/pet": n(of("pet_event").length, "event", "events"),
        "/food": n(of("food_option").length, "option", "options"),
        "/sensors": n(of("sensor").length, "sensor", "sensors"),
        "/lists": n(of("checklist").length, "list", "lists"),
        "/games": n(of("game").length, "game", "games"),
        "/films": n(of("film").filter((e) => e.fields.watched !== false).length, "film", "films"),
      } as Record<string, string>;
    }, []) ?? {}
  );
}

/**
 * Everything that is not a tab, grouped by area, with what is waiting in each. The phone's Library tab. Areas start
 * closed, each naming the screens inside, so all of them fit on one screen; the ones you open stay open.
 */
export function Library() {
  const summaries = useSummaries();
  const inbox = useInboxCount();
  const areas = useAreas();
  const [openAreas, toggleArea] = useOpenAreas();
  const pet = usePetName();
  return (
    <div className="col library">
      <h1>Library</h1>
      {areas.map((area) => {
        const open = openAreas.includes(area.title);
        const waiting = area.items.some((i) => i.path === "/inbox") ? inbox : 0;
        const id = `library-${area.title.toLowerCase().replace(/[^a-z]+/g, "-")}`;
        return (
          <section key={area.title} className={`library-area${open ? " open" : ""}`}>
            <button type="button" className="item library-head" aria-expanded={open} aria-controls={id} onClick={() => toggleArea(area.title)}>
              <span className="body">
                <span className="t">{area.title}</span>
                {!open && <span className="meta">{area.items.map((i) => (i.path === "/pet" ? pet : i.label)).join(", ")}</span>}
              </span>
              {!open && waiting > 0 && <span className="badge" aria-label={`${waiting} to sort`}>{waiting}</span>}
              <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
            </button>
            {open && (
              <nav className="list" id={id} aria-label={area.title}>
                {area.items.map((n) => (
                  <a key={n.path} href={`#${n.path}`} className="item library-row">
                    <span className="body">
                      <span className="t">{n.path === "/pet" ? pet : n.label}</span>
                      {summaries[n.path] && <span className="meta">{summaries[n.path]}</span>}
                    </span>
                    {n.path === "/inbox" && inbox > 0 && (
                      <span className="badge" aria-label={`${inbox} to sort`}>
                        {inbox}
                      </span>
                    )}
                  </a>
                ))}
              </nav>
            )}
          </section>
        );
      })}
      <section className="library-area">
        <nav className="list" aria-label="System">
          {SYSTEM.map((n) => (
            <a key={n.path} href={`#${n.path}`} className="item library-row">
              <span className="body"><span className="t">{n.label}</span></span>
            </a>
          ))}
        </nav>
      </section>
    </div>
  );
}
