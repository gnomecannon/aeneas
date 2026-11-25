import Foundation
@testable import EACore

/// Every read the Apple apps' screens make in sample mode, with the arguments the views pass (read from the views in
/// apple/EverythingApp, its Mac folder and the Watch app, not guessed from HubClient). SampleRecorderTests asks the
/// demo hub each of these to make SampleHub.json, and SampleHubTests checks that the bundled recording answers each
/// one on every day of the week. A screen that starts reading something new belongs here too.
///
/// Left out on purpose, because no screen asks them in sample mode or because the answer depends on what is typed:
/// - `devices` and `setup/pair`: the Connection page shows only the sample banner in sample mode.
/// - `hubs/requests/<id>`, `images/jobs/<id>`, and `dashboard/series` for a Dashboard tile: asked only after a write,
///   which sample mode keeps on the device. A reading card's 7, 30 and 90 days are read (below).
/// - `music/<id>/midi` and `audio`, `games/art/<appid>`, `prefs/feel/images/<id>`, `ai/images/<id>`, `wiki/media`:
///   files, and the sample has no hummed idea, Steam game, image shape, chat picture or wiki page.
/// - `connections/password-manager/status`: it reads which password manager tools the recording machine has; the
///   screen leaves its line out when there is no answer.
/// - KeePass entries, master password and file, password manager items, Confluence spaces: the sample links no
///   password manager and no Confluence.
/// - `wiki/search` and `search`: what is typed (Search looks on the device when the hub has no answer).
/// - `entities/<id>` for items not on the device, and `entities?kind=device`: sample mode has every item, and its
///   device id from the start.
/// - `ai/sessions`: sample mode keeps chats on the device.
/// - `machines/hub-key`: the hub machine's own SSH key, read only when asked; the sample hub has no machine of its own.
/// - `vault/index` and `file`, `ai/memory`, `dashboard`, `images/jobs`, `search` by kinds: no Apple screen reads them.
enum SampleScreens {
    struct Read: Sendable {
        /// Where the app asks it, for failure messages.
        var screen: String
        var call: @Sendable (HubClient) async throws -> Void
    }

    /// Week shows this week, and Previous and Next move a week at a time; Today shows another day from the week it
    /// falls in (swipes, and the Mac's arrows). Two weeks either side of this one are recorded.
    static let weeksAround = 2

    /// Kinds with a screen of their own in ItemView; every other kind opens GenericItemView, which reads Related.
    static let ownScreens: Set<Kind> = [.person, .note, .project, .film, .snippet, .runbook, .application, .checklist, .music_idea, .music_profile]

    /// The toolbar's Export CSV on Logs, Tasks, Journal, Snippets, Games, Films and Career (CSVExportButton).
    static let csvExports: [(Kind, [String: String])] = [
        (.log, [:]), (.task, ["space": "personal"]), (.journal, [:]), (.snippet, [:]), (.game, [:]), (.film, [:]), (.application, [:]),
    ]

    /// Connections' "Set it up with the guide" links (OwnKeyGuideView), and Add account's Show me how (`icloud`).
    static let guides = ["steam", "google", "atlassian", "icloud"]

    /// What the synced sample holds that screens ask about by id.
    struct World {
        /// Every item the first sync brings, deleted ones left out.
        var entities: [Entity]
        var wikiPages: [String]

        func ids(_ kind: Kind) -> [String] { entities.filter { $0.kind == kind }.map(\.id) }

        /// The first full sync, page by page as SyncEngine.pull asks it, and the wiki's index.
        static func load(_ client: HubClient) async throws -> World {
            var byId: [String: Entity] = [:]
            var since = 0
            for _ in 0..<200 {
                let page: ChangesResponse
                do { page = try await client.changes(since: since, deviceId: "sample-device") } catch { throw Unanswered(read: "Sync from \(since)", error: error) }
                for ch in page.changes { byId[ch.entity.id] = ch.entity }
                since = max(since, page.changes.map(\.seq).max() ?? since, page.seq)
                if !page.more { break }
            }
            let live = byId.values.filter { !$0.isDeleted }.sorted { $0.id < $1.id }
            let wiki: [String]
            do { wiki = try await client.wikiIndex().pages.map(\.id) } catch { throw Unanswered(read: "Wiki", error: error) }
            return World(entities: live, wikiPages: wiki)
        }
    }

    /// A read the ids come from was not answered.
    struct Unanswered: Error, CustomStringConvertible {
        var read: String
        var error: Error
        var description: String { "\(read): \(error.localizedDescription)" }
    }

