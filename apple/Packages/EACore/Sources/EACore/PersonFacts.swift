import Foundation

/// A person's facts in the sections of their page, and the key of a like, dislike or gift idea: the same rules as
/// `personFactGroups` and `personFactKey` in packages/shared, so every device shows the same sections.
public enum PersonFacts {
    public enum Section: String, CaseIterable, Sendable {
        case likes, dislikes, giftIdeas = "gift_ideas", healthAndFood = "health_and_food", history, other
    }

    /// One section of a person's page. `add` is the category its Add field makes, on the three that always show.
    public struct Group: Identifiable, Equatable, Sendable {
        public let section: Section
        public let title: String
        public let add: FactCategory?
        public let empty: String?
        public var items: [Entity]
        public var id: String { section.rawValue }
    }

    private struct Def { let section: Section; let title: String; let add: FactCategory?; let empty: String?; let categories: Set<String> }

    private static let defs: [Def] = [
        Def(section: .likes, title: "Likes", add: .like, empty: "No likes yet", categories: ["like", "preference"]),
        Def(section: .dislikes, title: "Dislikes", add: .dislike, empty: "No dislikes yet", categories: ["dislike"]),
        Def(section: .giftIdeas, title: "Gift ideas", add: .giftIdea, empty: "No gift ideas yet", categories: ["gift_idea"]),
        Def(section: .healthAndFood, title: "Health and food", add: nil, empty: nil, categories: ["health", "constraint"]),
        Def(section: .history, title: "History", add: nil, empty: nil, categories: ["history", "relationship"]),
        Def(section: .other, title: "Other", add: nil, empty: nil, categories: []),
    ]

    /// A person's facts (`TodayExtras.factsAbout`'s list) in the sections of their page, every section in order, empty
    /// ones too: Likes (`like`, and `preference` about them), Dislikes, Gift ideas (not given yet first, newest first,
    /// then given ones, the latest given first), Health and food (`health`, `constraint`), History (`history`,
    /// `relationship`), Other (the rest). A fact that only names them in its text goes to Other: a like or a gift idea
    /// there is someone else's. The order within the other sections is the order given.
    public static func groups(_ person: Entity, facts: [Entity]) -> [Group] {
        let linked = TodayExtras.linked(to: person)
        var groups = defs.map { Group(section: $0.section, title: $0.title, add: $0.add, empty: $0.empty, items: []) }
        for f in facts where !f.isDeleted {
            let cat = f.str("category")
            let i = linked(f) ? defs.firstIndex { $0.categories.contains(cat) } : nil
            groups[i ?? defs.count - 1].items.append(f)
        }
        // Stable whatever the sort does: ties keep the order given.
        let gifts = groups[2].items.enumerated().sorted { a, b in
            let ga = a.element.str("given_at"), gb = b.element.str("given_at")
            if ga.isEmpty != gb.isEmpty { return ga.isEmpty }
            if ga != gb { return ga > gb }
            if a.element.created_at != b.element.created_at { return a.element.created_at > b.element.created_at }
            return a.offset < b.offset
        }
        groups[2].items = gifts.map(\.element)
        return groups
    }

    /// The key of a like, dislike or gift idea about someone: `like:`, `dislike:` or `gift:` and the value's first six
    /// words, lower case, joined by `_`. Made from the value, so two ideas never share a key and the same idea said
    /// again is the same fact.
    public static func key(_ category: FactCategory, value: String) -> String {
        let folded = value.folding(options: [.diacriticInsensitive, .widthInsensitive], locale: nil).lowercased()
        var words: [String] = []
        var word = ""
        for c in folded {
            if c.isLetter || c.isNumber { word.append(c) } else if !word.isEmpty { words.append(word); word = "" }
        }
        if !word.isEmpty { words.append(word) }
        let joined = String(words.prefix(6).joined(separator: "_").prefix(60))
        let prefix = category == .giftIdea ? "gift" : category.rawValue
        return "\(prefix):\(joined.isEmpty ? "item" : joined)"
    }
}
