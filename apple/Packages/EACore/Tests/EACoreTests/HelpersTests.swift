import XCTest
@testable import EACore

final class HelpersTests: XCTestCase {
    /// GET /helpers as hub/src/routes/helpers.ts answers it.
    let body = #"""
    {"helpers":[{"id":"h1","name":"Robin","state":"active","offered_at":"2026-11-19T19:46:00.000Z","accepted_at":"2026-11-19T19:46:30.000Z"},
                {"id":"h2","name":"Sam","state":"offered","offered_at":"2026-11-19T20:00:00.000Z"}],
     "log":[{"id":"l1","at":"2026-11-19T19:47:00.000Z","helper":"Robin","kind":"check","device":"PC","text":"Looked at why your computer is slow","detail":"Get-Process","outcome":"done"},
            {"id":"l2","at":"2026-11-19T19:46:30.000Z","helper":"Robin","kind":"accepted","device":null,"text":"You let Robin help you.","detail":null,"outcome":null}],
     "passwords":[{"title":"My computer","username":"mom"}],
     "computers":[{"device_id":"d1","name":"PC","os":"windows","on":true,"at":"2026-11-19T19:45:00.000Z","listening":true}],
     "scan":{"at":"2026-11-19T19:48:00.000Z","by":"Mom's iPhone","network":"192.168.1.0/24","devices":[{"name":"HP printer","ip":"192.168.1.40","open":[80,9100],"kind":"printer"}]},
     "this_device":{"device_id":"d2","agent":null}}
    """#

    func testTheHubsAnswerReads() throws {
        let v = try JSONCoding.decode(HelpersView.self, from: Data(body.utf8))
        XCTAssertEqual(v.offered?.name, "Sam")
        XCTAssertEqual(v.active.map(\.name), ["Robin"])
        XCTAssertEqual(v.summary, "Robin helps you")
        XCTAssertEqual(v.log.first?.detail, "Get-Process")
        XCTAssertNil(v.log.last?.device)
        XCTAssertEqual(v.passwords.first?.username, "mom")
        XCTAssertEqual(v.scan?.devices.first?.open, [80, 9100])
        XCTAssertEqual(v.computers.first?.listening, true)
        // Nobody active yet: the offer is the summary.
        var o = v
        o.helpers = [v.helpers[1]]
        XCTAssertEqual(o.summary, "Sam offered to help")
        o.helpers = []
        XCTAssertNil(o.summary)
        // A job for the Mac.
        let jobs = try JSONCoding.decode(AgentJobs.self, from: Data(#"{"jobs":[{"id":"j1","device_id":"d2","command":"uptime","os":"macos","timeout_s":60,"created_at":"2026-11-19T19:47:00.000Z"}],"helping":true}"#.utf8))
        XCTAssertEqual(jobs.jobs.first?.timeout_s, 60)
        XCTAssertEqual(jobs.helping, true)
        XCTAssertNil(jobs.jobs.first?.ssh)
        // A job for another device in the home: its password never shows when the job is printed.
        let other = try JSONCoding.decode(AgentJob.self, from: Data(#"{"id":"j2","device_id":"d2","command":"uptime","os":"linux","timeout_s":60,"created_at":"2026-11-19T19:47:00.000Z","ssh":{"ip":"192.168.1.20","port":22,"username":"pi","password":"Hunter-22!"}}"#.utf8))
        XCTAssertEqual(other.ssh?.username, "pi")
        XCTAssertFalse("\(other)".contains("Hunter-22!"))
        XCTAssertFalse(String(reflecting: other).contains("Hunter-22!"))
    }

    func testTheInvitationIsFoundInAWholeMessage() throws {
        let node = String(repeating: "ab", count: 32)
        let link = "everythingapp://setup?code=ABCD-EFGH&name=Mom%27s%20phone&link=direct&node=\(node)&relay=\("https://relay.example".addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)&hid=\(String(repeating: "C", count: 26))"
        let message = """
        Hi Mom, it's Robin. I set up Aeneas for you.

        1. Install the Aeneas app. On an iPhone or iPad: https://apps.apple.com/app/id6832161802 . On an Android phone: https://github.com/gnomecannon/aeneas/releases/latest .
        2. Copy this whole message: press and hold it, then tap Copy.
        3. Open Aeneas and tap I have an invitation. It finds the invitation in this message and connects you.