    /// The reads the screens make on `today`, as the views pass them.
    static func reads(_ w: World, today: Date) -> [Read] {
        var out: [Read] = []
        func add(_ screen: String, _ call: @escaping @Sendable (HubClient) async throws -> Void) { out.append(Read(screen: screen, call: call)) }

        // Starting up and syncing: AppModel, SyncEngine, FeelController, CalendarImporter, the Watch app.
        add("Profile") { _ = try await $0.profile() }
        add("Modules") { _ = try await $0.modules() }
        add("Theme and taps") { _ = try await $0.feel() }
        add("Hub name, Assistant, Watch") { _ = try await $0.health() }
        add("Calendar and work, Work space") { _ = try await $0.workSpace() }

        // Today, Week, and Today on another day (SyncEngine.loadToday and loadWeek).
        add("Today") { _ = try await $0.plannerToday() }
        let monday = LocalPlanner.monday(of: today)
        for k in -weeksAround...weeksAround {
            guard let start = Calendar.current.date(byAdding: .day, value: 7 * k, to: monday) else { continue }
            let day = LocalPlanner.dateString(start)
            add("Week of \(day)") { _ = try await $0.plannerWeek(start: day, minHours: LocalPlanner.defaultBlockHours) }
        }

        // Library.
        add("Dashboard") { _ = try await $0.dashboardBoard() }
        add("Dashboard, Add a tile") { _ = try await $0.dashboardMetrics() }
        add("Renewals, totals") { _ = try await $0.renewalTotals() }
        add("Notes, tagging") { _ = try await $0.notesLinking() }
        add("Notes, map") { _ = try await $0.graph() }
        for id in w.ids(.note) { add("Note \(id), Related") { _ = try await $0.related(noteId: id) } }
        for e in w.entities where !ownScreens.contains(e.kind) {
            let id = e.id
            add("\(e.kind.rawValue) \(id), Related") { _ = try await $0.related(itemId: id) }
        }
        for id in w.ids(.project) { add("Projects and project \(id)") { _ = try await $0.projectSummary(id) } }
        add("Quiz") { _ = try await $0.quizToday() }
        add("Quiz, streak") { _ = try await $0.creativeStatus() }
        add("Ops") { _ = try await $0.opsBoard() }
        add("Machines") { _ = try await $0.hostSummaries() }
        add("Overview, Add machine") { _ = try await $0.machines() }
        // Add machine and Set up Machines offer a password manager item only when one is linked.
        add("Add machine, password manager") { _ = try await $0.passwordManagerLinked() }
        for id in w.ids(.monitor) {
            add("Monitor \(id), history") { _ = try await $0.monitorHistory(id: id, hours: 24) }
            // Monitor and machine pages read their monitors again every 30 s (Homelab.fresh).
            add("Monitor \(id), refreshed") { _ = try await $0.entity(id) }
        }
        for id in w.ids(.incident) { add("Incident \(id), refreshed") { _ = try await $0.entity(id) } }
        add("Sensors") { _ = try await $0.sensors() }
        for e in w.entities where e.kind == .sensor {
            let name = e.str("name")
            add("Sensor \(name), Export") { _ = try await $0.sensorCSV(name: name, days: 30) }
            // The reading card's 7d, 30d and 90d (SensorCard), a daily mean each.
            for days in [7, 30, 90] {
                add("Sensor \(name), \(days) days") { _ = try await $0.dashboardSeries(metric: "sensor:\(name)", days: days) }
            }
        }
        add("Sensors and Connections, feed keys") { _ = try await $0.feedKeys() }
        add("Wiki") { _ = try await $0.wikiIndex() }
        for id in w.wikiPages { add("Wiki page \(id)") { _ = try await $0.wikiPage(id: id) } }
        add("Images") { _ = try await $0.imageCapabilities() }
        for (kind, filter) in csvExports { add("Export CSV of \(kind.rawValue)") { _ = try await $0.exportCSV(kind: kind, filter: filter) } }

        // Settings.
        add("Settings, People on this machine") { _ = try await $0.hubs() }
        add("Accounts and Connections") { _ = try await $0.connections() }
        // Settings, Accounts: the iCloud account's calendars, and From this iPhone's lists and calendars. A demo hub
        // links no account (it would sign in with a made-up password), so these and Accounts' made-up addresses in
        // the answer above are written into SampleHub.json by hand, and kept when it is recorded again.
        add("Accounts, an iCloud account's calendars") { _ = try await $0.calendars() }
        add("Accounts, From this iPhone") { _ = try await $0.sources() }
        for s in guides { add("Connections, \(s) guide") { _ = try await $0.ownKeyGuide(service: s) } }
        add("Connections, Password manager machines") { _ = try await $0.commandHosts() }
        add("Bring your data in") { _ = try await $0.importJobs() }
        add("About, Hub software") { _ = try await $0.hubUpdate() }
        return out
    }

    /// The recording the app ships (apple/EverythingApp/Resources/SampleHub.json).
    static var bundledRecording: URL {
        var u = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { u.deleteLastPathComponent() }   // EACoreTests, Tests, EACore, Packages: apple/
        return u.appendingPathComponent("EverythingApp/Resources/SampleHub.json")
    }
}

/// Moves every date in a request by `days`, so a screen's reads on another day of the week can be recorded on the
/// recording day: there they ask for dates `days` later, and sample mode looks them up by their distance from today.
struct DayShiftTransport: HubTransport {
    var inner: HubTransport
    var days: Int
    /// The day the dates in requests are near (the other day of the week).
    var around: String

    func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        try await inner.send(method: method, path: SampleTransport.shift(path, days: days, around: around),
                             query: query.mapValues { SampleTransport.shift($0, days: days, around: around) }, body: body)
    }
}
