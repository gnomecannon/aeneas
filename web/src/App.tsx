import { Suspense, lazy, useEffect, useState, type ComponentType } from "react";
import { useRoute } from "./lib/router";
import { useGlobalKeys } from "./lib/keys";
import { engine } from "./sync/engine";
import { META, db, getMeta } from "./sync/db";
import { getFeel, updateFeel, useFeel } from "./feel/store";
import { applyAppTheme } from "./feel/appTheme";
import { useMeta } from "./sync/hooks";
import { isWindowsApp, onNavigate, onSetupLink, windowLabel } from "./tauri/bridge";
import { applySetupFile } from "./tauri/setupFile";
import { ModuleGate } from "./components/ModuleGate";

/**
 * A screen loaded the first time it shows, from a file of its own: each window downloads only what it shows (the
 * capture window Capture alone, the Now widget the widget alone). The offline service worker keeps every file.
 */
function screen<P>(load: () => Promise<ComponentType<P>>) {
  return lazy(() => load().then((c) => ({ default: c })));
}

const MainWindow = screen(() => import("./MainWindow").then((m) => m.MainWindow));
const Library = screen(() => import("./components/Shell").then((m) => m.Library));
const Today = screen(() => import("./views/Today").then((m) => m.Today));
const Week = screen(() => import("./views/Week").then((m) => m.Week));
const Renewals = screen(() => import("./views/Renewals").then((m) => m.Renewals));
const PlanRules = screen(() => import("./views/PlanRules").then((m) => m.PlanRules));
const Dashboard = screen(() => import("./views/Dashboard").then((m) => m.Dashboard));
const Now = screen(() => import("./views/Now").then((m) => m.Now));
const Capture = screen(() => import("./views/Capture").then((m) => m.Capture));
const Inbox = screen(() => import("./views/Inbox").then((m) => m.Inbox));
const Tasks = screen(() => import("./views/Tasks").then((m) => m.Tasks));
const Notes = screen(() => import("./views/Notes").then((m) => m.Notes));
const NotesMap = screen(() => import("./views/NotesMap").then((m) => m.NotesMap));
const Hosts = screen(() => import("./views/Hosts").then((m) => m.Hosts));
const Projects = screen(() => import("./views/Projects").then((m) => m.Projects));
const Procedures = screen(() => import("./views/Procedures").then((m) => m.Procedures));
const Music = screen(() => import("./views/Music").then((m) => m.Music));
const Wiki = screen(() => import("./views/Wiki").then((m) => m.Wiki));
const Quiz = screen(() => import("./views/Quiz").then((m) => m.Quiz));
const Images = screen(() => import("./views/Images").then((m) => m.Images));
const Gallery = screen(() => import("./views/Gallery").then((m) => m.Gallery));
const Layouts = screen(() => import("./views/Layouts").then((m) => m.Layouts));
const Item = screen(() => import("./views/Item").then((m) => m.Item));
const People = screen(() => import("./views/People").then((m) => m.People));
const Journal = screen(() => import("./views/Journal").then((m) => m.Journal));
const Snippets = screen(() => import("./views/Snippets").then((m) => m.Snippets));
const Logs = screen(() => import("./views/Logs").then((m) => m.Logs));
const Health = screen(() => import("./views/Health").then((m) => m.Health));
const Pet = screen(() => import("./views/Pet").then((m) => m.Pet));
const Sensors = screen(() => import("./views/Sensors").then((m) => m.Sensors));
const Ops = screen(() => import("./views/Ops").then((m) => m.Ops));
const Food = screen(() => import("./views/Food").then((m) => m.Food));
const Lists = screen(() => import("./views/Lists").then((m) => m.Lists));
const JobApplications = screen(() => import("./views/JobApplications").then((m) => m.JobApplications));
const Games = screen(() => import("./views/Games").then((m) => m.Games));
const Films = screen(() => import("./views/Films").then((m) => m.Films));
const Calc = screen(() => import("./views/Calc").then((m) => m.Calc));
const Memory = screen(() => import("./views/Memory").then((m) => m.Memory));
const Reference = screen(() => import("./views/Reference").then((m) => m.Reference));
const Mail = screen(() => import("./views/Mail").then((m) => m.Mail));
const Assistant = screen(() => import("./views/Assistant").then((m) => m.Assistant));
const Search = screen(() => import("./views/Search").then((m) => m.Search));
const Status = screen(() => import("./views/Status").then((m) => m.Status));
const Settings = screen(() => import("./views/Settings").then((m) => m.Settings));
const Setup = screen(() => import("./views/Setup").then((m) => m.Setup));
const Join = screen(() => import("./views/Join").then((m) => m.Join));
const Welcome = screen(() => import("./views/Welcome").then((m) => m.Welcome));
const HelpConnections = screen(() => import("./views/HelpConnections").then((m) => m.default));
const Widget = screen(() => import("./views/Widget").then((m) => m.Widget));

