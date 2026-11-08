import SwiftUI
import EACore

/// Tonight's recall quiz, one question at a time with no answer key up front.
/// I know it marks right. Not sure shows the hint for one more try, then Show the answer marks revealed. I got it wrong marks wrong.
struct QuizView: View {
    @EnvironmentObject var engine: SyncEngine

    private struct Shown: Equatable { var question: String; var answer: String; var result: QuizResult }

    @State private var quizId: String?
    @State private var loading = true
    @State private var loadNote: String?
    @State private var building = false
    @State private var state: Making.QuizState?
    @State private var shown: Shown?
    @State private var streak: Int?
    @State private var busy = false
    @State private var error: String?

    private var past: [Entity] {
        engine.list(.quiz).filter { $0.id != quizId }.sorted { $0.str("date") > $1.str("date") }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if loading {
                    ProgressView("Loading tonight's quiz").frame(maxWidth: .infinity).padding(.top, 40)
                } else if let id = quizId, let e = engine.get(id), let st = state {
                    let items = Making.quiz(e).items ?? []
                    header(e, st, items)
                    if let s = shown {
                        answerCard(s, st)
                    } else if st.phase == .done {
                        doneCard(st, items)
                    } else if items.indices.contains(st.index) {
                        questionCard(items[st.index], st)
                    }
                    if let err = error { MakingErrorLine(text: err) }
                } else {
                    noQuiz
                }
                if !loading && !past.isEmpty { pastList }
            }
            .padding()
            .frame(maxWidth: 720, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .navigationTitle("Recall quiz")
        .task { await load() }
        .refreshable { await load() }
    }

    // MARK: pieces

    private func header(_ e: Entity, _ st: Making.QuizState, _ items: [Making.QuizItem]) -> some View {
        let c = Making.quizCounts(st.results)
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(dayLabel(e.str("date"))).font(.subheadline.weight(.semibold))
                Spacer()
                if let s = streak { Text(s == 0 ? "No streak yet" : "\(s) day streak").font(.subheadline).foregroundStyle(.secondary) }
            }
            HStack(spacing: 6) {
                ForEach(Array(st.results.enumerated()), id: \.offset) { i, r in
                    dot(r, current: st.phase != .done && shown == nil && i == st.index)
                }
                Spacer()
                Text("\(c.answered) of \(c.total) answered").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func dot(_ r: QuizResult?, current: Bool) -> some View {
        let (symbol, color, label): (String, Color, String) = {
            switch r {
            case .right: return ("checkmark.circle.fill", .green, "right")
            case .revealed: return ("eye.circle.fill", .orange, "revealed")
            case .wrong: return ("xmark.circle.fill", .red, "wrong")
            case nil: return current ? ("circle.inset.filled", .blue, "current") : ("circle", .secondary, "not asked yet")
            }
        }()
        return Image(systemName: symbol).foregroundStyle(color).font(.title3).accessibilityLabel(label)
    }

    private func questionCard(_ item: Making.QuizItem, _ st: Making.QuizState) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 6) {
                Text("Question \(st.index + 1) of \(st.results.count)")
                if let t = item.topic, !t.isEmpty { Text("\u{00B7} \(StyleGuard.dashes(t))") }
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.blue)
            Text(StyleGuard.dashes(item.q))
                .font(.title2.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            if st.phase == .hint {
                Label {
                    Text((item.hint ?? "").isEmpty ? "No hint for this one." : StyleGuard.dashes(item.hint!))
                } icon: { Image(systemName: "lightbulb.fill").foregroundStyle(.yellow) }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.yellow.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                .accessibilityLabel("Hint: \(item.hint ?? "none")")
            }
            Button { Task { await act(.know) } } label: {
                Label("I know it", systemImage: "checkmark").font(.title3.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .tint(.green)
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
            .disabled(busy)
            HStack(spacing: 10) {
                if st.phase == .ask {
                    Button { Task { await act(.unsure) } } label: {
                        Label("Not sure, show a hint", systemImage: "lightbulb").frame(maxWidth: .infinity)
                    }
                } else {
                    Button { Task { await act(.reveal) } } label: {
                        Label("Show the answer", systemImage: "eye").frame(maxWidth: .infinity)
                    }
                }
                Button { Task { await act(.wrong) } } label: {
                    Label("I got it wrong", systemImage: "xmark").frame(maxWidth: .infinity)
                }
                .tint(.red)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(busy)
        }
        .padding()
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
    }

    private func answerCard(_ s: Shown, _ st: Making.QuizState) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(StyleGuard.dashes(s.question)).font(.headline).foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text("Answer").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Text(StyleGuard.dashes(s.answer)).font(.title3.weight(.semibold)).textSelection(.enabled)
            }
            MakingBadge.quiz(s.result)
            Button { shown = nil } label: {
                Label(st.phase == .done ? "See results" : "Next question", systemImage: "arrow.right")
                    .font(.title3.weight(.semibold)).frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
        }
        .padding()
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
    }


    private func doneCard(_ st: Making.QuizState, _ items: [Making.QuizItem]) -> some View {
        let c = Making.quizCounts(st.results)
        return VStack(alignment: .leading, spacing: 14) {
            Label("Done for tonight", systemImage: "checkmark.seal.fill").font(.title2.weight(.semibold)).foregroundStyle(.green)
            HStack(spacing: 8) {
                MakingBadge(text: "\(c.right) right", symbol: "checkmark.circle.fill", color: .green)
                MakingBadge(text: "\(c.revealed) revealed", symbol: "eye.circle.fill", color: .orange)
                MakingBadge(text: "\(c.wrong) wrong", symbol: "xmark.circle.fill", color: .red)
            }
            Divider()
            ForEach(Array(items.enumerated()), id: \.offset) { i, it in
                reviewRow(it, result: st.results.indices.contains(i) ? st.results[i] : it.result)
            }
        }
        .padding()
        .background(Color.green.opacity(0.06), in: RoundedRectangle(cornerRadius: 16))
    }