        The invitation works once, until Saturday, November 22 at 2:47 PM.
        \(link)
        """
        let parsed = try XCTUnwrap(SetupLink.find(in: message))
        XCTAssertEqual(parsed.credential, .code("ABCDEFGH"))
        XCTAssertEqual(parsed.name, "Mom's phone")
        XCTAssertTrue(parsed.hub.hasPrefix("iroh://"))
        // A full stop after the link is not part of it; a message with no link, or a broken one, gives nothing.
        XCTAssertNotNil(SetupLink.find(in: "Here: \(link)."))
        XCTAssertNil(SetupLink.find(in: "Hi Mom, nothing in here"))
        XCTAssertNil(SetupLink.find(in: "everythingapp://setup?name=x"))
    }

    func testDevicesAreNamedByWhatAnswers() {
        let k = { (ip: String, open: [Int], name: String) in HomeDeviceKind.kind(ip: ip, open: open, announced: name) }
        XCTAssertEqual(k("192.168.1.1", [80, 443], ""), "router")
        XCTAssertEqual(k("192.168.1.20", [80], ""), "device with a web page")
        XCTAssertEqual(k("192.168.1.30", [631, 9100], ""), "printer")
        XCTAssertEqual(k("192.168.1.31", [62078], ""), "iPhone or iPad")
        XCTAssertEqual(k("192.168.1.32", [], "Jane's iPhone"), "iPhone or iPad")
        XCTAssertEqual(k("192.168.1.33", [445, 3389], ""), "Windows computer (Remote Desktop on)")
        XCTAssertEqual(k("192.168.1.34", [22], ""), "computer or device with SSH")
        XCTAssertEqual(k("192.168.1.35", [22, 445, 5900], ""), "Mac")
        XCTAssertEqual(k("192.168.1.36", [22, 443, 445, 8080], "attic"), "storage box (NAS) or file server")
        XCTAssertEqual(k("192.168.1.37", [445], ""), "Windows computer")
        XCTAssertEqual(k("192.168.1.38", [], ""), "device")
    }

    func testHomeNetworkAddresses() {
        XCTAssertTrue(HomeNetwork.isPrivate("192.168.1.20"))
        XCTAssertTrue(HomeNetwork.isPrivate("192.168.1.7"))
        XCTAssertTrue(HomeNetwork.isPrivate("172.20.1.1"))
        XCTAssertFalse(HomeNetwork.isPrivate("172.40.1.1"))
        XCTAssertFalse(HomeNetwork.isPrivate("8.8.8.8"))
        XCTAssertFalse(HomeNetwork.isPrivate("not an ip"))
        XCTAssertEqual(HomeNetwork.network(of: "192.168.1.20")?.cidr, "192.168.1.0/24")
        XCTAssertNil(HomeNetwork.network(of: "100.64.1.1"))
    }

    func testPlainTimes() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/New_York")!
        let locale = Locale(identifier: "en_US")
        let now = ISO.date("2026-11-19T20:00:00.000Z")!
        XCTAssertEqual(HelperTime.when("2026-11-19T19:14:00.000Z", now: now, calendar: cal, locale: locale), "Today at 2:14\u{202F}PM")
        XCTAssertEqual(HelperTime.when("2026-11-18T14:02:00.000Z", now: now, calendar: cal, locale: locale), "Yesterday at 9:02\u{202F}AM")
        XCTAssertEqual(HelperTime.when("2026-11-16T20:14:00.000Z", now: now, calendar: cal, locale: locale), "Monday at 3:14\u{202F}PM")
        XCTAssertEqual(HelperTime.when("2026-11-03T20:14:00.000Z", now: now, calendar: cal, locale: locale), "November 3 at 3:14\u{202F}PM")
        XCTAssertEqual(HelperTime.since("2026-11-19T19:14:00.000Z", now: now, calendar: cal, locale: locale), "Since today at 2:14\u{202F}PM")
    }

    /// By hand on a real network: EA_SCAN_TEST=1 swift test --filter testScanThisNetwork
    func testScanThisNetwork() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["EA_SCAN_TEST"] == "1", "only by hand")
        let s = try await HomeNetwork.scan()
        print("\(s.devices.count) on \(s.network)")
        for d in s.devices { print(d.ip, d.kind ?? "", d.open, d.name) }
        XCTAssertFalse(s.devices.isEmpty)
    }

    #if os(macOS)
    func testAMacRunsACommandAndStopsOneThatRunsTooLong() async {
        let ok = await HelperCommand.run("echo hello; echo oops 1>&2", timeout: 10)
        XCTAssertEqual(ok.exitCode, 0)
        XCTAssertTrue(ok.output.contains("hello") && ok.output.contains("oops"), ok.output)
        let fail = await HelperCommand.run("exit 3", timeout: 10)
        XCTAssertEqual(fail.exitCode, 3)
        let start = Date()
        let slow = await HelperCommand.run("sleep 30 & sleep 30", timeout: 1)
        XCTAssertEqual(slow.exitCode, 124)
        XCTAssertLessThan(Date().timeIntervalSince(start), 6)
        XCTAssertTrue(HelperCommand.cut(String(repeating: "é", count: HelperCommand.maxOutput)).hasSuffix("[cut]"))
    }
    #endif
}
