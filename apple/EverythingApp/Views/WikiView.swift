import SwiftUI
import ImageIO
import EACore

/// The game design wiki: each project's Confluence handbook and repo docs, mirrored by the hub and read here. Pages
/// open in a reader that follows links between them; search asks the hub. The last index seen is kept for when the
/// hub is out of reach.
struct WikiView: View {
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var model: AppModel
    @State private var index: WikiIndex? = WikiCache.load()
    @State private var problem: String?
    @State private var query = ""
    @State private var hits: [WikiSearchHit] = []
    @State private var searched = ""
    @State private var opened: WikiOpen?

    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        List {
            if let problem { Text(problem).font(.callout).foregroundStyle(.red) }
            if searching {
                results
            } else if let index {
                ForEach(index.projects) { project in
                    SwiftUI.Section(project.name) {
                        ForEach(project.sources) { sp in
                            WikiSourceRow(source: sp.source)
                            ForEach(sp.pages) { p in
                                Button { opened = WikiOpen(id: p.id, title: p.title) } label: { WikiPageRow(page: p) }
                                    .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
        }
        .overlay {
            if !searching, let index, index.sources.isEmpty {
                EmptyState(text: "No wiki yet. Repo docs arrive from the project feed; Confluence links in Settings, Connections.")
            } else if index == nil, problem == nil, !searching {
                ProgressView()
            }
        }
        .searchable(text: $query, prompt: "Search the wiki")
        .navigationTitle("Wiki")
        .navigationDestination(item: $opened) { WikiPageView(id: $0.id, title: $0.title) }
        .task(id: query) { await search() }
        .task { await load() }
        .refreshable { await load() }
        .onAppear { takeLink() }
        .onChange(of: model.wikiPageId) { _, _ in takeLink() }
    }

    @ViewBuilder private var results: some View {
        SwiftUI.Section {
            ForEach(hits) { h in
                Button { opened = WikiOpen(id: h.id, title: h.title) } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(h.title).font(.body.weight(.medium))
                        Text([h.project, h.source == "confluence" ? "Confluence" : "Repo docs"].filter { !$0.isEmpty }.joined(separator: ", "))
                            .font(.caption).foregroundStyle(.secondary)
                        if !h.snippet.isEmpty { Text(h.snippet).font(.callout).foregroundStyle(.secondary).lineLimit(3) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        } header: {
            if searched == query.trimmingCharacters(in: .whitespaces) {
                Text(hits.isEmpty ? "No pages match" : hits.count == 1 ? "1 page" : "\(hits.count) pages")
            } else {
                Text("Searching")
            }
        }
    }

    /// A page asked for by an everythingapp://wiki link from outside the app opens straight away.
    private func takeLink() {
        guard let id = model.wikiPageId else { return }
        model.wikiPageId = nil
        opened = WikiOpen(id: id, title: index?.pages.first { $0.id == id }?.title ?? "")
    }

    private func load() async {
        guard let c = engine.client else {
            problem = "The wiki is kept by the hub. Connect one in Settings."
            return
        }
        do {
            let i = try await c.wikiIndex()
            index = i
            problem = nil
            WikiCache.save(i)
        } catch HubError.http(let status, _) where status == 404 {
            problem = "The wiki is not available on this hub yet."
        } catch {
            problem = index == nil ? error.localizedDescription : "Showing the last copy. \(error.localizedDescription)"
        }
    }

    private func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty, let c = engine.client else { hits = []; searched = ""; return }
        // Wait for a pause in typing; a newer query cancels this one.
        try? await Task.sleep(for: .milliseconds(300))
        guard !Task.isCancelled else { return }
        do {
            let r = try await c.wikiSearch(q)
            guard !Task.isCancelled else { return }
            hits = r
            searched = q
        } catch {
            if !Task.isCancelled { hits = []; searched = q; problem = error.localizedDescription }
        }
    }
}

struct WikiOpen: Identifiable, Hashable { var id: String; var title = "" }

private struct WikiSourceRow: View {
    var source: WikiSource

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label(source.name, systemImage: source.isConfluence ? "book.closed" : "folder")
                .font(.subheadline.weight(.semibold))
            Text(detail).font(.caption).foregroundStyle(.secondary)
            if let e = source.last_error, !e.isEmpty { Text(e).font(.caption).foregroundStyle(.red) }
        }
        .padding(.vertical, 2)
    }

    private var detail: String {
        let kind = source.isConfluence ? "Confluence" : "Repo docs"
        let pages = source.pages == 1 ? "1 page" : "\(source.pages) pages"
        let when = dateLabel(source.synced_at)
        let synced = when.isEmpty ? "not synced yet" : "synced \(when)"
        return "\(kind), \(pages), \(synced)"
    }
}

private struct WikiPageRow: View {
    var page: WikiPageSummary

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "doc.text").foregroundStyle(.secondary).font(.caption)
            Text(page.title).lineLimit(2)
            Spacer(minLength: 0)
        }
        .padding(.leading, CGFloat(min(page.depth, 6)) * 16)
        .contentShape(Rectangle())
        .accessibilityLabel(page.title)
    }
}