    private func reviewRow(_ it: Making.QuizItem, result: QuizResult?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(StyleGuard.dashes(it.q)).font(.callout.weight(.semibold))
                Spacer(minLength: 6)
                MakingBadge.quiz(result)
            }
            Text(StyleGuard.dashes(it.a)).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
        }
    }

    private var noQuiz: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("No quiz yet today", systemImage: "questionmark.bubble").font(.title2.weight(.semibold))
            Text(loadNote ?? "It is made from today's assistant chats when you ask, so the model runs only then.")
                .foregroundStyle(.secondary)
            if engine.client != nil {
                Button(building ? "Making it" : "Make today's quiz") { Task { await build() } }
                    .buttonStyle(.borderedProminent).disabled(building)
            }
            if let s = streak { Text(s == 0 ? "No streak yet." : "\(s) day streak.").font(.callout) }
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
    }

    private var pastList: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Earlier quizzes").font(.headline)
            ForEach(past.prefix(14)) { q in
                let items = Making.quiz(q).items ?? []
                let c = Making.quizCounts(items.map(\.result))
                NavigationLink { QuizReviewView(quizId: q.id) } label: {
                    HStack {
                        Text(dayLabel(q.str("date")))
                        Spacer()
                        Text(c.answered == 0 ? "Not taken" : "\(c.right) of \(c.total) right").foregroundStyle(.secondary)
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Divider()
            }
        }
    }

    private func dayLabel(_ ymd: String) -> String {
        let p = ymd.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3, let d = Calendar.current.date(from: DateComponents(year: p[0], month: p[1], day: p[2])) else { return ymd }
        if Calendar.current.isDateInToday(d) { return "Tonight" }
        if Calendar.current.isDateInYesterday(d) { return "Yesterday" }
        return d.formatted(date: .abbreviated, time: .omitted)
    }

    // MARK: actions

    private func load() async {
        loadNote = nil
        var id: String?
        var useLocal = engine.client == nil
        if let c = engine.client {
            do {
                if let q = try await c.quizToday() {
                    await engine.absorb(q)
                    id = q.id
                }
            } catch {
                if Making.unreachable(error) { useLocal = true } else { loadNote = Making.message(error) }
            }
            if let s = try? await c.creativeStatus() { streak = s.creative?.quiz_streak_days }
        }
        if useLocal {
            let today = Making.localDay()
            id = engine.list(.quiz).first { $0.str("date") == today }?.id
            if id == nil { loadNote = "The hub is out of reach and no quiz for tonight is on this device yet." }
        }
        // Keep the place in a quiz already under way; only reset when a different quiz shows up.
        if id != quizId || state == nil {
            quizId = id
            shown = nil
            state = id.flatMap { engine.get($0) }.map { Making.initialQuiz(Making.quiz($0).items ?? []) }
        }
        loading = false
    }

    private func build() async {
        guard let c = engine.client else { return }
        building = true
        defer { building = false }
        do {
            if let q = try await c.quizBuild() { await engine.absorb(q); await load() }
            else { loadNote = "Nothing to ask from today's chats yet." }
        } catch { loadNote = Making.message(error) }
    }

    private func act(_ action: Making.QuizAction) async {
        guard let id = quizId, let st = state, let e = engine.get(id), !busy else { return }
        let items = Making.quiz(e).items ?? []
        let (next, record) = Making.quizStep(st, action)
        state = next
        guard let r = record else { return }
        if r.result != .right, items.indices.contains(r.index) {
            shown = Shown(question: items[r.index].q, answer: items[r.index].a, result: r.result)
        }
        busy = true
        defer { busy = false }
        error = nil
        var saved = false
        if let c = engine.client {
            do {
                let out = try await c.quizAnswer(id, index: r.index, result: r.result)
                await engine.absorb(out)
                saved = true
            } catch {
                if !Making.unreachable(error) { self.error = Making.message(error); return }
            }
        }
        if !saved {
            var list = items
            guard list.indices.contains(r.index) else { return }
            list[r.index].result = r.result
            list[r.index].asked_at = ISO.now()
            var f: [String: JSONValue] = ["items": (try? JSONCoding.value(list)) ?? .array([])]
            if list.allSatisfy({ $0.result != nil }) { f["completed_at"] = .string(ISO.now()) }
            _ = await engine.update(id, fields: f)
        }
        if next.phase == .done, let c = engine.client, let s = try? await c.creativeStatus() { streak = s.creative?.quiz_streak_days }
    }
}

/// An earlier quiz with its answers and how each went.
struct QuizReviewView: View {
    @EnvironmentObject var engine: SyncEngine
    var quizId: String

    var body: some View {
        let e = engine.get(quizId)
        let items = e.map { Making.quiz($0).items ?? [] } ?? []
        List {
            ForEach(Array(items.enumerated()), id: \.offset) { i, it in
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline) {
                        Text("\(i + 1). \(StyleGuard.dashes(it.q))").font(.headline)
                        Spacer(minLength: 6)
                        MakingBadge.quiz(it.result)
                    }
                    Text(StyleGuard.dashes(it.a)).foregroundStyle(.secondary).textSelection(.enabled)
                    if let t = it.topic, !t.isEmpty { Text(StyleGuard.dashes(t)).font(.caption).foregroundStyle(.tertiary) }
                }
                .padding(.vertical, 2)
            }
        }
        .navigationTitle(e?.str("date") ?? "Quiz")
    }

}
