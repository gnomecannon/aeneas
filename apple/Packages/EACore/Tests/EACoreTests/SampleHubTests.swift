import XCTest
@testable import EACore

final class SampleHubTests: XCTestCase {
    private func day(_ s: String) -> Date { SampleTransport.dayDate(s)! }

    func testDatesMoveToTodayButBirthdaysStay() {
        let body = #"{"start":"2026-11-06T15:00:00.000Z","due":"2026-11-09","birthday":"1991-11-15","text":"Spotify on 2026-11-09"}"#
        let out = SampleTransport.shift(body, days: 10, around: "2026-11-06")
        XCTAssertTrue(out.contains(#""start":"2026-11-16T15:00:00.000Z""#), out)
        XCTAssertTrue(out.contains(#""due":"2026-11-19""#))
        XCTAssertTrue(out.contains(#""birthday":"1991-11-15""#), "a birthday decades ago is not moved")
        XCTAssertTrue(out.contains("Spotify on 2026-11-19"))
        XCTAssertEqual(SampleTransport.shift(body, days: 0, around: "2026-11-06"), body)
    }

    func testARequestForTodayFindsTheRecordingsToday() async throws {
        let recKey = SampleTransport.key(method: "GET", path: "planner/day/2026-11-06", query: ["tz": "America/New_York"], recordedDay: "2026-11-06")
        XCTAssertEqual(recKey, "GET planner/day/@D+0?tz=America/New_York")
        let rec = SampleTransport.Recording(day: "2026-11-06", entries: [recKey: .init(status: 200, body: #"{"date":"2026-11-06"}"#)])
        let t = SampleTransport(recording: rec, today: day("2026-12-01"))
        let r = try await t.send(method: "GET", path: "planner/day/2026-12-01", query: ["tz": "America/New_York"], body: nil)
        XCTAssertEqual(r.status, 200)
        XCTAssertEqual(String(data: r.data, encoding: .utf8), #"{"date":"2026-12-01"}"#)
    }

    func testEditsStayOnTheDeviceAndTheAssistantSaysWhy() async throws {
        let t = SampleTransport(recording: .init(day: "2026-11-06"), today: day("2026-11-06"))
        let push = try JSONEncoder().encode(PushRequest(device_id: "sample-device", patches: [Patch(id: "a1", kind: .task, fields: ["title": "x"], create: true)]))
        let p = try await t.send(method: "POST", path: "sync/push", query: [:], body: push)
        let pr = try JSONDecoder().decode(PushResponse.self, from: p.data)
        XCTAssertEqual(pr.applied.map(\.id), ["a1"])
        let c = try await t.send(method: "POST", path: "ai/chat", query: [:], body: Data("{}".utf8))
        XCTAssertTrue(try JSONDecoder().decode(ChatResponse.self, from: c.data).reply.contains("sample data"))
        let req = try JSONEncoder().encode(ChatRequest(session_id: "s1", message: "What's on today?"))
        _ = try await t.send(method: "POST", path: "ai/chat", query: [:], body: req)
        let back = try JSONDecoder().decode(AISession.self, from: try await t.send(method: "GET", path: "ai/sessions/s1", query: [:], body: nil).data)
        XCTAssertEqual(back.messages.map(\.role), [.user, .assistant], "the screen reads the conversation back")
        let later = try await t.send(method: "GET", path: "sync/changes", query: ["since": "1000001"], body: nil)
        XCTAssertEqual(try JSONDecoder().decode(ChangesResponse.self, from: later.data).changes.count, 0)
        let other = try await t.send(method: "POST", path: "capture", query: [:], body: Data("{}".utf8))
        XCTAssertEqual(other.status, 503)
    }

    /// The recording the app ships answers every read the screens make (SampleScreens), on each day of the week: Week
    /// asks for this week's Monday, which is a different distance from today on each weekday.
    func testTheBundledRecordingAnswersEveryScreenOnEveryWeekday() async throws {
        let rec = try JSONDecoder().decode(SampleTransport.Recording.self, from: Data(contentsOf: SampleScreens.bundledRecording))
        let recorded = try XCTUnwrap(SampleTransport.dayDate(rec.day))
        var weekdays = Set<Int>()
        for k in 0..<7 {
            // A month after the recording, so every date in the answers moves.
            let today = try XCTUnwrap(Calendar.current.date(byAdding: .day, value: 30 + k, to: recorded))
            weekdays.insert(Calendar.current.component(.weekday, from: today))
            let client = HubClient(transport: SampleTransport(recording: rec, today: today))
            let world = try await SampleScreens.World.load(client)
            XCTAssertFalse(world.entities.isEmpty)
            var missed: [String] = []
            for read in SampleScreens.reads(world, today: today) {
                do { try await read.call(client) } catch { missed.append("\(read.screen): \(error.localizedDescription)") }
            }
            XCTAssertEqual(missed, [], "not answered on \(LocalPlanner.dateString(today))")
        }
        XCTAssertEqual(weekdays.count, 7)
    }

    /// Week's answer on a later day is the week that starts on that day's Monday, with the recorded days moved there.
    func testTheWeekShownStartsOnThisWeeksMonday() async throws {
        let rec = try JSONDecoder().decode(SampleTransport.Recording.self, from: Data(contentsOf: SampleScreens.bundledRecording))
        let recorded = try XCTUnwrap(SampleTransport.dayDate(rec.day))
        for k in 40..<47 {
            let today = try XCTUnwrap(Calendar.current.date(byAdding: .day, value: k, to: recorded))
            let client = HubClient(transport: SampleTransport(recording: rec, today: today))
            let monday = LocalPlanner.dateString(LocalPlanner.monday(of: today))
            let week = try await client.plannerWeek(start: monday, minHours: LocalPlanner.defaultBlockHours)
            XCTAssertEqual(week.start, monday)
            XCTAssertEqual(week.days.count, 7)
            XCTAssertTrue(week.days.contains { $0.date == LocalPlanner.dateString(today) }, "today is in this week on \(LocalPlanner.dateString(today))")
        }
    }

    /// Sample mode as the app starts it: the month syncs with no error, and Today and Week (this week, the ones either
    /// side) come from the recording, not from the plan the device works out when the hub has no answer.
    @MainActor
    func testSampleModeSyncsAndPlansFromTheRecording() async throws {
        let before = SampleTransport.shared
        defer { SampleTransport.shared = before }
        SampleTransport.shared = SampleTransport(data: try Data(contentsOf: SampleScreens.bundledRecording))
        XCTAssertNotNil(SampleTransport.shared)
        let engine = SyncEngine(config: SharedConfig(suiteName: "sample-engine-\(UUID().uuidString)"), platform: .iphone, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        await engine.startSample()
        XCTAssertNil(engine.lastError)
        XCTAssertFalse(engine.list(.task).isEmpty)
        let today = await engine.loadToday()
        XCTAssertTrue(today.fromHub)
        let monday = LocalPlanner.monday(of: Date())
        for k in [-7, 0, 7] {
            let start = try XCTUnwrap(Calendar.current.date(byAdding: .day, value: k, to: monday))
            let week = await engine.loadWeek(start: start)
            XCTAssertTrue(week.fromHub, "week of \(LocalPlanner.dateString(start))")
        }
        engine.stop()
    }

    /// The bundled recording is Alex's made-up month and nothing of the machine it was recorded on, and stays small.
    func testTheBundledRecordingHoldsNothingOfTheRecordingMachine() throws {
        let data = try Data(contentsOf: SampleScreens.bundledRecording)
        XCTAssertLessThan(data.count, 2_000_000)
        let rec = try JSONDecoder().decode(SampleTransport.Recording.self, from: data)
        XCTAssertEqual(SampleRecordingCleaner.leftovers(rec), [])
        XCTAssertFalse(rec.entries.keys.contains { $0.hasPrefix("GET ai/sessions") }, "chats are kept on the device in sample mode")
    }

    /// A read the sample has no answer for, and a write it cannot keep, say so in words people read, with no code.
    func testWhatTheSampleCannotAnswerIsWordedWithoutACode() async throws {
        let client = HubClient(transport: SampleTransport(recording: .init(day: "2026-11-06"), today: day("2026-11-06")))
        do {
            _ = try await client.wikiSearch("dragons")
            XCTFail("nothing is recorded")
        } catch let h as HubError {
            XCTAssertEqual(h, .http(status: 404, message: SampleTransport.noSampleData), "screens that treat a 404 as missing still can")
            XCTAssertEqual(h.errorDescription, "This has no sample data. Connect your own hub to see it.")
        }
        do {
            _ = try await client.setWorkSpace(enabled: true)
            XCTFail("a write is refused")
        } catch let h as HubError {
            XCTAssertEqual(h.errorDescription, "This is sample data: connect your own hub to save this.")
        }
        XCTAssertEqual(HubError.http(status: 404, message: "not found").errorDescription, "HTTP 404: not found", "a real hub's refusal keeps its code")
    }

    func testTheRecorderLeavesChatsToTheDevice() async throws {
        struct Hub: HubTransport {
            func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
                (200, Data(path == "ai/sessions" ? #"{"sessions":[]}"#.utf8 : #"{"ok":true}"#.utf8))
            }
        }
        let r = RecordingTransport(inner: Hub(), file: nil, day: "2026-11-06")
        _ = try await r.send(method: "GET", path: "ai/sessions", query: ["limit": "100"], body: nil)
        _ = try await r.send(method: "GET", path: "profile", query: [:], body: nil)
        XCTAssertEqual(Array(r.recording.entries.keys), ["GET profile"])
    }

    func testSampleModeIsConfiguredAndUsesNoNetwork() {
        let c = SharedConfig(suiteName: "sample-test-\(UUID().uuidString)")
        XCTAssertFalse(c.isConfigured)
        c.sampleMode = true
        XCTAssertTrue(c.isConfigured)
        SampleTransport.shared = SampleTransport(recording: .init(day: "2026-11-06"))
        let client = HubClient.make(config: c)
        XCTAssertNotNil(client)
        XCTAssertFalse(client!.supportsStreaming, "no HTTP transport in sample mode")
    }

    /// "Use my location" in the bill splitter: sample mode answers as a hub would (the hub's answers for these places,
    /// from hub/src/mealstax.ts), on the device.
    func testSampleModeFindsTheMealsTaxOnTheDeviceAsTheHubDoes() async throws {
        var u = SampleScreens.bundledRecording
        u.deleteLastPathComponent()
        let table = try JSONDecoder().decode(MealsTaxTable.self, from: Data(contentsOf: u.appendingPathComponent("SampleMealsTax.json")))
        let hub: [(Double, Double, String?, Double)] = [
            (37.32, -122.03, "CA", 7.25), (42.36, -71.06, "MA", 6.25), (39.74, -104.99, "CO", 2.9), (38.9, -77.04, "DC", 10),
            (51.51, -0.13, nil, 0), (21.31, -157.86, "HI", 4), (61.22, -149.9, "AK", 0), (39.1, -94.58, "MO", 4.225), (39.11, -94.63, "KS", 6.5),
        ]
        for (lat, lon, state, pct) in hub {
            let m = table.answer(latitude: lat, longitude: lon)
            XCTAssertEqual(m?.state, state, "\(lat), \(lon)")
            if let m { XCTAssertEqual(m.pct, pct, "\(lat), \(lon)") }
        }

        // Through the client, as the calculator asks.
        let t = SampleTransport(recording: .init(day: "2026-11-06"), today: day("2026-11-06"), mealsTax: table)
        let client = HubClient(transport: t)
        let ca = try await client.mealsTax(latitude: 37.3229, longitude: -122.0322)
        XCTAssertEqual(ca, MealsTax(state: "CA", name: "California", pct: 7.25, note: "California's rate on restaurant meals. Your city or county may add its own."))
        do {
            _ = try await client.mealsTax(latitude: 51.5072, longitude: -0.1276)
            XCTFail("London is not in a US state")
        } catch HubError.http(let status, _) {
            XCTAssertEqual(status, 404, "the calculator says the place is not in a US state")
        }
    }

    // MARK: on any day, at any time

    /// A local time on `day` (YYYY-MM-DD) as the hub writes it.
    private func at(_ day: String, _ h: Int, _ m: Int = 0) -> Date {
        Calendar.current.date(bySettingHour: h, minute: m, second: 0, of: SampleTransport.dayDate(day)!)!
    }

    /// A recording made at 10 AM and read at 12:30 AM: what had happened by 10 AM has happened by now (10 minutes
    /// before it), a reminder that was due when written is due now, and plans stay where they were.
    func testWhatHadHappenedByTheRecordingHasHappenedByNow() async throws {
        let d = "2026-11-06"
        let iso = { (h: Int, m: Int) in ISO.string(self.at(d, h, m)) }
        let written = iso(10, 0)
        func item(_ kind: String, _ fields: String) -> String {
            #"{"id":"\#(kind)1","kind":"\#(kind)","space":"personal","created_at":"\#(written)","updated_at":"\#(written)","deleted_at":null,"fields":\#(fields),"field_ts":{"title":"\#(written)"}}"#
        }
        let changes = [
            item("log", #"{"type":"weight","value":158.4,"at":"\#(iso(7, 30))"}"#),
            item("task", #"{"title":"Call the vet","status":"scheduled","remind_at":"\#(iso(9, 55))"}"#),
            item("task", #"{"title":"Later","status":"scheduled","remind_at":"\#(iso(10, 30))"}"#),
            item("event", #"{"title":"Dentist","start":"\#(iso(8, 0))","end":"\#(iso(9, 0))"}"#),
            item("checklist", #"{"title":"Run","items":[{"text":"Glue","done_at":"\#(iso(9, 0))"}]}"#),
        ].enumerated().map { #"{"seq":\#($0.offset + 1),"entity":\#($0.element)}"# }.joined(separator: ",")
        let rec = SampleTransport.Recording(day: d, entries: [
            "GET sync/changes?since=0": .init(status: 200, body: #"{"changes":[\#(changes)],"seq":5,"more":false}"#),
            "GET planner/today": .init(status: 200, body: #"{"free_slots":[{"start":"\#(iso(9, 0))","end":"\#(iso(15, 0))"}],"checked":{"last_check":"\#(iso(9, 30))"}}"#),
            "GET export/csv/task": .init(status: 200, body: "id,updated_at,title,remind_at,due\r\nt1,\(written),\"Call the vet, today\",\(iso(9, 55)),\r\nt2,\(written),Later,\(iso(10, 30)),2026-11-09\r\n"),
        ])
        // Read a week later at 12:30 AM: the recording's day is that day.
        let later = "2026-11-13"
        let now = at(later, 0, 30)
        let t = SampleTransport(recording: rec, today: now)
        let held = ISO.string(now.addingTimeInterval(-600))
        let moved = { (h: Int, m: Int) in ISO.string(self.at(later, h, m)) }

        let page = try JSONDecoder().decode(ChangesResponse.self, from: try await t.send(method: "GET", path: "sync/changes", query: ["since": "0"], body: nil).data)
        let byKind = Dictionary(grouping: page.changes.map(\.entity), by: \.kind)
        let log = try XCTUnwrap(byKind[.log]?.first)
        XCTAssertEqual(log.str("at"), held, "the 7:30 weigh-in happened before now")
        XCTAssertEqual(log.created_at, held)
        XCTAssertEqual(log.field_ts["title"], held)
        let tasks = try XCTUnwrap(byKind[.task])
        XCTAssertEqual(tasks.first { $0.str("title") == "Call the vet" }?.str("remind_at"), held, "due when written, so due now")
        XCTAssertEqual(tasks.first { $0.str("title") == "Later" }?.str("remind_at"), moved(10, 30), "a reminder still to come stays")
        let event = try XCTUnwrap(byKind[.event]?.first)
        XCTAssertEqual(event.str("start"), moved(8, 0), "a plan stays where it is")
        XCTAssertEqual(byKind[.checklist]?.first?.fields["items"]?.arrayValue?.first?.objectValue?["done_at"]?.stringValue, held)

        let plan = String(decoding: try await t.send(method: "GET", path: "planner/today", query: [:], body: nil).data, as: UTF8.self)
        XCTAssertTrue(plan.contains(#""start":"\#(moved(9, 0))""#), "free time is a plan: \(plan)")
        XCTAssertTrue(plan.contains(#""last_check":"\#(held)""#), plan)

        let csv = String(decoding: try await t.send(method: "GET", path: "export/csv/task", query: [:], body: nil).data, as: UTF8.self)
        XCTAssertEqual(csv, "id,updated_at,title,remind_at,due\r\nt1,\(held),\"Call the vet, today\",\(held),\r\nt2,\(held),Later,\(moved(10, 30)),2026-11-16\r\n")

        // After the recording's time of day nothing moves back.
        let noon = SampleTransport(recording: rec, today: at(later, 12, 0))
        let page2 = try JSONDecoder().decode(ChangesResponse.self, from: try await noon.send(method: "GET", path: "sync/changes", query: ["since": "0"], body: nil).data)
        XCTAssertEqual(page2.changes.first { $0.entity.kind == .log }?.entity.str("at"), moved(7, 30))

        // Just after midnight it stays on today, the day Dashboard shows it on.
        let early = SampleTransport(recording: rec, today: at(later, 0, 3))
        let page3 = try JSONDecoder().decode(ChangesResponse.self, from: try await early.send(method: "GET", path: "sync/changes", query: ["since": "0"], body: nil).data)
        XCTAssertEqual(page3.changes.first { $0.entity.kind == .log }?.entity.str("at"), ISO.string(at(later, 0, 0)))
    }

    /// The bundled recording agrees with itself: Dashboard (worked out by the hub) has every weigh-in, night of sleep and
    /// cup the first sync brings (Health and Memory). It was once recorded with the hub's clock at 2 AM while its items
    /// were made as at 10 AM, and Dashboard left out the morning's weigh-in.
    func testTheBundledDashboardHasEveryLogTheSampleHas() throws {
        let rec = try JSONDecoder().decode(SampleTransport.Recording.self, from: Data(contentsOf: SampleScreens.bundledRecording))
        let page = try JSONDecoder().decode(ChangesResponse.self, from: Data(try XCTUnwrap(rec.entries["GET sync/changes?since=0"]).body.utf8))
        let logs = page.changes.map(\.entity).filter { $0.kind == .log && !$0.isDeleted }
        let board = try JSONDecoder().decode(DashboardBoard.self, from: Data(try XCTUnwrap(rec.entries["GET dashboard/board"]).body.utf8))
        for type in ["weight", "sleep"] {
            let newest = try XCTUnwrap(logs.filter { $0.str("type") == type }.max { $0.str("at") < $1.str("at") })
            let tile = try XCTUnwrap(board.tiles.first { $0.tile.metric == "log:\(type)" }?.series)
            XCTAssertEqual(tile.latest?.at, newest.str("at"), "Dashboard's newest \(type) is the sample's newest")
        }
        let cups = logs.filter { $0.str("type") == "caffeine" }.compactMap { $0.number("value") }.reduce(0, +)
        XCTAssertEqual(board.tiles.first { $0.tile.metric == "log:caffeine" }?.series?.current, cups)
    }

    /// The bundled recording's hub answered on the clock its items were made on, and the recorder refuses one that did
    /// not (a hub seeded as at 10 AM and recorded at 2 AM).
    func testTheRecordingWasMadeOnOneClock() throws {
        let rec = try JSONDecoder().decode(SampleTransport.Recording.self, from: Data(contentsOf: SampleScreens.bundledRecording))
        XCTAssertEqual(SampleRecordingCleaner.madeLater(rec), [])
        var other = rec
        other.entries["GET health"] = .init(status: 200, body: #"{"ok":true,"time":"2026-11-22T06:55:02.627Z"}"#)
        XCTAssertFalse(SampleRecordingCleaner.madeLater(other).isEmpty)
    }

    /// The sample's machines each say what kind of device they are, as a real hub's do (identify.ts; the demo hub's
    /// seedMachines), and the hub's own machine is the journal's "server", not a second machine of that name. The hub's
    /// own check is on it too, not on a machine called hub (the starter check named one until 2026-11-25).
    func testTheBundledMachinesAreIdentified() async throws {
        let rec = try JSONDecoder().decode(SampleTransport.Recording.self, from: Data(contentsOf: SampleScreens.bundledRecording))
        let client = HubClient(transport: SampleTransport(recording: rec, today: Date()))
        let board = try await client.opsBoard()
        let machines = (board.things ?? []).filter { $0.kind == .machine }
        XCTAssertFalse(machines.isEmpty)
        XCTAssertEqual(Tech.machineSections(machines).map(\.title), ["Computers"])
        XCTAssertEqual(Set(machines.map(\.name)).count, machines.count, "no machine shows twice")
        XCTAssertFalse(machines.contains { $0.name == "hub" })
        let own = try XCTUnwrap(machines.first { $0.hub })
        XCTAssertEqual(own.name, "server")
        let check = try XCTUnwrap(board.monitors.first { $0.entity.str("name") == "hub health" })
        XCTAssertEqual(own.monitors, [check.id])
        let synced = try await SampleScreens.World.load(client).entities.first { $0.id == check.id }
        XCTAssertEqual(synced?.str("host"), "server", "the synced check names the same machine")
    }

    /// Sample mode as the app runs it, opened at 12:30 AM and again two days later at 9 AM: Health (the device's copy),
    /// Memory and Dashboard (the recording) show the same weigh-in on the same day, nothing that happened is later than
    /// now, and an edit made to the sample moves on with it.
    @MainActor
    func testHealthMemoryAndDashboardAgreeOnAnyDayTheSampleIsOpened() async throws {
        final class Clock: @unchecked Sendable { var now: Date; init(_ d: Date) { now = d } }
        let before = SampleTransport.shared
        defer { SampleTransport.shared = before }
        let today = ISO.localDay()
        let clock = Clock(at(today, 0, 30))
        SampleTransport.shared = SampleTransport(data: try Data(contentsOf: SampleScreens.bundledRecording), now: { clock.now })
        let engine = SyncEngine(config: SharedConfig(suiteName: "sample-days-\(UUID().uuidString)"), platform: .iphone, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        await engine.startSample()
        defer { engine.stop() }

        func check(_ when: String, file: StaticString = #filePath, line: UInt = #line) async throws {
            let now = clock.now
            let weights = engine.logs.filter { $0.str("type") == "weight" }
            let newest = try XCTUnwrap(weights.max { ($0.date("at") ?? .distantPast) < ($1.date("at") ?? .distantPast) }, file: file, line: line)
            let day = ISO.localDay(try XCTUnwrap(newest.date("at")))
            XCTAssertEqual(day, ISO.localDay(now), "\(when): Health's newest weigh-in is today's", file: file, line: line)
            let board = try await XCTUnwrap(engine.client).dashboardBoard()
            let latest = try XCTUnwrap(board.tiles.first { $0.tile.metric == "log:weight" }?.series?.latest, file: file, line: line)
            XCTAssertEqual(latest.day, day, "\(when): Dashboard shows the same day", file: file, line: line)
            XCTAssertEqual(latest.value, newest.number("value"), file: file, line: line)
            let memory = engine.list(.fact).first { $0.str("key") == "weight:current" }?.str("value") ?? ""
            XCTAssertTrue(memory.contains(day), "\(when): Memory says \(memory)", file: file, line: line)
            for e in engine.entities.values {
                for k in ["at", "done_at", "created_at"] {
                    let t = k == "created_at" ? ISO.date(e.created_at) : e.date(k)
                    if let t { XCTAssertLessThanOrEqual(t, now, "\(when): \(e.kind) \(k) is not later than now", file: file, line: line) }
                }
            }
            let vet = engine.list(.task).first { $0.str("title") == "Call the vet about Pepper's chew" }
            XCTAssertLessThanOrEqual(try XCTUnwrap(vet?.date("remind_at"), file: file, line: line), now, "\(when): the reminder due at the recording is due", file: file, line: line)
        }
        try await check("opened at 12:30 AM")

        // Read again later that night: what was held back stays where it was put, in the copy and in every answer.
        let vetTitle = "Call the vet about Pepper's chew"
        let stored = engine.list(.task).first { $0.str("title") == vetTitle }?.str("remind_at")
        XCTAssertNotNil(stored)
        clock.now = at(today, 2, 0)
        await engine.sync()
        let plan = try await XCTUnwrap(engine.client).plannerToday()
        XCTAssertEqual(plan.reminders_due.first { $0.str("title") == vetTitle }?.str("remind_at"), stored, "the reminder held back has not moved")
        XCTAssertEqual(engine.list(.task).first { $0.str("title") == vetTitle }?.str("remind_at"), stored)

        // An edit: a task done, stamped with the device's own clock as the app stamps it.
        let hdmi = try XCTUnwrap(engine.list(.task).first { $0.str("title") == "Pick up HDMI cable at Micro Center" })
        await engine.markDone(hdmi.id)
        let doneDay = ISO.localDay(try XCTUnwrap(engine.get(hdmi.id)?.date("done_at")))

        clock.now = at(LocalPlanner.dateString(Calendar.current.date(byAdding: .day, value: 2, to: at(today, 12))!), 9, 0)
        await engine.sync()
        try await check("two days later at 9 AM")
        let moved = try XCTUnwrap(engine.get(hdmi.id))
        XCTAssertEqual(moved.str("status"), "done", "the edit is kept")
        XCTAssertEqual(SampleTransport.days(from: doneDay, to: try XCTUnwrap(moved.date("done_at"))), 2, "and moved on with the sample")
    }

    /// A screen the app opens on at launch reads through the client before `start()` has run (Wiki, Sensors, Recall
    /// quiz said there was no hub, or that it was out of reach).
    @MainActor
    func testAScreenOpenedAtLaunchReadsTheSampleAtOnce() async throws {
        let before = SampleTransport.shared
        defer { SampleTransport.shared = before }
        SampleTransport.shared = SampleTransport(data: try Data(contentsOf: SampleScreens.bundledRecording))
        let config = SharedConfig(suiteName: "sample-early-\(UUID().uuidString)")
        config.sampleMode = true
        config.hubURL = SyncEngine.sampleHubURL
        let engine = SyncEngine(config: config, platform: .iphone, store: try SyncStore.inMemory())
        XCTAssertNil(engine.client)
        engine.connectEarly()
        let c = try XCTUnwrap(engine.client, "connected before start()")
        _ = try await c.wikiIndex()
        let other = SyncEngine(config: SharedConfig(suiteName: "sample-early-none-\(UUID().uuidString)"), platform: .iphone, store: try SyncStore.inMemory())
        other.connectEarly()
        XCTAssertNil(other.client, "a device not set up has none")
    }

    func testCalendarRemindersAndContactsWaitForTheHubsWord() {
        let c = SharedConfig(suiteName: "modules-test-\(UUID().uuidString)")
        XCTAssertTrue(c.moduleOn(.appleCalendar), "screens show before the list comes")
        XCTAssertFalse(c.moduleSaidOn(.appleCalendar), "nothing of the person's is copied before the hub says so")
        c.modules = [ModuleInfo(id: "apple_calendar", title: "Apple Calendar", summary: "", group: "On your devices", on: true)]
        XCTAssertTrue(c.moduleSaidOn(.appleCalendar))
        XCTAssertFalse(c.moduleSaidOn(.contacts), "a module the hub did not list is off for copying")
    }
}
