import XCTest
@testable import EACore

final class HomeFinderTests: XCTestCase {
    let pin = String(repeating: "ab", count: 32)

    func testAddressWritesIPv6InBracketsWithItsInterface() {
        XCTAssertEqual(HomeFinder.address(host: "192.168.1.20", port: 8787), "https://192.168.1.20:8787")
        XCTAssertEqual(HomeFinder.address(host: "192.168.1.20%en0", port: 8787), "https://192.168.1.20:8787")
        XCTAssertEqual(HomeFinder.address(host: "fe80::1%en0", port: 8787), "https://[fe80::1%25en0]:8787")
        XCTAssertEqual(HomeFinder.address(host: "2001:db8::5", port: 443), "https://[2001:db8::5]:443")
        XCTAssertNotNil(URL(string: HomeFinder.address(host: "fe80::1%en0", port: 8787)))
    }

    func testSameAddressIgnoresCaseAndPath() {
        XCTAssertTrue(HomeFinder.sameAddress("https://192.168.1.20:8787", "HTTPS://192.168.1.20:8787/"))
        XCTAssertFalse(HomeFinder.sameAddress("https://192.168.1.20:8787", "https://192.168.1.21:8787"))
        XCTAssertFalse(HomeFinder.sameAddress("https://192.168.1.20:8787", "https://192.168.1.20:8788"))
    }

    func testLooksOnlyForAPinnedHomeHubThatDidNotAnswer() {
        let down = HubError.transport("Could not connect to the server.")
        XCTAssertTrue(HomeFinder.worthLooking(hubURL: "https://192.168.1.20:8787", pin: pin, error: down))
        XCTAssertTrue(HomeFinder.worthLooking(hubURL: "https://192.168.1.20:8787", pin: pin, error: URLError(.timedOut)))
        // It answered: not moved.
        XCTAssertFalse(HomeFinder.worthLooking(hubURL: "https://192.168.1.20:8787", pin: pin, error: HubError.http(status: 500, message: "")))
        // No pin (Tailscale, a public certificate), or a Direct link hub: nothing announces it.
        XCTAssertFalse(HomeFinder.worthLooking(hubURL: "https://hub.tail1234.ts.net", pin: nil, error: down))
        XCTAssertFalse(HomeFinder.worthLooking(hubURL: DirectHub.address(node: pin, relay: "https://relay.example"), pin: pin, error: down))
    }
}

/// Against a live announcement (hub/src/announce.ts): EA_HOME_TEST_PIN is its fingerprint, EA_HOME_TEST_PORT its port.
final class HomeFinderLiveTests: XCTestCase {
    func testFindsTheAnnouncedHubByItsFingerprint() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let pin = env["EA_HOME_TEST_PIN"], let port = env["EA_HOME_TEST_PORT"] else { throw XCTSkip("no live announcement") }
        let found = await HomeFinder.find(pin: pin)
        XCTAssertNotNil(found)
        XCTAssertTrue(found?.hasSuffix(":\(port)") ?? false, found ?? "nil")
        // Another fingerprint is not this hub.
        let other = await HomeFinder.find(pin: String(repeating: "0", count: 64), timeout: 2)
        XCTAssertNil(other)
    }
}