enum WikiCache {
    private static let key = "wiki.index"
    static func load() -> WikiIndex? {
        guard let d = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONCoding.decode(WikiIndex.self, from: d)
    }
    static func save(_ i: WikiIndex) {
        if let d = try? JSONCoding.data(i) { UserDefaults.standard.set(d, forKey: key) }
        UserDefaults.standard.set(i.pages.count, forKey: "wiki.pageCount")
    }
    static var pageCount: Int { UserDefaults.standard.integer(forKey: "wiki.pageCount") }
    /// A linked page's title from the last index, so the bar is titled before the page arrives.
    static func title(of id: String) -> String? { load()?.pages.first { $0.id == id }?.title }
}

// MARK: reader

/// One page: crumbs, title, when it changed, a link to Confluence, then its markdown as blocks laid out lazily.
/// Links to other wiki pages open here; pictures the hub saved load with the token.
struct WikiPageView: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.openURL) private var systemOpen
    var id: String
    /// Known from the list, so the bar has a title before the page arrives.
    var title = ""
    @State private var page: WikiPage?
    @State private var blocks: [WikiBlock] = []
    @State private var problem: String?
    @State private var next: WikiOpen?
    @State private var media: WikiOpen?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                if let page {
                    header(page)
                    ForEach(blocks.indices, id: \.self) { i in WikiBlockView(block: blocks[i]) }
                } else if let problem {
                    Text(problem).foregroundStyle(.red)
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
            .padding()
            .frame(maxWidth: 900, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .environment(\.openURL, OpenURLAction { open($0) })
        .navigationTitle(page?.title ?? (title.isEmpty ? "Page" : title))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .navigationDestination(item: $next) { WikiPageView(id: $0.id, title: $0.title) }
        .sheet(item: $media) { m in WikiMediaSheet(src: m.id) }
        .task(id: id) { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder private func header(_ p: WikiPage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            let trail = [p.project] + p.crumbs
            if !trail.filter({ !$0.isEmpty }).isEmpty {
                Text(trail.filter { !$0.isEmpty }.joined(separator: " / ")).font(.caption).foregroundStyle(.secondary)
            }
            Text(p.title).font(.largeTitle.bold()).textSelection(.enabled)
            Text([p.source_name, p.updated_at.flatMap { ISO.date($0) }.map { "updated \($0.shortDateTime)" }].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
                .font(.caption).foregroundStyle(.secondary)
            if let s = p.url, let u = URL(string: s) {
                Button { systemOpen(u) } label: { Label("Open in Confluence", systemImage: "arrow.up.right.square") }
                    .font(.callout)
                    .buttonStyle(.borderless)
            }
            Divider().padding(.top, 4)
        }
    }

    /// Wiki links stay in the wiki, saved files open in a sheet, anchors and bare paths do nothing, the rest leave.
    private func open(_ url: URL) -> OpenURLAction.Result {
        if let id = WikiLink.pageId(url) { next = WikiOpen(id: id, title: WikiCache.title(of: id) ?? ""); return .handled }
        if url.scheme == nil {
            if WikiLink.isMedia(url.relativeString) { media = WikiOpen(id: url.relativeString) }
            return .handled
        }
        return .systemAction
    }

    private func load() async {
        guard let c = engine.client else { problem = "Connect a hub in Settings to read the wiki."; return }
        do {
            let p = try await c.wikiPage(id: id)
            // A long page is parsed away from the main thread; only the blocks on screen are laid out.
            var parsed = await Task.detached(priority: .userInitiated) { WikiMarkdown.parse(p.markdown) }.value
            // A doc's own top heading repeats the title the header already shows.
            if case .heading(1, let t)? = parsed.first, t.trimmingCharacters(in: .whitespaces) == p.title { parsed.removeFirst() }
            page = p
            blocks = parsed
            problem = nil
        } catch HubError.http(let status, _) where status == 404 {
            problem = "This page is no longer in the wiki."
        } catch {
            if page == nil { problem = error.localizedDescription }
        }
    }
}

/// One block of a page. Lists and quotes hold blocks of their own.
struct WikiBlockView: View {
    var block: WikiBlock
    var depth = 0

    var body: some View {
        switch block {
        case .heading(let level, let text):
            Text(Self.inline(text))
                .font(Self.headingFont(level))
                .padding(.top, level <= 2 ? 10 : 4)
                .textSelection(.enabled)
                .accessibilityAddTraits(.isHeader)
        case .paragraph(let text):
            Text(Self.inline(text)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        case .list(let list):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(list.items.indices, id: \.self) { i in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        marker(list, i)
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(list.items[i].blocks.indices, id: \.self) { j in
                                WikiBlockView(block: list.items[i].blocks[j], depth: depth + 1)
                            }
                        }
                    }
                }
            }
        case .quote(let inner):
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5).fill(.tint.opacity(0.6)).frame(width: 3)
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(inner.indices, id: \.self) { i in WikiBlockView(block: inner[i], depth: depth) }
                }
                .foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
        case .code(let language, let text):
            VStack(alignment: .leading, spacing: 0) {
                if !language.isEmpty {
                    Text(language).font(.caption2).foregroundStyle(.secondary).padding([.horizontal, .top], 10)
                }
                ScrollView(.horizontal) {
                    Text(text).font(.callout.monospaced()).textSelection(.enabled).fixedSize().padding(10)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        case .table(let table):
            WikiTableView(table: table)
        case .image(let alt, let src):
            WikiImage(alt: alt, src: src)
        case .rule:
            Divider().padding(.vertical, 4)
        }
    }

    @ViewBuilder private func marker(_ list: WikiList, _ i: Int) -> some View {
        if let done = list.items[i].checked {
            Image(systemName: done ? "checkmark.square.fill" : "square")
                .foregroundStyle(done ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                .accessibilityLabel(done ? "Done" : "Not done")
        } else if list.ordered {
            Text("\(list.start + i).").monospacedDigit().foregroundStyle(.secondary)
        } else {
            Text(depth % 2 == 0 ? "\u{2022}" : "\u{25E6}").foregroundStyle(.secondary)
        }
    }

    static func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .title.bold()
        case 2: return .title2.bold()
        case 3: return .title3.weight(.semibold)
        default: return .headline
        }
    }

    /// Bold, italic, code and links inside a block; what does not parse shows as written.
    static func inline(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}

