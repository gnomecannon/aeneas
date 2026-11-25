#if DEBUG && os(iOS)
import Foundation
import EventKit
import SwiftUI
import UIKit
import EACore

/// Simulator test hooks, Debug builds only. Launch arguments:
///   -EASeedWorkCalendar YES      create a local "Work (simulator)" calendar with two events and select it
///   -EASection <section>         open a section, e.g. settings or today
///   -EASettingsFocus <id>        scroll Settings to a section id, e.g. workCalendar
///   -EASetupURL <url>            open a pairing link (everythingapp://setup?...) as a QR scan would
///   -EAReferenceTest YES         open the Reference screen
///   -EAReferenceQuery <words>    open the Reference screen searching for the words
///   -EAReferenceOpen <book>/<path>  open the Reference screen with that page in the reader
///   -EAHumSample YES             put a hummed song (melody and rhythm) on the device and open it
///   -EASample YES                a copy that is not set up starts in sample mode, as Try it with sample data does
///   -EAMachine <name>            with -EASection ops, the Overview opens that machine's page (Tech screenshots)
///   -EAScrollTo history          that machine's page scrolls to its History; without -EAMachine, the Overview scrolls to
///                                that row (a Needs a look key such as hub-backup)
///   -EAAddMachine YES            with -EASection ops, the Overview opens Add machine
///   -EAReadingSpan 7             reading cards start on 7 days (24, 7, 30 or 90)
///   -EAMachinesStart YES         Set up Machines shows, as when Machines is switched on in Settings, Modules
///   -EAAppTheme <id>             use that app theme (classic, midnight, paper, daylight, forest, ocean, sunset, neon), as
///                                choosing it in Settings does; with -EAAppearance light or dark, Classic's appearance
///   -EAThemeEditor YES           with -EASettingsPage appColors, the theme editor opens on the theme in use
///   -EAOpenItem <id>             an item's sheet opens, as a link to it does
///   -EAMailPlace <place>         with -EASection mail: inbox, snoozed, done or bundle:<id> (MailView.debugLaunch)
///   -EAMailOpen <words>          with -EASection mail, the first thread whose subject has the words opens
///   -EAMailSelect <n>            with -EASection mail, the first n mail rows are selected
///   -EAMailFake, -EAMailWrite, -EAMailType, -EAMailProbe  a made-up mailbox, a writing box opened and typed in, and
///                                what each letter costs (MailProbe)
///   -EASourcesPage <page>        a page of Settings, Accounts, From this iPhone over the screen shown: reminders
///                                (DeviceRemindersView) or calendars (DeviceCalendarsView)
///   -EASettingsPage <page>       with -EASection settings, a Settings page opens (SettingsPage): accounts (Settings,
///                                Accounts), addAccount (Add account), calendar (From this iPhone, Calendars),
///                                appleHealth (From this iPhone, Apple Health)...
///   -EAAccount <address>         with -EASettingsPage accounts, that account's page opens once the accounts load
///   -EAAccountsScroll <part>     with -EASettingsPage accounts, the page opens scrolled to device (From this iPhone)
///                                or work; with -EAAccount too, signin scrolls that account's page to Sign-in; with
///                                -EASettingsPage appleHealth, writes or hub scrolls the Apple Health page there
///   -EAContactsTakeOver <name>   with -EASettingsPage accounts, From this iPhone asks whether to take Contacts over from
///                                the device of that name, as when another device mirrors them (sample mode too)
///   -EABarOpen YES               the bottom bar's second row shows open at launch (PhoneRoot)
///   -EABarReveal <points>        the bottom bar's panel held as if pulled up that far (0 folded, the second row's
///                                height open, more for a pull past open), to photograph each stage (PhoneBar)
///   -EABarCount <3|4|5>          the bottom bar shows that many screens across, as choosing it in Theme, Bottom bar
///                                does (rows cut to it); -EASettingsPage bottomBar opens that page
///   -EABarReset YES              the bottom bar goes back to its default first, as Reset in Theme, Bottom bar does (a
///                                count cut by -EABarCount stays cut otherwise)
///   -EATodayOrder <ids>          Today's order, ids comma separated (now,coming,todo...), or default for the default
///                                (TodayDebug); -EATodayHidden <ids> the parts hidden. -EASettingsPage today opens the
///                                editor, Theme, Today
///   -EATodoLists <keys>          the lists that fill To do, keys comma separated (none for tasks in no list, all for
///                                every list); -EASettingsPage todoLists opens Lists in To do, and with
///                                -EASettingsPage today, -EAScrollTo todoLists scrolls the editor to its row
///   -EASourcesSample YES         in sample mode, the sample hub's sources setting with a list for each list the sample's
///                                tasks name, so the list choosers have lists (sample mode reads no setting itself);
///                                with -EATaskGroups "School=Jamie Shopping|none;Home=Alex Shopping" the groups on Tasks
///                                (lists by name, none for tasks in no list), -tasks.space group:<id> shows one, and
///                                -EAGroupEdit <id, or new> opens the group editor over Tasks
///   -EAWeekView, -EAWeekDate, -EAWeekSearch, -EAWeekCalendars, -EAWeekSample, -EAWeekHide  Week's view, day, search,
///                                Calendars list and sample calendars (WeekDebug in WeekCalendarViews.swift)
@MainActor
enum DebugHooks {
    /// The machine page `-EAMachine` asked for opens once, not again each time the Overview shows.
    static var machineShown = false

