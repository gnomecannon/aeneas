import { Suspense, useEffect, type ReactNode } from "react";
import type { Route } from "./lib/router";
import { ScreenStart, Shell, screenOf } from "./components/Shell";
import { ReminderBanner } from "./components/ReminderBanner";
import { PairAgainBanner } from "./components/PairAgainBanner";
import { ActivityBanner, ConnectionBanner, DigestToast, DiskBanner, AppUpdateBanner, MailToast, MonitorBanner, QuizToast, SensorBanner } from "./components/NotifyBanners";
import { UpdateToast } from "./components/UpdateToast";
import { JoinedToast } from "./components/JoinedToast";
import { IfModule, ModuleGate } from "./components/ModuleGate";
import { HelperOfferBanner } from "./components/HelperOffer";
import { startHelperAgent } from "./lib/helperAgent";
import { startComputerReports } from "./lib/thisComputer";

/**
 * The main window around a screen: sidebar and tab bar, banners and toasts. A file of its own, loaded only by the main
 * window: the capture window and the Now and next widget never need it.
 */
export function MainWindow({ route, view }: { route: Route; view: ReactNode }) {
  // The Windows app on a helped person's computer runs their helper's commands (lib/helperAgent.ts).
  useEffect(() => { void startHelperAgent(); void startComputerReports(); }, []);
  return (
    <Shell route={route}>
      <div className="banners">
        <PairAgainBanner />
        <HelperOfferBanner path={route.path} />
        <ReminderBanner quiet={route.path === "/today"} />
        <ActivityBanner />
        <DiskBanner />
        <ConnectionBanner />
        <AppUpdateBanner />
        <IfModule id="sensors"><SensorBanner /></IfModule>
        <IfModule id="homelab"><MonitorBanner /></IfModule>
      </div>
      <ModuleGate path={route.path}>
        <Suspense fallback={null}>
          {view}
          <ScreenStart screen={screenOf(route.path).key} />
        </Suspense>
      </ModuleGate>
      <JoinedToast />
      <UpdateToast />
      <DigestToast />
      <IfModule id="quiz"><QuizToast /></IfModule>
      <IfModule id="mail_inbox"><MailToast /></IfModule>
    </Shell>
  );
}
