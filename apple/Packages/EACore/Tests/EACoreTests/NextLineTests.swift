import XCTest
@testable import EACore

/// The Next line (TodayBoard.nowLine, lineWords; NextLine.swift): the cases in packages/shared/test/next-line-cases.json,
/// which packages/shared's nextLine.test.ts reads too, so the Apple apps, the web, Windows and Android apps and the hub
/// say the same words. Since 2026-11-25 only a task you started is on it, never the first task in Next.
final class NextLineTests: XCTestCase {
    private struct Cases: Decodable {
        var day: String
        var cases: [Case]
    }
    private struct Case: Decodable {
        struct Task: Decodable { var id: String; var title: String; var status: String; var order: Double; var started: String?; var block: [String]? }
        struct Thing: Decodable { var kind: String; var title: String?; var start: String; var end: String?; var all_day: Bool?; var type: String? }
        var name: String
        var now: String
        var tasks: [Task]
        var things: [Thing]
        var started: String?
        var kind: String
        var label: String
        var text: String
        var today: String
    }

    private let cal = Calendar.current
    /// "15:00": one clock for every case, whatever the machine's own.
    private var clock: TodayBoard.Clock {
        let cal = self.cal
        return { d in
            let c = cal.dateComponents([.hour, .minute], from: d)
            return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
        }
    }

    private func load() throws -> Cases {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { root.deleteLastPathComponent() }   // EACoreTests, Tests, EACore, Packages, apple: the repository
        let data = try Data(contentsOf: root.appendingPathComponent("packages/shared/test/next-line-cases.json"))
        return try JSONDecoder().decode(Cases.self, from: data)
    }

    /// A local time on the cases' day.
    private func at(_ day: String, _ hhmm: String) -> Date {
        let d = day.split(separator: "-").map { Int($0)! }, t = hhmm.split(separator: ":").map { Int($0)! }
        return cal.date(from: DateComponents(year: d[0], month: d[1], day: d[2], hour: t[0], minute: t[1]))!
    }

    private func kind(_ line: TodayBoard.NowLine) -> String {
        switch line {
        case .started: return "started"
        case .during: return "during"
        case .next: return "next"
        case .clear: return "clear"
        }
    }

    func testTheSharedCases() throws {
        let file = try load()
        XCTAssertGreaterThan(file.cases.count, 8)
        for c in file.cases {
            let now = at(file.day, c.now)
            let tasks = c.tasks.map { t -> Entity in
                var fields: [String: JSONValue] = ["title": .string(t.title), "status": .string(t.status), "order": .number(t.order)]
                if let b = t.block { fields["block"] = .object(["start": .string(ISO.string(at(file.day, b[0]))), "end": .string(ISO.string(at(file.day, b[1])))]) }
                return Entity(id: t.id, kind: .task, updated_at: ISO.string(at(file.day, "00:00")), fields: fields,
                              field_ts: t.started.map { ["status": ISO.string(at(file.day, $0))] } ?? [:])
            }
            let spans = c.things.enumerated().map { i, x -> TodayBoard.Span in
                let s = at(file.day, x.start), e = x.end.map { at(file.day, $0) } ?? s
                let rule = x.type.flatMap(PlanRuleType.init(rawValue:))
                let allDay = x.all_day == true || (x.kind == "commitment" && TodayBoard.wholeDay(start: s, end: e))
                return TodayBoard.Span(id: "\(i)", kind: TodayBoard.Span.Kind(rawValue: x.kind)!, title: x.title ?? "", start: s, end: e, allDay: allDay, rule: rule)
            }
            let started = TodayBoard.startedTask(tasks)
            XCTAssertEqual(started?.id, c.started, c.name)
            let line = TodayBoard.nowLine(spans, now: now, started: started.map(TodayBoard.StartedTask.init))
            XCTAssertEqual(kind(line), c.kind, c.name)
            let alone = TodayBoard.lineWords(line, free: TodayBoard.freeLine(spans, now: now, clock: clock), clock: clock)
            XCTAssertEqual(alone.label.rawValue, c.label, c.name)
            XCTAssertEqual(alone.text, c.text, c.name)
            XCTAssertEqual(TodayBoard.lineWords(line, free: nil, clock: clock).text, c.today, c.name)
            XCTAssertNil(alone.text.range(of: "[\u{2013}\u{2014}]", options: .regularExpression), c.name)
        }
    }