    static func applyLaunchArguments(_ model: AppModel) async {
        let d = UserDefaults.standard
        if d.bool(forKey: "EASample"), !model.isConfigured { await model.startSample() }
        if d.bool(forKey: "EASourcesSample") { await sourcesSample(model.engine) }
        applyTheme()
        if let id = d.string(forKey: "EAOpenItem"), !id.isEmpty {
            Task { try? await Task.sleep(for: .seconds(1.5)); model.open(itemId: id) }
        }
        if d.bool(forKey: "EASeedWorkCalendar") { await seedWorkCalendar() }
        if let s = d.string(forKey: "EASection"), let section = Section(rawValue: s) { model.section = section }
        // The link a QR scan or the camera opens, without the system's "Open in Aeneas?" tap (automated tests).
        if let s = d.string(forKey: "EASetupURL"), let url = URL(string: s) { model.handle(url: url) }
        referenceRequests(model)
        if d.bool(forKey: "EAHumSample") { await humSample(model) }
        if let name = d.string(forKey: "EAWatchCaptureFile") { watchCaptureFile(name) }
        if d.bool(forKey: "EAMachinesStart") { model.machinesStart = true }
        if let page = d.string(forKey: "EASourcesPage") { sourcesPage(model, page) }
        // Week's sample calendars (WeekDebug): after the launch's own read of the feel setting, which would put the
        // sample's (none) back.
        if d.bool(forKey: "EAWeekSample") { Task { try? await Task.sleep(for: .seconds(3)); await WeekDebug.seed(model.engine) } }
    }

