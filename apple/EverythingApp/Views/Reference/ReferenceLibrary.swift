import SwiftUI
import EACore

/// A page to open in the reader: a book and a path in it, with its title when it is known.
struct ReferencePageLink: Hashable, Identifiable {
    var book: String
    var path: String
    var title = ""
    var id: String { ReferenceLink.key(book: book, path: path) }
}

/// What the hub has (sources, books, downloads), shared by the Reference screen, the reader and Settings, Reference.
/// Kept in memory only: everything here comes from the hub again when the screen opens.
@MainActor
final class ReferenceLibrary: ObservableObject {
    static let shared = ReferenceLibrary()

    @Published private(set) var catalog: ReferenceSources?
    @Published private(set) var status: ReferenceStatus?
    @Published private(set) var problem: String?
    @Published private(set) var loading = false
    /// Debug builds: a page to open on the Reference screen (`-EAReferenceOpen <book>/<path>`).
    @Published var openRequest: ReferencePageLink?
    /// Debug builds: words to search for on the Reference screen (`-EAReferenceQuery <words>`).
    @Published var queryRequest: String?
    private var catalogAt: Date?
    private var hub = ""

    /// Status every time; the sources list at most every 10 minutes, or when asked.
    func refresh(_ client: HubClient?, catalog force: Bool = false) async {
        guard let client else { problem = "Connect your hub in Settings to use Reference."; return }
        forgetOtherHub()
        loading = true
        defer { loading = false }
        await refreshStatus(client)
        let stale = catalogAt.map { Date().timeIntervalSince($0) > 600 } ?? true
        if force || catalog == nil || stale {
            if let c = try? await client.referenceSources() { catalog = c; catalogAt = Date() }
        }
    }

    func refreshStatus(_ client: HubClient?) async {
        guard let client else { return }
        do {
            status = try await client.referenceStatus()
            problem = nil
        } catch {
            if !Task.isCancelled { problem = Self.message(error) }
        }
    }

    /// The status a change on the hub answered with (Settings).
    func take(_ s: ReferenceStatus) { status = s }

    /// Another hub's books are not this one's.
    private func forgetOtherHub() {
        let now = SharedConfig.shared.hubURL
        guard now != hub else { return }
        hub = now
        catalog = nil
        catalogAt = nil
        status = nil
    }

    // MARK: lookups

    var readableBooks: [ReferenceBook] { status?.readableBooks ?? [] }

    func book(_ name: String) -> ReferenceBook? { status?.books.first { $0.name == name } }

    /// A source's title: from its books on the hub (`/reference/status`), else the sources list, else its id.
    func sourceTitle(_ id: String) -> String {
        if let t = status?.books.first(where: { $0.source == id })?.title, !t.isEmpty { return t }
        if let t = catalog?.source(id)?.title, !t.isEmpty { return t }
        return id.isEmpty ? "Reference" : id.prefix(1).uppercased() + id.dropFirst()
    }

    /// A language's English name from its ISO 639-3 code.
    func languageName(_ code: String) -> String {
        if let l = catalog?.language(code), !l.name.isEmpty, l.name != code { return l.name }
        return Locale(identifier: "en").localizedString(forLanguageCode: code) ?? code
    }

    /// The archive date of a book on the hub, short (`Oct 2025`).
    func archiveDate(book: String) -> String? {
        guard let d = self.book(book)?.date, !d.isEmpty else { return nil }
        return ReferenceText.shortArchiveDate(d)
    }

    /// Ready books by source, in the order the hub lists its books.
    var readySources: [ReadySource] {
        var order: [String] = []
        var by: [String: [ReferenceBook]] = [:]
        for b in readableBooks {
            if by[b.source] == nil { order.append(b.source) }
            by[b.source, default: []].append(b)
        }
        return order.map { ReadySource(id: $0, title: sourceTitle($0), books: by[$0] ?? []) }
    }

    /// Languages of the ready books, by name.
    var readyLanguages: [String] {
        Array(Set(readableBooks.map(\.lang).filter { !$0.isEmpty })).sorted { languageName($0).localizedStandardCompare(languageName($1)) == .orderedAscending }
    }

    struct ReadySource: Identifiable, Equatable {
        var id: String
        var title: String
        var books: [ReferenceBook]
        var articles: Int { books.reduce(0) { $0 + $1.articles } }
    }

    /// A hub error in words. A hub without these routes is older than Reference.
    static func message(_ e: Error) -> String {
        if let h = e as? HubError, case .http(let status, _) = h, status == 404 {
            return "This hub does not have Reference yet. Update it in Settings, About."
        }
        return (e as? HubError)?.errorDescription ?? e.localizedDescription
    }
}

/// Pages read on this device and where each was left, in this device's own settings: never on the hub, never synced.
/// The list belongs to one hub; pairing with another starts it again.
@MainActor
final class ReferenceHistory: ObservableObject {
    static let shared = ReferenceHistory()

    @Published private(set) var recents: [ReferenceRecent] = []
    @Published private(set) var positions: [String: ReferencePosition] = [:]
    private let defaults = UserDefaults.standard
    static let recentsKey = "reference.recents"
    static let positionsKey = "reference.positions"
    static let hubKey = "reference.hub"

