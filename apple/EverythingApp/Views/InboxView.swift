import SwiftUI
import EACore

/// Unprocessed captures with convert buttons, then the last week's captures and where the assistant filed each one.
struct InboxView: View {
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
                                    NavigationLink(destination: ItemView(id: cap.id)) {
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(StyleGuard.dashes(cap.str("text"))).lineLimit(3)
                                            Text("\(dateLabel(cap.created_at))  ·  \(StyleGuard.dashes(cap.str("filed", cap.str("filing") == "pending" ? "Filing it now" : cap.stringArray("converted_to").isEmpty ? "Diary only" : "Sorted by hand")))")
                                                .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                                        }
                                    }
                                    // The chat that filed it: tell the assistant what it got wrong there.
                                    .swipeActions(edge: .leading) {
                                        if let thread = cap.string("thread") { Button("Fix") { model.openChat(thread) }.tint(.accentColor) }
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
        }
        .navigationTitle("Unsorted Info")
        .refreshable { await engine.sync() }
    }
}

struct CaptureRow: View {
    @EnvironmentObject var engine: SyncEngine
    var capture: Entity
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
        .padding(.vertical, 6)
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
