import XCTest
import EACore
@testable import EALink

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
