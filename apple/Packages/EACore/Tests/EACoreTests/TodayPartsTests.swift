import XCTest
@testable import EACore

/// Today's setting (TodayParts.swift), the same cases as packages/shared/test/today.test.ts so the Apple apps, the web
/// client and the hub agree on what a setting is, what is drawn and what an edit does.
final class TodayPartsTests: XCTestCase {
    private let usual = ["now", "tech", "needs", "schedule", "todo", "sofar", "coming"]
    private func setting(_ order: [String], _ hidden: [String] = []) -> TodaySetting { TodaySetting(order: order, hidden: hidden) }
    private func decode(_ json: String) -> TodaySetting? { try? JSONCoding.decode(TodaySetting.self, from: json) }

    func testTheDefaultIsTodayAsItWas() {
        XCTAssertEqual(TodayPart.allCases.map(\.rawValue), usual)
        XCTAssertEqual(TodaySetting.standard, setting(usual))
        XCTAssertEqual(TodaySetting.standard.parts.map(\.rawValue), usual)
        XCTAssertEqual(TodaySetting.standard.shown.map(\.rawValue), usual)
        XCTAssertEqual(TodaySetting.standard.cards.map(\.rawValue), Array(usual.dropFirst()))
        XCTAssertEqual(TodayPart.cards.map(\.rawValue), Array(usual.dropFirst()))
        XCTAssertTrue(TodaySetting.standard.showsTop)
        XCTAssertTrue(TodaySetting.standard.isStandard)
    }

