import Foundation

/// The bottom bar of the phone layout (the iPhone, and the web, Windows and Android apps in a narrow window): which
/// screens it holds, in two rows, and how many across. One setting for every device: `bar` in the feel setting
/// (CONTRACT.md, Feel). The rules here are the ones in `packages/shared/src/bar.ts`, which the hub checks by and the
/// web client draws and edits by; tests on both sides keep the two and the contract the same.
public enum BarScreen {
    /// Every screen a place can hold, by id: the app's `Section` names where it has the screen. `layouts` and `status`
    /// are screens of the web, Windows and Android apps only, so this app skips them when it draws the bar.
    public static let all: [String] = [
        "today", "assistant", "capture", "library", "search",
        "inbox", "tasks", "week", "renewals", "dashboard",
        "notes", "memory", "people", "reference",
        "ops", "sensors",
        "projects", "procedures", "music", "wiki", "images", "quiz", "layouts",
        "health", "logs", "pet", "food",
        "mail", "lists", "games", "films", "listening", "calc",
        "status",
    ]

    /// The one screen that always has a place: every other screen, and Settings, is reached from it.
    public static let library = "library"

    /// The main screens: the ones the Library does not list. One left out of the bar is listed at the top of the Library.
    public static let main: [String] = ["today", "assistant", "capture", "search"]

    /// A screen id as the setting takes it: a letter, then letters, digits, `_` or `-`, 40 at most. It need not be one
    /// this build knows.
    public static func isId(_ s: String) -> Bool {
        guard let first = s.unicodeScalars.first, s.unicodeScalars.count <= 40 else { return false }
        func letter(_ u: Unicode.Scalar) -> Bool { ("a"..."z").contains(u) || ("A"..."Z").contains(u) }
        return letter(first) && s.unicodeScalars.allSatisfy { letter($0) || ("0"..."9").contains($0) || $0 == "_" || $0 == "-" }
    }
}

public enum BarRow: String, CaseIterable, Sendable, Hashable {
    /// The row that always shows.
    case first
    /// The row a drag up on the bar reveals.
    case second
}

/// One place of the bar: a row and how far along it, from 0.
public struct BarPlace: Equatable, Hashable, Sendable, Identifiable {
    public var row: BarRow
    public var index: Int
    public var id: String { "\(row.rawValue)-\(index)" }
    public init(_ row: BarRow, _ index: Int) { self.row = row; self.index = index }
}

/// The setting: `{ count, first, second }`.
public struct BarSetting: Codable, Equatable, Sendable {
    /// How many screens a row holds. Fewer means larger icons with more room.
    public static let counts = [3, 4, 5]

    public var count: Int
    /// The row that always shows: at most `count` screen ids.
    public var first: [String]
    /// The row a drag up on the bar reveals: at most `count` screen ids. Empty: nothing to reveal.
    public var second: [String]

    public init(count: Int, first: [String], second: [String]) {
        self.count = count; self.first = first; self.second = second
    }

    /// The bar as it was before it could be changed, with the screens most people open next in the second row.
    public static let standard = BarSetting(count: 5, first: ["today", "assistant", "capture", "library", "search"],
                                            second: ["tasks", "week", "notes", "memory", "people"])

    /// Whether it keeps the rules: `count` is 3, 4 or 5; each row holds at most `count` screen ids; an id has one place
    /// across both rows. An id this build does not know is fine: a newer app may have put it there, and it is only
    /// skipped when the bar is drawn.
    public var isValid: Bool {
        guard Self.counts.contains(count), first.count <= count, second.count <= count else { return false }
        let all = first + second
        return all.allSatisfy(BarScreen.isId) && Set(all).count == all.count
    }

    enum CodingKeys: String, CodingKey { case count, first, second }

