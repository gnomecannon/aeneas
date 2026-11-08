import SwiftUI
import EACore

/// The single current task, full screen.
struct NowView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @State private var showPark = false
    /// The task the Park sheet opened for. Park used to act on whatever was Now when it was tapped, which could be
    /// another task if the first was finished elsewhere meanwhile.
    @State private var parkTaskId: String?
    @State private var showUpNext = false
    @State private var parkReason = ""

    var body: some View {
        VStack(spacing: 16) {
            StatusBanner()
            if let task = engine.nowTask {
                nowCard(task)
            } else {
                VStack(spacing: 14) {
                    Spacer()
                    Text("Nothing is next").font(.largeTitle.bold())
                    Text("Capture something, or move a task to Next.").foregroundStyle(.secondary)
                    BigButton(title: "Capture", symbol: "square.and.pencil", prominent: true) { model.section = .capture }
                        .frame(maxWidth: 360)
                    Spacer()
                }
            }
            remindersStrip
            upNextSection
        }
        .padding()
        .navigationTitle("Now")
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Button {
                    model.section = .inbox
                } label: {
                    Label("Unsorted Info", systemImage: "tray")
                }
                .badge(engine.unprocessedCaptures.count)
                .overlay(alignment: .topTrailing) {
                    if !engine.unprocessedCaptures.isEmpty {
                        Text("\(engine.unprocessedCaptures.count)")
                            .font(.caption2.bold())
                            .padding(4)
                            .background(Color.accentColor, in: Capsule())
                            .foregroundStyle(.white)
                            .offset(x: 8, y: -8)
                    }
                }
            }
        }
        .sheet(isPresented: $showPark) { parkSheet }
        .refreshable { await engine.sync() }
    }

    @ViewBuilder
    private func nowCard(_ task: Entity) -> some View {
        let f = task.decoded(TaskFields.self)
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(f?.status == .doing ? "Doing" : "Next").font(.headline).foregroundStyle(.secondary)
                Spacer()
                if let b = f?.block, let end = ISO.date(b.end) {
                    TimelineView(.periodic(from: .now, by: 60)) { ctx in
                        Text(end > ctx.date ? "Block ends \(end.shortTime)" : "Block ended \(end.shortTime)")
                            .font(.headline).foregroundStyle(.secondary)
                    }
                }
            }
            Text(StyleGuard.dashes(task.str("title")))
                .font(.system(size: 34, weight: .bold))
                .fixedSize(horizontal: false, vertical: true)
            if let n = f?.notes, !n.isEmpty {
                Text(StyleGuard.dashes(n)).font(.title3).foregroundStyle(.secondary).lineLimit(6)
            }
            if let due = f?.due, !due.isEmpty {
                // A date alone is a day, not midnight: it used to show "Due 12:00 AM".
                Text("Due \(TaskDue.label(due))").font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            VStack(spacing: 10) {
                BigButton(title: "Done", symbol: "checkmark", prominent: true) { Task { await engine.markDone(task.id) } }
                HStack(spacing: 10) {
                    BigButton(title: "Park", symbol: "pause") { parkReason = ""; parkTaskId = task.id; showPark = true }
                    BigButton(title: "Skip", symbol: "forward") { Task { await engine.skip(task.id) } }
                }
                if f?.status != .doing {
                    BigButton(title: "Start 3 h block", symbol: "timer") { Task { await engine.startBlock(task.id, hours: 3) } }
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 18))
    }

    private var parkSheet: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Why park it?").font(.title2.bold())
                TextField("Reason", text: $parkReason, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .font(.title3)
                    .lineLimit(3...6)
                BigButton(title: "Park", symbol: "pause", prominent: true) {
                    if let id = parkTaskId { let reason = parkReason; Task { await engine.park(id, reason: reason) } }
                    showPark = false
                }
                .disabled(parkReason.trimmingCharacters(in: .whitespaces).isEmpty)
                Spacer()
            }
            .padding()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showPark = false } } }
        }
        .presentationDetents([.medium])
    }

    @ViewBuilder
    private var remindersStrip: some View {
        let today = engine.remindersToday
        if !today.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(today) { r in
                        Button { model.open(itemId: r.id) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(r.str("title")).font(.subheadline.weight(.semibold)).lineLimit(1)
                                Text(r.alertDate?.formatted(date: .omitted, time: .shortened) ?? "").font(.caption).foregroundStyle(.secondary)
                            }
                            .padding(10)
                            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var upNextSection: some View {
        let next = engine.upNext
        DisclosureGroup(isExpanded: $showUpNext) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(next.prefix(5)) { t in
                    HStack {
                        Text(StyleGuard.dashes(t.str("title"))).lineLimit(1)
                        Spacer()
                        Button("Now") { Task { await engine.makeNow(t.id) } }.buttonStyle(.borderless)
                    }
                    .padding(.vertical, 4)
                }
                if next.count > 5 { Button("All tasks") { model.section = .tasks }.buttonStyle(.borderless) }
            }
            .padding(.top, 6)
        } label: {
            Text(next.isEmpty ? "Nothing after this" : "Up next (\(next.count))").font(.headline).foregroundStyle(.secondary)
        }
    }
}
