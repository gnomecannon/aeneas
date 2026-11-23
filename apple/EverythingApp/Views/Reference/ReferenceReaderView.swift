import SwiftUI
import WebKit
import ImageIO
import EACore

/// One page of a reference: the hub's article in our own reader, in the app's theme and the device's text size.
/// Contents beside it on wide screens (a sheet or popover elsewhere) marking the section in view; links inside the
/// book open the next page here with the usual back; the place each page was left is kept on this device.
struct ReferenceReaderView: View {
    let link: ReferencePageLink
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var model: AppModel
    @ObservedObject private var library = ReferenceLibrary.shared
    @ObservedObject private var history = ReferenceHistory.shared
    @StateObject private var web = ReferenceWebController()
    @Environment(\.eaTheme) private var theme
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.openURL) private var openURL
    @Environment(\.dismiss) private var dismiss
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    #endif
    @AppStorage(ReferenceTextSize.key) private var textScale = 1.0
    @AppStorage("reference.contentsColumn") private var contentsColumn = true

    @State private var article: ReferenceArticle?
    @State private var problem: String?
    @State private var loading = false
    @State private var shown = false
    @State private var section = ""
    /// Where the page starts: where it was left on this device, read once when it arrives.
    @State private var start: ReferencePosition?
    @State private var next: ReferencePageLink?
    @State private var picture: ReferencePicture?
    @State private var outside: URL?
    @State private var preview: ReferencePreviewRequest?
    @State private var contents = false
    @State private var note: String?
    @State private var width: CGFloat = 0
    #if os(macOS)
    @State private var finding = false
    @State private var findText = ""
    @State private var findCount: Int?
    @State private var findIndex = 0
    #endif

    private var style: ReferenceStyle {
        ReferenceStyle.make(theme: theme, scheme: scheme, base: ReferenceTextSize.base(typeSize), scale: textScale)
    }
    private var sourceTitle: String { library.sourceTitle(article?.source ?? "") }
    private var toc: [ReferenceTocEntry] { article?.toc ?? [] }

    /// Room for the contents beside the page.
    private var wide: Bool {
        #if os(iOS)
        return sizeClass == .regular && width >= 700
        #else
        return width >= 760
        #endif
    }
    private var columnShown: Bool { wide && contentsColumn && !toc.isEmpty }

    var body: some View {
        HStack(spacing: 0) {
            if columnShown {
                ReferenceContentsList(toc: toc, current: section) { jump($0) }
                    .frame(width: min(300, max(220, width * 0.27)))
                Divider()
            }
            page
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .navigationTitle(article?.title ?? (link.title.isEmpty ? "Reference" : link.title))
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar { toolbar }
        .pageDestination(item: $next) { ReferenceReaderView(link: $0) }
        .sheet(item: $picture) { p in
            if let c = engine.client { ReferencePictureSheet(picture: p, client: c, style: style) }
        }
        .alert("Open in your browser?", isPresented: Binding(get: { outside != nil }, set: { if !$0 { outside = nil } }), presenting: outside) { u in
            Button("Open in Browser") { openURL(u) }
            Button("Cancel", role: .cancel) {}
        } message: { u in
            Text("\(u.host ?? "This page") is on the internet, so it needs a connection, and that site sees the visit. Everything else here is read from your hub.")
        }
        .overlay(alignment: .bottom) {
            if let note {
                Text(note)
                    .font(.callout.weight(.medium))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.bottom, 18)
                    .transition(.opacity)
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .background {
            // Escape goes back (Mac, and iPad with a keyboard); while finding, it closes the find bar instead.
            #if os(macOS)
            if !finding { Button("Back") { dismiss() }.keyboardShortcut(.cancelAction).opacity(0).frame(width: 0, height: 0).accessibilityHidden(true) }
            #else
            Button("Back") { dismiss() }.keyboardShortcut(.cancelAction).opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
            #endif
        }
        .task(id: link.id) { await load() }
        #if os(macOS)
        .task(id: findText) { await count() }
        #endif
    }

    // MARK: the page

    @ViewBuilder private var page: some View {
        ZStack {
            if let article, let client = engine.client {
                ReferenceWebView(article: article, sourceTitle: sourceTitle, languageTag: library.catalog?.language(article.lang)?.tag ?? "",
                                 client: client, style: style, position: start, controller: web, onEvent: handle)
                    .opacity(shown ? 1 : 0)
                    #if os(macOS)
                    .popover(item: $preview, attachmentAnchor: .rect(.rect(preview?.rect ?? .zero))) { p in
                        ReferencePreviewCard(client: client, link: p.link) {
                            preview = nil
                            next = p.link
                        }
                    }
                    #endif
            }
            if !shown {
                if let problem {
                    VStack(spacing: 12) {
                        Text(problem).foregroundStyle(.secondary).multilineTextAlignment(.center)
                        if !model.config.sampleMode, engine.client != nil {
                            Button(loading ? "Trying" : "Try again") { Task { await load(again: true) } }.disabled(loading)
                        }
                    }
                    .padding()
                    .frame(maxWidth: 480)
                } else {
                    ProgressView()
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        #if os(macOS)
        .overlay(alignment: .top) {
            if finding {
                ReferenceFindBar(text: $findText, count: findCount, index: findIndex, onFind: { find(backwards: $0) }) {
                    finding = false
                    findText = ""
                }
            }
        }
        #endif
    }

    // MARK: toolbar

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            if !toc.isEmpty {
                Button {
                    if wide { withAnimation(.snappy(duration: 0.2)) { contentsColumn.toggle() } } else { contents = true }
                } label: {
                    Label("Contents", systemImage: "list.bullet.indent")
                }
                .help("Contents")
                .popover(isPresented: $contents) {
                    ReferenceContentsList(toc: toc, current: section) { id in
                        contents = false
                        jump(id)
                    }
                    .frame(minWidth: 300, minHeight: 380)
                    .presentationDetents([.medium, .large])
                }
            }
            #if os(macOS)
            Button { startFinding() } label: { Label("Find in Page", systemImage: "magnifyingglass") }
                .keyboardShortcut("f")
                .help("Find in page")
                .disabled(article == nil)
            #endif
            Menu {
                SwiftUI.Section("Text size \(ReferenceTextSize.label(textScale))") {
                    Button { textScale = ReferenceTextSize.larger(textScale) } label: { Label("Larger Text", systemImage: "textformat.size.larger") }
                        .keyboardShortcut("+")
                        .disabled(textScale >= ReferenceTextSize.steps.last! - 0.001)
                    Button { textScale = ReferenceTextSize.smaller(textScale) } label: { Label("Smaller Text", systemImage: "textformat.size.smaller") }
                        .keyboardShortcut("-")
                        .disabled(textScale <= ReferenceTextSize.steps.first! + 0.001)
                    Button { textScale = 1 } label: { Label("Normal Size", systemImage: "textformat") }
                        .keyboardShortcut("0")
                        .disabled(abs(textScale - 1) < 0.001)
                }
            } label: {
                Label("Text size", systemImage: "textformat.size")
            }
            .help("Text size")
            #if os(macOS)
            Button { ask() } label: { Label("Ask about this page", systemImage: "bubble.left.and.text.bubble.right") }
                .help("Ask the assistant about this page")
                .disabled(article == nil)
            #endif
            Menu {
                #if os(iOS)
                Button { web.showFind() } label: { Label("Find in Page", systemImage: "magnifyingglass") }
                Button { ask() } label: { Label("Ask about this page", systemImage: "bubble.left.and.text.bubble.right") }
                #endif
                Button { copyCitation() } label: { Label("Copy Citation", systemImage: "quote.opening") }
                if let s = article?.url, let u = URL(string: s) {
                    Button { outside = u } label: { Label("Open the Original Page", systemImage: "safari") }
                }
            } label: {
                Label("More", systemImage: "ellipsis.circle")
            }
            .help("More")
            .disabled(article == nil)
        }
    }

    // MARK: actions

    private func load(again: Bool = false) async {
        guard article == nil || again else { return }
        guard !model.config.sampleMode else { problem = ReferenceSample.text; return }
        guard let c = engine.client else { problem = "Connect your hub in Settings to read this page."; return }
        // Source titles and language names, without waiting for them.
        if library.catalog == nil { Task { await library.refresh(c) } }
        loading = true
        defer { loading = false }
        do {
            let a = try await c.referenceArticle(book: link.book, path: link.path)
            start = history.position(ReferencePageLink(book: a.book, path: a.path)) ?? history.position(link)
            article = a
            problem = nil
            history.opened(a)
        } catch {
            guard !Task.isCancelled else { return }
            if let h = error as? HubError, case .http(let status, _) = h, status == 404 {
                problem = library.status == nil || library.book(link.book) != nil
                    ? "This page is not in the book now. A newer copy of the book may have moved it."
                    : "This book is not on your hub now."
            } else {
                problem = ReferenceLibrary.message(error)
            }
        }
    }

    private func handle(_ e: ReferenceWebEvent) {
        switch e {
        case .shown:
            withAnimation(.easeOut(duration: 0.15)) { shown = true }
        case .open(let l):
            next = l
        case .external(let u):
            outside = u
        case .section(let id):
            section = id
        case .position(let p):
            if let a = article { history.setPosition(p, for: ReferencePageLink(book: a.book, path: a.path)) }
        case .image(let path, let alt):
            picture = ReferencePicture(book: article?.book ?? link.book, path: path, alt: alt)
        case .preview(let l, let rect):
            preview = ReferencePreviewRequest(link: l, rect: rect)
        }
    }

    private func jump(_ id: String) {
        section = id
        web.scroll(to: id)
    }

    private func ask() {
        guard let a = article else { return }
        model.ask(ReferenceText.askPrefill(title: a.title, sourceTitle: sourceTitle, book: a.book, path: a.path))
    }

    private func copyCitation() {
        guard let a = article else { return }
        let text = ReferenceText.citation(title: a.title, sourceTitle: sourceTitle, date: a.date, url: a.url)
        #if os(iOS)
        UIPasteboard.general.string = text
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
        flash("Citation copied")
    }

    private func flash(_ text: String) {
        withAnimation { note = text }
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            withAnimation { if note == text { note = nil } }
        }
    }

    #if os(macOS)
    private func startFinding() {
        finding = true
    }

    /// Counts the matches a moment after typing stops, and shows the first.
    private func count() async {
        findIndex = 0
        findCount = nil
        let q = findText.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        try? await Task.sleep(for: .milliseconds(200))
        guard !Task.isCancelled else { return }
        let n = await web.count(q)
        guard !Task.isCancelled else { return }
        findCount = n
        if n > 0, await web.find(q, backwards: false), !Task.isCancelled { findIndex = 1 }
    }

    private func find(backwards: Bool) {
        let q = findText.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty, let n = findCount, n > 0 else { return }
        Task {
            guard await web.find(q, backwards: backwards), q == findText.trimmingCharacters(in: .whitespaces) else { return }
            if backwards { findIndex = findIndex <= 1 ? n : findIndex - 1 } else { findIndex = findIndex >= n ? 1 : findIndex + 1 }
        }
    }
    #endif
}

/// A picture to show enlarged.
struct ReferencePicture: Identifiable, Hashable {
    var book: String
    var path: String
    var alt: String
    var id: String { ReferenceLink.key(book: book, path: path) }
}

/// Mac: a link's preview, shown next to the link.
struct ReferencePreviewRequest: Identifiable {
    var link: ReferencePageLink
    var rect: CGRect
    var id: String { link.id }
}

/// The page's headings: the one in view is marked, a tap goes there.
struct ReferenceContentsList: View {
    var toc: [ReferenceTocEntry]
    var current: String
    var onSelect: (String) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            List {
                Button { onSelect("") } label: { row("Beginning", level: 2, on: current.isEmpty) }
                    .buttonStyle(.plain)
                    .id("")
                ForEach(toc) { e in
                    Button { onSelect(e.id) } label: { row(e.text, level: e.level, on: e.id == current) }
                        .buttonStyle(.plain)
                        .id(e.id)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .onChange(of: current) { _, id in withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(id, anchor: .center) } }
            .onAppear { proxy.scrollTo(current, anchor: .center) }
        }
        .accessibilityLabel("Contents")
    }

    private func row(_ text: String, level: Int, on: Bool) -> some View {
        HStack(spacing: 8) {
            Capsule()
                .fill(on ? AnyShapeStyle(.tint) : AnyShapeStyle(Color.clear))
                .frame(width: 3, height: 18)
            Text(text)
                .font(level >= 3 ? .callout : .body)
                .fontWeight(on ? .semibold : .regular)
                .foregroundStyle(level >= 3 && !on ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                .lineLimit(2)
                .padding(.leading, level >= 3 ? 12 : 0)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// A linked page's first paragraph and picture (`/reference/summary`): long press on iPhone and iPad, Force Touch or
/// right click on the Mac.
struct ReferencePreviewCard: View {
    var client: HubClient
    var link: ReferencePageLink
    var onOpen: (() -> Void)?
    @State private var summary: ReferenceSummary?
    @State private var image: CGImage?
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let image {
                Image(decorative: image, scale: 2)
                    .resizable()
                    .scaledToFill()
                    .frame(maxWidth: .infinity, maxHeight: 150)
                    .clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            Text(summary.map { $0.title.isEmpty ? link.title : $0.title } ?? (link.title.isEmpty ? "Page" : link.title))
                .font(.headline)
            if let s = summary, !s.text.isEmpty {
                Text(s.text).font(.callout).foregroundStyle(.secondary).lineLimit(12).fixedSize(horizontal: false, vertical: true)
            } else if failed || summary != nil {
                Text("No preview for this page.").font(.callout).foregroundStyle(.secondary)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
            if let onOpen {
                Button("Open", action: onOpen).buttonStyle(.themedProminent).keyboardShortcut(.defaultAction)
            }
        }
        .padding(14)
        .frame(width: 320, alignment: .leading)
        .task(id: link.id) {
            do {
                let s = try await client.referenceSummary(book: link.book, path: link.path)
                summary = s
                if let m = s.media, let d = await ReferenceMediaCache.shared.data(book: link.book, path: m, client: client) {
                    image = Self.decode(d)
                }
            } catch {
                failed = true
            }
        }
    }

    /// Raster pictures only, at most 640 pixels; a drawing (SVG) is left out of the card.
    static func decode(_ data: Data) -> CGImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 640,
                                     kCGImageSourceCreateThumbnailWithTransform: true]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, opts as CFDictionary)
    }
}

/// A picture of a page, enlarged: pinch to zoom. Drawings (SVG) and moving pictures show as they are.
struct ReferencePictureSheet: View {
    var picture: ReferencePicture
    var client: HubClient
    var style: ReferenceStyle
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ReferencePictureView(picture: picture, client: client, style: style)
                if !picture.alt.isEmpty {
                    Text(picture.alt)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                        .textSelection(.enabled)
                }
            }
            .navigationTitle("Picture")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 460)
        #endif
    }
}