    func testAStartedTaskWhoseBlockIsOverOrNotBegunSaysNoTime() {
        let day = "2026-11-25"
        let task = TodayBoard.StartedTask(id: "r", title: "Write the report", blockStart: at(day, "09:00"), blockEnd: at(day, "12:00"))
        XCTAssertEqual(TodayBoard.nowLine([], now: at(day, "13:00"), started: task), .started(title: "Write the report", id: "r", until: nil, left: nil))
        XCTAssertEqual(TodayBoard.nowLine([], now: at(day, "08:00"), started: task), .started(title: "Write the report", id: "r", until: nil, left: nil))
        let w = TodayBoard.lineWords(TodayBoard.nowLine([], now: at(day, "10:00"), started: task), free: nil, clock: clock)
        XCTAssertEqual(w.text, "Doing: Write the report until 12:00, 2 h left")
        XCTAssertEqual(w.detail, "until 12:00, 2 h left")
        XCTAssertTrue(w.isStarted)
    }

    /// The plan the widgets and the Watch keep: the same line at every moment, worked out from the whole day.
    func testThePlanDrawsTheLineAsTheMinutesPass() throws {
        let day = Calendar.current.startOfDay(for: Date())
        func t(_ h: Int, _ m: Int = 0) -> Date { day.addingTimeInterval(Double(h * 3600 + m * 60)) }
        let dentist = Entity(kind: .event, fields: ["title": "Dentist", "start": .string(ISO.string(t(15))), "end": .string(ISO.string(t(16)))])
        let parade = Entity(kind: .event, fields: ["title": "Parade", "start": .string(LocalPlanner.dateString(day)), "end": .string(LocalPlanner.dateString(day.addingTimeInterval(86400))), "all_day": true])
        let gift = Entity(kind: .task, fields: ["title": "Gift idea for Alex", "status": "next", "order": 1])
        let planned = LocalPlanner.day(day, tasks: [gift], rules: [], events: [dentist, parade], reminders: [], watches: [], now: day)
        let plan = NextLinePlan(day: planned, started: TodayBoard.startedTask([gift]))
        XCTAssertNil(plan.started, "a task first in Next is never on the line")
        XCTAssertFalse(plan.spans.contains { $0.allDay }, "an all-day event is never on it, so it is not kept")
        XCTAssertEqual(plan.words(at: t(15, 14), clock: clock).text, "Dentist until 16:00, 46 min left")
        XCTAssertEqual(plan.words(at: t(12, 50), clock: clock).text, "Next: Dentist at 15:00, in 2 h 10 min")
        // The free time as the day began, cut to what is left: 16:00 to 23:00, from now on.
        XCTAssertEqual(plan.words(at: t(19), clock: clock).text, "Free until 23:00, 4 h")
        XCTAssertEqual(plan.words(at: t(21), clock: clock).text, "Nothing else today", "under three hours left is not free time to offer")
        XCTAssertEqual(plan.words(at: t(15, 14).addingTimeInterval(86400), clock: clock).text, "Nothing else today", "a plan from another day has nothing on it")
        XCTAssertNil(plan.then(at: t(15, 14)))

        var doing = plan
        doing.started = TodayBoard.StartedTask(id: "r", title: "Write the report")
        XCTAssertEqual(doing.words(at: t(15, 14), clock: clock).text, "Doing: Write the report")
        XCTAssertEqual(doing.then(at: t(15, 14), clock: clock)?.text, "Dentist until 16:00, 46 min left")
        XCTAssertEqual(NextLinePlan(data: try XCTUnwrap(doing.data)), doing)

        let moments = NextLinePlan.moments(from: t(9, 0).addingTimeInterval(20))
        XCTAssertEqual(moments.count, 61)
        XCTAssertEqual(moments[1], t(9, 1))
        XCTAssertEqual(moments.last, t(10, 0))
    }

    @MainActor
    func testTheEngineOffersOnlyATaskYouStarted() async throws {
        let engine = SyncEngine(config: SharedConfig(suiteName: "next-line-\(UUID().uuidString)"), platform: .iphone, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        await engine.absorb(Entity(id: "gift", kind: .task, fields: ["title": "Gift idea for Alex", "status": "next", "order": 1]))
        await engine.absorb(Entity(id: "milk", kind: .task, fields: ["title": "Buy milk", "status": "next", "order": 2]))
        XCTAssertNil(engine.startedTask)
        XCTAssertEqual(engine.upNext.map(\.id), ["gift", "milk"])
        XCTAssertNil(engine.localToday().now, "the first task in Next is never what you are doing")
        await engine.startTask("milk")
        XCTAssertEqual(engine.startedTask?.id, "milk")
        XCTAssertEqual(engine.localToday().now?.id, "milk")
        XCTAssertEqual(engine.upNext.map(\.id), ["gift"])
        engine.updateSnapshot()
        XCTAssertEqual(engine.config.nowTaskTitle, "Buy milk")
        XCTAssertEqual(engine.config.nextLinePlan?.started?.title, "Buy milk")
        await engine.skip("milk")
        XCTAssertNil(engine.startedTask)
        engine.updateSnapshot()
        XCTAssertNil(engine.config.nowTaskTitle)
        XCTAssertNil(engine.config.nextLinePlan?.started)
    }
}
