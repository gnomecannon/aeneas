import SwiftUI
import EACore

// Life admin helpers shared by Lists, Career and Games. Ported from web/src/lib/admin.ts and web/src/sync/admin.ts.
// Names carry an Admin prefix because every area's files compile into one target.

// MARK: Checklists

struct AdminChecklistItem: Identifiable, Equatable {
    var index: Int
    var text: String
    var note: String?
    var done: Bool
    var id: Int { index }
}

enum AdminChecklist {
    static func items(_ e: Entity) -> [AdminChecklistItem] {
        (e.fields["items"]?.arrayValue ?? []).enumerated().map { i, v in
            let o = v.objectValue ?? [:]
            let text = o["text"]?.stringValue ?? v.stringValue ?? ""
            let note = o["note"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
            let done = !(o["done_at"]?.stringValue ?? "").isEmpty
            return AdminChecklistItem(index: i, text: text, note: note, done: done)
        }
    }

    static func progress(_ e: Entity) -> (done: Int, total: Int) {
        let it = items(e)
        return (it.filter(\.done).count, it.count)
    }

    static func isTemplate(_ e: Entity) -> Bool { e.bool("template") ?? false }
    static func isArchived(_ e: Entity) -> Bool { e.bool("archived") ?? false }
    static func isStates(_ e: Entity) -> Bool { e.str("kind") == "states" }

    /// The items with one done_at flipped, exactly what POST /checklists/:id/toggle does.
    static func toggled(_ raw: [JSONValue], index: Int, at: String) -> [JSONValue] {
        raw.enumerated().map { i, v in
            guard i == index else { return v }
            var o = v.objectValue ?? ["text": .string(v.stringValue ?? "")]
            if !(o["done_at"]?.stringValue ?? "").isEmpty { o.removeValue(forKey: "done_at") } else { o["done_at"] = .string(at) }
            return .object(o)
        }
    }

    /// The position of the item a row showed (its index and text then) in the list as it is now: the same index while
    /// its text still matches, else the nearest item with that text. Items have no id on the hub, only a position, so
    /// a row's index alone points at another item once something above it was added or deleted.
    static func locate(_ raw: [JSONValue], index: Int, text: String) -> Int? {
        func textAt(_ i: Int) -> String { raw[i].objectValue?["text"]?.stringValue ?? raw[i].stringValue ?? "" }
        if raw.indices.contains(index), textAt(index) == text { return index }
        return raw.indices.filter { textAt($0) == text }.min { abs($0 - index) < abs($1 - index) }
    }

    /// A template copy, as POST /checklists/:id/instantiate makes it: every done_at cleared, from_template set.
    static func instantiateFields(_ template: Entity, title: String? = nil) -> [String: JSONValue] {
        let t = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let items: [JSONValue] = items(template).map { it in
            var o: [String: JSONValue] = ["text": .string(it.text)]
            if let n = it.note { o["note"] = .string(n) }
            return .object(o)
        }
        return [
            "title": .string(t.isEmpty ? template.str("title") : t),
            "kind": .string(template.string("kind") ?? "generic"),
            "items": .array(items),
            "template": false,
            "from_template": .string(template.id),
            "tags": template.fields["tags"] ?? .array([]),
        ]
    }

    static let states: [(code: String, name: String)] = [
        ("AL", "Alabama"), ("AK", "Alaska"), ("AZ", "Arizona"), ("AR", "Arkansas"), ("CA", "California"),
        ("CO", "Colorado"), ("CT", "Connecticut"), ("DE", "Delaware"), ("FL", "Florida"), ("GA", "Georgia"),
        ("HI", "Hawaii"), ("ID", "Idaho"), ("IL", "Illinois"), ("IN", "Indiana"), ("IA", "Iowa"),
        ("KS", "Kansas"), ("KY", "Kentucky"), ("LA", "Louisiana"), ("ME", "Maine"), ("MD", "Maryland"),
        ("MA", "Massachusetts"), ("MI", "Michigan"), ("MN", "Minnesota"), ("MS", "Mississippi"), ("MO", "Missouri"),
        ("MT", "Montana"), ("NE", "Nebraska"), ("NV", "Nevada"), ("NH", "New Hampshire"), ("NJ", "New Jersey"),
        ("NM", "New Mexico"), ("NY", "New York"), ("NC", "North Carolina"), ("ND", "North Dakota"), ("OH", "Ohio"),
        ("OK", "Oklahoma"), ("OR", "Oregon"), ("PA", "Pennsylvania"), ("RI", "Rhode Island"), ("SC", "South Carolina"),
        ("SD", "South Dakota"), ("TN", "Tennessee"), ("TX", "Texas"), ("UT", "Utah"), ("VT", "Vermont"),
        ("VA", "Virginia"), ("WA", "Washington"), ("WV", "West Virginia"), ("WI", "Wisconsin"), ("WY", "Wyoming"),
    ]
    private static let byName = Dictionary(uniqueKeysWithValues: states.map { ($0.name.lowercased(), $0.code) })
    private static let byCode = Dictionary(uniqueKeysWithValues: states.map { ($0.code, $0.name) })

    /// Two-letter code for an item text like "Massachusetts", "MA" or "- [x] Massachusetts"; nil when not a state.
    static func stateCode(_ text: String) -> String? {
        var t = text.replacingOccurrences(of: #"^\s*[-*]\s*(\[[ xX]\]\s*)?"#, with: "", options: .regularExpression)
        if t.hasSuffix(".") { t.removeLast() }
        t = t.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.count == 2, byCode[t.uppercased()] != nil, t.allSatisfy(\.isLetter) { return t.uppercased() }
        return byName[t.lowercased().replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)]
    }

    struct StateChip: Identifiable { var index: Int; var code: String; var name: String; var done: Bool; var id: Int { index } }

    /// One chip per item that names a state, in item order; items that are not states are left out.
    static func statesGrid(_ items: [AdminChecklistItem]) -> [StateChip] {
        items.compactMap { it in stateCode(it.text).map { StateChip(index: it.index, code: $0, name: byCode[$0] ?? $0, done: it.done) } }
    }
}

extension SyncEngine {
    /// Flips one tick as a patch of the whole list, read from the list as it is now. It used to send
    /// POST /checklists/:id/toggle with the row's index while adds and deletes wrote the whole list as patches, so a
    /// tick that reached the hub before a queued delete ticked the wrong item and brought the deleted one back, and an
    /// add made while a tick was on its way overwrote the tick. Every change to the items is now one patch through the
    /// outbox, so they reach the hub in the order they were made. Returns an error to show, if any.
    func adminToggleChecklist(_ id: String, index: Int, text: String) async -> String? {
        guard let e = get(id), !e.isDeleted else { return "List not found." }
        if AdminChecklist.isTemplate(e) { return "Templates are copied, never ticked. Start a list from it first." }
        let raw = e.fields["items"]?.arrayValue ?? []
        guard let i = AdminChecklist.locate(raw, index: index, text: text) else { return "That item is no longer on the list." }
        _ = await update(id, fields: ["items": .array(AdminChecklist.toggled(raw, index: i, at: ISO.now()))])
        return nil
    }

