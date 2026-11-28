import XCTest
@testable import EACore

/// Connections that broke after setup (hub `connection-problems.ts`): read from the day's plan, listed in Needs you,
/// said on the Settings rows, Mail and Week, and alerted once. The web app's lib/connectionProblems.ts is the same.
final class ConnectionProblemTests: XCTestCase {
    private let mailbox = ConnectionProblem(id: "account:icloud:jamie@icloud.com", service: "iCloud", title: "iCloud stopped signing in for jamie@icloud.com",
                                            detail: "Replace its app-specific password.", fix: .account, account: "icloud:jamie@icloud.com",
                                            button: "Replace password", affects: ["mail", "calendar"])
    private let steam = ConnectionProblem(id: "steam", service: "Steam", title: "Steam stopped accepting the hub's key", detail: "Replace the Steam key to keep playtime coming in.",
                                          fix: .connections, button: "Replace the Steam key", affects: ["games"])

    func testTheDaysPlanCarriesTheProblemsAndAnOlderHubsPlanReadsAsNone() throws {
        let json = #"{"date":"2026-11-27","now":null,"next":[],"blocks":[],"commitments":[],"reminders_due":[],"watches_due_soon":[],"captures_unprocessed":0,"free_slots":[],"digest":"","connection_problems":[{"id":"account:icloud:jamie@icloud.com","service":"iCloud","title":"iCloud stopped signing in for jamie@icloud.com","detail":"Replace its app-specific password.","fix":"account","account":"icloud:jamie@icloud.com","button":"Replace password","affects":["mail","calendar"],"since":"2026-11-27T09:00:00.000Z"},{"id":"later","title":"Something new","fix":"elsewhere"}]}"#
        let t = try JSONCoding.decode(PlannerToday.self, from: Data(json.utf8))
        XCTAssertEqual(t.connection_problems?.first, ConnectionProblem(id: mailbox.id, service: "iCloud", title: mailbox.title, detail: mailbox.detail, fix: .account,
                                                                       account: mailbox.account, button: "Replace password", affects: ["mail", "calendar"], since: "2026-11-27T09:00:00.000Z"))
        // A newer hub's kind of fix does not stop the plan from being read: it opens Settings, Connections.
        XCTAssertEqual(t.connection_problems?.last?.fix, .connections)
        XCTAssertEqual(t.connection_problems?.last?.button, "Open")
        let older = #"{"date":"2026-11-27","now":null,"next":[],"blocks":[],"commitments":[],"reminders_due":[],"watches_due_soon":[],"captures_unprocessed":0,"free_slots":[],"digest":""}"#
        XCTAssertNil(try JSONCoding.decode(PlannerToday.self, from: Data(older.utf8)).connection_problems)
    }

    func testNeedsYouListsEachAfterInvitationsAndBeforeRenewals() {
        let cal = Calendar(identifier: .gregorian)
        let now = cal.date(from: DateComponents(year: 2026, month: 11, day: 27, hour: 15))!
        let watch = Entity(id: "w1", kind: .watch, fields: ["title": .string("Plex Pass"), "due": .string("2026-11-26")])
        let needs = TodayBoard.needsYou(reminders: [], watches: [watch], meds: [], unsorted: 0, now: now, calendar: cal,
                                        invitations: (1, "Dinner"), connections: [mailbox, steam])
        XCTAssertEqual(needs.map(\.id), ["invitations", "c:account:icloud:jamie@icloud.com", "c:steam", "w:w1"])
        XCTAssertEqual(needs[1].title, "iCloud stopped signing in for jamie@icloud.com")
        XCTAssertEqual(needs[1].detail, "Replace its app-specific password.")
        XCTAssertFalse(needs[1].late)
    }

    func testSettingsRowsMailAndWeekEachSayTheirOwn() {
        XCTAssertEqual(ConnectionProblem.rowWarning([mailbox, steam], fix: .account), "iCloud stopped signing in for jamie@icloud.com")
        XCTAssertEqual(ConnectionProblem.rowWarning([mailbox, steam], fix: .connections), "Steam stopped accepting the hub's key")
        var other = mailbox
        other.id = "account:imap:alex@gmail.com"
        XCTAssertEqual(ConnectionProblem.rowWarning([mailbox, other], fix: .account), "2 accounts need you")
        XCTAssertNil(ConnectionProblem.rowWarning(nil, fix: .account))
        XCTAssertEqual(ConnectionProblem.affecting([mailbox, steam], "calendar").map(\.id), [mailbox.id])
        XCTAssertEqual(ConnectionProblem.mailboxKey(MailMailbox(email: "a@icloud.com", kind: "icloud")), "icloud:a@icloud.com")
        XCTAssertEqual(ConnectionProblem.mailboxKey(MailMailbox(email: "a@gmail.com", kind: "gmail")), "imap:a@gmail.com")
    }

    func testAMailboxSaysWhenItsProviderRefusedThePassword() throws {
        let m = try JSONCoding.decode(MailMailbox.self, from: Data(#"{"email":"a@icloud.com","last_refresh":null,"last_error":null,"more":false,"kind":"icloud","signin_refused":true}"#.utf8))
        XCTAssertEqual(m.signin_refused, true)
        XCTAssertNil(try JSONCoding.decode(MailMailbox.self, from: Data(#"{"email":"a@icloud.com","more":false}"#.utf8)).signin_refused)
    }

    func testTheAlertNamesTheServiceOverWhatBrokeAndOpensToday() {
        let a = AlertNotice(NotifyEvent(kind: "connection", id: "connection:account:icloud:jamie@icloud.com:2026-11-27T09:00:00.000Z",
                                        title: "iCloud stopped signing in for jamie@icloud.com. Replace its app-specific password.", name: "iCloud"))
        XCTAssertEqual(a.title, "iCloud")
        XCTAssertEqual(a.body, "iCloud stopped signing in for jamie@icloud.com. Replace its app-specific password.")
        XCTAssertEqual(a.url, AlertNotice.todayURL)
        XCTAssertEqual(a.thread, "connection")
        XCTAssertEqual(AlertKind(rawValue: "connection"), .connection)
    }
}
