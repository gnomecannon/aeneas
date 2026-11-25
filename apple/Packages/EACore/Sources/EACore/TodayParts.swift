import Foundation

/// A part of Today, by its id in the setting, in the order Today has by default. `now` is the line at the top (what is
/// on now or next, and the free time): it is drawn above the cards whenever it is shown, so its place in the order
/// changes nothing. Tech is drawn only while it has something to show (Machines on and something watched), whatever
/// the setting says. The same parts as `TODAY_PARTS` in packages/shared/src/today.ts.
public enum TodayPart: String, CaseIterable, Codable, Sendable, Identifiable, Hashable {
    case now, tech, needs, schedule, todo, sofar, coming

    public var id: String { rawValue }

    /// The line at the top.
    public static let top = TodayPart.now
    /// The cards in their default order: every part but the line at the top.
    public static let cards: [TodayPart] = allCases.filter { $0 != top }
}

/// What Today shows and in what order: one setting for every device, `today` in the feel setting (CONTRACT.md, Feel).
/// The rules here are the ones in `packages/shared/src/today.ts`, which the hub checks by and the web client draws and
/// edits by; tests on both sides keep the two and the contract the same.
public struct TodaySetting: Codable, Equatable, Sendable {
    /// How many ids each list may hold: room for parts a newer app may add.
    public static let maxIds = 40

    /// The parts in the order chosen. A part left out goes in its default place; an id this build does not know is
    /// skipped.
    public var order: [String]
    /// The parts not drawn.
    public var hidden: [String]

    public init(order: [String], hidden: [String]) {
        self.order = order; self.hidden = hidden
    }

    /// Today as it was before it could be changed: every part shown, in the default order.
    public static let standard = TodaySetting(order: TodayPart.allCases.map(\.rawValue), hidden: [])

    /// Whether it keeps the rules: `order` and `hidden` are each a list of at most 40 part ids, each named once in its
    /// list. An id this build does not know is fine: a newer app may have put it there, and it is only skipped when
    /// Today is drawn.
    public var isValid: Bool {
        [order, hidden].allSatisfy { list in
            list.count <= Self.maxIds && list.allSatisfy(BarScreen.isId) && Set(list).count == list.count
        }
    }

    enum CodingKeys: String, CodingKey { case order, hidden }

    /// A value that breaks a rule does not decode, so what reads it (`try?`) falls back to the default.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        order = try c.decode([String].self, forKey: .order)
        hidden = try c.decode([String].self, forKey: .hidden)
        guard isValid else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Today's setting breaks a rule"))
        }
    }

    /// Every part in the order chosen: the line at the top first, wherever `order` puts it, then the cards `order`
    /// names, in its order, and each card it leaves out in its default place, right after the card before it in the
    /// default order (first, for the first card). Ids this build does not know are skipped.
    public var parts: [TodayPart] { [TodayPart.top] + cardOrder }

    /// Every card in its order, the hidden ones too: the list the editor shows.
    public var cardOrder: [TodayPart] {
        var cards: [TodayPart] = []
        for id in order {
            if let p = TodayPart(rawValue: id), p != TodayPart.top, !cards.contains(p) { cards.append(p) }
        }
        for (i, c) in TodayPart.cards.enumerated() where !cards.contains(c) {
            let at = i == 0 ? 0 : (cards.firstIndex(of: TodayPart.cards[i - 1]) ?? -1) + 1
            cards.insert(c, at: at)
        }
        return cards
    }

    /// The parts drawn, in their order: every part not hidden.
    public var shown: [TodayPart] { parts.filter { !hidden.contains($0.rawValue) } }

    /// Whether the line at the top is drawn.
    public var showsTop: Bool { !hidden.contains(TodayPart.top.rawValue) }

    /// The cards drawn, in their order (Tech still only while it has something to show).
    public var cards: [TodayPart] { shown.filter { $0 != TodayPart.top } }

    /// Whether it draws Today as the default does: every part shown, the cards in their default order.
    public var isStandard: Bool {
        cardOrder == TodayPart.cards && !TodayPart.allCases.contains { hidden.contains($0.rawValue) }
    }

    /// The setting with the cards in a new order. The line at the top is written first; a card left out of `cards`
    /// goes in its default place. Ids this build does not know stay in `order`, each after the part it followed, so a
    /// part a newer app added keeps its place.
    public func withOrder(_ cards: [TodayPart]) -> TodaySetting {
        let parts = TodaySetting(order: ([TodayPart.top] + cards).map(\.rawValue), hidden: []).parts
        var after: [String: [String]] = [:]
        let start = ""
        var last = start
        var room = Self.maxIds - TodayPart.allCases.count
        for id in order {
            if TodayPart(rawValue: id) != nil {
                last = id
            } else if room > 0 {
                after[last, default: []].append(id)
                room -= 1
            }
        }
        var out = after[start] ?? []
        for p in parts { out.append(p.rawValue); out += after[p.rawValue] ?? [] }
        return TodaySetting(order: out, hidden: hidden)
    }

    /// Move a card to a place among the cards (0 is the first). A place past the end is the last.
    public func moving(_ card: TodayPart, to index: Int) -> TodaySetting {
        guard card != TodayPart.top else { return self }
        var cards = cardOrder.filter { $0 != card }
        cards.insert(card, at: max(0, min(index, cards.count)))
        return withOrder(cards)
    }

    /// The cards moved as a list's `onMove` moves its rows.
    public func moving(fromOffsets source: IndexSet, toOffset destination: Int) -> TodaySetting {
        var cards = cardOrder
        let moved = source.sorted().filter(cards.indices.contains).map { cards[$0] }
        let before = source.filter { $0 < destination }.count
        cards.removeAll { moved.contains($0) }
        cards.insert(contentsOf: moved, at: max(0, min(destination - before, cards.count)))
        return withOrder(cards)
    }

    /// Show or hide a part.
    public func showing(_ part: TodayPart, _ shown: Bool) -> TodaySetting {
        var h = hidden.filter { $0 != part.rawValue }
        if !shown, h.count < Self.maxIds { h.append(part.rawValue) }
        return TodaySetting(order: order, hidden: h)
    }
}

