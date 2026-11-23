import SwiftUI
import EACore

/// Unprocessed captures with convert buttons, then the last week's captures and where the assistant filed each one.
struct InboxView: View {
    @Environment(\.eaTheme) private var theme
    @State private var showFiled = false
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var model: AppModel

    private var filed: [Entity] {
        let since = Date().addingTimeInterval(-7 * 86400)
        return engine.list(.capture)
            .filter { $0.bool("processed") == true && (ISO.date($0.created_at) ?? .distantPast) > since }
            .sorted { $0.created_at > $1.created_at }
    }

    var body: some View {
        let items = engine.unprocessedCaptures
        let done = filed
        Group {
            if items.isEmpty && done.isEmpty {
                EmptyState(text: "Nothing to sort")
            } else {
                // The rows are swiped to discard a capture, so the cards are for the Mac only (WideReader).
                WideReader(macOnly: true) { wide in
                    if wide { cards(items, done) } else { list(items, done) }
                }
            }
        }
        .navigationTitle("Unsorted Info")
        .refreshable { await engine.sync() }
    }

    /// One filed capture's words: what it said, when, and where it went.
    private func filedWords(_ cap: Entity) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(StyleGuard.dashes(cap.str("text"))).lineLimit(3).multilineTextAlignment(.leading)
            Text("\(dateLabel(cap.created_at))  ·  \(CaptureFiling.line(cap))")
                .font(.caption).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.leading)
        }
    }

    private func list(_ items: [Entity], _ done: [Entity]) -> some View {
        List {
            if !items.isEmpty {
                SwiftUI.Section(done.isEmpty ? "" : "To sort") {
                    ForEach(items) { cap in
                        CaptureRow(capture: cap)
                            .deleteSwipe(cap.id, label: "Discard")
                    }
                }
            }
            if !done.isEmpty {
                // What was filed is a record, not work: collapsed until opened.
                SwiftUI.Section {
                    DisclosureGroup(isExpanded: $showFiled) {
                        ForEach(done) { cap in
                            NavigationLink(destination: ItemView(id: cap.id)) { filedWords(cap) }
                            // The chat that filed it: tell the assistant what it got wrong there.
                            .swipeActions(edge: .leading) {
                                if let thread = cap.string("thread") { Button("Fix") { model.openChat(thread) }.tint(theme?.accent ?? Color.accentColor) }
                            }
                            .contextMenu {
                                if let thread = cap.string("thread") { Button("Fix the filing", systemImage: "bubble.left.and.text.bubble.right") { model.openChat(thread) } }
                            }
                        }
                    } label: {
                        Text("Filed this week (\(done.count))").font(.headline)
                    }
                }
            }
        }
        .listStyle(.plain)
    }

    /// A wide Mac window: what is waiting as cards, as many across as fit at 480 points each (2 across a screen of
    /// 1040 points, 3 across a 1920 window), which keeps a card's buttons on one line; then what was filed this
    /// week, also as cards, under its heading, which still opens and closes it. Discard is a button on the card and
    /// in its right-click menu, and Fix the filing is in a filed card's right-click menu (on a narrow window both
    /// are swipes too).
    private func cards(_ items: [Entity], _ done: [Entity]) -> some View {
        WidePage {
            if !items.isEmpty {
                let waiting = CardGrid(minWidth: 480) {
                    ForEach(items) { cap in
                        CaptureRow(capture: cap, card: true)
                            .deleteSwipe(cap.id, label: "Discard")
                    }
                }
                if done.isEmpty { waiting } else { WideSection("To sort") { waiting } }
            }
            if !done.isEmpty {
                DisclosureGroup(isExpanded: $showFiled) {
                    CardGrid(minWidth: 400) {
                        ForEach(done) { cap in
                            NavigationLink(destination: ItemView(id: cap.id)) { filedWords(cap).gridCard() }
                                .buttonStyle(.plain)
                                .contextMenu {
                                    if let thread = cap.string("thread") { Button("Fix the filing", systemImage: "bubble.left.and.text.bubble.right") { model.openChat(thread) } }
                                }
                        }
                    }
                    .padding(.top, 8)
                } label: {
                    Text("Filed this week (\(done.count))").font(.headline)
                }
            }
        }
    }
}

/// Where a capture went, in words: what the assistant said it filed, or how far along it is.
enum CaptureFiling {
    static func line(_ cap: Entity) -> String {
        let filed = cap.str("filed")
        if !filed.isEmpty { return StyleGuard.dashes(filed) }
        if cap.str("filing") == "pending" { return "Filing it now" }
        if cap.bool("processed") != true { return "Not sorted yet" }
        return cap.stringArray("converted_to").isEmpty ? "Diary only" : "Sorted by hand"
    }
}

struct CaptureRow: View {
    @EnvironmentObject var engine: SyncEngine
    var capture: Entity
    /// A card in the wide window's grid instead of a list row: the same words and buttons on a card's fill.
    var card = false
    @State private var working = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(StyleGuard.dashes(capture.str("text"))).font(.title3)
            HStack {
                Text(capture.str("source")).font(.caption).foregroundStyle(.secondary)
                Text(dateLabel(capture.created_at)).font(.caption).foregroundStyle(.secondary)
                if let a = capture.fields["attachments"]?.arrayValue, !a.isEmpty { Image(systemName: "paperclip").font(.caption) }
            }
            FlowLayout(spacing: 8) {
                // The assistant files it as it files every capture: calendar, people, memory, tasks, logs.
                Chip(text: working ? "Filing" : "File it", selected: true) { fileIt() }
                ForEach([SuggestedKind.task, .note, .reminder, .log, .fact], id: \.self) { k in
                    Chip(text: k.rawValue.capitalized) { convert(k) }
                }
                Chip(text: "Discard") { Task { await engine.discardCapture(capture.id) } }
            }
            .disabled(working)
        }
        .padding(.vertical, card ? 0 : 6)
        .gridCard(if: card)
    }

    private func fileIt() {
        working = true
        Task {
            _ = try? await engine.client?.fileCapture(capture.id)
            await engine.sync()
            working = false
        }
    }

    private func convert(_ k: SuggestedKind) {
        guard let kind = Kind(rawValue: k.rawValue) else { return }
        working = true
        Task {
            let c = Classifier.classify(capture.str("text"))
            _ = await engine.convertCapture(capture.id, to: kind, fields: c.kind == k ? c.fields : nil)
            working = false
        }
    }
}
