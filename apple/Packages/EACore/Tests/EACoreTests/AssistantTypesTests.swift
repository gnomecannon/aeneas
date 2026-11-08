import XCTest
@testable import EACore

final class AssistantTypesTests: XCTestCase {
    func testHubHeldTurnSendsOnlyTheNewMessage() throws {
        let req = ChatRequest(session_id: "s1", message: "hi", images: ["AAAA"], allow_cloud: false)
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONCoding.data(req)) as? [String: Any])
        XCTAssertEqual(json["message"] as? String, "hi")
        XCTAssertEqual(json["images"] as? [String], ["AAAA"])
        XCTAssertNil(json["messages"], "no history is sent; the hub keeps it")
        XCTAssertNil(json["task_type"], "auto mode is the hub default")
    }

    func testSessionAndPendingActionDecode() throws {
        let raw = """
        {"session_id":"s1","title":"Samba","task_type":"troubleshoot","created_at":"2026-10-27T20:00:00.000Z","last_at":"2026-10-27T20:01:00.000Z",
         "messages":[{"role":"user","content":"fix it","images":["abc"]},
                     {"role":"assistant","content":"Approve?","actions":[{"tool":"run_command","ok":true,"writes":false}],"approval":{"action_id":"a1","host":"storage","command":"systemctl restart smbd","status":"pending"}}],
         "summary":null,"summary_upto":0,
         "pending_action":{"id":"a1","host":"storage","command":"systemctl restart smbd","purpose":"restart Samba"}}
        """
        let s = try JSONCoding.decode(AISession.self, from: Data(raw.utf8))
        XCTAssertEqual(s.messages.count, 2)
        XCTAssertEqual(s.messages[0].images, ["abc"])
        XCTAssertEqual(s.messages[1].approval?.status, "pending")
        XCTAssertEqual(s.pending_action?.command, "systemctl restart smbd")
        let done = try JSONCoding.decode(ChatResponse.self, from: Data(#"{"reply":"ok","model":"m","backend":"ollama","redactions":0,"rules_applied":[],"mode":"troubleshoot","pending_action":{"id":"a2","host":"desktop","command":"Restart-Service x","risk":"medium"}}"#.utf8))
        XCTAssertEqual(done.pending_action?.host, "desktop")
        XCTAssertEqual(ToolAction.label("web_search"), "Searching the web")
        XCTAssertEqual(TaskType(rawValue: "auto"), .auto)
    }
}