/// The picture in a page view of its own, loaded the same way as the page's (through the app, with the device's key).
@MainActor
struct ReferencePictureView {
    var picture: ReferencePicture
    var client: HubClient
    var style: ReferenceStyle

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        let pictures: ReferenceSchemeHandler
        init(client: HubClient) { pictures = ReferenceSchemeHandler(client: client) }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
            decisionHandler(action.navigationType == .other && action.request.url?.scheme == ReferenceHTML.scheme ? .allow : .cancel)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(client: client) }

    fileprivate func make(_ c: Coordinator) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(c.pictures, forURLScheme: ReferenceHTML.scheme)
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = c
        web.allowsLinkPreview = false
        #if os(macOS)
        web.allowsMagnification = true
        #else
        web.isOpaque = false
        web.backgroundColor = .clear
        #endif
        web.loadHTMLString(ReferenceHTML.picture(book: picture.book, path: picture.path, alt: picture.alt, style: style), baseURL: ReferenceHTML.pageURL)
        return web
    }
}

#if os(iOS)
extension ReferencePictureView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView { make(context.coordinator) }
    func updateUIView(_ webView: WKWebView, context: Context) {}
}
#else
extension ReferencePictureView: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView { make(context.coordinator) }
    func updateNSView(_ webView: WKWebView, context: Context) {}
}