    private init() {
        if let d = defaults.data(forKey: Self.recentsKey), let r = try? JSONCoding.decode([ReferenceRecent].self, from: d) { recents = r }
        if let d = defaults.data(forKey: Self.positionsKey), let p = try? JSONCoding.decode([String: ReferencePosition].self, from: d) { positions = p }
        checkHub()
    }

    /// Another hub's pages are dropped.
    func checkHub() {
        let hub = SharedConfig.shared.hubId ?? SharedConfig.shared.hubURL
        let saved = defaults.string(forKey: Self.hubKey)
        if let saved, saved != hub { clear() }
        if saved != hub { defaults.set(hub, forKey: Self.hubKey) }
    }

    func opened(_ a: ReferenceArticle) {
        recents = ReferenceRecents.adding(ReferenceRecent(book: a.book, path: a.path, title: a.title, source: a.source, lang: a.lang, at: ISO.now()), to: recents)
        save()
    }

    #if DEBUG
    /// Debug screenshots (`-EAReferenceRows YES`): pages to list under Continue reading, kept in memory only.
    func debugShow(_ list: [ReferenceRecent]) { recents = list }
    #endif

    func remove(_ r: ReferenceRecent) {
        recents.removeAll { $0.id == r.id }
        positions.removeValue(forKey: r.id)
        save()
    }

    func clear() {
        recents = []
        positions = [:]
        defaults.removeObject(forKey: Self.recentsKey)
        defaults.removeObject(forKey: Self.positionsKey)
    }

    func position(_ link: ReferencePageLink) -> ReferencePosition? { positions[link.id] }

    func setPosition(_ p: ReferencePosition, for link: ReferencePageLink) {
        positions = ReferencePositions.setting(p, for: link.id, in: positions)
        if let d = try? JSONCoding.data(positions) { defaults.set(d, forKey: Self.positionsKey) }
    }

    /// How far a page was read, 0 to 1, when it was scrolled at all.
    func progress(_ r: ReferenceRecent) -> Double? {
        guard let f = positions[r.id]?.fraction, f > 0.01 else { return nil }
        return f
    }

    private func save() {
        if let d = try? JSONCoding.data(recents) { defaults.set(d, forKey: Self.recentsKey) }
        if let d = try? JSONCoding.data(positions) { defaults.set(d, forKey: Self.positionsKey) }
    }
}

/// Pictures of pages, kept in memory while the app runs (64 MB at most), each fetched once even when asked for twice.
actor ReferenceMediaCache {
    static let shared = ReferenceMediaCache()
    private let memory = NSCache<NSString, NSData>()
    private var inFlight: [String: Task<Data?, Never>] = [:]

    init() { memory.totalCostLimit = 64 << 20 }

    func data(book: String, path: String, client: HubClient) async -> Data? {
        let key = ReferenceLink.key(book: book, path: path)
        if let d = memory.object(forKey: key as NSString) { return d as Data }
        if let t = inFlight[key] { return await t.value }
        let t = Task<Data?, Never> { try? await client.referenceMedia(book: book, path: path) }
        inFlight[key] = t
        let d = await t.value
        inFlight[key] = nil
        if let d, ReferenceMedia.mimeType(d) != nil { memory.setObject(d as NSData, forKey: key as NSString, cost: d.count) }
        return d
    }
}

/// The reader's text size on this device: a step over the system's own size (Dynamic Type on iPhone and iPad).
enum ReferenceTextSize {
    static let key = "reference.textScale"
    static let steps: [Double] = [0.8, 0.9, 1.0, 1.1, 1.25, 1.4, 1.6, 1.8, 2.0]

    static func larger(_ s: Double) -> Double { steps.first { $0 > s + 0.001 } ?? steps.last! }
    static func smaller(_ s: Double) -> Double { steps.last { $0 < s - 0.001 } ?? steps.first! }
    static func label(_ s: Double) -> String { "\(Int((s * 100).rounded()))%" }

    /// The body size in points the page starts from: the system's reading size for the person's text size setting.
    static func base(_ size: DynamicTypeSize) -> Double {
        #if os(macOS)
        return 16
        #else
        switch size {
        case .xSmall: return 14
        case .small: return 15
        case .medium: return 16
        case .large: return 17
        case .xLarge: return 19
        case .xxLarge: return 21
        case .xxxLarge: return 23
        case .accessibility1: return 28
        case .accessibility2: return 33
        case .accessibility3: return 40
        case .accessibility4: return 47
        case .accessibility5: return 53
        @unknown default: return 17
        }
        #endif
    }
}

/// A small colored label naming a source, the same color for a source everywhere.
struct ReferenceSourceBadge: View {
    var title: String
    var id: String

    private static let palette: [Color] = [.blue, .teal, .green, .orange, .pink, .purple, .indigo, .brown, .mint, .cyan, .red]

    static func color(_ id: String) -> Color {
        let sum = id.unicodeScalars.reduce(0) { $0 &+ Int($1.value) }
        return palette[abs(sum) % palette.count]
    }

    var body: some View {
        let c = Self.color(id)
        Text(title)
            .font(.caption2.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(c.opacity(0.16), in: Capsule())
            .foregroundStyle(c)
            .accessibilityLabel("Source: \(title)")
    }
}

/// Said in sample mode, on the Reference screen and in Settings, Reference.
enum ReferenceSample {
    static let text = "Reference works with your own hub. It keeps Wikipedia and other open references on your hub, so you can search and read them with no internet. In sample mode there is nothing to search."
}