/**
 * The app's colors come from the feel setting (one for every device). A light or dark choice made on this device
 * before that existed is carried over once, then forgotten here.
 */
function useTheme() {
  const f = useFeel();
  const local = useMeta<string>(META.theme);
  useEffect(() => {
    applyAppTheme(f);
  }, [f.app_theme, f.app_themes, f.appearance]);
  useEffect(() => {
    if (local === "light" || local === "dark") {
      if (getFeel().appearance === "system") updateFeel({ appearance: local });
      void db.meta.delete(META.theme);
    }
  }, [local]);
}

async function boot(): Promise<void> {
  await engine.start();
  if (!isWindowsApp) return;
  const hubUrl = await getMeta<string>(META.hubUrl);
  const token = await getMeta<string>(META.token);
  if (hubUrl && token) return;
  try {
    await applySetupFile();
  } catch {
    /* reported in Settings */
  }
}

/** A hub nobody has set up yet (no owner name) opens Welcome once per visit. */
function useFirstRun(configured: boolean) {
  useEffect(() => {
    if (!configured) return;
    try { if (sessionStorage.getItem("ea-welcome-skip")) return; } catch { /* private window */ }
    const c = engine.client;
    if (!c) return;
    void c.setup().then((v) => {
      if (!v.named && !window.location.hash.startsWith("#/welcome") && !window.location.hash.startsWith("#/help")) {
        try { sessionStorage.setItem("ea-welcome-skip", "1"); } catch { /* private window */ }
        window.location.hash = "/welcome";
      }
    }).catch(() => undefined);
  }, [configured]);
}

