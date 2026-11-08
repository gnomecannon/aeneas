import SwiftUI
import EACore

// Reminders are tasks with a reminder time (since 2026-10-28). What is left here: the snooze-with-a-reason sheet
// and the repeat editor the task editor uses.

/// Typed reason required when friction is reason.
struct SnoozeReasonSheet: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    var reminderId: String
    @State private var reason = ""
    @State private var minutes = 10

    var body: some View {
        let r = engine.get(reminderId)
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text(r?.str("title") ?? "Reminder").font(.title2.bold())
                Text("This reminder needs a reason to snooze.")
                    .foregroundStyle(.secondary)
                TextField("Reason", text: $reason, axis: .vertical).textFieldStyle(.roundedBorder).font(.title3).lineLimit(2...6)
                Picker("For", selection: $minutes) {
                    Text("10 min").tag(10); Text("1 h").tag(60); Text("Tomorrow").tag(24 * 60)
                }
                .pickerStyle(.segmented)
                BigButton(title: "Snooze", symbol: "zzz", prominent: true) {
                    Task { _ = await engine.snooze(reminderId, minutes: minutes, reason: reason) }
                    dismiss()
                }
                .disabled(reason.trimmingCharacters(in: .whitespaces).isEmpty)
                Spacer()
            }
            .padding()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium])
    }
}

/// Repeat for a task's reminder: off, or every N units, with weekdays or a day of the month.
struct RepeatEditor: View {
    @Binding var rule: String?
    @State private var repeats = false
    @State private var every = 1
    @State private var unit: RepeatRule.Unit = .weeks
    @State private var onDays = ""
    @State private var loaded = false

    var body: some View {
        Group {
            Toggle("Repeat", isOn: $repeats)
            if repeats {
                Stepper("Every \(every)", value: $every, in: 1...365)
                Picker("Unit", selection: $unit) {
                    ForEach([RepeatRule.Unit.minutes, .hours, .days, .weeks, .months, .years], id: \.self) { Text($0.rawValue).tag($0) }
                }
                if unit == .weeks { TextField("On (mon,thu)", text: $onDays) }
                if unit == .months { TextField("On day (15)", text: $onDays) }
                Text(built ?? "Not a valid repeat").font(.caption).foregroundStyle(.secondary)
            }
        }
        .onAppear(perform: load)
        .onChange(of: repeats) { _, _ in publish() }
        .onChange(of: every) { _, _ in publish() }
        .onChange(of: unit) { _, _ in publish() }
        .onChange(of: onDays) { _, _ in publish() }
    }

    private var built: String? {
        guard repeats else { return nil }
        // Full weekday names become the short codes the rule matches, and anything that is not a weekday or a day
        // of the month is refused. "monday" used to be shown as valid and never fired again.
        return RepeatRule.editorRule(n: every, unit: unit, on: onDays)
    }

    private func publish() { if loaded { rule = built } }

    private func load() {
        defer { loaded = true }
        guard let r = rule, let parsed = RepeatRule.parse(r) else { return }
        repeats = true
        every = parsed.n
        unit = parsed.unit
        if let on = parsed.on {
            onDays = parsed.unit == .months ? (on.last?.replacingOccurrences(of: "day", with: "") ?? "") : on.joined(separator: ",")
        }
    }
}
