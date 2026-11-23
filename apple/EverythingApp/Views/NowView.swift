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
    /// The task's title: 34 points at the default text size, following the text size set on the device.
    @ScaledMetric(relativeTo: .largeTitle) private var titleSize: CGFloat = 34

    var body: some View {
        // A wide window: the task on a card at most 720 points wide at the left, as tall as its words and buttons,
        // and beside it today's reminders and what is up next, always open, so the rest of the window is the queue.
        // On a narrow one the card fills the screen and the queue folds away under it, as before.
        WideReader { wide in
            if wide { widePage } else { narrowPage }
        }
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
                            .background(.tint, in: Capsule())
                            .foregroundStyle(.onAccent)
                            .offset(x: 8, y: -8)
                    }
                }
            }
        }
        .sheet(isPresented: $showPark) { parkSheet }
        .refreshable { await engine.sync() }
    }

    private var narrowPage: some View {
        VStack(spacing: 16) {
            StatusBanner()
            if let task = engine.nowTask {
                nowCard(task, fills: true)
            } else {
                VStack(spacing: 14) {
                    Spacer()
                    nothingNext(wide: false)
                    Spacer()
                }
            }
            remindersStrip
            // Only a task being done has something after it.
            if engine.nowTask != nil { upNextSection }
        }
        .frame(maxWidth: .infinity)
        .padding()
    }

    private var widePage: some View {
        WidePage {
            StatusBanner()
            HStack(alignment: .top, spacing: 22) {
                Group {
                    if let task = engine.nowTask {
                        nowCard(task, fills: false)
                    } else {
                        VStack(alignment: .leading, spacing: 14) { nothingNext(wide: true) }
                            .padding(20)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 18))
                    }
                }
                .frame(maxWidth: 720, alignment: .leading)
                queue
            }
        }
    }

    /// With no task doing or next: the open tasks to pick from, each with Start, as Today's To do offers them. Tasks
    /// from Reminders and captures arrive in the Inbox, so for someone who never sorts them into Next this screen
    /// used to say "Nothing is next" every day. With no open task at all it says what to do about that. On a wide
    /// window the rows run the width of their card; on a narrow one they keep a width that reads, in the middle.
    @ViewBuilder
    private func nothingNext(wide: Bool) -> some View {
        let open = TodayBoard.openTasks(engine.tasks)
        if open.isEmpty {
            Text("Nothing is next").font(.largeTitle.bold())
            Text("Capture something, or add a task in Tasks.").foregroundStyle(.secondary)
            BigButton(title: "Capture", symbol: "square.and.pencil", prominent: true) { model.section = .capture }
                .frame(maxWidth: 360)
        } else {
            Text("Nothing is being done").font(.largeTitle.bold())
            Text(open.count == 1 ? "Start your open task:" : "Start one of your \(open.count) open tasks:").foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(open.prefix(6)) { t in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(StyleGuard.dashes(t.str("title"))).font(.title3).lineLimit(2).multilineTextAlignment(.leading)
                            if !t.str("due").isEmpty {
                                Text("Due \(TaskDue.label(t.str("due")))").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 8)
                        Button("Start") { Task { await engine.makeNow(t.id) } }
                            .buttonStyle(.bordered)
                            .help("Make this the thing you are doing now")
                            .accessibilityLabel("Start \(t.str("title"))")
                    }
                }
                if open.count > 6 {
                    Button("All \(open.count) in Tasks") { model.section = .tasks }.buttonStyle(.borderless)
                }
            }
            .frame(maxWidth: wide ? .infinity : 520, alignment: .leading)
        }
    }

    /// The task's own words: its title in full, its notes and when it is due.
    @ViewBuilder
    private func words(_ task: Entity, _ f: TaskFields?) -> some View {
        Text(StyleGuard.dashes(task.str("title")))
            .font(.system(size: titleSize, weight: .bold))
            .fixedSize(horizontal: false, vertical: true)
        if let n = f?.notes, !n.isEmpty {
            Text(StyleGuard.dashes(n)).font(.title3).foregroundStyle(.secondary).lineLimit(6)
        }
        if let due = f?.due, !due.isEmpty {
            // A date alone is a day, not midnight: it used to show "Due 12:00 AM".
            Text("Due \(TaskDue.label(due))").font(.subheadline).foregroundStyle(.secondary)
        }
    }

    /// The task with its buttons. `fills` is the narrow screen's card, as tall as the screen allows with the buttons
    /// at its foot: there the words scroll inside the card when they do not fit. They used to be held at their full
    /// height instead, and the Mac sizes a window by asking a screen how small it can get at no width at all, where
    /// a title is one letter a line: a window showing Now could not be made shorter than about 1,650 points, taller
    /// than the display. A scrolling area has no least height, so the window keeps the size it was given.
    @ViewBuilder
    private func nowCard(_ task: Entity, fills: Bool) -> some View {
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
            if fills {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) { words(task, f) }
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .scrollBounceBehavior(.basedOnSize)
            } else {
                words(task, f)
            }
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
        .frame(maxWidth: .infinity, maxHeight: fills ? .infinity : nil, alignment: .topLeading)
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
            VStack(alignment: .leading, spacing: 6) { upNextRows(next, limit: 5) }
                .padding(.top, 6)
        } label: {
            Text(next.isEmpty ? "Nothing after this" : "Up next (\(next.count))").font(.headline).foregroundStyle(.secondary)
        }
    }

    /// The first tasks after this one, each with the button that makes it the task now, and the way to the rest.
    @ViewBuilder
    private func upNextRows(_ next: [Entity], limit: Int) -> some View {
        ForEach(next.prefix(limit)) { t in
            HStack {
                Text(StyleGuard.dashes(t.str("title"))).lineLimit(1)
                Spacer()
                Button("Now") { Task { await engine.makeNow(t.id) } }.buttonStyle(.borderless)
            }
            .padding(.vertical, 4)
        }
        if next.count > limit { Button("All tasks") { model.section = .tasks }.buttonStyle(.borderless) }
    }

    /// Beside the task in a wide window: today's reminders with their times, then what is up next, each on a card
    /// and always open (on a narrow screen they are a strip and a row that opens, under the task).
    @ViewBuilder
    private var queue: some View {
        let today = engine.remindersToday
        let next = engine.upNext
        VStack(alignment: .leading, spacing: 22) {
            if !today.isEmpty {
                WideSection("Reminders today") {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(today) { r in
                            Button { model.open(itemId: r.id) } label: {
                                HStack(alignment: .firstTextBaseline) {
                                    Text(StyleGuard.dashes(r.str("title"))).lineLimit(2)
                                    Spacer(minLength: 8)
                                    Text(r.alertDate?.formatted(date: .omitted, time: .shortened) ?? "")
                                        .font(.callout.monospacedDigit()).foregroundStyle(.secondary)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    // As tall as its rows: a card otherwise fills the height the task's card gives the row.
                    .gridCard().fixedSize(horizontal: false, vertical: true)
                }
            }
            // Only a task being done has something after it.
            if engine.nowTask != nil {
                WideSection(next.isEmpty ? "Nothing after this" : "Up next (\(next.count))") {
                    if !next.isEmpty {
                        VStack(alignment: .leading, spacing: 6) { upNextRows(next, limit: 12) }
                            .gridCard().fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .frame(maxWidth: 560, alignment: .leading)
    }
}
