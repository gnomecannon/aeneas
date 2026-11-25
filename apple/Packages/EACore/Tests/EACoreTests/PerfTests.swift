import XCTest
@testable import EACore

/// Timings on a year of data, for the work the screens redo each time they draw (a SwiftUI body runs again on every
/// change the engine publishes). Skipped unless `EA_PERF_ENTITIES` names a JSON array of entities, such as the perf
/// fixture's sync feed (hub/scripts/perf-fixture.ts):
///
///     EA_PERF_ENTITIES=/path/entities.json swift test --filter PerfTests
///
/// `EA_PERF_MAIL` names a saved answer of `GET /mail` for the Mail screen's timings.
///
/// Each line printed is the median of the runs, in milliseconds: CPU time of the test's thread for work done there, wall
/// time for work that waits on the store.
@MainActor
final class PerfTests: XCTestCase {
    private static var loaded: [Entity]?

    private func entities() throws -> [Entity] {
        if let l = Self.loaded { return l }
        guard let path = ProcessInfo.processInfo.environment["EA_PERF_ENTITIES"], !path.isEmpty else { throw XCTSkip("EA_PERF_ENTITIES is not set") }
        let list = try JSONDecoder().decode([Entity].self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        Self.loaded = list
        return list
    }

    private func engine() async throws -> SyncEngine {
        let e = SyncEngine(config: SharedConfig(suiteName: "perf-\(UUID().uuidString)"), platform: .iphone, store: try SyncStore.inMemory())
        e.schedulesNotifications = false
        await e.absorb(try entities())
        return e
    }

    /// Runs `body` `runs` times and prints the median of the time this thread spent on it (CPU time, so other work on
    /// a busy machine counts less).
    @discardableResult
    private func time(_ label: String, runs: Int = 7, _ body: () -> Void) -> Double {
        var ms: [Double] = []
        for _ in 0..<runs {
            let t = clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)
            body()
            ms.append(Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID) - t) / 1e6)
        }
        let m = ms.sorted()[runs / 2]
        print(String(format: "PERF %-44@ %8.1f ms", label as NSString, m))
        return m
    }

    private func timeAsync(_ label: String, runs: Int = 7, _ body: () async -> Void) async -> Double {
        var ms: [Double] = []
        for _ in 0..<runs {
            let t = DispatchTime.now().uptimeNanoseconds
            await body()
            ms.append(Double(DispatchTime.now().uptimeNanoseconds - t) / 1e6)
        }
        let m = ms.sorted()[runs / 2]
        print(String(format: "PERF %-44@ %8.1f ms", label as NSString, m))
        return m
    }

    /// What Today's board works out each time it draws (TodayBoardView: board, needs, schedule, to do, so far, coming).
    func testTodayBoardDraw() async throws {
        let engine = try await engine()
        let now = Date()
        let today = engine.localToday(now: now)
        time("Today: the day's events (localDay)") { _ = engine.localDay(now).events }
        time("Today: needs you") {
            let tasks = engine.list(.task)
            _ = TodayBoard.needsYou(reminders: Mail.dueReminders(tasks, now: now), tasks: tasks, watches: today.watches_due_soon,
                                    followUps: TodayExtras.followUpsDue(engine.list(.application), now: now),
                                    meds: TodayExtras.regularMeds(engine.logs(type: .med, days: 9), now: now),
                                    unsorted: engine.unprocessedCaptures.count, now: now)
        }
        let events = engine.localDay(now).events
        time("Today: schedule (plans and people)") {
            let plans = TodayExtras.plansToday(events: events, reminders: today.reminders_due,
                                               tasks: engine.list(.task).filter { $0.str("status") == "doing" || !$0.str("due").isEmpty }, now: now)
            _ = TodayExtras.peopleInPlans(people: engine.list(.person), facts: engine.list(.fact), plans: plans)
        }
        time("Today: to do") { _ = TodayBoard.openTasks(engine.list(.task)); _ = engine.startedTask }
        time("Today: so far") {
            let diary = TodayBoard.diary(engine.list(.note), now: now)
            _ = TodayBoard.soFar(diary: diary?.lines ?? [], tasks: engine.list(.task), logs: engine.logs, now: now)
            _ = TodayBoard.todayNumbers(engine.logs, now: now)
        }
        time("Today: coming") {
            let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: now))!
            _ = TodayBoard.tomorrowLines(engine.localDay(tomorrow, now: now).events, now: now)
            _ = TodayExtras.datesSoon(engine.list(.person), now: now)
        }
        time("Today: whole board, once") {
            _ = engine.localDay(now).events
            let tasks = engine.list(.task)
            _ = TodayBoard.needsYou(reminders: Mail.dueReminders(tasks, now: now), tasks: tasks, watches: today.watches_due_soon,
                                    followUps: TodayExtras.followUpsDue(engine.list(.application), now: now),
                                    meds: TodayExtras.regularMeds(engine.logs(type: .med, days: 9), now: now),
                                    unsorted: engine.unprocessedCaptures.count, now: now)
            let plans = TodayExtras.plansToday(events: events, reminders: today.reminders_due,
                                               tasks: tasks.filter { $0.str("status") == "doing" || !$0.str("due").isEmpty }, now: now)
            _ = TodayExtras.peopleInPlans(people: engine.list(.person), facts: engine.list(.fact), plans: plans)
            _ = TodayBoard.openTasks(tasks); _ = engine.startedTask
            let diary = TodayBoard.diary(engine.list(.note), now: now)
            _ = TodayBoard.soFar(diary: diary?.lines ?? [], tasks: tasks, logs: engine.logs, now: now)
            _ = TodayBoard.todayNumbers(engine.logs, now: now)
            let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: now))!
            _ = TodayBoard.tomorrowLines(engine.localDay(tomorrow, now: now).events, now: now)
            _ = TodayExtras.datesSoon(engine.list(.person), now: now)
        }
        time("Week: the week planned here (localWeek)") { _ = engine.localWeek(start: now) }
    }

    /// Notes: the sorted list (NotesView reads it twice per draw) and a search typed into it, one letter at a time.
    func testNotesDraw() async throws {
        let engine = try await engine()
        time("Notes: engine.notes (sorted by title)") { _ = engine.notes }
        time("Notes: search 'gar' over every note") {
            let q = "gar"
            _ = engine.notes.filter { $0.str("title").lowercased().contains(q) || $0.str("body").lowercased().contains(q) || $0.stringArray("tags").contains { $0.lowercased().contains(q) } }
        }
    }

    /// Tasks: the lists the Tasks screen draws.
    func testTasksDraw() async throws {
        let engine = try await engine()
        time("Tasks: next, scheduled, inbox, doing") {
            for s in [TaskStatus.next, .scheduled, .inbox, .doing] { _ = engine.tasks(status: s) }
        }
        time("Tasks: reminders (sorted by time)") { _ = engine.reminders }
    }

    /// One edit: what the engine does after it (the store, the kind index, the widget snapshot and the reminders).
    func testOneEdit() async throws {
        let engine = try await engine()
        var planned = 0
        engine.schedulesNotifications = true
        engine.onReplan = { planned += $0.count }
        let task = try XCTUnwrap(engine.list(.task).first { $0.str("status") == "next" })
        var n = 0
        await timeAsync("Edit: a task's title, end to end") {
            n += 1
            _ = await engine.update(task.id, fields: ["title": .string("Edited \(n)")])
        }
        time("Edit: rebuild the kind index after a change") {
            engine.byKind = nil
            _ = engine.list(.task)
        }
        time("Edit: widget snapshot (updateSnapshot)") { engine.updateSnapshot() }
        XCTAssertGreaterThan(planned, 0)
    }

    /// Launch: reading the whole copy from the device's store, and one sync page taken in.
    func testLaunchAndPull() async throws {
        let list = try entities()
        let store = try SyncStore.inMemory()
        _ = try await store.upsertManyFromHub(list)
        await timeAsync("Launch: read every item from the store", runs: 3) { _ = try? await store.all(kind: nil, includeDeleted: true) }
        let page = Array(list.prefix(500)).map { e -> Entity in var x = e; x.updated_at = ISO.now(); return x }
        await timeAsync("Sync: take in one page of 500", runs: 3) { _ = try? await store.upsertManyFromHub(page) }
        time("Parse 10,000 dates (ISO.date)") {
            for e in list.prefix(10_000) { _ = ISO.date(e.updated_at) }
        }
    }

    /// Mail: what the Inbox works out each time it draws, on a saved answer of `GET /mail` (EA_PERF_MAIL).
    func testMailDraw() throws {
        guard let path = ProcessInfo.processInfo.environment["EA_PERF_MAIL"], !path.isEmpty else { throw XCTSkip("EA_PERF_MAIL is not set") }
        let list = try JSONCoding.decode(MailList.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
        let threads = Mail.threads(list.messages)
        let shown = Mail.shownBundles(on: { _ in true }, custom: list.custom_bundles)
        let now = Date()
        time("Mail: Inbox sections (\(threads.count) threads)") { _ = Mail.inboxSections(threads, shown: shown, now: now, delivery: list.bundle_delivery) }
        time("Mail: when each mail shows (inboxAt)") { for t in threads { _ = Mail.inboxAt(t.summary, delivery: list.bundle_delivery, now: now) } }
    }

    /// Mail: a reload after one opened mail, the whole list against what changed (GET /mail?since=), on a saved answer
    /// of `GET /mail` (EA_PERF_MAIL): reading the answer, putting it into the list held, and the threads.
    func testMailReload() throws {
        guard let path = ProcessInfo.processInfo.environment["EA_PERF_MAIL"], !path.isEmpty else { throw XCTSkip("EA_PERF_MAIL is not set") }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        let list = try JSONCoding.decode(MailList.self, from: data)
        var one = list.messages[3]
        one.seen = !(one.seen ?? false)
        let changes = try JSONCoding.data(["changed": [one]])
        var delta = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        delta.removeValue(forKey: "messages"); delta.removeValue(forKey: "logos")
        delta["changed"] = (try JSONSerialization.jsonObject(with: changes) as! [String: Any])["changed"]
        delta["gone"] = [String](); delta["cursor"] = "c"; delta["max"] = 5000
        let deltaData = try JSONSerialization.data(withJSONObject: delta)
        print(String(format: "PERF Mail: answer sizes, whole %.0f KB, changes %.1f KB", Double(data.count) / 1024, Double(deltaData.count) / 1024))
        time("Mail reload: the whole list read, threads") { let l = try! JSONCoding.decode(MailList.self, from: data); _ = Mail.threads(l.messages) }
        time("Mail reload: the changes read and put in, threads") {
            let a = try! JSONCoding.decode(MailListAnswer.self, from: deltaData)
            _ = Mail.threads(Mail.applyChanges(list, a)!.messages)
        }
    }
}
