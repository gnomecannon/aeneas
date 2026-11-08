import XCTest
@testable import EACore

final class SSETests: XCTestCase {
    private func messages(_ raw: String) -> [SSEMessage] {
        var lines = SSELineBuffer(), parser = SSEParser(), out: [SSEMessage] = []
        for b in Array(raw.utf8) { if let l = lines.append(b), let m = parser.feed(line: l) { out.append(m) } }
        if let rest = lines.flush(), let m = parser.feed(line: rest) { out.append(m) }
        if let m = parser.feed(line: "") { out.append(m) }
        return out
    }

    func testChatStreamSplitsIntoTokenAndDoneEvents() {
        let raw = "event: token\ndata: {\"token\":\"Hel\"}\n\nevent: token\ndata: {\"token\":\"lo\"}\n\nevent: done\ndata: {\"reply\":\"Hello\",\"model\":\"m\",\"backend\":\"ollama\",\"redactions\":0,\"rules_applied\":[]}\n\n"
        let m = messages(raw)
        XCTAssertEqual(m.map(\.event), ["token", "token", "done"])
        XCTAssertEqual(m[1].data, "{\"token\":\"lo\"}")
        XCTAssertNotNil(try? JSONCoding.decode(ChatResponse.self, from: Data(m[2].data.utf8)))
    }

    func testCarriageReturnsCommentsAndUnterminatedTail() {
        let m = messages(": keepalive\r\n\r\nevent: error\r\ndata: {\"error\":\"down\"}")
        XCTAssertEqual(m.map(\.event), ["error"])
        XCTAssertEqual(m[0].data, "{\"error\":\"down\"}")
    }

    func testMultibyteTextSurvives() {
        let m = messages("event: token\ndata: {\"token\":\"caf\u{e9} \u{1F44B}\"}\n\n")
        XCTAssertEqual(m.first?.data, "{\"token\":\"caf\u{e9} \u{1F44B}\"}")
    }
}
