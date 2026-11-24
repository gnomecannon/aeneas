import XCTest
import EACore
@testable import EALink
import IrohLib

final class HTTPWireTests: XCTestCase {
    func testChunkedBodiesComeOutWholeHoweverTheBytesArrive() {
        let wire = Data("3\r\nabc\r\n10\r\n0123456789abcdef\r\n0\r\n\r\n".utf8)
        for split in [1, 2, 5, 7, 64] {
            var d = ChunkDecoder(); var out = Data()
            var i = 0
            while i < wire.count { out.append(d.feed(wire.subdata(in: i..<min(i + split, wire.count)))); i += split }
            XCTAssertEqual(String(decoding: out, as: UTF8.self), "abc0123456789abcdef", "pieces of \(split)")
            XCTAssertTrue(d.finished)
        }
    }

    func testTheRequestIsHTTP10WithTheKeyAndNoCompression() {
        var r = URLRequest(url: URL(string: "iroh://\(String(repeating: "a", count: 64))/setup?x=1")!)
        r.httpMethod = "PUT"
        r.setValue("Bearer k", forHTTPHeaderField: "Authorization")
        r.setValue("gzip", forHTTPHeaderField: "Accept-Encoding")
        let head = String(decoding: HTTPWire.requestHead(r, bodyLength: 4), as: UTF8.self)
        XCTAssertTrue(head.hasPrefix("PUT /setup?x=1 HTTP/1.0\r\nHost: hub\r\n"))
        XCTAssertTrue(head.contains("Authorization: Bearer k\r\n"))
        XCTAssertTrue(head.contains("Accept-Encoding: identity\r\n"))
        XCTAssertFalse(head.contains("gzip"))
        XCTAssertTrue(head.hasSuffix("Content-Length: 4\r\n\r\n"))
    }

    func testTheHeadIsReadOnceComplete() {
        XCTAssertNil(HTTPWire.parseHead(Data("HTTP/1.1 200 OK\r\nA: b\r\n".utf8)))
        let (h, used) = HTTPWire.parseHead(Data("HTTP/1.1 404 Not Found\r\nContent-Type: x\r\n\r\nbody".utf8))!
        XCTAssertEqual(h.status, 404)
        XCTAssertEqual(h.headers["Content-Type"], "x")
        XCTAssertEqual(used, "HTTP/1.1 404 Not Found\r\nContent-Type: x\r\n\r\n".utf8.count)
    }

    /// Against a real hub with the Direct link on (EA_LINK_TEST_ADDRESS: iroh://<key>?relay=..., EA_LINK_TEST_KEY: a
    /// device key or the main key is refused): skipped without them.
    func testARealHubAnswersOverTheDirectLink() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["EA_LINK_TEST_ADDRESS"], let key = env["EA_LINK_TEST_KEY"] else { throw XCTSkip("no test hub named") }
        EALink.install()
        let t = try XCTUnwrap(HTTPTransport.make(urlString: address, token: key))
        let r = try await t.send(method: "GET", path: "setup", query: [:], body: nil)
        XCTAssertEqual(r.status, 200, String(decoding: r.data, as: UTF8.self))
        let state = await EALink.state(hubAddress: address)
        XCTAssertEqual(state?.connected, true)
    }
}

final class JoinListenerTests: XCTestCase {
    func testTheDeadlineAnswersWithoutWaitingForTheCall() async throws {
        let started = Date()
        do {
            _ = try await IrohDeadline.run(0.2) { try await Task.sleep(nanoseconds: 5_000_000_000); return 1 }
            XCTFail("the call took longer than its time")
        } catch is IrohDeadline.TimedOut {}
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
        let v = try await IrohDeadline.run(5) { 7 }
        XCTAssertEqual(v, 7)
    }

    func testThePreviousSecretCountsForTwoMinutesAfterTheChange() {
        let now = Date(), a = Data([1]), b = Data([2])
        XCTAssertEqual(JoinListener.secrets(current: b, previous: nil, now: now), [b])
        XCTAssertEqual(JoinListener.secrets(current: b, previous: (a, now.addingTimeInterval(-119)), now: now), [b, a])
        XCTAssertEqual(JoinListener.secrets(current: b, previous: (a, now.addingTimeInterval(-121)), now: now), [b])
    }

    func testKeysAreWrittenAsTheHubWritesThem() {
        XCTAssertEqual(JoinListener.hex(Data([0, 1, 0xab, 0xff])), "0001abff")
    }

    /// A whole join between two endpoints on this machine, through n0's relays (EA_LINK_TEST_JOIN=1; it needs the
    /// internet): a stand-in hub connects, sends a proof made with the secret from the code, and the device says yes.
    /// A second hub after that is refused.
    func testAHubThatProvesTheSecretIsAnsweredYes() async throws {
        guard ProcessInfo.processInfo.environment["EA_LINK_TEST_JOIN"] == "1" else { throw XCTSkip("set EA_LINK_TEST_JOIN=1 to join through n0's relays") }
        let listener = JoinListener()
        var events = listener.events().makeAsyncIterator()
        guard case .ready(let node, let relay, let secretText)? = await events.next() else { return XCTFail("no code to show") }
        XCTAssertTrue(DirectHub.validKey(node))
        XCTAssertTrue(DirectHub.validRelay(relay), relay)
        print("The device's home relay, as the code carries it: \(relay)")
        XCTAssertTrue(JoinLink(node: node, relay: relay, secret: secretText, name: "Test Mac", platform: .mac).url.flatMap(JoinLink.parse) != nil)
        let secret = try XCTUnwrap(JoinSecret.decode(secretText))

        func hub(proofSecret: Data) async throws -> String {
            let b = EndpointBuilder()
            b.applyMinimal()
            b.relayMode(mode: RelayMode.defaultMode())
            let ep = try await b.bind()
            defer { Task { try? await ep.close() } }
            let key = JoinListener.hex(ep.id().toBytes())
            let link = "everythingapp://setup?hid=0123456789ABCDEFGHJKMNPQRS&code=ABCD-EFGH&name=Test%20Mac&link=direct&node=\(key)&relay=\(relay.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!)"
            let proof = JoinCheck.proof(secret: proofSecret, hubKey: key, node: node, link: link)
            let conn = try await IrohDeadline.run(30) { try await ep.connect(addr: EndpointAddr(id: try EndpointId.fromString(s: node), relayUrl: relay, addresses: []), alpn: Data("aeneas/join/1".utf8)) }
            let bi = try await conn.openBi()
            try await bi.send().writeAll(buf: try JSONSerialization.data(withJSONObject: ["v": 1, "link": link, "proof": proof]))
            try await bi.send().finish()
            let answer = try await IrohDeadline.run(20) { try await bi.recv().readToEnd(sizeLimit: 4096) }
            return String(decoding: answer, as: UTF8.self)
        }

        // The wrong secret first: refused, and the device keeps waiting.
        let refused = try await hub(proofSecret: JoinSecret.make())
        XCTAssertTrue(refused.contains("\"ok\":false"), refused)
        let yes = try await hub(proofSecret: secret)
        XCTAssertTrue(yes.contains("\"ok\":true"), yes)
        guard case .joined(let link)? = await events.next() else { return XCTFail("no join") }
        XCTAssertEqual(link.credential, .code("ABCDEFGH"))
        // Only the first join that checks out is taken.
        let again = try await hub(proofSecret: secret)
        XCTAssertTrue(again.contains(JoinCheck.alreadyJoined), again)
        await listener.stop()
    }
}
