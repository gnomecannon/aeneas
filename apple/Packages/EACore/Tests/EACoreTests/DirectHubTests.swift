import XCTest
@testable import EACore

final class DirectHubTests: XCTestCase {
    let key = "33093251b2924d8cbbf2c6673d7ea5623e8ac37a00756e98545de8af89188afe"
    let relay = "https://use1-1.relay.n0.iroh.link./"

    func testSetupLinkForADirectHubCarriesKeyAndRelay() throws {
        let raw = "everythingapp://setup?code=ABCD-EFGH&name=iPhone&link=direct&node=\(key)&relay=https%3A%2F%2Fuse1-1.relay.n0.iroh.link.%2F"
        let link = try XCTUnwrap(SetupLink.parse(URL(string: raw)!))
        let d = try XCTUnwrap(DirectHub.parse(link.hub))
        XCTAssertEqual(d.node, key)
        XCTAssertEqual(d.relay, relay)
        XCTAssertNil(link.pin, "a Direct link hub has no certificate to pin")
        XCTAssertEqual(HTTPTransport.hubURL(link.hub)?.absoluteString, "iroh://\(key)")
    }

    func testABadKeyOrAPlainRelayIsNotASetupLink() {
        XCTAssertNil(SetupLink.parse(URL(string: "everythingapp://setup?code=ABCD-EFGH&link=direct&node=abc&relay=https%3A%2F%2Fr.example")!))
        XCTAssertNil(SetupLink.parse(URL(string: "everythingapp://setup?code=ABCD-EFGH&link=direct&node=\(key)&relay=http%3A%2F%2Fr.example")!))
    }

    func testNoTransportWithoutTheBridge() {
        let saved = DirectLinkBridge.session
        DirectLinkBridge.session = nil
        defer { DirectLinkBridge.session = saved }
        XCTAssertNil(HTTPTransport.make(urlString: DirectHub.address(node: key, relay: relay), token: "k"))
    }

    func testTheBridgeGivesTheTransportItsSession() throws {
        let saved = DirectLinkBridge.session
        let s = URLSession(configuration: .ephemeral)
        DirectLinkBridge.session = { node, r in node == self.key && r == self.relay ? s : nil }
        defer { DirectLinkBridge.session = saved }
        let t = try XCTUnwrap(HTTPTransport.make(urlString: DirectHub.address(node: key, relay: relay), token: "k"))
        XCTAssertTrue(t.session === s)
        XCTAssertEqual(t.baseURL.absoluteString, "iroh://\(key)")
    }

    func testOrdinaryAddressesAreUnchanged() {
        XCTAssertNil(DirectHub.parse("https://hub.tail1234.ts.net:8787"))
        XCTAssertEqual(HTTPTransport.hubURL("hub.tail1234.ts.net:8787")?.absoluteString, "https://hub.tail1234.ts.net:8787")
    }
}

final class TailnetTests: XCTestCase {
    func testTailnetHubsAreTheTsNetNames() {
        XCTAssertTrue(Tailnet.isTailnetHub("https://core.tail1234.ts.net"))
        XCTAssertTrue(Tailnet.isTailnetHub("https://CORE.tail1234.TS.NET:443/"))
        XCTAssertFalse(Tailnet.isTailnetHub("https://192.168.1.20:8787"))
        XCTAssertFalse(Tailnet.isTailnetHub("https://ts.net.example.com"))
        XCTAssertFalse(Tailnet.isTailnetHub("iroh://abc"))
    }
}