    func testAValueThatBreaksARuleIsNotASetting() {
        XCTAssertEqual(decode(#"{"order":["coming","now","todo"],"hidden":["sofar"],"extra":1}"#), setting(["coming", "now", "todo"], ["sofar"]))
        XCTAssertEqual(decode(#"{"order":[],"hidden":[]}"#), setting([]))
        // An id this build does not know is kept.
        XCTAssertEqual(decode(#"{"order":["weather","now"],"hidden":["weather-2"]}"#), setting(["weather", "now"], ["weather-2"]))
        let forty = (0..<TodaySetting.maxIds).map { "\"p\($0)\"" }.joined(separator: ",")
        XCTAssertNotNil(decode(#"{"order":[\#(forty)],"hidden":[\#(forty)]}"#))
        for bad in [
            "null", #""today""#, "[]", "{}",
            #"{"order":["now"]}"#,
            #"{"hidden":[]}"#,
            #"{"order":"now","hidden":[]}"#,
            #"{"order":["now"],"hidden":"tech"}"#,
            #"{"order":["now","now"],"hidden":[]}"#,
            #"{"order":[],"hidden":["tech","tech"]}"#,
            #"{"order":[""],"hidden":[]}"#,
            #"{"order":["two words"],"hidden":[]}"#,
            #"{"order":["1st"],"hidden":[]}"#,
            #"{"order":[7],"hidden":[]}"#,
            #"{"order":["\#(String(repeating: "x", count: 41))"],"hidden":[]}"#,
            #"{"order":[\#(forty),"one-more"],"hidden":[]}"#,
            #"{"order":[],"hidden":[\#(forty),"one-more"]}"#,
        ] {
            XCTAssertNil(decode(bad), bad)
        }
    }

    func testTheFeelSettingReadsItAndFallsBackToTheDefault() throws {
        let with = try JSONCoding.decode(FeelSettings.self, from: #"{"today":{"order":["now","coming","todo"],"hidden":["sofar"]}}"#)
        XCTAssertEqual(with.today, setting(["now", "coming", "todo"], ["sofar"]))
        XCTAssertEqual(with.shownToday, with.today)
        // A hub from before Today's setting, and one whose setting breaks a rule: none, and the default is drawn. The
        // rest of the setting is read all the same.
        let older = try JSONCoding.decode(FeelSettings.self, from: #"{"key":"D"}"#)
        XCTAssertNil(older.today)
        XCTAssertEqual(older.shownToday, .standard)
        let broken = try JSONCoding.decode(FeelSettings.self, from: #"{"key":"D","today":{"order":["now","now"],"hidden":[]}}"#)
        XCTAssertNil(broken.today)
        XCTAssertEqual(broken.key, "D")
        // Sent back as it came.
        let round = try JSONCoding.decode(FeelSettings.self, from: JSONCoding.data(with))
        XCTAssertEqual(round.today, with.today)
    }

    func testTheOrderSkipsUnknownIdsAndPutsMissingPartsInTheirDefaultPlaces() {
        let all = ["now", "coming", "todo", "schedule", "needs", "tech", "sofar"]
        XCTAssertEqual(setting(all).parts.map(\.rawValue), all)
        XCTAssertEqual(setting(["weather", "now", "coming", "x-1", "todo", "schedule", "needs", "tech", "sofar"]).parts.map(\.rawValue), all)
        XCTAssertEqual(setting(["coming", "schedule"]).parts.map(\.rawValue), ["now", "tech", "needs", "coming", "schedule", "todo", "sofar"])
        XCTAssertEqual(setting(["sofar", "needs"]).parts.map(\.rawValue), ["now", "tech", "sofar", "coming", "needs", "schedule", "todo"])
        // Named alone, a part has no other part to follow: every other part takes its default place around it.
        XCTAssertEqual(setting(["coming"]).parts.map(\.rawValue), usual)
        XCTAssertEqual(setting([]).parts.map(\.rawValue), usual)
        XCTAssertEqual(setting(["weather"]).parts.map(\.rawValue), usual)
        // The line at the top is drawn above the cards wherever the order puts it.
        XCTAssertEqual(setting(["coming", "now", "needs"]).cards, setting(["now", "coming", "needs"]).cards)
    }

    func testHiddenPartsAreNotDrawnAndTheRestKeepTheirOrder() {
        let s = setting(["now", "coming", "todo", "schedule", "needs", "tech", "sofar"], ["sofar", "needs", "weather"])
        XCTAssertEqual(s.shown.map(\.rawValue), ["now", "coming", "todo", "schedule", "tech"])
        XCTAssertEqual(s.cards.map(\.rawValue), ["coming", "todo", "schedule", "tech"])
        XCTAssertEqual(s.cardOrder.map(\.rawValue), ["coming", "todo", "schedule", "needs", "tech", "sofar"], "the editor lists the hidden ones too")
        XCTAssertTrue(s.showsTop)
        let top = setting([], ["now"])
        XCTAssertFalse(top.showsTop)
        XCTAssertEqual(top.cards.map(\.rawValue), Array(usual.dropFirst()))
        XCTAssertEqual(setting([], usual).shown, [])
        XCTAssertEqual(setting([], Array(usual.dropFirst())).cards, [])
        XCTAssertFalse(s.isStandard)
        XCTAssertFalse(top.isStandard)
        XCTAssertTrue(setting([], ["weather"]).isStandard, "hiding a part this build does not know changes nothing here")
        XCTAssertFalse(setting(["coming", "tech"]).isStandard)
        XCTAssertTrue(setting(["needs", "now"]).isStandard, "the line at the top has no place among the cards")
    }

    func testTheEditorMovesShowsAndHidesAndKeepsIdsItDoesNotKnow() {
        var s = TodaySetting.standard
        s = s.moving(.coming, to: 0)
        XCTAssertEqual(s.order, ["now", "coming", "tech", "needs", "schedule", "todo", "sofar"])
        s = s.moving(.tech, to: 99)
        XCTAssertEqual(s.cardOrder, [.coming, .needs, .schedule, .todo, .sofar, .tech])
        s = s.moving(.needs, to: -3)
        XCTAssertEqual(s.cardOrder, [.needs, .coming, .schedule, .todo, .sofar, .tech])
        s = s.moving(.schedule, to: 1)
        XCTAssertEqual(s.cardOrder, [.needs, .schedule, .coming, .todo, .sofar, .tech])
        // As a list's onMove moves rows: the row at 0 dropped before the row at 3, and the last row dropped at the top.
        XCTAssertEqual(s.moving(fromOffsets: IndexSet(integer: 0), toOffset: 3).cardOrder, [.schedule, .coming, .needs, .todo, .sofar, .tech])
        XCTAssertEqual(s.moving(fromOffsets: IndexSet(integer: 5), toOffset: 0).cardOrder, [.tech, .needs, .schedule, .coming, .todo, .sofar])
        XCTAssertEqual(s.moving(fromOffsets: IndexSet(integer: 2), toOffset: 6).cardOrder, [.needs, .schedule, .todo, .sofar, .tech, .coming])
        s = s.showing(.sofar, false)
        s = s.showing(.now, false)
        XCTAssertEqual(s.hidden, ["sofar", "now"])
        XCTAssertEqual(s.showing(.sofar, false).hidden, ["now", "sofar"], "hidden once")
        s = s.showing(.sofar, true)
        XCTAssertEqual(s.hidden, ["now"])
        XCTAssertTrue(s.isValid, "every edit is a setting the hub takes")
        // A part a newer app added stays after the part it followed (and moves with it), and stays hidden.
        let newer = setting(["now", "weather", "tech", "needs", "schedule", "todo", "sofar", "coming", "x-1"], ["weather"])
        let moved = newer.moving(.coming, to: 0)
        XCTAssertEqual(moved.order, ["now", "weather", "coming", "x-1", "tech", "needs", "schedule", "todo", "sofar"])
        XCTAssertEqual(moved.hidden, ["weather"])
        XCTAssertEqual(setting(["first-one"]).withOrder([.todo]).order, ["first-one", "now", "tech", "needs", "schedule", "todo", "sofar", "coming"])
        // However many it holds, an edit stays within the limit.
        let crowded = setting((0..<TodaySetting.maxIds).map { "p\($0)" })
        XCTAssertTrue(crowded.moving(.coming, to: 0).isValid)
        XCTAssertTrue(crowded.withOrder(TodayPart.cards.reversed()).isValid)
    }

    func testTheSummaryInTheme() {
        XCTAssertEqual(TodayText.summary(.standard), "Usual order, all shown")
        XCTAssertEqual(TodayText.summary(setting(["coming", "tech"], ["sofar", "needs", "weather"])), "Your order, 2 hidden")
        XCTAssertEqual(TodayText.summary(setting([], ["now"])), "Usual order, 1 hidden")
        for p in TodayPart.allCases {
            XCTAssertFalse(TodayText.name(p).isEmpty)
            XCTAssertTrue(TodayText.holds(p).hasSuffix("."))
        }
    }

    func testTheContractListsTheSameParts() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { root.deleteLastPathComponent() }   // EACoreTests, Tests, EACore, Packages, apple: the repository
        let contract = try String(contentsOf: root.appendingPathComponent("packages/shared/CONTRACT.md"), encoding: .utf8)
        let start = try XCTUnwrap(contract.range(of: "Today parts: "), "CONTRACT.md names the parts after 'Today parts:'")
        let rest = contract[start.upperBound...]
        let list = rest[..<(rest.firstIndex(of: ".") ?? rest.endIndex)]
        // Between backticks: every second piece, counting the (empty) one before the first backtick.
        let ids = list.split(separator: "`", omittingEmptySubsequences: false).enumerated().filter { $0.offset % 2 == 1 }.map { String($0.element) }
        XCTAssertEqual(ids, usual)
    }
}