/// Mac: find in page, with how many matches there are and which one is shown.
struct ReferenceFindBar: View {
    @Binding var text: String
    var count: Int?
    var index: Int
    var onFind: (Bool) -> Void
    var onDone: () -> Void
    @FocusState private var focused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Find in page", text: $text)
                .textFieldStyle(.plain)
                .focused($focused)
                .onSubmit { onFind(false) }
                .frame(minWidth: 160, maxWidth: 260)
            if let count {
                Text(count == 0 ? "Not found" : "\(max(index, 1)) of \(count)")
                    .font(.caption)
                    .foregroundStyle(count == 0 ? AnyShapeStyle(.warnText) : AnyShapeStyle(.secondary))
                    .monospacedDigit()
            }
            Button { onFind(true) } label: { Image(systemName: "chevron.up") }
                .keyboardShortcut("g", modifiers: [.command, .shift])
                .disabled((count ?? 0) == 0)
                .help("Previous match")
                .accessibilityLabel("Previous match")
            Button { onFind(false) } label: { Image(systemName: "chevron.down") }
                .keyboardShortcut("g")
                .disabled((count ?? 0) == 0)
                .help("Next match")
                .accessibilityLabel("Next match")
            Button("Done", action: onDone).keyboardShortcut(.cancelAction)
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
        .shadow(radius: 3, y: 1)
        .padding(10)
        .onAppear { focused = true }
    }
}
#endif
