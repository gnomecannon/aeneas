import { useEffect, useState } from "react";
import { useRoute } from "./lib/router";
import { useGlobalKeys } from "./lib/keys";
import { engine } from "./sync/engine";
import { META, db, getMeta } from "./sync/db";
import { getFeel, updateFeel, useFeel } from "./feel/store";
import { applyAppTheme } from "./feel/appTheme";
import { useMeta } from "./sync/hooks";
import { Shell, Library } from "./components/Shell";
import { ReminderBanner } from "./components/ReminderBanner";
import { ActivityBanner, DigestToast, MonitorBanner, QuizToast, SensorBanner } from "./components/NotifyBanners";
import { UpdateToast } from "./components/UpdateToast";
import { Today } from "./views/Today";
import { Week } from "./views/Week";
import { Renewals } from "./views/Renewals";
import { PlanRules } from "./views/PlanRules";
import { Dashboard } from "./views/Dashboard";
import { isTauri, onNavigate, windowLabel } from "./tauri/bridge";
import { applySetupFile } from "./tauri/setupFile";
import { Now } from "./views/Now";
import { Capture } from "./views/Capture";
import { Inbox } from "./views/Inbox";
import { Tasks } from "./views/Tasks";
import { Notes } from "./views/Notes";
import { NotesMap } from "./views/NotesMap";
import { Hosts } from "./views/Hosts";
import { Projects } from "./views/Projects";
import { Procedures } from "./views/Procedures";
import { Music } from "./views/Music";
import { Wiki } from "./views/Wiki";
import { Quiz } from "./views/Quiz";
import { Images } from "./views/Images";
import { Gallery } from "./views/Gallery";
import { Layouts } from "./views/Layouts";
import { Item } from "./views/Item";
import { People } from "./views/People";
import { Journal } from "./views/Journal";
import { Snippets } from "./views/Snippets";
import { Logs } from "./views/Logs";
import { Health } from "./views/Health";
import { Pet } from "./views/Pet";
import { Sensors } from "./views/Sensors";
import { Ops } from "./views/Ops";
import { Food } from "./views/Food";
import { Lists } from "./views/Lists";
import { JobApplications } from "./views/JobApplications";
import { Games } from "./views/Games";
import { Films } from "./views/Films";
import { Calc } from "./views/Calc";
import { Memory } from "./views/Memory";
import { Assistant } from "./views/Assistant";
import { Search } from "./views/Search";
import { Status } from "./views/Status";
import { Settings } from "./views/Settings";
import { Setup } from "./views/Setup";
import { Welcome } from "./views/Welcome";
import { Widget } from "./views/Widget";
import { IfModule, ModuleGate } from "./components/ModuleGate";

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
  if (!isTauri) return;
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
      if (!v.named && !window.location.hash.startsWith("#/welcome")) {
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
    return () => {
      un?.();
      engine.stop();
    };
  }, []);

  const mini = label === "capture" || route.params.get("mini") === "1";
  if (mini) {
    return (
      <div className="capture-mini">
        <main className="main">
          <Capture mini />
        </main>
      </div>
    );
  }

  if (label === "widget" || route.path === "/widget") return <Widget />;

  const configured = !!hubUrl && !!token;
  // A pairing link (#/setup?hub=&code=, or an older one with token=) connects this device, even one connected to a hub before.
  if (booted && ((!configured && !route.path.startsWith("/settings")) || (route.path === "/setup" && (route.params.get("code") || route.params.get("token"))))) {
    return <Setup />;
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
  else if (p.startsWith("/hosts")) view = <Hosts host={route.parts[1]} runbookId={route.params.get("runbook")} />;
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
  else if (p.startsWith("/assistant")) view = <Assistant id={route.parts[1]} />;
  else if (p.startsWith("/search")) view = <Search q={route.params.get("q") ?? ""} />;
  else if (p.startsWith("/status")) view = <Status />;
  else if (p.startsWith("/welcome")) view = <Welcome />;
  else if (p.startsWith("/settings")) view = <Settings parts={route.parts.slice(1)} params={route.params} />;
  else if (p === "/library" || p === "/more") view = <Library />;
  else view = <Now />;

  // A screen in a window of its own (second monitor): the view alone, no sidebar or tab bar.
  if (route.params.get("pop") === "1") {
    return (
      <div className="popout">
        <main className="main"><ModuleGate path={p}>{view}</ModuleGate></main>
      </div>
    );
  }

  return (
    <Shell route={route}>
      <div className="banners">
        <ReminderBanner />
        <ActivityBanner />
        <IfModule id="sensors"><SensorBanner /></IfModule>
        <IfModule id="homelab"><MonitorBanner /></IfModule>
      </div>
      <ModuleGate path={p}>{view}</ModuleGate>
      <UpdateToast />
      <DigestToast />
      <IfModule id="quiz"><QuizToast /></IfModule>
    </Shell>
  );
}