    /// Adds an item to the list as it is now, not as the screen last showed it.
    func adminAddChecklistItem(_ id: String, text: String) async {
        guard let e = get(id), !e.isDeleted else { return }
        let raw = e.fields["items"]?.arrayValue ?? []
        _ = await update(id, fields: ["items": .array(raw + [.object(["text": .string(text)])])])
    }

    /// Removes the item a row showed from the list as it is now; nothing happens when it is already gone.
    func adminRemoveChecklistItem(_ id: String, index: Int, text: String) async {
        guard let e = get(id), !e.isDeleted else { return }
        var raw = e.fields["items"]?.arrayValue ?? []
        guard let i = AdminChecklist.locate(raw, index: index, text: text) else { return }
        raw.remove(at: i)
        _ = await update(id, fields: ["items": .array(raw)])
    }

    /// POST /checklists/:id/instantiate when the hub answers, else the same copy created here. Returns the copy's id.
    func adminInstantiateChecklist(_ template: Entity, title: String? = nil) async -> String? {
        if let c = client, status == .online, let copy = try? await c.checklistInstantiate(template.id, title: title) {
            await absorb(copy)
            return copy.id
        }
        return await create(kind: .checklist, fields: AdminChecklist.instantiateFields(template, title: title))?.id
    }
}

// MARK: Career

enum AdminStage: String, CaseIterable, Identifiable {
    case saved, applied, screen, interview, offer, rejected, withdrawn, accepted
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    static let active: [AdminStage] = [.saved, .applied, .screen, .interview, .offer]
    static let closed: [AdminStage] = [.accepted, .rejected, .withdrawn]
    var isActive: Bool { Self.active.contains(self) }

    /// The next step forward in the pipeline, for the one-tap advance.
    var next: AdminStage? {
        switch self {
        case .saved: return .applied
        case .applied: return .screen
        case .screen: return .interview
        case .interview: return .offer
        case .offer: return .accepted
        default: return nil
        }
    }

