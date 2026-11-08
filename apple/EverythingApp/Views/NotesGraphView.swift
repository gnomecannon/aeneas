import SwiftUI
import EACore

/// The notes map: every note a dot colored by its folder, every link a line. The layout is worked once per graph (EACore
/// `NoteGraphLayout`); drag to pan, pinch to zoom, tap a dot to open the note. Uses the hub's /notes/graph, or the local
/// notes when the hub is out of reach.
struct NotesGraphView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var result: NoteGraphLayout.Result?
    @State private var fromHub = false
    @State private var scale: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1
    @State private var offset: CGSize = .zero
    @GestureState private var drag: CGSize = .zero
    @State private var opened: String?

    /// The same folder colors as the web map.
    static let palette: [Color] = {
        let hexes: [Int] = [0x2f5fbf, 0x3a8f5a, 0xc2871a, 0xb4443c, 0x7a4fb0, 0x2a8f9a, 0x8a6d3b, 0x5a5f7a]
        return hexes.map { (hex: Int) -> Color in
            let r = Double((hex >> 16) & 0xff) / 255, g = Double((hex >> 8) & 0xff) / 255, b = Double(hex & 0xff) / 255
            return Color(red: r, green: g, blue: b)
        }
    }()
    static func color(_ folderIndex: Int) -> Color { palette[folderIndex % palette.count] }
    static func folderName(_ f: String) -> String { f.isEmpty ? "Top level" : f }

    private var zoom: CGFloat { min(8, max(0.3, scale * pinch)) }
    private var pan: CGSize { CGSize(width: offset.width + drag.width, height: offset.height + drag.height) }

    var body: some View {
        Group {
            if let r = result {
                if r.nodes.isEmpty {
                    EmptyState(text: "No notes to map")
                } else {
                    GeometryReader { geo in
                        canvas(r, size: geo.size)
                    }
                    .overlay(alignment: .bottom) { legend(r) }
                }
            } else {
                ProgressView("Placing notes")
            }
        }
        .navigationTitle("Notes map")
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { withAnimation { scale = max(0.3, scale / 1.5) } } label: { Label("Zoom out", systemImage: "minus.magnifyingglass") }
                Button { withAnimation { scale = min(8, scale * 1.5) } } label: { Label("Zoom in", systemImage: "plus.magnifyingglass") }
                Button { withAnimation { scale = 1; offset = .zero } } label: { Label("Fit", systemImage: "arrow.down.right.and.arrow.up.left") }
            }
        }
        .navigationDestination(item: $opened) { id in NoteEditorView(noteId: id) }
        .task(id: engine.notes.count) { await load() }
    }

    private func load() async {
        var graph: NoteGraph?
        if let c = engine.client { graph = try? await c.graph() }
        fromHub = graph != nil
        let g = graph ?? NoteGraphLayout.localGraph(engine.notes)
        let placed = await Task.detached(priority: .userInitiated) { NoteGraphLayout.layout(g) }.value
        result = placed
    }

    /// Unit square to screen: the whole view less a margin, centred, then zoomed about the centre and panned.
    private func screen(_ n: NoteGraphLayout.Node, _ size: CGSize) -> CGPoint {
        let w = max(1, size.width - 56), h = max(1, size.height - 56)
        return CGPoint(x: size.width / 2 + (n.x - 0.5) * w * zoom + pan.width,
                       y: size.height / 2 + (n.y - 0.5) * h * zoom + pan.height)
    }

    private func radius(_ n: NoteGraphLayout.Node) -> CGFloat {
        (4 + min(8, CGFloat(n.degree) * 1.5)) * min(2, max(0.7, sqrt(zoom)))
    }

    private func canvas(_ r: NoteGraphLayout.Result, size: CGSize) -> some View {
        // Titles for the best-linked notes always, for every note once zoomed in.
        let labelled = Set(r.nodes.sorted { $0.degree > $1.degree }.prefix(zoom >= 1.8 ? r.nodes.count : 12).filter { $0.degree > 0 || zoom >= 1.8 }.map(\.id))
        return Canvas { ctx, size in
            let pts = r.nodes.map { screen($0, size) }
            var lines = Path()
            for e in r.edges { lines.move(to: pts[e.a]); lines.addLine(to: pts[e.b]) }
            ctx.stroke(lines, with: .color(.secondary.opacity(0.35)), lineWidth: 1)
            for (i, n) in r.nodes.enumerated() {
                let p = pts[i], rad = radius(n)
                guard p.x > -40, p.y > -40, p.x < size.width + 40, p.y < size.height + 40 else { continue }
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - rad, y: p.y - rad, width: rad * 2, height: rad * 2)), with: .color(Self.color(n.folderIndex)))
                if labelled.contains(n.id) {
                    let title = n.title.count > 28 ? String(n.title.prefix(27)) + "." : n.title
                    // Right half: the title goes on the left of its dot so it stays on screen.
                    let left = p.x > size.width / 2
                    ctx.draw(Text(StyleGuard.dashes(title)).font(.caption2).foregroundStyle(.primary),
                             at: CGPoint(x: left ? p.x - rad - 3 : p.x + rad + 3, y: p.y), anchor: left ? .trailing : .leading)
                }
            }
        }
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 4)
                .updating($drag) { v, s, _ in s = v.translation }
                .onEnded { v in offset.width += v.translation.width; offset.height += v.translation.height }
        )
        .simultaneousGesture(
            MagnifyGesture()
                .updating($pinch) { v, s, _ in s = v.magnification }
                .onEnded { v in scale = min(8, max(0.3, scale * v.magnification)) }
        )
        .onTapGesture { loc in
            // The nearest dot within a finger's reach.
            let hit = r.nodes.map { n in (n.id, hypot(screen(n, size).x - loc.x, screen(n, size).y - loc.y) - radius(n)) }
                .filter { $0.1 < 18 }.min { $0.1 < $1.1 }
            if let id = hit?.0 { opened = id }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Notes map, \(r.nodes.count) notes and \(r.edges.count) links")
    }

    private func legend(_ r: NoteGraphLayout.Result) -> some View {
        let counts = Dictionary(grouping: r.nodes, by: \.folderIndex).mapValues(\.count)
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                ForEach(Array(r.folders.enumerated()), id: \.offset) { i, f in
                    HStack(spacing: 4) {
                        Circle().fill(Self.color(i)).frame(width: 9, height: 9)
                        Text("\(StyleGuard.dashes(Self.folderName(f))) \(counts[i] ?? 0)").font(.caption)
                    }
                }
                Text("\(r.nodes.count) notes, \(r.edges.count) links\(fromHub ? "" : ", from this device")").font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(.bar)
    }
}