/// A table as a grid that scrolls sideways when it is wider than the screen.
private struct WikiTableView: View {
    var table: WikiTable

    /// Each column as wide as its longest cell needs, up to 280 points; a set width lets long cells wrap to their height.
    private var widths: [CGFloat] {
        table.header.indices.map { c in
            let longest = ([table.header[c]] + table.rows.map { c < $0.count ? $0[c] : "" }).map(\.count).max() ?? 0
            return min(280, max(56, CGFloat(longest) * 10.5))
        }
    }

    var body: some View {
        let widths = widths
        ScrollView(.horizontal) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(table.header.indices, id: \.self) { c in cell(table.header[c], column: c, width: widths[c]).font(.callout.weight(.semibold)) }
                }
                .background(Color.secondary.opacity(0.12))
                ForEach(table.rows.indices, id: \.self) { r in
                    Divider()
                    GridRow {
                        ForEach(table.rows[r].indices, id: \.self) { c in cell(table.rows[r][c], column: c, width: widths[c]).font(.callout) }
                    }
                }
            }
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
            .padding(1)
        }
    }

    private func cell(_ text: String, column: Int, width: CGFloat) -> some View {
        let align = column < table.alignments.count ? table.alignments[column] : .leading
        let a: Alignment = align == .center ? .center : align == .trailing ? .trailing : .leading
        return Text(WikiBlockView.inline(text))
            .multilineTextAlignment(align == .center ? .center : align == .trailing ? .trailing : .leading)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(width: width, alignment: a)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .gridColumnAlignment(column == 0 ? .leading : align == .trailing ? .trailing : align == .center ? .center : .leading)
    }
}

