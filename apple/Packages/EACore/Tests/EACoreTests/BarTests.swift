import XCTest
@testable import EACore

/// The bottom bar's rules (Bar.swift), the same cases as packages/shared/test/bar.test.ts so the Apple apps, the web
/// client and the hub agree on what a setting is, what is drawn and what an edit does.
final class BarTests: XCTestCase {
    private let usual = BarSetting.standard
    private func bar(_ count: Int, _ first: [String], _ second: [String] = []) -> BarSetting { BarSetting(count: count, first: first, second: second) }
    private func decode(_ json: String) -> BarSetting? { try? JSONCoding.decode(BarSetting.self, from: json) }

    func testTheDefaultKeepsTheBarAsItWas() {
        XCTAssertEqual(usual, bar(5, ["today", "assistant", "capture", "library", "search"], ["tasks", "week", "notes", "memory", "people"]))
        XCTAssertEqual(usual.layout { _ in true }, BarLayout(count: 5, first: usual.first, second: usual.second))
        for id in usual.first + usual.second { XCTAssertTrue(BarScreen.all.contains(id), id) }
        XCTAssertEqual(Set(BarScreen.all).count, BarScreen.all.count)
        XCTAssertTrue(BarScreen.main.allSatisfy(BarScreen.all.contains))
    }

