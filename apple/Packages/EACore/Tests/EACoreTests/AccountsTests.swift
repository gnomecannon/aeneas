import XCTest
@testable import EACore

/// Settings, Accounts (since 2026-11-24): adding an account switches on the modules its switches need, in one sheet,
/// with no trip to Settings, Modules; each address is one account; the texts are the web's.
final class AccountsTests: XCTestCase {
    private static let calendars = Data(#"{"accounts": [], "active": false}"#.utf8)

    private func body(_ t: FakeTransport, _ i: Int) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: t.calls[i].body ?? Data()) as? NSDictionary)
    }

    func testAddingAnICloudAccountSwitchesItsModulesOnFirstThenLinksItWithEverythingAsked() async throws {
        let t = FakeTransport()
        t.responses = [(200, Data("{}".utf8)), (200, Self.calendars)]
        var switched: [[String: Bool]] = []
        let form = NewAccount(kind: .icloud, email: " Jamie@iCloud.example ", password: "abcd-efgh-ijkl-mnop", want: [.inbox, .receipts, .calendars])
        let key = try await HubClient(transport: t).addAccount(form, isOn: { $0 == .mail }) { switched.append($0) }
        XCTAssertEqual(key, "icloud:jamie@icloud.example")
        XCTAssertEqual(switched, [["mail_inbox": true, "calendars": true]], "only the modules that are off, before anything is linked")
        XCTAssertEqual(t.calls.map { "\($0.method) \($0.path)" }, ["PUT connections/icloud", "PUT calendars/icloud"])
        XCTAssertEqual(try body(t, 0), ["email": "jamie@icloud.example", "password": "abcd-efgh-ijkl-mnop"])
        XCTAssertEqual(try body(t, 1), ["email": "jamie@icloud.example"], "the calendars take the password the mail has")
    }

    func testASwitchLeftOffIsSwitchedOffAfterTheLink() async throws {
        let t = FakeTransport()
        let form = NewAccount(kind: .icloud, email: "jamie@icloud.example", password: "abcd-efgh-ijkl-mnop", want: [.receipts])
        _ = try await HubClient(transport: t).addAccount(form, isOn: { _ in true }) { _ in XCTFail("every module is on") }
        XCTAssertEqual(t.calls.map { "\($0.method) \($0.path)" }, ["PUT connections/icloud", "PUT connections/accounts/icloud:jamie@icloud.example"])
        XCTAssertEqual(try body(t, 1), ["inbox": false])

        // An iCloud account for its calendars alone is linked through calendar sync, which does not read its mail.
        let cal = FakeTransport()
        cal.responses = [(200, Self.calendars)]
        let only = NewAccount(kind: .icloud, email: "jamie@icloud.example", password: "abcd-efgh-ijkl-mnop", want: [.calendars])
        _ = try await HubClient(transport: cal).addAccount(only, isOn: { _ in true }) { _ in }
        XCTAssertEqual(cal.calls.map { "\($0.method) \($0.path)" }, ["PUT calendars/icloud"])
        XCTAssertEqual(try body(cal, 0), ["email": "jamie@icloud.example", "password": "abcd-efgh-ijkl-mnop"])
    }

    func testGoogleAndOtherMailTakeAnAppPasswordAndNeverCalendars() async throws {
        let t = FakeTransport()
        var switched: [[String: Bool]] = []
        let google = NewAccount(kind: .google, email: "jamie@gmail.example", password: "abcd efgh ijkl mnop", want: [.inbox, .calendars])
        XCTAssertEqual(google.wanted, [.inbox], "Calendars is iCloud's only")
        let key = try await HubClient(transport: t).addAccount(google, isOn: { _ in false }) { switched.append($0) }
        XCTAssertEqual(key, "imap:jamie@gmail.example")
        XCTAssertEqual(switched, [["mail_inbox": true]])
        XCTAssertEqual(t.calls.map { "\($0.method) \($0.path)" }, ["PUT connections/imap", "PUT connections/accounts/imap:jamie@gmail.example"])
        XCTAssertEqual(try body(t, 0), ["email": "jamie@gmail.example", "password": "abcd efgh ijkl mnop", "preset": "gmail"])
        XCTAssertEqual(try body(t, 1), ["receipts": false])

        let other = FakeTransport()
        let form = NewAccount(kind: .other, email: "jamie@example.com", password: "secret one", host: "imap.example.com", port: 993, user: "jamie", want: [.inbox, .receipts])
        _ = try await HubClient(transport: other).addAccount(form, isOn: { _ in true }) { _ in }
        XCTAssertEqual(other.calls.map { "\($0.method) \($0.path)" }, ["PUT connections/imap"], "both switches on: nothing to switch off")
        XCTAssertEqual(try body(other, 0), ["email": "jamie@example.com", "password": "secret one", "preset": "imap", "host": "imap.example.com", "port": 993, "user": "jamie"])
    }

    func testAddAccountIsReadyWithAnAddressAPasswordAServerForOtherMailAndOneSwitch() {
        XCTAssertTrue(NewAccount(kind: .icloud, email: "jamie@icloud.example", password: "x").ready)
        XCTAssertFalse(NewAccount(kind: .icloud, email: " ", password: "x").ready)
        XCTAssertFalse(NewAccount(kind: .other, email: "jamie@example.com", password: "x").ready, "another provider needs its server")
        XCTAssertFalse(NewAccount(kind: .google, email: "jamie@gmail.example", password: "x", want: [.calendars]).ready, "nothing it can bring in is on")
    }

    func testANewPasswordKeepsTheAccountsSwitches() async throws {
        let t = FakeTransport()
        t.responses = [(200, Self.calendars), (200, Data("{}".utf8)), (200, Data("{}".utf8)), (200, Data("{}".utf8))]
        let c = HubClient(transport: t)
        try await c.replacePassword(InternetAccount(key: "icloud:jamie@icloud.example", kind: "icloud", email: "jamie@icloud.example", features: .init(inbox: false, receipts: false, calendars: true)), password: "abcd-efgh-ijkl-mnop")
        try await c.replacePassword(InternetAccount(key: "icloud:jamie@icloud.example", kind: "icloud", email: "jamie@icloud.example", features: .init(inbox: true, receipts: false, calendars: true)), password: "abcd-efgh-ijkl-mnop")
        try await c.replacePassword(InternetAccount(key: "imap:jamie@gmail.example", kind: "gmail", email: "jamie@gmail.example", features: .init(inbox: true)), password: "abcd efgh ijkl mnop")
        try await c.replacePassword(InternetAccount(key: "imap:jamie@example.com", kind: "imap", email: "jamie@example.com", features: .init(inbox: true), host: "imap.example.com", port: 993), password: "new one")
        XCTAssertEqual(t.calls.map { "\($0.method) \($0.path)" }, ["PUT calendars/icloud", "PUT connections/icloud", "PUT connections/imap", "PUT connections/imap"],
                       "an account kept for its calendars alone is not linked for its mail")
        XCTAssertEqual(try body(t, 2)["preset"] as? String, "gmail")
        XCTAssertEqual(try body(t, 3)["host"] as? String, "imap.example.com")
    }

    func testARowSaysWhatTheAccountBringsInWhileItsModuleIsOn() {
        let a = InternetAccount(key: "icloud:jamie@icloud.example", kind: "icloud", email: "jamie@icloud.example", features: .init(inbox: true, receipts: true, calendars: true))
        XCTAssertEqual(a.broughtIn { _ in true }, "Mail, Receipts and renewals, Calendars")
        XCTAssertEqual(a.broughtIn { $0 == .calendars }, "Calendars")
        XCTAssertEqual(a.broughtIn { _ in false }, "Nothing switched on")
        XCTAssertFalse(a.shows(.inbox) { _ in false }, "a switch shows on only while its module is on")
        XCTAssertEqual(AccountFeature.modulesToSwitchOn([.inbox, .receipts], isOn: { $0 == .mailInbox }), ["mail": true])
    }

    func testFromThisDeviceSaysWhatComesIn() {
        XCTAssertEqual(AccountTexts.listsSummary(on: 2, total: 4), "2 of 4 lists")
        XCTAssertEqual(AccountTexts.listsSummary(on: 0, total: 0), "No lists yet")
        XCTAssertEqual(AccountTexts.calendarsSummary(personal: "Home", work: 2), "Home, and 2 work calendars")
        XCTAssertEqual(AccountTexts.calendarsSummary(personal: "Home", work: 1), "Home, and 1 work calendar")
        XCTAssertEqual(AccountTexts.calendarsSummary(personal: "Home", work: 0), "Home, no work calendars")
        XCTAssertEqual(AccountTexts.contactsSummary(device: nil, mine: true, here: "this iPhone"), "Mirrored by this iPhone")
        XCTAssertEqual(AccountTexts.contactsSummary(device: "Jamie's Mac", mine: false, here: "this iPhone"), "Mirrored by Jamie's Mac")
        XCTAssertEqual(AccountTexts.contactsSummary(device: nil, mine: false, here: "this iPhone"), "No device mirrors them")
        XCTAssertEqual(AccountTexts.devicesFooter("iPhone"), "What this iPhone's own accounts hold (iCloud, Google, Exchange). One switch each, and it asks for the permission.")
    }

    /// The same words as the web's Settings, Accounts, and none with a dash or an exclamation mark.
    func testTheTextsAreTheWebsAndPlain() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { root.deleteLastPathComponent() }   // the file, EACoreTests, Tests, EACore, Packages, apple
        let web = try String(contentsOf: root.appendingPathComponent("web/src/views/settings/Accounts.tsx"), encoding: .utf8)
        let shared = [AccountTexts.accountsFooter, AccountTexts.addFooter, AccountTexts.inboxNote, AccountTexts.receiptsNote, AccountTexts.calendarsNote,
                      AccountTexts.readOnlyNote, AccountTexts.googleHowTo, AccountTexts.icloudHowTo, InternetAccount.olderGoogleNote]
        for text in shared { XCTAssertTrue(web.contains("\"\(text)\""), text) }
        for kind in ["iCloud", "Google, older sign-in", "Google", "Other mail"] { XCTAssertTrue(web.contains("\"\(kind)\""), kind) }
        let all = shared + [AccountTexts.devicesFooter("Mac"), AccountTexts.takeOverContacts(from: "Jamie's Mac", here: "this iPhone")]
        for text in all { XCTAssertNil(text.range(of: "[\u{2013}\u{2014}!]", options: .regularExpression), text) }
    }
}