/// A picture on a page. One the hub saved is read through the hub with this device's key. One from another site is
/// a link until it is tapped: loading it would tell that site this device read the page.
struct WikiImage: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.displayScale) private var scale
    var alt: String
    var src: String
    @State private var image: CGImage?
    @State private var failed = false
    @State private var loadOutside = false

    var body: some View {
        Group {
            if WikiLink.isMedia(src) {
                if let image {
                    Image(decorative: image, scale: scale)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: CGFloat(image.width) / scale)
                        .accessibilityLabel(alt)
                } else if failed {
                    missing
                } else {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 80)
                }
            } else if let url = WikiLink.imageURL(src) {
                if loadOutside {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let img): img.resizable().scaledToFit().accessibilityLabel(alt)
                        case .failure: missing
                        default: ProgressView().frame(maxWidth: .infinity, minHeight: 80)
                        }
                    }
                    .frame(maxWidth: 900)
                } else {
                    Button { loadOutside = true } label: {
                        Label("\(alt.isEmpty ? "Picture" : alt) from \(url.host ?? "another site"). Tap to load it.", systemImage: "photo.badge.arrow.down")
                            .font(.callout)
                            .multilineTextAlignment(.leading)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityHint("Loads the picture from \(url.host ?? "another site")")
                }
            } else {
                missing
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .task(id: src) {
            guard WikiLink.isMedia(src), image == nil, let c = engine.client else { return }
            image = await WikiImageCache.shared.image(src, client: c)
            failed = image == nil
        }
    }

    private var missing: some View {
        Label(alt.isEmpty ? "Picture" : alt, systemImage: "photo").font(.callout).foregroundStyle(.secondary)
    }
}

/// Decoded wiki pictures, kept in memory while the app runs, so scrolling back does not fetch them again.
actor WikiImageCache {
    static let shared = WikiImageCache()
    private let memory = NSCache<NSString, CGImageBox>()

    init() { memory.countLimit = 120 }

    func image(_ src: String, client: HubClient) async -> CGImage? {
        if let hit = memory.object(forKey: src as NSString) { return hit.image }
        guard let data = try? await client.wikiMedia(src), let img = Self.decode(data) else { return nil }
        memory.setObject(CGImageBox(img), forKey: src as NSString)
        return img
    }

    /// Large pictures are scaled down to 2400 pixels on the long side; that is plenty for a page.
    static func decode(_ data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 2400,
                                     kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCacheImmediately: true]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, opts as CFDictionary)
    }
}

/// A file a page links to that the hub saved (a picture or a PDF): shown when it is a picture, otherwise offered to share.
private struct WikiMediaSheet: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    @Environment(\.displayScale) private var scale
    var src: String
    @State private var image: CGImage?
    @State private var file: URL?
    @State private var problem: String?

    private var name: String { (WikiLink.mediaPath(src) as NSString?)?.lastPathComponent ?? "File" }

    var body: some View {
        NavigationStack {
            Group {
                if let image {
                    ScrollView([.horizontal, .vertical]) { Image(decorative: image, scale: scale) }
                } else if let file {
                    VStack(spacing: 12) {
                        Image(systemName: "doc").font(.largeTitle).foregroundStyle(.secondary)
                        Text(name)
                        ShareLink(item: file) { Label("Share or open", systemImage: "square.and.arrow.up") }
                    }
                } else if let problem {
                    Text(problem).foregroundStyle(.red).padding()
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle(name)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .frame(minWidth: 400, minHeight: 400)
        .task {
            guard let c = engine.client else { return }
            do {
                let data = try await c.wikiMedia(src)
                if let img = WikiImageCache.decode(data) { image = img; return }
                let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
                // Complete protection: an attachment opened from the open app.
                try DataProtection.write(data, to: url, .complete)
                file = url
            } catch {
                problem = error.localizedDescription
            }
        }
    }
}