    var color: Color {
        switch self {
        case .saved: return .gray
        case .applied: return .blue
        case .screen: return .teal
        case .interview: return .purple
        case .offer, .accepted: return .green
        case .rejected: return .red
        case .withdrawn: return .secondary
        }
    }

    var symbol: String {
        switch self {
        case .saved: return "bookmark"
        case .applied: return "paperplane"
        case .screen: return "phone"
        case .interview: return "person.2"
        case .offer: return "envelope.open"
        case .accepted: return "checkmark.seal"
        case .rejected: return "xmark.circle"
        case .withdrawn: return "arrow.uturn.backward.circle"
        }
    }

    static func of(_ e: Entity) -> AdminStage { AdminStage(rawValue: e.str("stage")) ?? .saved }
}

enum AdminBoard {
    /// Within a stage: a next_at first (soonest first), then most recently updated.
    static func sorted(_ apps: [Entity]) -> [Entity] {
        apps.sorted { a, b in
            let x = a.str("next_at"), y = b.str("next_at")
            if !x.isEmpty, !y.isEmpty, x != y { return (ISO.date(x) ?? .distantFuture) < (ISO.date(y) ?? .distantFuture) }
            if x.isEmpty != y.isEmpty { return !x.isEmpty }
            return a.updated_at > b.updated_at
        }
    }

    static func column(_ apps: [Entity], _ stage: AdminStage) -> [Entity] {
        sorted(apps.filter { AdminStage.of($0) == stage })
    }

    /// Active applications with a next_at, soonest first.
    static func followUps(_ apps: [Entity]) -> [Entity] {
        apps.filter { AdminStage.of($0).isActive && $0.date("next_at") != nil }
            .sorted { ($0.date("next_at") ?? .distantFuture) < ($1.date("next_at") ?? .distantFuture) }
    }
}

// MARK: Games

enum AdminGames {
    /// The owner's name from the hub's profile (kept by AppModel.refreshProfile; empty until setup names them).
    static let ownerKey = "ea.ownerName"

    /// How the owner shows among the players and a game's owners: their name, or "Me" until the hub has one.
    static func me(_ stored: String? = UserDefaults.standard.string(forKey: ownerKey)) -> String {
        let n = (stored ?? "").trimmingCharacters(in: .whitespaces)
        return n.isEmpty ? "Me" : n
    }

    /// Every name in any owned_by, the owner (`me`) first, then alphabetical.
    static func friends(_ games: [Entity], me: String = AdminGames.me()) -> [String] {
        var set = Set<String>()
        for g in games { for n in g.stringArray("owned_by") { let t = n.trimmingCharacters(in: .whitespaces); if !t.isEmpty { set.insert(t) } } }
        set.remove(me)
        return [me] + set.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    static func players(_ g: Entity) -> String {
        let lo = Int(g.number("min_players") ?? 1), hi = Int(g.number("max_players") ?? 4)
        let range = lo == hi ? "\(lo) player\(lo == 1 ? "" : "s")" : "\(lo) to \(hi) players"
        return (g.bool("coop") ?? true) ? "\(range), co-op" : range
    }
}

// MARK: Shared bits

/// A status label with an icon and text, so the state never rides on color alone.
struct AdminPill: View {
    var text: String
    var symbol: String? = nil
    var color: Color = .secondary

    var body: some View {
        HStack(spacing: 4) {
            if let s = symbol { Image(systemName: s) }
            Text(text)
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 8).padding(.vertical, 3)
        .background(color.opacity(0.15), in: Capsule())
        .foregroundStyle(color)
        .fixedSize()
    }
}

/// A one-line message under an action: errors in red with an icon, success in green, notes in gray.
struct AdminMessage: View {
    enum Tone { case error, ok, note }
    var tone: Tone
    var text: String

    var body: some View {
        Label(text, systemImage: tone == .error ? "exclamationmark.triangle" : (tone == .ok ? "checkmark.circle" : "info.circle"))
            .font(.callout)
            .foregroundStyle(tone == .error ? Color.red : (tone == .ok ? Color.green : Color.secondary))
    }
}

/// "today", "yesterday", "3 days ago", "in 2 days": whole days, numbers not adjectives.
func adminDaysLabel(_ d: Date, now: Date = Date()) -> String {
    let cal = Calendar.current
    let n = cal.dateComponents([.day], from: cal.startOfDay(for: now), to: cal.startOfDay(for: d)).day ?? 0
    switch n {
    case 0: return "today"
    case -1: return "yesterday"
    case 1: return "tomorrow"
    case ..<0: return "\(-n) days ago"
    default: return "in \(n) days"
    }
}
