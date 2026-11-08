import Foundation
import CoreSpotlight
import EACore

/// Puts the things people look for (notes, tasks, projects, snippets, fix notes, lists, games, films, procedures, music
/// ideas, job applications) into Spotlight, titles and a short line only (never a note's text), never the work space.
/// Only when the person turned on Settings, Privacy on this device, Show in Spotlight (off by default); turning it off
/// removes everything this app put there. Tapping a result opens it through `everythingapp://item/<id>`. Kept current
/// by a debounced pass after each sync: only changed items are written, and deleted ones removed.
@MainActor
final class SpotlightIndexer {
    static let shared = SpotlightIndexer()
    private let index = CSSearchableIndex(name: "everythingapp")
    /// What was last given to Spotlight: id to updated_at.
    private var indexed: [String: String] = [:]
    private var loaded = false
    private let file = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!.appendingPathComponent("spotlight-index.json")

    static let kinds: Set<Kind> = [.note, .task, .project, .snippet, .runbook, .checklist, .game, .film, .procedure, .music_idea, .application]

    func update(_ engine: SyncEngine) async {
        if !loaded {
            loaded = true
            indexed = (try? JSONDecoder().decode([String: String].self, from: Data(contentsOf: file))) ?? [:]
        }
        guard engine.config.showInSpotlight else { await clear(); return }
        var want: [String: Entity] = [:]
        // Kinds of a module that is off leave Spotlight, as their screens leave the app; they come back with it.
        let modules = engine.config.modules ?? []
        for k in Self.kinds where AppModule.of(kind: k).map({ modules.isOn($0) }) ?? true {
            for e in engine.list(k) where e.space != .work { want[e.id] = e }
        }
        let changed = want.values.filter { indexed[$0.id] != $0.updated_at }
        let gone = indexed.keys.filter { want[$0] == nil }
        guard !changed.isEmpty || !gone.isEmpty else { return }
        let items = changed.map(Self.item)
        do {
            for chunk in stride(from: 0, to: items.count, by: 200).map({ Array(items[$0..<min($0 + 200, items.count)]) }) {
                try await index.indexSearchableItems(chunk)
            }
            if !gone.isEmpty { try await index.deleteSearchableItems(withIdentifiers: Array(gone)) }
        } catch {
            return  // tried again after the next sync
        }
        for e in changed { indexed[e.id] = e.updated_at }
        for id in gone { indexed[id] = nil }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Ids and change times only. Complete until first user authentication: a sync in the background (phone
        // locked) updates Spotlight too, and an unreadable list would index everything again.
        if let d = try? JSONEncoder().encode(indexed) { try? DataProtection.write(d, to: file, .untilFirstUnlock) }
    }

    /// Everything this app put in Spotlight goes, with the list of what was given. Used when the setting is off and when
    /// this device is removed from the hub.
    func clear() async {
        if !loaded {
            loaded = true
            indexed = (try? JSONDecoder().decode([String: String].self, from: Data(contentsOf: file))) ?? [:]
        }
        let cleared = UserDefaults.standard.bool(forKey: "spotlight.cleared")
        guard !indexed.isEmpty || !cleared else { return }
        do { try await index.deleteAllSearchableItems() } catch { return }
        indexed = [:]
        try? FileManager.default.removeItem(at: file)
        UserDefaults.standard.set(true, forKey: "spotlight.cleared")
    }

    /// Turning the setting on starts indexing from scratch at the next pass.
    func enabled() { UserDefaults.standard.set(false, forKey: "spotlight.cleared") }

    /// The title and one line each kind shows in Spotlight.
    static func item(_ e: Entity) -> CSSearchableItem {
        let a = CSSearchableItemAttributeSet(contentType: .text)
        var title = e.str("title")
        var line = ""
        switch e.kind {
        case .note: line = "Note"
        case .task: line = "Task, \(e.str("status"))"
        case .project: title = e.str("name"); line = "Project"
        case .snippet: line = "Snippet, \(e.str("language"))"
        case .runbook: title = "\(e.str("host")): \(e.str("title"))"; line = "Fix notes"
        case .checklist: line = "List"
        case .game:
            title = e.str("name")
            line = e.number("playtime_min").map { "Game, \(Int(($0 / 60).rounded())) hours played" } ?? "Game"
        case .film: line = ["Film", e.number("year").map { String(Int($0)) }, e.str("last_watched").isEmpty ? nil : "watched \(e.str("last_watched"))"].compactMap { $0 }.joined(separator: ", ")
        case .procedure: line = "Procedure"
        case .music_idea: line = "Music idea, \(e.str("type"))"
        case .application: title = "\(e.str("role")) at \(e.str("company"))"; line = "Job application, \(e.str("stage"))"
        default: break
        }
        a.title = StyleGuard.dashes(title.isEmpty ? "Untitled" : title)
        a.contentDescription = StyleGuard.dashes(line)
        a.keywords = [e.kind.rawValue] + e.stringArray("tags")
        return CSSearchableItem(uniqueIdentifier: e.id, domainIdentifier: e.kind.rawValue, attributeSet: a)
    }
}