export function App() {
  const route = useRoute();
  const hubUrl = useMeta<string>(META.hubUrl);
  const token = useMeta<string>(META.token);
  const [label, setLabel] = useState<string>("main");
  const [booted, setBooted] = useState(false);
  useTheme();
  useGlobalKeys();
  useFirstRun(booted && !!hubUrl && !!token);

  useEffect(() => {
    void boot().finally(() => setBooted(true));
    void windowLabel().then(setLabel);
    let un: (() => void) | undefined;
    void onNavigate((p) => {
      window.location.hash = p;
    }).then((u) => (un = u));
    let unLink: (() => void) | undefined;
    void onSetupLink((p) => { window.location.hash = p; }).then((u) => (unLink = u));
    return () => {
      un?.();
      unLink?.();
      engine.stop();
    };
  }, []);

  const mini = label === "capture" || route.params.get("mini") === "1";
  if (mini) {
    return (
      <div className="capture-mini">
        <main className="main">
          <Suspense fallback={null}><Capture mini /></Suspense>
        </main>
      </div>
    );
  }

  if (label === "widget" || route.path === "/widget") return <Suspense fallback={null}><Widget /></Suspense>;

  const configured = !!hubUrl && !!token;
  // A pairing link (#/setup?hub=&code=, or an older one with token=) connects this device, even one connected to a hub before.
  if (booted && ((!configured && !route.path.startsWith("/settings")) || (route.path === "/setup" && (route.params.get("code") || route.params.get("token"))))) {
    // A new pairing link while Setup shows starts it afresh, so it reads that link.
    return <Suspense fallback={null}><Setup key={route.path === "/setup" ? window.location.hash : "setup"} /></Suspense>;
  }

  let view: JSX.Element;
  const p = route.path;
  if (p.startsWith("/today")) view = <Today />;
  else if (p.startsWith("/week")) view = <Week />;
  else if (p.startsWith("/renewals")) view = <Renewals focus={route.params.get("focus")} />;
  else if (p.startsWith("/plan-rules")) view = <PlanRules />;
  else if (p.startsWith("/dashboard")) view = <Dashboard />;
  else if (p.startsWith("/capture")) view = <Capture />;
  else if (p.startsWith("/inbox")) view = <Inbox />;
  else if (p.startsWith("/tasks")) view = <Tasks focus={route.params.get("focus")} />;
  else if (p.startsWith("/reminders")) view = <Tasks focus={route.params.get("focus")} />; // older links: reminders are tasks
  else if (p === "/notes/map") view = <NotesMap />;
  else if (p.startsWith("/notes")) view = <Notes id={route.parts[1]} />;
  else if (p.startsWith("/hosts")) view = <Hosts host={route.parts[1]} runbookId={route.params.get("runbook")} focus={route.params.get("focus")} />;
  else if (p.startsWith("/projects")) view = <Projects id={route.parts[1]} />;
  else if (p.startsWith("/procedures")) view = <Procedures id={route.parts[1]} />;
  else if (p.startsWith("/music")) view = <Music id={route.parts[1]} />;
  else if (p.startsWith("/wiki")) view = <Wiki id={route.params.get("id")} />;
  else if (p.startsWith("/quiz")) view = <Quiz />;
  else if (p.startsWith("/images")) view = <Images />;
  else if (p.startsWith("/gallery")) view = <Gallery />;
  else if (p.startsWith("/layouts")) view = <Layouts id={route.parts[1]} />;
  else if (p.startsWith("/people")) view = <People id={route.parts[1]} />;
  else if (p.startsWith("/item/")) view = <Item key={route.parts[1]} id={route.parts[1]} />;
  else if (p.startsWith("/journal")) view = <Journal focus={route.params.get("focus")} />;
  else if (p.startsWith("/snippets")) view = <Snippets id={route.parts[1]} host={route.params.get("host")} />;
  else if (p.startsWith("/logs")) view = <Logs />;
  else if (p.startsWith("/health")) view = <Health />;
  else if (p.startsWith("/pet")) view = <Pet />;
  else if (p.startsWith("/sensors")) view = <Sensors />;
  else if (p.startsWith("/ops")) view = <Ops focus={route.params.get("focus")} />;
  else if (p.startsWith("/food")) view = <Food />;
  else if (p.startsWith("/lists/jobs")) view = <JobApplications id={route.parts[2]} />;
  else if (p.startsWith("/lists")) view = <Lists id={route.parts[1]} />;
  else if (p.startsWith("/career")) view = <JobApplications id={route.parts[1]} />; // older links
  else if (p.startsWith("/games")) view = <Games key={route.params.get("q") ?? ""} q={route.params.get("q") ?? ""} />;
  else if (p.startsWith("/films")) view = <Films key={route.params.get("q") ?? ""} q={route.params.get("q") ?? ""} />;
  else if (p.startsWith("/calc")) view = <Calc />;
  else if (p.startsWith("/memory")) view = <Memory />;
  else if (p === "/reference" || p.startsWith("/reference/")) view = <Reference path={p} params={route.params} />;
  else if (p === "/mail") view = <Mail />;
  else if (p.startsWith("/assistant")) view = <Assistant id={route.parts[1]} />;
  else if (p.startsWith("/search")) view = <Search q={route.params.get("q") ?? ""} />;
  else if (p.startsWith("/status")) view = <Status />;
  else if (p === "/join") view = <Join key={window.location.hash} params={route.params} />;
  else if (p.startsWith("/welcome")) view = <Welcome />;
  else if (p.startsWith("/help/connections")) view = <HelpConnections />;
  else if (p.startsWith("/settings")) view = <Settings parts={route.parts.slice(1)} params={route.params} />;
  else if (p === "/library" || p === "/more") view = <Library />;
  else view = <Now />;

  // A screen in a window of its own (second monitor): the view alone, no sidebar or tab bar.
  if (route.params.get("pop") === "1") {
    return (
      <div className="popout">
        <main className="main"><ModuleGate path={p}><Suspense fallback={null}>{view}</Suspense></ModuleGate></main>
      </div>
    );
  }

  return <Suspense fallback={null}><MainWindow route={route} view={view} /></Suspense>;
}

