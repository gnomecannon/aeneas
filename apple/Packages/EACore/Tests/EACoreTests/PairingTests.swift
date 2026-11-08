import XCTest
@testable import EACore

/// Pairing codes and setup links: what a scanned QR code or a typed code becomes.
final class PairingTests: XCTestCase {
    func testCodesAreReadTheWayTheHubReadsThem() {
        XCTAssertEqual(PairingCode.normalize("abcd-efgh"), "ABCDEFGH")
        XCTAssertEqual(PairingCode.normalize(" 7k3m 9p2q "), "7K3M9P2Q")
        // O is read as 0, I and L as 1 (Crockford base32 has none of them).
        XCTAssertEqual(PairingCode.normalize("OILo-1234"), "01101234")
        XCTAssertTrue(PairingCode.isValid("7K3M-9P2Q"))
        XCTAssertTrue(PairingCode.isValid("7k3m9p2q"))
        XCTAssertFalse(PairingCode.isValid("7K3M-9P2"), "seven characters")
        XCTAssertFalse(PairingCode.isValid("7K3M-9P2QX"), "nine characters")
        XCTAssertFalse(PairingCode.isValid("7K3M-9P2U"), "U is not in the alphabet")
        XCTAssertEqual(PairingCode.display("7k3m9p2q"), "7K3M-9P2Q")
        XCTAssertEqual(PairingCode.display("short"), "short")
    }

    private func link(_ s: String) -> SetupLink? { URL(string: s).flatMap(SetupLink.parse) }

    func testCodeLinkFromTheHub() throws {
        // The hub's `app` link: the code without its dash, URL-encoded hub address.
        let l = try XCTUnwrap(link("everythingapp://setup?hub=https%3A%2F%2Fcore.tail1234.ts.net&code=7K3M9P2Q&name=iPad"))
        XCTAssertEqual(l.hub, "https://core.tail1234.ts.net")
        XCTAssertEqual(l.credential, .code("7K3M9P2Q"))
        XCTAssertEqual(l.name, "iPad")
        XCTAssertNil(l.pin)
    }

    func testSpacesInTheNameReadTheSameWhicheverWayTheyAreWritten() throws {
        // URLSearchParams writes a space as "+", a hand-made link as %20; a real plus arrives as %2B.
        for raw in ["Robin%E2%80%99s+iPad", "Robin%E2%80%99s%20iPad"] {
            let l = try XCTUnwrap(link("everythingapp://setup?hub=https%3A%2F%2Fcore.tail1234.ts.net&code=7K3M9P2Q&name=\(raw)"))
            XCTAssertEqual(l.name, "Robin\u{2019}s iPad", raw)
        }
        let plus = try XCTUnwrap(link("everythingapp://setup?hub=https%3A%2F%2Fcore.tail1234.ts.net&code=7K3M9P2Q&name=C%2B%2B+box"))
        XCTAssertEqual(plus.name, "C++ box")
    }

    func testCodeIsNormalizedAndPreferredOverAToken() throws {
        let l = try XCTUnwrap(link("everythingapp://setup?hub=http%3A%2F%2Fhub.test%3A8787&code=7k3m-9p2q&token=old"))
        XCTAssertEqual(l.credential, .code("7K3M9P2Q"))
        XCTAssertNil(l.name)
    }

    func testOlderTokenLinkStillParses() throws {
        let l = try XCTUnwrap(link("everythingapp://setup?hub=http%3A%2F%2Flocalhost%3A8788&token=devtoken&name=sim"))
        XCTAssertEqual(l.credential, .token("devtoken"))
        XCTAssertEqual(l.name, "sim")
    }

    func testBrokenLinksAreRefused() {
        XCTAssertNil(link("everythingapp://setup?hub=http%3A%2F%2Fhub.test&code=ABC"), "a code that is not 8 characters")
        XCTAssertNil(link("everythingapp://setup?code=7K3M9P2Q"), "no hub")
        XCTAssertNil(link("everythingapp://setup?hub=http%3A%2F%2Fhub.test"), "no code or token")
        XCTAssertNil(link("everythingapp://setup?hub=javascript%3Aalert(1)&code=7K3M9P2Q"), "not an http address")
        XCTAssertNil(link("everythingapp://setup?hub=ftp%3A%2F%2Fhub.test&code=7K3M9P2Q"), "not http or https")
        XCTAssertNil(link("everythingapp://today?hub=http%3A%2F%2Fhub.test&code=7K3M9P2Q"), "not the setup link")
        XCTAssertNil(link("https://hub.test/app/#/setup?hub=x&code=7K3M9P2Q"), "the web link is for browsers")
    }