/// What Theme, Today says, and Today's own lines about it: the same words as the web's page (`TODAY_TEXT` and
/// `TODAY_PART_TEXT` in web/src/views/settings/TodayParts.tsx; web/src/lib/todayParts.test.ts keeps the two the same).
public enum TodayText {
    public static let intro = "Choose which parts Today shows and in what order. Every device follows."
    public static let top = "At the top"
    public static let topNote = "This line stays at the top of Today. It can only be shown or hidden."
    public static let cards = "Cards"
    public static let drag = "Drag a card by its handle to move it."
    public static let wide = "On a wide window the cards fill the columns in this order. Tech sits at the top of the card after it."
    public static let moveUp = "Move up"
    public static let moveDown = "Move down"
    public static let reset = "Reset"
    public static let resetAsk = "Put Today back to every part shown, in the usual order?"
    public static let edit = "Edit Today"
    public static let none = "No cards are shown."
    public static let usual = "Usual order"
    public static let yours = "Your order"
    public static let allShown = "all shown"

    /// A part's name.
    public static func name(_ p: TodayPart) -> String {
        switch p {
        case .now: return "Now and free time"
        case .tech: return "Tech"
        case .needs: return "Needs you"
        case .schedule: return "Schedule"
        case .todo: return "To do"
        case .sofar: return "Today so far"
        case .coming: return "Coming up"
        }
    }

    /// The line under a part's name, saying what it holds.
    public static func holds(_ p: TodayPart) -> String {
        switch p {
        case .now: return "What is on now or next, and your free time."
        case .tech: return "One line with the light for your machines, checks and readings. It shows only while something is watched."
        case .needs: return "Reminders that have come due, renewals, follow-ups, medicine not logged, and captures that could not be filed."
        case .schedule: return "Today's plans in time order, free time to schedule, and the people in them."
        case .todo: return "The task you are doing or the next one, then your other open tasks."
        case .sofar: return "Today's numbers, the diary's lines, finished tasks and logs."
        case .coming: return "Tomorrow's plans, and birthdays and other dates in the next two weeks."
        }
    }

    /// The line under Today in Theme: "Usual order, all shown", "Your order, 2 hidden".
    public static func summary(_ s: TodaySetting) -> String {
        let n = TodayPart.allCases.filter { s.hidden.contains($0.rawValue) }.count
        return (s.cardOrder == TodayPart.cards ? usual : yours) + ", " + (n > 0 ? "\(n) hidden" : allShown)
    }
}
