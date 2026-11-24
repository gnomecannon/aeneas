import Foundation

/// Music's Projects page (gnomecannon/aeneas#13): every music project, a release in the making (an album, an EP or a
/// single), as a card with its ideas and its hummed takes. Sorted as the web app sorts them (`musicProjectCards` in
/// web/src/lib/creative.ts): active ones first, then parked, then done, the newest change first within each; ideas and
/// takes newest change first.
public enum MusicProjects {
    public struct Card: Identifiable, Equatable, Sendable {
        public let project: Entity
        public let ideas: [Entity]
        public let takes: [Entity]
        public var id: String { project.id }
    }

    /// A hummed take: its recording is kept on the hub (`audio_ref` hum:<id>).
    public static func isHummed(_ idea: Entity) -> Bool { idea.str("audio_ref").hasPrefix("hum:") }

    private static let order = ["active": 0, "parked": 1, "done": 2]

    private static func newestFirst(_ a: Entity, _ b: Entity) -> Bool { a.updated_at > b.updated_at }

    public static func cards(projects: [Entity], ideas: [Entity]) -> [Card] {
        projects
            .filter { !$0.isDeleted && $0.str("area") == "music" }
            .sorted {
                let a = order[$0.str("status", "active")] ?? 0, b = order[$1.str("status", "active")] ?? 0
                return a != b ? a < b : newestFirst($0, $1)
            }
            .map { p in
                let mine = ideas.filter { !$0.isDeleted && $0.str("project_id") == p.id }.sorted(by: newestFirst)
                return Card(project: p, ideas: mine.filter { !isHummed($0) }, takes: mine.filter(isHummed))
            }
    }
}