    /// A value that breaks a rule does not decode, so what reads it (`try?`) falls back to the default.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        count = try c.decode(Int.self, forKey: .count)
        first = try c.decode([String].self, forKey: .first)
        second = try c.decode([String].self, forKey: .second)
        guard isValid else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "the bottom bar breaks a rule"))
        }
    }

    public subscript(row: BarRow) -> [String] {
        get { row == .first ? first : second }
        set { if row == .first { first = newValue } else { second = newValue } }
    }

    /// A row with Library in its last place: the next free one, else in place of the screen in place `count`.
    static func libraryLast(_ row: [String], count: Int) -> [String] {
        row.count < count ? row + [BarScreen.library] : Array(row.prefix(max(0, count - 1))) + [BarScreen.library]
    }

    /// The setting with Library in it: unchanged when a row has it, else Library takes the last place of the first row.
    public var withLibrary: BarSetting {
        if first.contains(BarScreen.library) || second.contains(BarScreen.library) { return self }
        return BarSetting(count: count, first: Self.libraryLast(first, count: count), second: second)
    }

    /// What a device draws. A screen it cannot show now (`has` says which it can: one it has no screen for, or one
    /// whose module is off) is skipped, never taken out of the setting. When nothing of the first row is left, the
    /// second row is drawn in its place. When neither row has Library, it is drawn in the last place of the first row.
    public func layout(has: (String) -> Bool) -> BarLayout {
        let keep: (String) -> Bool = { $0 == BarScreen.library || has($0) }
        var a = first.prefix(count).filter(keep), b = second.prefix(count).filter(keep)
        if a.isEmpty { (a, b) = (b, []) }
        if !a.contains(BarScreen.library), !b.contains(BarScreen.library) { a = Self.libraryLast(a, count: count) }
        return BarLayout(count: count, first: a, second: b)
    }

    /// Another count. Each row is cut to it: the screens past it leave the bar. Library cut off that way takes the last
    /// place of its own row instead, so it keeps a place.
    public func withCount(_ n: Int) -> BarSetting {
        guard Self.counts.contains(n) else { return self }
        func cut(_ row: [String]) -> [String] {
            var kept = Array(row.prefix(n))
            if row.contains(BarScreen.library), !kept.contains(BarScreen.library) { kept[n - 1] = BarScreen.library }
            return kept
        }
        return BarSetting(count: n, first: cut(first), second: cut(second)).withLibrary
    }

    /// The count chosen in the editor. `before` is the bar as it was before this run of count changes, so going back to
    /// a larger count while the page is open brings back what the smaller one cut.
    public func countChange(_ n: Int, before: BarSetting?) -> BarSetting {
        let from = before ?? self
        return from.count == n ? from : from.withCount(n)
    }

    /// Where an id has its place.
    public func position(of id: String) -> BarPlace? {
        for row in BarRow.allCases {
            if let i = self[row].firstIndex(of: id) { return BarPlace(row, i) }
        }
        return nil
    }

    /// The id in a place of the bar as the editor shows it (with Library), or nil for a free place.
    public func screen(at place: BarPlace) -> String? {
        let row = withLibrary[place.row]
        return row.indices.contains(place.index) ? row[place.index] : nil
    }

    /// Whether `id` may be chosen for a place (0 to `count` - 1). Library's place takes only a screen that has a
    /// place, which swaps with it, so Library always keeps one. A screen moved out of the first row into a free place
    /// of the second must leave the first row a screen.
    public func canPick(_ id: String, for place: BarPlace) -> Bool {
        let b = withLibrary
        guard BarScreen.isId(id), place.index >= 0, place.index < b.count else { return false }
        let there = b.screen(at: place)
        if there == id { return true }
        let from = b.position(of: id)
        if there == BarScreen.library, from == nil { return false }
        if there == nil, from?.row == .first, place.row == .second, b.first.count == 1 { return false }
        return true
    }

    /// Choose a screen for a place. One that already has a place swaps with what was there; into a free place it
    /// moves, and the row it left closes up. One with no place takes the place, and what was there leaves the bar. A
    /// free place is the next one after the row's last. A choice that is not allowed (`canPick`) changes nothing.
    public func picking(_ id: String, for place: BarPlace) -> BarSetting {
        var b = withLibrary
        guard b.canPick(id, for: place) else { return b }
        let there = b.screen(at: place)
        if there == id { return b }
        let from = b.position(of: id)
        if let from, let there {
            b[from.row][from.index] = there
            b[place.row][place.index] = id
        } else if let from {
            b[from.row].remove(at: from.index)
            b[place.row].append(id)
        } else if there != nil {
            b[place.row][place.index] = id
        } else {
            b[place.row].append(id)
        }
        return b
    }

    /// Whether a place can be emptied: one of the second row that holds a screen other than Library.
    public func canEmpty(_ place: BarPlace) -> Bool {
        guard place.row == .second, let there = screen(at: place) else { return false }
        return there != BarScreen.library
    }

    /// Empty a place of the second row: the screens after it move up.
    public func emptying(_ index: Int) -> BarSetting {
        var b = withLibrary
        guard b.canEmpty(BarPlace(.second, index)) else { return b }
        b.second.remove(at: index)
        return b
    }
}

/// The bar as one device draws it now (`BarSetting.layout`).
public struct BarLayout: Equatable, Sendable {
    public var count: Int
    public var first: [String]
    public var second: [String]

    public init(count: Int, first: [String], second: [String]) {
        self.count = count; self.first = first; self.second = second
    }

    /// Every screen it draws, the first row then the second: each is a tab with a navigation stack of its own.
    public var tabs: [String] { first + second }

    public func has(_ id: String) -> Bool { first.contains(id) || second.contains(id) }

    /// The tab a screen shows on: its own when it has a place; else its home's when it has one that has a place
    /// (Week opens over Today, Memory over the Assistant); else Library's, where every other screen opens.
    public func tab(for id: String, home: String? = nil) -> String {
        if has(id) { return id }
        if let home, has(home) { return home }
        return BarScreen.library
    }
}