    func testPinIsKeptOnlyForAnHTTPSHub() throws {
        let fp = "5574901170F2584F903413900ADBC3F1C2B2E33DFD54E42664F6D4CEDB02E537"
        let https = try XCTUnwrap(link("everythingapp://setup?hub=https%3A%2F%2Fhub.lan&code=7K3M9P2Q&fp=\(fp)"))
        XCTAssertEqual(https.pin, fp.lowercased())
        let http = try XCTUnwrap(link("everythingapp://setup?hub=http%3A%2F%2Fhub.lan&code=7K3M9P2Q&fp=\(fp)"))
        XCTAssertNil(http.pin, "a plain http hub has no certificate to pin")
        let bad = try XCTUnwrap(link("everythingapp://setup?hub=https%3A%2F%2Fhub.lan&code=7K3M9P2Q&fp=abc"))
        XCTAssertNil(bad.pin, "a fingerprint that is not 32 bytes is ignored, not trusted")
    }

    func testLongNamesAreCut() throws {
        let long = String(repeating: "a", count: 90)
        let l = try XCTUnwrap(link("everythingapp://setup?hub=http%3A%2F%2Fhub.test&code=7K3M9P2Q&name=\(long)"))
        XCTAssertEqual(l.name?.count, 60)
    }

    func testPairingAnswersDecodeFromNewAndOlderHubs() throws {
        let new = try JSONCoding.decode(PairingLinks.self, from: #"{"hub":"https://h","code":"7K3M-9P2Q","expires_at":"2026-11-05T21:00:00.000Z","app":"everythingapp://setup?hub=https%3A%2F%2Fh&code=7K3M9P2Q&name=iPad","web":"https://h/app/#/setup?hub=x"}"#)
        XCTAssertEqual(new.code, "7K3M-9P2Q")
        XCTAssertNotNil(new.expires)
        XCTAssertFalse(new.carriesSharedKey)
        let old = try JSONCoding.decode(PairingLinks.self, from: #"{"hub":"http://h","app":"everythingapp://setup?hub=x&token=t","web":"http://h/app"}"#)
        XCTAssertNil(old.code)
        XCTAssertTrue(old.carriesSharedKey)
    }

    func testPairingFallsBackToTheOlderRoute() async throws {
        let t = FakeTransport()
        t.responses = [(404, Data(#"{"error":"not found"}"#.utf8)), (200, Data(#"{"hub":"http://h","app":"everythingapp://setup?hub=x&token=t","web":"w"}"#.utf8))]
        let links = try await HubClient(transport: t).pairing(name: "iPad")
        XCTAssertEqual(t.calls.map(\.path), ["devices/pairing", "setup/pair"])
        XCTAssertEqual(t.calls[1].query["name"], "iPad")
        XCTAssertTrue(links.carriesSharedKey)
    }

    func testClaimSendsTheNormalizedCode() async throws {
        let t = FakeTransport()
        t.responses = [(200, Data(#"{"device_id":"d1","key":"ead1_k","name":"iPad","version":"1"}"#.utf8))]
        let r = try await HubClient(transport: t).claim(code: "7k3m-9p2q", name: "iPad", platform: .ipad, deviceId: nil)
        XCTAssertEqual(r.key, "ead1_k")
        let body = try XCTUnwrap(t.calls.first?.body).asJSON()
        XCTAssertEqual(body["code"] as? String, "7K3M9P2Q")
        XCTAssertEqual(body["platform"] as? String, "ipad")
        XCTAssertNil(body["device_id"])
    }

    func testRemovedDeviceIsItsOwnError() {
        XCTAssertEqual(HubClient.error(status: 401, data: Data(#"{"error":"unauthorized","device_removed":true}"#.utf8)), .deviceRemoved)
        XCTAssertTrue(HubError.deviceRemoved.isAuth)
        XCTAssertEqual(HubClient.error(status: 401, data: Data(#"{"error":"unauthorized"}"#.utf8)), .http(status: 401, message: "unauthorized"))
        XCTAssertEqual(HubClient.error(status: 403, data: Data(#"{"device_removed":true}"#.utf8)).isDeviceRemoved, false, "only a 401 says removed")
    }
}

extension Data {
    func asJSON() throws -> [String: Any] { (try JSONSerialization.jsonObject(with: self)) as? [String: Any] ?? [:] }
}
