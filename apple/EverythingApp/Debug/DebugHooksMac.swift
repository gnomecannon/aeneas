#if DEBUG && os(macOS)
import AppKit
import SwiftUI
import UserNotifications
import EACore

/// Mac screenshot hooks, Debug builds only. Launch arguments:
///   -EASection <section>       open a section, e.g. today or week
///   -EAWindowSize 1280x800     the main window's size with its title bar, in points
///   -EASample YES              a copy that is not set up starts in sample mode, as Try it with sample data does
///   -EADictationTest YES       presses the mic on the screen shown; with -EADictationSay "<words>" it hears them
///   -EAReferenceTest YES       the Reference screen in a window of its own (its size from -EAWindowSize); prints the
///                              window number. With -EAReferenceQuery <words> it searches for them; with
///                              -EAReferenceOpen <book>/<path> (which also opens the window) that page is in the reader
///   -EAMachinesStart YES       Set up Machines in a window of its own; prints the window number
///   -EAThisMacTest YES         Settings, Machines (with This Mac) in a window of its own; prints the window number.
///                              With -EAThisMacSignIn YES its Add machine for this Mac shows, filled in, without
///                              opening System Settings, and with -EAScrollTo thisMac This Mac is at the top
///   -EAMachine <name>          that machine's page in a window of its own (760x900, or the size -EAWindowSize
///                              gives); prints the window number
///   -EAItemWindow <words>      the own screen of the first person, project, list, film, snippet or note whose name
///                              has the words (or of the item with that id), in a window of its own (its size from
///                              -EAWindowSize); prints the window number
///   -EAHealthMetric <name>     that Health measure (weight, sleep, caffeine...) in a window of its own (its size
///                              from -EAWindowSize); prints the window number
///   -EAAppTheme <id>           use that app theme (classic, midnight, paper, ...); -EAAppearance light or dark for Classic
///   -EAThemeEditor YES         with -EASection settings -EASettingsPage appColors, the theme editor opens on the theme in use
///   -EAOpenItem <id>           an item's sheet opens, as a link to it does
///   -EAPrintWindows YES        prints the number of every window of the app (sheets too) once the screen has loaded
///   -EASettingsWindow <page>   a Settings page (theme, appColors, calendarColors...) in a window of its own (640x860,
///                              or the size -EAWindowSize gives)
///   -EAWideLayouts NO          every screen keeps its narrow layout however wide the window is (WideLayout in
///                              UI.swift), to compare a wide window with and without the wide layouts
///   -EAWideFrom <points>       the width a screen is wide from, instead of 1040 (also on the iPhone and iPad)
///   -EANoteOpen <words>        on Notes in a wide window, the first note whose title has the words opens beside the
///                              list (NotesView); with -EANoteRelatedSample YES four other notes stand in as its
///                              related notes, which otherwise come from the hub
///   -EASearchFor <words>       Search runs for those words when it opens (SearchView), to see what it finds
///   -EAChatSample YES          the Assistant shows three made-up chats with the first one open (ChatStore), on a
///                              copy whose hub has none; nothing is kept or sent
///   -EAQuizTest YES            puts a made-up recall quiz for today and two earlier ones on this copy when it has
///                              none (as if the hub had sent them: nothing goes to the hub)
///   -EAProcedureTest YES       puts a made-up procedure of four steps on this copy when it has none (as if the hub
///                              had sent it: nothing goes to the hub); with -EAProcedureRun YES it also opens, to
///                              run, in a window of its own (its size from -EAWindowSize) and prints the window number
/// And one from the environment, so a pairing code is never in the process list:
///   EA_SETUP_LINK=<setup link> pairs this copy with that link (everythingapp://setup?hub=...&code=...) without asking,
///                              as Setup does with a first link, and prints "setup link: paired" or what went wrong.
///                              For a test copy and a throwaway hub: moving to another hub wipes this copy's data.
/// And three links, for a test copy that is running (`open -g -a <the test copy> <link>`), so a screen can be tested
/// from a shell with no control of the Mac: the copy does to its own main window what a hand would.
///   everythingapp://debug/click?x=<points>&y=<points>   a click at that point, counted from the window's top left
///                                                       corner as in a screenshot at 1x
///   everythingapp://debug/size?w=<points>&h=<points>    the window takes that size, its top left corner staying put
///   everythingapp://debug/key                           the window draws as the key window of the app in front,
///                                                       without coming to the front (`actLikeKey`)
/// Screenshots are then taken from outside (screencapture -o -l <window id>), which needs Screen Recording.
@MainActor
enum DebugHooksMac {
    static func applyLaunchArguments(_ model: AppModel) async {
        let d = UserDefaults.standard
        if let raw = ProcessInfo.processInfo.environment["EA_SETUP_LINK"], let url = URL(string: raw), let link = SetupLink.parse(url) {
            let wrong = await model.connect(link)
            print("setup link: \(wrong ?? "paired")")
            fflush(stdout)
        }
        if d.bool(forKey: "EASample"), !model.isConfigured { await model.startSample() }
        var theme: [String: JSONValue] = [:]
        if let t = d.string(forKey: "EAAppTheme"), !t.isEmpty { theme["app_theme"] = .string(t) }
        if let a = d.string(forKey: "EAAppearance"), ["system", "light", "dark"].contains(a) { theme["appearance"] = .string(a) }
        if !theme.isEmpty { FeelController.shared.change(theme) }
        if let id = d.string(forKey: "EAOpenItem"), !id.isEmpty {
            Task { try? await Task.sleep(for: .seconds(1.5)); model.open(itemId: id) }
        }
        if d.bool(forKey: "EAPrintWindows") {
            Task {
                // On the sharpest screen first, so a screenshot is at 2x when a Retina display is attached.
                try? await Task.sleep(for: .seconds(2))
                if let screen = NSScreen.screens.max(by: { $0.backingScaleFactor < $1.backingScaleFactor }) {
                    for w in NSApp.windows where w.isVisible && w.canBecomeMain && w.screen != screen {
                        let f = screen.visibleFrame
                        w.setFrameOrigin(NSPoint(x: f.midX - w.frame.width / 2, y: max(f.minY, f.maxY - w.frame.height - 40)))
                    }
                }
                try? await Task.sleep(for: .seconds(5))
                // The main windows and their sheets; the menu bar item's window is left out.
                for w in NSApp.windows where w.isVisible && (w.canBecomeMain || w.isSheet) {
                    print("window \(w.windowNumber) \(w.isSheet ? "sheet" : "window") \"\(w.title)\" at \(Int(w.backingScaleFactor))x")
                }
                fflush(stdout)
            }
        }
        if d.bool(forKey: "EAMenuTest") { Task { await menuSelfTest(model) } }
        if let s = d.string(forKey: "EASection"), let section = Section(rawValue: s) { model.section = section }
        if d.bool(forKey: "EADictationTest") { let s = model.section; Task { await dictationSelfTest(section: s) } }
        if let id = d.string(forKey: "EAModuleTest") { Task { await moduleSelfTest(model, id: id) } }
        if d.bool(forKey: "EAReferenceTest") || d.string(forKey: "EAReferenceOpen") != nil { Task { await referenceSelfTest(model) } }
        if d.bool(forKey: "EAMachinesStart") {
            Task { await screenWindow(model, title: "Set up Machines", size: NSSize(width: 600, height: 780)) { MachinesStartSheet() } }
        }
        if d.bool(forKey: "EAThisMacTest") {
            Task { await screenWindow(model, title: "Machines", size: NSSize(width: 640, height: 900)) { NavigationStack { MachinesSettingsPage() } } }
        }
        if d.bool(forKey: "EAProcedureTest") { Task { await procedureSelfTest(model) } }
        if d.bool(forKey: "EAQuizTest") { Task { await quizSelfTest(model) } }
        if let page = d.string(forKey: "EASettingsWindow").flatMap(SettingsPage.init(rawValue:)) {
            let size = d.string(forKey: "EAWindowSize").flatMap(parse) ?? NSSize(width: 640, height: 860)
            Task { await screenWindow(model, title: "Settings", size: size) { NavigationStack { page.view } } }
        }
        if let name = d.string(forKey: "EAMachine"), !name.isEmpty {
            Task {
                // A window of its own has no scene that is active, so the page would not load these itself.
                try? await Task.sleep(for: .seconds(2))
                await OpsBoardFeed.shared.load(model.engine)
                await ReadingsFeed.shared.load(model.engine)
                let size = d.string(forKey: "EAWindowSize").flatMap(parse) ?? NSSize(width: 760, height: 900)
                await screenWindow(model, title: name, size: size) { NavigationStack { HostDetailView(host: name) } }
            }
        }
        if let words = d.string(forKey: "EAItemWindow")?.lowercased(), !words.isEmpty {
            let size = d.string(forKey: "EAWindowSize").flatMap(parse) ?? NSSize(width: 760, height: 900)
            Task {
                // Once the store is read: the sample's ids differ from one recording to the next, names do not.
                try? await Task.sleep(for: .seconds(2))
                let kinds: [Kind] = [.person, .project, .checklist, .film, .snippet, .note]
                let id = kinds.flatMap { model.engine.list($0) }.first { $0.displayTitle.lowercased().contains(words) }?.id ?? words
                await screenWindow(model, title: "Item", size: size) { NavigationStack { ItemView(id: id) } }
            }
        }
        if let metric = d.string(forKey: "EAHealthMetric").flatMap(HealthMetric.init(rawValue:)) {
            let size = d.string(forKey: "EAWindowSize").flatMap(parse) ?? NSSize(width: 760, height: 900)
            Task { await screenWindow(model, title: metric.title, size: size) { NavigationStack { HealthMetricView(metric: metric) } } }
        }
        guard let size = d.string(forKey: "EAWindowSize").flatMap(parse) else { return }
        try? await Task.sleep(for: .seconds(1))
        guard let window = NSApp.windows.first(where: { $0.canBecomeMain }) else { return }
        window.setFrame(NSRect(origin: window.frame.origin, size: size), display: true)
        window.center()
    }

