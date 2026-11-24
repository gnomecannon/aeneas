import XCTest
@testable import EACore

/// Music's Projects page (gnomecannon/aeneas#13): the same cards, in the same order, as the web app's
/// `musicProjectCards` (web/src/lib/creative.test.ts has the same two cases).
final class MusicProjectsTests: XCTestCase {
    private func project(_ id: String, _ status: String, _ at: String, music: Bool = true) -> Entity {
        var f: [String: JSONValue] = ["name": .string(id), "status": .string(status), "definition_of_done": ""]
        if music { f["area"] = "music" }
        return Entity(id: id, kind: .project, created_at: at, updated_at: at, fields: f)
    }

    private func idea(_ id: String, _ project: String, _ at: String, hum: Bool = false, deleted: Bool = false) -> Entity {
        var f: [String: JSONValue] = ["title": .string(id), "type": "riff", "status": "idea", "project_id": .string(project)]
        if hum { f["audio_ref"] = .string("hum:\(id)") }
        return Entity(id: id, kind: .music_idea, created_at: at, updated_at: at, deleted_at: deleted ? at : nil, fields: f)
    }

    func testEveryMusicProjectActiveThenParkedThenDoneNewestFirst() {
        let cards = MusicProjects.cards(projects: [
            project("ep-done", "done", "2026-11-20"), project("album", "active", "2026-11-01"), project("single", "parked", "2026-11-23"),
            project("ep", "active", "2026-11-10"), project("shed", "active", "2026-11-24", music: false),
        ], ideas: [])
        XCTAssertEqual(cards.map(\.id), ["ep", "album", "single", "ep-done"])
    }

    func testIdeasAndHummedTakesApartNewestFirstWithoutDeletedOrOtherProjects() throws {
        let card = try XCTUnwrap(MusicProjects.cards(projects: [project("album", "active", "2026-11-01")], ideas: [
            idea("riff-old", "album", "2026-11-02"), idea("take-1", "album", "2026-11-03", hum: true), idea("riff-new", "album", "2026-11-05"),
            idea("take-2", "album", "2026-11-04", hum: true), idea("gone", "album", "2026-11-06", deleted: true), idea("elsewhere", "ep", "2026-11-07"),
        ]).first)
        XCTAssertEqual(card.ideas.map(\.id), ["riff-new", "riff-old"])
        XCTAssertEqual(card.takes.map(\.id), ["take-2", "take-1"])
    }

    func testAQuickLineInAProjectSaysWhichProject() throws {
        let plain = try XCTUnwrap(String(data: JSONEncoder().encode(HubClient.musicQuickBody("Am F", projectId: nil)), encoding: .utf8))
        let inProject = try XCTUnwrap(String(data: JSONEncoder().encode(HubClient.musicQuickBody("Am F", projectId: "album")), encoding: .utf8))
        XCTAssertFalse(plain.contains("project_id"))
        XCTAssertTrue(inProject.contains(#""project_id":"album""#))
    }
}