/// The iPhone keeps at most five of the bar's screens alive at once, each with its own navigation stack: the system
/// puts the tabs of a tab view past the fifth under a "More" list of its own, which a bar drawn by the app has no use
/// for. Five fixed slots hold the screens used most recently; a sixth takes the slot of the one used longest ago,
/// which starts again from its first screen when it is next opened.
public struct BarSlots: Equatable, Sendable {
    public static let limit = 5

    /// The screen in each slot, nil for a slot not used yet.
    public private(set) var ids: [String?]
    /// When each slot was last shown, as a count that only grows.
    private var used: [Int]
    private var clock = 0

    public init() {
        ids = Array(repeating: nil, count: Self.limit)
        used = Array(repeating: 0, count: Self.limit)
    }

    public func index(of id: String) -> Int? { ids.firstIndex(of: id) }

    /// The slots with `id` showing: in the slot it has, else in a free one, else in place of the screen shown longest
    /// ago. Slots whose screen is no longer among the bar's `tabs` are freed first. The same slots come out however
    /// often this is asked for the same screen, so a view may ask while it draws and keep the answer afterwards.
    public func showing(_ id: String, among tabs: [String]) -> BarSlots {
        var s = self
        for i in s.ids.indices {
            if let held = s.ids[i], held != id, !tabs.contains(held) { s.ids[i] = nil; s.used[i] = 0 }
        }
        let slot = s.index(of: id) ?? s.ids.firstIndex(of: nil) ?? s.used.indices.min { s.used[$0] < s.used[$1] } ?? 0
        s.ids[slot] = id
        s.clock += 1
        s.used[slot] = s.clock
        return s
    }
}

/// The three sizes of the bar's icons and names, in points: the fewer screens across, the larger each is and the more
/// room it has. Five across is the size the system's own tab bar has (on iOS 26, symbols of about 23.5 points over
/// names of 10, in a row 49 points tall).
public struct BarSize: Equatable, Sendable {
    /// The symbol's point size.
    public var icon: Double
    /// The height kept for the symbol, so names line up whatever the symbols' own heights.
    public var box: Double
    /// The name's point size.
    public var label: Double
    /// Between the symbol and the name.
    public var gap: Double
    /// Above the symbol and under the name.
    public var pad: Double

    /// The height of a row at the standard text size.
    public var rowHeight: Double { pad + box + gap + (label * 1.2).rounded(.up) + pad }

    public static func of(count: Int) -> BarSize {
        switch count {
        case ...3: return BarSize(icon: 29, box: 35, label: 12, gap: 3, pad: 6)
        case 4: return BarSize(icon: 26, box: 32, label: 11, gap: 2, pad: 5)
        default: return BarSize(icon: 23.5, box: 28, label: 10, gap: 1, pad: 4)
        }
    }
}

/// What Theme, Bottom bar says, the same words as the web's page (`BAR_TEXT` in web/src/views/settings/BottomBar.tsx;
/// web/src/lib/bar.test.ts keeps the two the same).
public enum BarText {
    public static let intro = "The bar along the bottom of the screen on a phone. Choose how many screens it shows across and which ones. Drag up on the bar to reach the second row."
    public static let whereShown = "iPad, Mac and wide windows keep the sidebar, which this does not change."
    public static let across = "Screens across"
    public static let acrossNote = "Fewer across means larger icons and names with more room. Going down to fewer leaves out the last screens of each row."
    public static let preview = "Preview"
    public static let first = "First row"
    public static let second = "Second row"
    public static let tap = "Choose a place, then the screen for it."
    public static let secondNote = "With nothing in the second row, the bar has no grabber and nothing to drag up."
    public static let swap = "Choosing a screen that already has a place swaps the two."
    public static let library = "Library always has a place, since every other screen and Settings are reached from it. Here it can only swap with a screen that has a place."
    public static let main = "Main"
    public static let empty = "Empty this place"
    public static let free = "Empty"
    public static let off = "off"
    public static let here = "Here"
    public static let cancel = "Cancel"
    public static let reset = "Reset"
    public static let resetAsk = "Put the bottom bar back to Today, Assistant, Capture, Library and Search, with Tasks, Week, Notes, Memory and People in the second row?"
    /// The grabber on the bar's top edge, as VoiceOver names it.
    public static let more = "More screens"
    /// On the iPhone: VoiceOver's action on the bar, and what the grabber says of the second row.
    public static let showMore = "Show more screens"
    public static let hideMore = "Hide more screens"
    public static let opened = "Open"
    public static let closed = "Closed"

    public static func name(_ row: BarRow) -> String { row == .first ? first : second }

    /// "First row, place 2".
    public static func place(_ p: BarPlace) -> String { "\(name(p.row)), place \(p.index + 1)" }

    /// The line under Bottom bar in Theme.
    public static func summary(_ bar: BarSetting) -> String {
        let more = bar.withLibrary.second.count
        return "\(bar.count) across, " + (more > 0 ? "\(more) in the second row" : "no second row")
    }
}