    /// `-EASourcesSample YES`: the sample hub's sources setting, with an iCloud list for each list the sample's tasks
    /// name, and the groups `-EATaskGroups` names. Sample mode only.
    static func sourcesSample(_ engine: SyncEngine) async {
        guard engine.config.sampleMode, var s = try? await engine.client?.sources() else { return }
        for title in Set(engine.tasks.compactMap(\.reminderList)).sorted() where !s.lists.contains(where: { $0.title == title }) {
            s.lists.append(.init(key: SourceKey.make(kind: "icloud", account: "iCloud", title: title), title: title, account: "iCloud"))
        }
        if let spec = UserDefaults.standard.string(forKey: "EATaskGroups") {
            var groups: [TaskGroup] = []
            for part in spec.split(separator: ";") {
                let pair = part.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
                guard let name = pair.first, !name.isEmpty else { continue }
                let lists = (pair.count > 1 ? pair[1] : "").split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }
                    .compactMap { t in t == ListChoices.noList ? t : s.lists.first { $0.title == t }?.key }
                groups.append(TaskGroup(id: TaskGroups.newId(name, groups: groups), name: name, lists: lists))
            }
            if TaskGroups.problem(groups) == nil { s.groups = groups }
        }
        engine.adoptSources(s)
    }

    /// `-EASourcesPage reminders|calendars`: the page over the screen shown, as a sheet of its own.
    static func sourcesPage(_ model: AppModel, _ page: String) {
        let content: AnyView
        switch page {
        case "reminders": content = AnyView(NavigationStack { DeviceRemindersView() })
        case "calendars": content = AnyView(NavigationStack { DeviceCalendarsView() })
        default: return
        }
        Task {
            try? await Task.sleep(for: .seconds(2))
            let host = UIHostingController(rootView: content.themedRoot().environmentObject(model).environmentObject(model.engine))
            let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
            guard var top = (windows.first { $0.isKeyWindow } ?? windows.first)?.rootViewController else { return }
            while let shown = top.presentedViewController { top = shown }
            top.present(host, animated: false)
        }
    }

    /// `-EAAppTheme <id>` and `-EAAppearance <light|dark>`: the theme and Classic's appearance, as Settings sets them;
    /// `-EABarReset` and `-EABarCount <n>`: the bottom bar's default and its count, as Theme, Bottom bar sets them.
    static func applyTheme() {
        let d = UserDefaults.standard
        var patch: [String: JSONValue] = [:]
        if let t = d.string(forKey: "EAAppTheme"), !t.isEmpty { patch["app_theme"] = .string(t) }
        if let a = d.string(forKey: "EAAppearance"), ["system", "light", "dark"].contains(a) { patch["appearance"] = .string(a) }
        if !patch.isEmpty { FeelController.shared.change(patch) }
        let feel = FeelController.shared
        if d.bool(forKey: "EABarReset"), feel.settings.shownBar != .standard { feel.setBar(.standard) }
        let n = d.integer(forKey: "EABarCount")
        if BarSetting.counts.contains(n), feel.settings.shownBar.count != n { feel.setBar(feel.settings.shownBar.withLibrary.withCount(n)) }
        TodayDebug.apply()
    }

    /// A spoken capture as if it had come from the Watch: `-EAWatchCaptureFile <name>` takes that file from this app's
    /// temporary folder (copied in from the Mac), so the speech model and the reply to the Watch can be checked in the
    /// simulator, whose WatchConnectivity does not deliver file transfers.
    static func watchCaptureFile(_ name: String) {
        let src = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent("copy-" + name)
        try? FileManager.default.removeItem(at: copy)
        guard (try? FileManager.default.copyItem(at: src, to: copy)) != nil else { return }
        let c = WatchVoiceCapture(seconds: 10, format: src.pathExtension.lowercased())
        guard (try? WatchCaptureQueue.local.add(c, moving: copy)) == true else { return }
        WatchCaptureRelay.shared.kick()
    }

    /// A hummed idea as the hub leaves it after hearing it both ways, for screenshots of Melody, Rhythm and Both.
    static func humSample(_ model: AppModel) async {
        let id = "0f9e8d7c-6b5a-4321-8fed-00000000b001"
        let melody = [(57, 0.0, 0.5), (60, 0.5, 0.5), (64, 1.0, 0.75), (62, 1.75, 0.25), (60, 2.0, 0.5), (57, 2.5, 1.0), (55, 3.5, 0.5)]
            .map { #"{"p":\#($0.0),"s":\#($0.1),"d":\#($0.2),"v":96}"# }.joined(separator: ",")
        var hits: [String] = []
        for beat in 0..<8 {
            let t = Double(beat) * 0.5
            hits.append(#"{"p":\#(beat % 2 == 0 ? 36 : 38),"s":\#(t),"d":0.125,"v":110}"#)
            hits.append(#"{"p":42,"s":\#(t + 0.25),"d":0.125,"v":60}"#)
        }
        let json = #"{"id":"\#(id)","kind":"music_idea","space":"personal","created_at":"2026-11-17T20:00:00.000Z","updated_at":"2026-11-17T20:00:05.000Z","deleted_at":null,"fields":{"title":"Song in A minor, 120 BPM","type":"riff","body":"","status":"idea","tags":["hummed"],"key":"A minor","bpm":120,"audio_ref":"hum:\#(id)","midi":{"source":"hum","state":"done","seconds":4.2,"mode":"melody","notes":[\#(melody)],"melody":[\#(melody)],"rhythm":[\#(hits.joined(separator: ","))]}},"field_ts":{}}"#
        guard let e = try? JSONCoding.decode(Entity.self, from: json) else { return }
        await model.engine.absorb(e)
        model.open(itemId: id)
    }

    /// Reference screenshots from a shell (`xcrun simctl launch booted <bundle id> -EAReferenceOpen <book>/<path>`).
    static func referenceRequests(_ model: AppModel) {
        let d = UserDefaults.standard
        let library = ReferenceLibrary.shared
        if let q = d.string(forKey: "EAReferenceQuery"), !q.isEmpty { library.queryRequest = q }
        if let s = d.string(forKey: "EAReferenceOpen"), let l = ReferenceLink.split(s) { library.openRequest = ReferencePageLink(book: l.book, path: l.path) }
        if d.bool(forKey: "EAReferenceTest") || library.queryRequest != nil || library.openRequest != nil { model.section = .reference }
    }

    /// Needs full calendar access, e.g. `xcrun simctl privacy booted grant calendar com.gnomecannon.everythingapp`.
    static func seedWorkCalendar() async {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { return }
        let store = EKEventStore()
        let title = "Work (simulator)"
        let calendar: EKCalendar
        if let existing = store.calendars(for: .event).first(where: { $0.title == title }) {
            calendar = existing
        } else {
            guard let source = store.sources.first(where: { $0.sourceType == .local }) ?? store.defaultCalendarForNewEvents?.source else { return }
            calendar = EKCalendar(for: .event, eventStore: store)
            calendar.title = title
            calendar.source = source
            do { try store.saveCalendar(calendar, commit: true) } catch { return }
        }
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        let window = store.predicateForEvents(withStart: today.addingTimeInterval(-86400), end: today.addingTimeInterval(3 * 86400), calendars: [calendar])
        for ev in store.events(matching: window) { try? store.remove(ev, span: .thisEvent, commit: false) }
        func add(_ title: String, dayOffset: Int, hour: Int, minutes: Int) {
            let ev = EKEvent(eventStore: store)
            ev.calendar = calendar
            ev.title = title
            ev.startDate = cal.date(bySettingHour: hour, minute: 0, second: 0, of: today.addingTimeInterval(Double(dayOffset) * 86400))
            ev.endDate = ev.startDate.addingTimeInterval(Double(minutes) * 60)
            ev.location = "Room 4B"   // set on purpose: it must not be imported
            ev.notes = "Private agenda"
            try? store.save(ev, span: .thisEvent, commit: false)
        }
        add("Design review", dayOffset: 0, hour: 14, minutes: 60)
        add("One on one with manager", dayOffset: 1, hour: 11, minutes: 30)
        try? store.commit()
        SharedConfig.shared.workCalendarIds = [calendar.calendarIdentifier]
        CalendarImporter.shared.refreshAccess()
    }
}
#endif