    /// `everythingapp://debug/click?x=&y=` and `everythingapp://debug/size?w=&h=`: see the list at the top. The click
    /// is a mouse press and release handed to the window itself, so it needs no permission and moves no pointer; what
    /// it reaches is whatever is drawn at that point. Each prints one line on standard output.
    static func command(_ url: URL) {
        func say(_ s: String) { print("debug: " + s); fflush(stdout) }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func number(_ name: String) -> Double? { items.first { $0.name == name }?.value.flatMap(Double.init) }
        guard let window = NSApp.windows.first(where: { $0.isVisible && $0.canBecomeMain }) else { say("no window"); return }
        switch url.pathComponents.dropFirst().first {
        case "click":
            guard let x = number("x"), let y = number("y") else { say("click needs x and y"); return }
            // A window counts from its bottom left corner.
            let at = NSPoint(x: x, y: window.frame.height - y)
            func send(_ type: NSEvent.EventType) {
                guard let e = NSEvent.mouseEvent(with: type, location: at, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                                 windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) else { return }
                window.sendEvent(e)
            }
            send(.leftMouseDown)
            // The release in a later turn of the run loop, as a hand's is.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) {
                send(.leftMouseUp)
                say("clicked \(Int(x)),\(Int(y))")
            }
        case "size":
            guard let w = number("w"), let h = number("h") else { say("size needs w and h"); return }
            let f = window.frame
            window.setFrame(NSRect(x: f.minX, y: f.maxY - h, width: w, height: h), display: true)
            say("size \(Int(window.frame.width))x\(Int(window.frame.height))")
        case "key":
            actLikeKey(window)
            say("key \(window.isKeyWindow) main \(window.isMainWindow) active \(NSApp.isActive)")
        default:
            say("unknown command")
        }
    }

    /// `everythingapp://debug/key`: the window draws as the key window of the app in front without being it, so the
    /// colors a screen has only then (the sidebar's chosen row, prominent buttons) can be photographed while someone
    /// else is using the Mac: nothing comes to the front and no typing is taken. The window and the app answer "yes"
    /// when asked whether they are key, main and active, and every view is told that this changed, as AppKit tells
    /// them when a window really becomes key (its own, private, message for it; this file is in Debug builds only).
    /// One thing it does not reach: a list's own band for its chosen row stays gray (the Mac draws it in the accent
    /// only while the keyboard is really in that list).
    private static func actLikeKey(_ window: NSWindow) {
        let yes: @convention(block) (AnyObject) -> Bool = { _ in true }
        let asked: [(of: AnyClass, name: String)] = [(type(of: window), "isKeyWindow"), (type(of: window), "isMainWindow"), (type(of: NSApplication.shared), "isActive")]
        for q in asked { class_replaceMethod(q.of, Selector(q.name), imp_implementationWithBlock(yes), "c@:") }
        NotificationCenter.default.post(name: NSApplication.didBecomeActiveNotification, object: NSApp)
        NotificationCenter.default.post(name: NSWindow.didBecomeMainNotification, object: window)
        NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: window)
        let changed = Selector(("_windowChangedKeyState"))
        func tell(_ v: NSView) {
            if v.responds(to: changed) { v.perform(changed) }
            v.needsDisplay = true
            v.subviews.forEach(tell)
        }
        if let top = window.contentView?.superview ?? window.contentView { tell(top) }
    }

    /// `-EAMenuTest YES` (with `-EASample YES` on a copy that is not set up): the window commands checked from inside
    /// the app, one line each on standard output, so run the binary from a shell. When it says "ready for reopen",
    /// send what a Dock click sends (`open -b <bundle id>`); at "ready for link", open `everythingapp://week` with
    /// `open -b <bundle id>`; at "ready for second link", open `everythingapp://section/tasks` the same way.
    static func menuSelfTest(_ model: AppModel) async {
        func say(_ s: String) { print("menu test: " + s); fflush(stdout) }
        func mains() -> [NSWindow] {
            NSApp.windows.filter { $0.isVisible && $0.canBecomeMain && $0.identifier?.rawValue.hasPrefix("screen") != true }
        }
        func wait(_ seconds: Double, until ok: () -> Bool) async -> Bool {
            let end = Date().addingTimeInterval(seconds)
            while Date() < end {
                if ok() { return true }
                try? await Task.sleep(for: .milliseconds(200))
            }
            return ok()
        }
        func closeAll() async {
            mains().forEach { $0.performClose(nil) }
            _ = await wait(3) { mains().isEmpty }
        }
        func describe(_ title: String) -> String {
            guard let menu = NSApp.mainMenu?.items.first(where: { $0.title == title })?.submenu else { return "\(title): none" }
            let items = menu.items.filter { !$0.isSeparatorItem && !$0.isHidden }.map { i -> String in
                guard !i.keyEquivalent.isEmpty else { return i.title }
                let f = i.keyEquivalentModifierMask
                let mods = (f.contains(.control) ? "⌃" : "") + (f.contains(.option) ? "⌥" : "") + (f.contains(.shift) ? "⇧" : "") + (f.contains(.command) ? "⌘" : "")
                return "\(i.title) \(mods)\(i.keyEquivalent == " " ? "Space" : i.keyEquivalent.uppercased())"
            }
            return "\(title): " + items.joined(separator: " | ")
        }

        guard await wait(15, until: { !mains().isEmpty }) else { say("FAIL no main window at start"); return }
        say("main window at start: " + mains().map { "\($0.identifier?.rawValue ?? "none") \"\($0.title)\"" }.joined(separator: ", "))
        let app = NSApp.mainMenu?.items.first?.submenu
        say("App menu: " + (app?.items.filter { !$0.isSeparatorItem && !$0.isHidden }.map(\.title).joined(separator: " | ") ?? "none"))
        for title in ["File", "Window", "Help"] { say(describe(title)) }

        // Settings… in the app menu, with the main window closed.
        await closeAll()
        say("closed: \(mains().count) main windows open")
        if let app, let i = app.items.firstIndex(where: { $0.title.hasPrefix("Settings") }) {
            app.performActionForItem(at: i)
            let ok = await wait(5) { !mains().isEmpty && model.section == .settings }
            say((ok ? "PASS" : "FAIL") + " Settings opened the main window on Settings (\(mains().count) open, section \(model.section.rawValue))")
        } else {
            say("FAIL no Settings item")
        }

        // Aeneas in the Window menu, with the main window closed.
        await closeAll()
        if let menu = NSApp.mainMenu?.items.first(where: { $0.title == "Window" })?.submenu,
           let i = menu.items.firstIndex(where: { $0.title == "Aeneas" }) {
            menu.performActionForItem(at: i)
            let ok = await wait(5) { mains().count == 1 }
            say((ok ? "PASS" : "FAIL") + " Window, Aeneas opened the main window (\(mains().count) open)")
            menu.performActionForItem(at: i)
            try? await Task.sleep(for: .seconds(1))
            say((mains().count == 1 ? "PASS" : "FAIL") + " Window, Aeneas with it open kept one window (\(mains().count) open)")
        } else {
            say("FAIL no Aeneas item in the Window menu")
        }

        // A Dock click, sent from the shell.
        await closeAll()
        say("ready for reopen")
        let reopened = await wait(30) { !mains().isEmpty }
        say((reopened ? "PASS" : "FAIL") + " reopen brought the main window back (\(mains().count) open)")

        // A link while the main window is closed.
        await closeAll()
        model.section = .today
        say("ready for link")
        let linked = await wait(30) { !mains().isEmpty && model.section == .week }
        say((linked ? "PASS" : "FAIL") + " the link opened the main window on Week (\(mains().count) open, section \(model.section.rawValue))")
        // A link while the main window is open: the same window shows it. Each link used to open one more.
        say("ready for second link")
        let shown = await wait(30) { model.section == .tasks }
        try? await Task.sleep(for: .seconds(2))
        say((shown && mains().count == 1 ? "PASS" : "FAIL") + " a link with the window open kept one window (\(mains().count) open, section \(model.section.rawValue))")
        // Settings… again with the window open: the same window, not a second one.
        if let app, let i = app.items.firstIndex(where: { $0.title.hasPrefix("Settings") }) {
            app.performActionForItem(at: i)
            try? await Task.sleep(for: .seconds(2))
            let ok = mains().count == 1 && model.section == .settings
            say((ok ? "PASS" : "FAIL") + " Settings with the window open kept one window (\(mains().count) open, section \(model.section.rawValue))")
        }
        if let w = mains().first { say("window \(w.windowNumber)") }
        // The File, Window and Help menus drawn over the window for 4 seconds each, with the menu's own window number
        // printed for a screenshot taken from the shell (`screencapture -l`).
        if let w = mains().first, let content = w.contentView {
            for title in ["File", "Window", "Help"] {
                guard let menu = NSApp.mainMenu?.items.first(where: { $0.title == title })?.submenu else { continue }
                let find = Timer(timeInterval: 0.8, repeats: false) { _ in
                    let all = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
                    let level = Int(CGWindowLevelForKey(.popUpMenuWindow))
                    let ids = all.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == getpid() && ($0[kCGWindowLayer as String] as? Int) == level }
                        .compactMap { $0[kCGWindowNumber as String] as? Int }
                    say("menu \(title) window \(ids.first.map(String.init) ?? "none")")
                }
                let done = Timer(timeInterval: 4, repeats: false) { _ in menu.cancelTracking() }
                RunLoop.main.add(find, forMode: .eventTracking)
                RunLoop.main.add(done, forMode: .eventTracking)
                // Near the top of the window (SwiftUI's content view is flipped), so the whole menu fits below.
                menu.popUp(positioning: nil, at: NSPoint(x: 240, y: content.isFlipped ? 30 : content.bounds.height - 30), in: content)
                try? await Task.sleep(for: .milliseconds(500))
            }
        }
        // The sample's reminders would otherwise alert later from a copy that is no longer running.
        UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
        say("done")
    }

    /// `-EADictationTest YES` with `-EADictationSay "<words>"` and `-EASection assistant` (or capture): runs the screen's
    /// mic button action as a click does (SwiftUI builds no accessibility tree to press it by unless an assistive app is
    /// on). The dictation prints each step ("dictation: ..."); this prints the window number for a screenshot and, on
    /// Capture, taps again after 8 seconds (Capture has no stop on a pause).
    static func dictationSelfTest(section: Section) async {
        func say(_ s: String) { print("dictation test: " + s); fflush(stdout) }
        var window: NSWindow?
        for _ in 0..<100 {
            window = NSApp.windows.first { $0.isVisible && $0.canBecomeMain && $0.identifier?.rawValue.hasPrefix("main") == true }
            if window != nil { break }
            try? await Task.sleep(for: .milliseconds(200))
        }
        guard let window else { say("FAIL no main window"); return }
        // The screen's own start (the assistant reads its chats first).
        try? await Task.sleep(for: .seconds(3))
        say("window \(window.windowNumber)")
        say("pressing the mic on \(section.rawValue)")
        NotificationCenter.default.post(name: .debugPressMic, object: nil)
        if section == .capture {
            try? await Task.sleep(for: .seconds(8))
            say("pressing the mic again to stop")
            NotificationCenter.default.post(name: .debugPressMic, object: nil)
        }
        try? await Task.sleep(for: .seconds(20))
        say("done")
    }

    /// `-EAModuleTest <module id>` (in sample mode): Settings, Modules in a window of its own with that module switched
    /// on as a click does, so the answer shown under the switch can be screenshotted. Prints the window number.
    static func moduleSelfTest(_ model: AppModel, id: String) async {
        func say(_ s: String) { print("module test: " + s); fflush(stdout) }
        try? await Task.sleep(for: .seconds(3))
        let screen = NavigationStack { ModulesSettingsView() }
            .themedRoot()
            .environmentObject(model)
            .environmentObject(model.engine)
        let w = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 640, height: 720), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        w.title = "Modules"
        w.isReleasedWhenClosed = false
        w.contentView = NSHostingView(rootView: screen)
        w.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .seconds(3))
        say("flipping \(id)")
        NotificationCenter.default.post(name: .debugFlipModule, object: id)
        try? await Task.sleep(for: .seconds(3))
        say("window \(w.windowNumber)")
        try? await Task.sleep(for: .seconds(2))
        say("done")
    }

    /// `-EAReferenceTest YES` or `-EAReferenceOpen <book>/<path>`: the Reference screen in a window of its own, with
    /// its toolbar and search field, searching for `-EAReferenceQuery` and with the page open when asked. Prints the
    /// window number once the page has had time to load.
    static func referenceSelfTest(_ model: AppModel) async {
        func say(_ s: String) { print("reference test: " + s); fflush(stdout) }
        let d = UserDefaults.standard
        try? await Task.sleep(for: .seconds(2))
        let query = d.string(forKey: "EAReferenceQuery")
        var page: ReferencePageLink?
        if let s = d.string(forKey: "EAReferenceOpen") {
            if let l = ReferenceLink.split(s) { page = ReferencePageLink(book: l.book, path: l.path) } else { say("not <book>/<path>: \(s)") }
        }
        let screen = NavigationStack { ReferenceView(startQuery: query, startPage: page) }
            .themedRoot()
            .environmentObject(model)
            .environmentObject(model.engine)
        let size = d.string(forKey: "EAWindowSize").flatMap(parse) ?? NSSize(width: 1100, height: 760)
        let w = NSWindow(contentRect: NSRect(origin: NSPoint(x: 160, y: 120), size: size), styleMask: [.titled, .closable, .resizable, .miniaturizable],
                         backing: .buffered, defer: false)
        w.title = "Reference"
        w.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: screen)
        // The screen's toolbar (search field, buttons) and title on this window, as in the app's own windows.
        host.sceneBridgingOptions = .all
        w.contentView = host
        w.center()
        w.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .seconds(6))
        say("window \(w.windowNumber)")
        try? await Task.sleep(for: .seconds(2))
        say("done")
    }

    /// `-EAProcedureTest YES`: a procedure to look at on a copy that has none (the sample has none). It is put in
    /// the local copy as an item from the hub is, under an id of its own, so nothing is queued for the hub. With
    /// `-EAProcedureRun YES` the procedure opens to run in a window of its own.
    static func procedureSelfTest(_ model: AppModel) async {
        try? await Task.sleep(for: .seconds(2))
        let engine = model.engine
        var id = engine.list(.procedure).first?.id
        if id == nil {
            let text = """
            1. Snapshot the dataset before touching it
            ```
            zfs snapshot tank/scratch@pre-move
            ```
            2. Copy the snapshot to the new pool and wait for it to finish
            ```
            zfs send tank/scratch@pre-move | zfs receive backup/scratch
            ```
            3. Check that both sides list the same snapshot with `zfs list -t snapshot -r backup/scratch`
            4. Point the nightly job at the new pool and run it once by hand
            """
            let steps = Making.stepsFromText(text, host: "nas01")
            let made = Entity(id: "0f9e8d7c-6b5a-4321-8fed-00000000c001", kind: .procedure, fields: [
                "title": "Move scratch to the backup pool", "steps": (try? JSONCoding.value(steps)) ?? .array([]), "current": 0
            ])
            await engine.absorb(made)
            id = made.id
        }
        guard let id, UserDefaults.standard.bool(forKey: "EAProcedureRun") else { return }
        let size = UserDefaults.standard.string(forKey: "EAWindowSize").flatMap(parse) ?? NSSize(width: 1100, height: 760)
        await screenWindow(model, title: "Procedure", size: size) { NavigationStack { ProcedureRunnerView(procedureId: id) } }
    }

    /// `-EAQuizTest YES`: a recall quiz for today and two earlier ones on a copy that has none, put in the local
    /// copy as items from the hub are, under ids of their own, so nothing is queued for the hub.
    static func quizSelfTest(_ model: AppModel) async {
        try? await Task.sleep(for: .seconds(2))
        guard model.engine.list(.quiz).isEmpty else { return }
        func items(_ answered: [QuizResult?]) -> JSONValue {
            let all = [
                Making.QuizItem(q: "Which disk goes into the NAS first, and why one at a time?", a: "Any one of the four. A resilver is when a second disk is most likely to fail.", hint: "Think about what RAIDZ2 survives.", topic: "Homelab"),
                Making.QuizItem(q: "What did the last scrub say about how long a resilver takes?", a: "About 19 hours for the same data, so 20 to 26 hours a disk.", hint: "It read every block once.", topic: "Homelab"),
                Making.QuizItem(q: "What has Jamie been wanting to try?", a: "A pottery class.", hint: "It is made of clay.", topic: "People")
            ]
            let marked = zip(all, answered).map { item, r in var i = item; i.result = r; return i }
            return (try? JSONCoding.value(marked)) ?? .array([])
        }
        let day = { (back: Int) in Making.localDay(Date().addingTimeInterval(-86400 * Double(back))) }
        await model.engine.absorb([
            Entity(id: "0f9e8d7c-6b5a-4321-8fed-00000000d001", kind: .quiz, fields: ["date": .string(day(0)), "items": items([nil, nil, nil])]),
            Entity(id: "0f9e8d7c-6b5a-4321-8fed-00000000d002", kind: .quiz, fields: ["date": .string(day(1)), "items": items([.right, .right, .revealed])]),
            Entity(id: "0f9e8d7c-6b5a-4321-8fed-00000000d003", kind: .quiz, fields: ["date": .string(day(2)), "items": items([.right, .wrong, .right])])
        ])
    }

    /// One screen in a window of its own, with its toolbar on the window as in the app, for a screenshot: prints the
    /// window number once the screen has had time to load what it reads.
    static func screenWindow<V: View>(_ model: AppModel, title: String, size: NSSize, @ViewBuilder _ content: () -> V) async {
        func say(_ s: String) { print("screen test: " + s); fflush(stdout) }
        try? await Task.sleep(for: .seconds(3))
        let screen = content()
            .themedRoot()
            .environmentObject(model)
            .environmentObject(model.engine)
        let w = NSWindow(contentRect: NSRect(origin: NSPoint(x: 160, y: 120), size: size), styleMask: [.titled, .closable, .resizable, .miniaturizable],
                         backing: .buffered, defer: false)
        w.title = title
        w.isReleasedWhenClosed = false
        let host = NSHostingView(rootView: screen)
        host.sceneBridgingOptions = .all
        w.contentView = host
        // On the sharpest screen, so a screenshot is at 2x when a Retina display is attached.
        if let screen = NSScreen.screens.max(by: { $0.backingScaleFactor < $1.backingScaleFactor }) {
            let f = screen.visibleFrame
            w.setFrameOrigin(NSPoint(x: f.midX - size.width / 2, y: max(f.minY, f.maxY - size.height - 40)))
        } else {
            w.center()
        }
        w.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .seconds(5))
        say("\(title) window \(w.windowNumber), at \(Int(w.backingScaleFactor))x")
    }

    private static func parse(_ s: String) -> NSSize? {
        let p = s.lowercased().split(separator: "x").compactMap { Double($0) }
        return p.count == 2 ? NSSize(width: p[0], height: p[1]) : nil
    }
}
#endif