    func testAValueThatBreaksARuleIsNotASetting() throws {
        XCTAssertEqual(decode(#"{"count":4,"first":["today","library"],"second":[],"extra":1}"#), bar(4, ["today", "library"]))
        // An id this build does not know is kept.
        XCTAssertEqual(decode(#"{"count":3,"first":["today","someNewScreen","library"],"second":["x-1"]}"#), bar(3, ["today", "someNewScreen", "library"], ["x-1"]))
        // Library may be left out: the apps draw it.
        XCTAssertEqual(decode(#"{"count":5,"first":[],"second":[]}"#), bar(5, []))
        for bad in [
            "null", #""bar""#, "[]", "{}",
            #"{"count":2,"first":[],"second":[]}"#,
            #"{"count":6,"first":[],"second":[]}"#,
            #"{"count":"5","first":[],"second":[]}"#,
            #"{"count":5,"first":"today","second":[]}"#,
            #"{"count":5,"first":["today"]}"#,
            #"{"count":5,"first":["today","today"],"second":[]}"#,
            #"{"count":5,"first":["today"],"second":["today"]}"#,
            #"{"count":5,"first":["a","b","c","d","e","f"],"second":[]}"#,
            #"{"count":5,"first":[],"second":["a","b","c","d","e","f"]}"#,
            #"{"count":3,"first":["a","b","c","d"],"second":[]}"#,
            #"{"count":4,"first":["library"],"second":["a","b","c","d","e"]}"#,
            #"{"count":4.5,"first":[],"second":[]}"#,
            #"{"count":5,"first":[""],"second":[]}"#,
            #"{"count":5,"first":["two words"],"second":[]}"#,
            #"{"count":5,"first":["1st"],"second":[]}"#,
            #"{"count":5,"first":[7],"second":[]}"#,
            #"{"count":5,"first":["\#(String(repeating: "x", count: 41))"],"second":[]}"#,
        ] {
            XCTAssertNil(decode(bad), bad)
        }
        XCTAssertTrue(BarScreen.isId(String(repeating: "x", count: 40)))
        XCTAssertFalse(BarScreen.isId("café"))
    }

    func testTheFeelSettingReadsItAndFallsBackToTheDefault() throws {
        let with = try JSONCoding.decode(FeelSettings.self, from: #"{"bar":{"count":3,"first":["today","library","mail"],"second":["tasks"]}}"#)
        XCTAssertEqual(with.bar, bar(3, ["today", "library", "mail"], ["tasks"]))
        XCTAssertEqual(with.shownBar, with.bar)
        // A hub from before the bottom bar, and one whose bar breaks a rule: none, and the default is drawn. The rest
        // of the setting is read all the same.
        let older = try JSONCoding.decode(FeelSettings.self, from: #"{"key":"D"}"#)
        XCTAssertNil(older.bar)
        XCTAssertEqual(older.shownBar, .standard)
        let broken = try JSONCoding.decode(FeelSettings.self, from: #"{"key":"D","bar":{"count":9,"first":["today","today"],"second":"x"}}"#)
        XCTAssertNil(broken.bar)
        XCTAssertEqual(broken.key, "D")
        // What the app keeps for the next launch has the bar in it, and a setting with none writes none.
        XCTAssertEqual(try JSONCoding.typed(FeelSettings.self, from: try JSONCoding.value(with)).bar, with.bar)
        XCTAssertNil(try JSONCoding.value(older).objectValue?["bar"])
        // The editor's change is the JSON the hub takes.
        XCTAssertEqual(try JSONCoding.string(bar(4, ["today", "library"], ["tasks"])), #"{"count":4,"first":["today","library"],"second":["tasks"]}"#)
    }

    func testALowerCountCutsEachRowAndLibraryKeepsAPlaceInItsOwnRow() {
        // Library was fourth: it takes the third place, and Capture and Search leave the bar.
        let three = usual.withCount(3)
        XCTAssertEqual(three, bar(3, ["today", "assistant", "library"], ["tasks", "week", "notes"]))
        XCTAssertEqual(usual.withCount(4), bar(4, ["today", "assistant", "capture", "library"], ["tasks", "week", "notes", "memory"]))
        // Library in the second row stays in the second row.
        let low = bar(5, ["today", "assistant", "capture", "search", "tasks"], ["week", "notes", "memory", "people", "library"])
        XCTAssertEqual(low.withCount(3), bar(3, ["today", "assistant", "capture"], ["week", "notes", "library"]))
        // A higher count cuts nothing: the new places are free.
        XCTAssertEqual(three.withCount(5), bar(5, ["today", "assistant", "library"], ["tasks", "week", "notes"]))
        XCTAssertEqual(usual.withCount(7), usual, "a count that is not 3, 4 or 5 changes nothing")
        for n in BarSetting.counts {
            for b in [usual, low, bar(5, ["a", "b", "c", "d", "e"])] {
                let out = b.withCount(n)
                XCTAssertTrue(out.isValid, "\(out)")
                XCTAssertEqual((out.first + out.second).filter { $0 == "library" }.count, 1)
            }
        }
    }

    func testGoingBackToALargerCountInTheEditorBringsBackWhatTheSmallerOneCut() {
        let three = usual.countChange(3, before: nil)
        XCTAssertEqual(three.first, ["today", "assistant", "library"])
        XCTAssertEqual(three.countChange(4, before: usual), usual.withCount(4))
        XCTAssertEqual(three.countChange(5, before: usual), usual)
        // Without it (the page opened again), the new places are free.
        XCTAssertEqual(three.countChange(5, before: nil).first, ["today", "assistant", "library"])
    }

    func testLibraryIsAlwaysReachable() {
        let all: (String) -> Bool = { _ in true }
        // In neither row: the last place of the first row, a free one when there is one.
        XCTAssertEqual(bar(5, ["today", "capture"], ["tasks"]).layout(has: all), BarLayout(count: 5, first: ["today", "capture", "library"], second: ["tasks"]))
        XCTAssertEqual(bar(3, ["today", "capture", "search"]).layout(has: all).first, ["today", "capture", "library"])
        XCTAssertEqual(bar(5, []).layout(has: all).first, ["library"])
        XCTAssertEqual(bar(3, ["today", "capture", "search"], ["x"]).withLibrary, bar(3, ["today", "capture", "library"], ["x"]))
        // In the second row is enough: the first row is left alone.
        let low = bar(3, ["today", "capture", "search"], ["library"])
        XCTAssertEqual(low.withLibrary, low)
        XCTAssertEqual(low.layout(has: all), BarLayout(count: 3, first: low.first, second: low.second))
        // Whatever the modules say, Library is drawn.
        XCTAssertEqual(usual.layout { _ in false }, BarLayout(count: 5, first: ["library"], second: []))
        // Every arrangement draws it once.
        for count in BarSetting.counts {
            for first in [[], ["a"], ["a", "b", "c"], ["a", "b", "library"], Array(["a", "b", "c", "d", "e"].prefix(count))] {
                for second in [[], ["x", "y", "library"].filter({ !first.contains($0) })] {
                    for has in [all, { $0 != "a" && $0 != "x" }] {
                        let b = bar(count, first, second)
                        XCTAssertTrue(b.isValid)
                        let drawn = b.layout(has: has)
                        XCTAssertEqual(drawn.tabs.filter { $0 == "library" }.count, 1, "\(b)")
                        XCTAssertTrue(drawn.first.count >= 1 && drawn.first.count <= count && drawn.second.count <= count)
                    }
                }
            }
        }
    }

    func testAScreenThatIsOffOrUnknownIsSkippedWhenDrawnAndStaysInTheSetting() {
        let b = bar(5, ["today", "music", "capture", "library", "layouts"], ["tasks", "futureScreen", "mail"])
        let off: Set<String> = ["music", "layouts", "futureScreen", "mail"]
        let drawn = b.layout { !off.contains($0) }
        XCTAssertEqual(drawn, BarLayout(count: 5, first: ["today", "capture", "library"], second: ["tasks"]))
        XCTAssertEqual(drawn.tabs, ["today", "capture", "library", "tasks"])
        XCTAssertEqual(b.first, ["today", "music", "capture", "library", "layouts"], "the setting is as it was")
        // Its place waits for it: back on, it is drawn where it was.
        XCTAssertEqual(b.layout { _ in true }.first, b.first)
        // A second row with nothing to draw is an empty second row: no grabber.
        XCTAssertEqual(bar(5, ["today", "library"], ["music", "mail"]).layout { !off.contains($0) }.second, [])
        // A skipped screen frees its place for Library.
        XCTAssertEqual(bar(3, ["today", "music", "search"]).layout { !off.contains($0) }.first, ["today", "search", "library"])
        // Nothing of the first row to draw: the second row is drawn in its place.
        XCTAssertEqual(bar(4, ["music", "mail"], ["library", "tasks"]).layout { !off.contains($0) }, BarLayout(count: 4, first: ["library", "tasks"], second: []))
    }

    func testChoosingAScreenForAPlaceSwapsMovesOrReplaces() {
        // One that already has a place swaps with what was there, across rows too.
        XCTAssertEqual(usual.picking("tasks", for: BarPlace(.first, 0)),
                       bar(5, ["tasks", "assistant", "capture", "library", "search"], ["today", "week", "notes", "memory", "people"]))
        XCTAssertEqual(usual.picking("search", for: BarPlace(.first, 1)).first, ["today", "search", "capture", "library", "assistant"])
        // One with no place takes it, and what was there leaves the bar.
        let mail = usual.picking("mail", for: BarPlace(.second, 2))
        XCTAssertEqual(mail.second, ["tasks", "week", "mail", "memory", "people"])
        XCTAssertNil(mail.position(of: "notes"))
        // The screen already there: nothing changes.
        XCTAssertEqual(usual.picking("today", for: BarPlace(.first, 0)), usual)
        // A free place is the next one of its row, whichever free place was chosen.
        let short = bar(5, ["today", "library"], ["tasks"])
        XCTAssertEqual(short.picking("mail", for: BarPlace(.first, 4)).first, ["today", "library", "mail"])
        XCTAssertEqual(short.picking("today", for: BarPlace(.second, 1)), bar(5, ["library"], ["tasks", "today"]), "a screen with a place moves into a free one")
        XCTAssertEqual(short.picking("today", for: BarPlace(.first, 2)).first, ["library", "today"], "also within its own row")
        XCTAssertNil(short.screen(at: BarPlace(.second, 1)))
        // An id is never in two places, and what the editor makes is a setting the hub takes.
        for id in ["tasks", "mail", "library", "today"] {
            for row in BarRow.allCases {
                for i in 0..<5 {
                    for start in [usual, short, usual.withCount(3)] {
                        let out = start.picking(id, for: BarPlace(row, i))
                        XCTAssertTrue(out.isValid, "\(id) \(row) \(i)")
                        XCTAssertEqual((out.first + out.second).filter { $0 == "library" }.count, 1)
                        XCTAssertFalse(out.first.isEmpty)
                    }
                }
            }
        }
        // A place past the count, or an id that is not one, changes nothing.
        XCTAssertFalse(usual.withCount(3).canPick("mail", for: BarPlace(.first, 3)))
        XCTAssertEqual(usual.withCount(3).picking("mail", for: BarPlace(.first, 3)), usual.withCount(3))
        XCTAssertEqual(usual.picking("not an id", for: BarPlace(.first, 0)), usual)
    }

    func testLibraryCannotBeRemovedFromBothRows() {
        // Its place takes only a swap with a screen that has a place: one with no place would push it out.
        XCTAssertFalse(usual.canPick("mail", for: BarPlace(.first, 3)))
        XCTAssertEqual(usual.picking("mail", for: BarPlace(.first, 3)), usual)
        XCTAssertTrue(usual.canPick("tasks", for: BarPlace(.first, 3)))
        let low = usual.picking("tasks", for: BarPlace(.first, 3))
        XCTAssertEqual(low.second, ["library", "week", "notes", "memory", "people"], "it may live in the second row")
        // It is not emptied out of the second row.
        XCTAssertFalse(low.canEmpty(BarPlace(.second, 0)))
        XCTAssertEqual(low.emptying(0), low)
        // A setting that left it out is edited as it is drawn: Library in the last place of the first row.
        let none = bar(3, ["today", "capture", "search"])
        XCTAssertEqual(none.screen(at: BarPlace(.first, 2)), "library")
        XCTAssertEqual(none.picking("mail", for: BarPlace(.second, 0)), bar(3, ["today", "capture", "library"], ["mail"]))
    }

    func testTheFirstRowKeepsAScreen() {
        let one = bar(3, ["today"], ["library"])
        XCTAssertFalse(one.canPick("today", for: BarPlace(.second, 1)))
        XCTAssertEqual(one.picking("today", for: BarPlace(.second, 1)), one)
        // Swapping is fine: the row still holds one.
        XCTAssertEqual(one.picking("today", for: BarPlace(.second, 0)), bar(3, ["library"], ["today"]))
    }

    func testASecondRowPlaceCanBeEmptiedAFirstRowPlaceCannot() {
        XCTAssertFalse(usual.canEmpty(BarPlace(.first, 0)))
        XCTAssertTrue(usual.canEmpty(BarPlace(.second, 1)))
        XCTAssertEqual(usual.emptying(1).second, ["tasks", "notes", "memory", "people"])
        XCTAssertFalse(usual.emptying(1).canEmpty(BarPlace(.second, 4)), "a free place has nothing to empty")
        var b = usual
        for _ in 0..<5 { b = b.emptying(0) }
        XCTAssertEqual(b, bar(5, usual.first, []))
        XCTAssertNil(b.screen(at: BarPlace(.second, 0)))
        XCTAssertEqual(b.layout { _ in true }.second, [], "an empty second row: nothing to reveal")
    }

    func testAScreenOpensOnItsOwnTabElseItsHomesElseLibrarys() {
        let drawn = usual.layout { _ in true }
        XCTAssertEqual(drawn.tab(for: "today"), "today")
        XCTAssertEqual(drawn.tab(for: "week", home: "today"), "week", "a screen with a place is its own tab, in the second row too")
        XCTAssertEqual(drawn.tab(for: "mail"), "library")
        XCTAssertEqual(drawn.tab(for: "settings"), "library")
        // Week with no place of its own opens over Today.
        let noWeek = bar(5, usual.first, ["tasks", "notes", "memory", "people"]).layout { _ in true }
        XCTAssertEqual(noWeek.tab(for: "week", home: "today"), "today")
        // Today left out of the bar too: Week, and Today itself, open in Library like every other screen.
        let bare = bar(3, ["assistant", "capture", "library"]).layout { _ in true }
        XCTAssertEqual(bare.tab(for: "week", home: "today"), "library")
        XCTAssertEqual(bare.tab(for: "today"), "library")
        XCTAssertEqual(bare.tab(for: "memory", home: "assistant"), "assistant")
    }

    func testFiveSlotsKeepTheScreensUsedMostRecently() {
        let tabs = usual.first + usual.second
        var s = BarSlots()
        XCTAssertEqual(s.ids, [nil, nil, nil, nil, nil])
        for id in usual.first { s = s.showing(id, among: tabs) }
        XCTAssertEqual(s.ids, ["today", "assistant", "capture", "library", "search"])
        // Asking again, while drawing and when keeping the answer, gives the same slots.
        XCTAssertEqual(s.showing("capture", among: tabs).ids, s.ids)
        XCTAssertEqual(s.showing("tasks", among: tabs).ids, s.showing("tasks", among: tabs).showing("tasks", among: tabs).ids)
        // A sixth screen takes the slot of the one shown longest ago (Today), never the one just left.
        s = s.showing("tasks", among: tabs)
        XCTAssertEqual(s.ids, ["tasks", "assistant", "capture", "library", "search"])
        XCTAssertEqual(s.index(of: "tasks"), 0)
        s = s.showing("assistant", among: tabs).showing("week", among: tabs)
        XCTAssertEqual(s.ids, ["tasks", "assistant", "week", "library", "search"], "Capture was the one used longest ago by then")
        // A screen that left the bar frees its slot, and the next new screen takes that one.
        let fewer = tabs.filter { $0 != "search" }
        s = s.showing("today", among: fewer)
        XCTAssertEqual(s.ids, ["tasks", "assistant", "week", "library", "today"])
        // The screen being shown keeps its slot even when the bar no longer lists it (it is on its way out).
        XCTAssertEqual(s.showing("today", among: ["library"]).ids, [nil, nil, nil, "library", "today"])
    }

    func testIconsAndNamesGrowAsTheCountFalls() {
        let five = BarSize.of(count: 5), four = BarSize.of(count: 4), three = BarSize.of(count: 3)
        for (small, large) in [(five, four), (four, three)] {
            XCTAssertLessThan(small.icon, large.icon)
            XCTAssertLessThan(small.label, large.label)
            XCTAssertLessThan(small.gap, large.gap)
            XCTAssertLessThan(small.pad, large.pad)
            XCTAssertLessThan(small.rowHeight, large.rowHeight)
        }
        XCTAssertEqual(five.rowHeight, 49, "five across is the system's tab bar row (62 points with the capsule around it)")
        XCTAssertGreaterThanOrEqual(five.rowHeight, 44, "a finger's width at least")
    }

    func testTheWordsOfTheEditor() {
        XCTAssertEqual(BarText.summary(usual), "5 across, 5 in the second row")
        XCTAssertEqual(BarText.summary(usual.withCount(3)), "3 across, 3 in the second row")
        XCTAssertEqual(BarText.summary(bar(4, ["today", "library"])), "4 across, no second row")
        XCTAssertEqual(BarText.place(BarPlace(.second, 1)), "Second row, place 2")
        for text in [BarText.intro, BarText.whereShown, BarText.across, BarText.acrossNote, BarText.tap, BarText.secondNote, BarText.swap, BarText.library,
                     BarText.empty, BarText.resetAsk, BarText.more] {
            XCTAssertFalse(text.contains("\u{2014}") || text.contains("\u{2013}") || text.contains("!"), text)
        }
    }

    func testTheContractListsTheSameScreenIds() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { root.deleteLastPathComponent() }   // EACoreTests, Tests, EACore, Packages, apple: the repository
        let contract = try String(contentsOf: root.appendingPathComponent("packages/shared/CONTRACT.md"), encoding: .utf8)
        let start = try XCTUnwrap(contract.range(of: "Screen ids: "), "CONTRACT.md names the screen ids after 'Screen ids:'")
        let rest = contract[start.upperBound...]
        let list = rest[..<(rest.firstIndex(of: ".") ?? rest.endIndex)]
        // Between backticks: every second piece, counting the (empty) one before the first backtick.
        let ids = list.split(separator: "`", omittingEmptySubsequences: false).enumerated().filter { $0.offset % 2 == 1 }.map { String($0.element) }
        XCTAssertEqual(ids, BarScreen.all)
    }
}
