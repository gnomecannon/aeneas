import SwiftUI
import EACore

// The Mail screen's sheets and settings: Snooze (and the owner's snooze times), when a bundle shows in the Inbox, the
// owner's own bundles, new-mail notifications and the mailboxes. All of it is kept on the hub for every device, as on
// the web. (A new reminder is made where the app makes reminders, not here: CONTRACT.md, Mail, Reminders.)

private let weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

/// `HH:MM` as a date today, for a time picker, and back.
private func clockDate(_ hhmm: String?) -> Date {
    let p = (hhmm ?? "").split(separator: ":").map { Int($0) ?? 0 }
    return Calendar.current.date(bySettingHour: p.first ?? 0, minute: p.count > 1 ? p[1] : 0, second: 0, of: Date()) ?? Date()
}
private func clockString(_ d: Date) -> String {
    let c = Calendar.current.dateComponents([.hour, .minute], from: d)
    return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
}

/// Snooze: later today, tomorrow, the weekend, next week (as the owner set them), or a date and time of your own. For
/// threads, until then on the hub (the mail stays in its mailbox's Inbox); for a due reminder, its task's snooze, with a
/// reason when the task asks for one.
struct MailSnoozeSheet: View {
    @ObservedObject var store: MailStore
    var target: MailView.SnoozeTarget
    var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    @State private var own = Date().addingTimeInterval(3600)
    @State private var editingTimes = false
    @State private var reason = ""
    @State private var busy = false

    private var needsReason: Bool { (target.reminder?.friction ?? "none") != "none" }
    private var title: String {
        if let r = target.reminder { return "Snooze \u{201C}\(r.title)\u{201D}" }
        return target.threads.count == 1 ? "Snooze until" : "Snooze \(target.threads.count) until"
    }

    var body: some View {
        NavigationStack {
            Form {
                if needsReason {
                    SwiftUI.Section("Why snooze it?") {
                        TextField("Reason", text: $reason, axis: .vertical)
                    }
                }
                SwiftUI.Section {
                    ForEach(Mail.snoozeChoices(times: store.snoozeTimes)) { c in
                        Button { go(c.at) } label: {
                            HStack {
                                Text(c.label).fontWeight(.semibold).foregroundStyle(Color.primary)
                                Spacer()
                                Text(c.at.formatted(.dateTime.weekday(.abbreviated).hour().minute())).foregroundStyle(.secondary)
                            }
                        }
                        .disabled(busy || (needsReason && reason.trimmingCharacters(in: .whitespaces).isEmpty))
                    }
                }
                SwiftUI.Section("Pick a date and time") {
                    DatePicker("Until", selection: $own, in: Date().addingTimeInterval(120)...Date().addingTimeInterval(366 * 86400))
                    Button("Snooze") { go(own) }
                        .disabled(busy || own < Date().addingTimeInterval(60) || (needsReason && reason.trimmingCharacters(in: .whitespaces).isEmpty))
                }
                if target.reminder == nil {
                    SwiftUI.Section {
                        DisclosureGroup("Change these times", isExpanded: $editingTimes) {
                            MailSnoozeTimesForm(store: store)
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        #if os(macOS)
        .frame(minWidth: 440, minHeight: 480)
        #else
        .presentationDetents([.medium, .large])
        #endif
    }

    private func go(_ until: Date) {
        busy = true
        Task {
            if let r = target.reminder {
                let minutes = max(1, Int((until.timeIntervalSinceNow / 60).rounded(.up)))
                _ = await engine.snooze(r.id, minutes: minutes, reason: needsReason ? reason : nil)
            } else {
                await store.snooze(target.threads, until: until)
            }
            busy = false
            dismiss()
        }
    }
}

/// What "Later today", "Tomorrow", "This weekend" and "Next week" mean, kept on the hub for every device.
struct MailSnoozeTimesForm: View {
    @ObservedObject var store: MailStore
    @State private var t: MailSnoozeTimes?
    @State private var busy = false

    var body: some View {
        let v = t ?? store.snoozeTimes
        Group {
            Stepper("Later today: \(v.later_hours) hours on", value: bind(\.later_hours), in: 1...12)
            DatePicker("Tomorrow at", selection: time(\.tomorrow), displayedComponents: .hourAndMinute)
            Picker("This weekend", selection: bind(\.weekend_day)) { ForEach(0..<7, id: \.self) { Text(weekdays[$0]).tag($0) } }
            DatePicker("at", selection: time(\.weekend_time), displayedComponents: .hourAndMinute)
            Picker("Next week", selection: bind(\.week_day)) { ForEach(0..<7, id: \.self) { Text(weekdays[$0]).tag($0) } }
            DatePicker("at", selection: time(\.week_time), displayedComponents: .hourAndMinute)
            HStack {
                Button("Save") { busy = true; Task { await store.setSnoozeTimes(v); busy = false; t = nil } }
                    .disabled(busy || t == nil)
                Spacer()
                Button("Back to the usual times") { t = .defaults }
            }
            .buttonStyle(.borderless)
        }
    }

    private func bind(_ k: WritableKeyPath<MailSnoozeTimes, Int>) -> Binding<Int> {
        Binding(get: { (t ?? store.snoozeTimes)[keyPath: k] }, set: { var x = t ?? store.snoozeTimes; x[keyPath: k] = $0; t = x })
    }
    private func time(_ k: WritableKeyPath<MailSnoozeTimes, String>) -> Binding<Date> {
        Binding(get: { clockDate((t ?? store.snoozeTimes)[keyPath: k]) }, set: { var x = t ?? store.snoozeTimes; x[keyPath: k] = clockString($0); t = x })
    }
}

/// When this bundle's mail shows in the Inbox: as it arrives, once a day, once a week, or never (only here). Held
/// mail is always listed here; pinned mail always shows in the Inbox. With Notify me for its new mail.
struct MailDeliveryControl: View {
    @ObservedObject var store: MailStore
    var bundle: Mail.Bundle
    var mails: [MailThread]

    var body: some View {
        let d = store.delivery[bundle.id] ?? MailBundleDelivery(mode: .now)
        Picker("Show in Inbox", selection: Binding(get: { d.mode }, set: { mode in
            save(mode == .daily ? MailBundleDelivery(mode: mode, time: d.time ?? "07:00") : mode == .weekly ? MailBundleDelivery(mode: mode, time: d.time ?? "18:00", day: d.day ?? 0) : MailBundleDelivery(mode: mode))
        })) {
            Text("as it arrives").tag(MailBundleDelivery.Mode.now)
            Text("once a day").tag(MailBundleDelivery.Mode.daily)
            Text("once a week").tag(MailBundleDelivery.Mode.weekly)
            Text("never (only here)").tag(MailBundleDelivery.Mode.never)
        }
        if d.mode == .weekly {
            Picker("on", selection: Binding(get: { d.day ?? 0 }, set: { var x = d; x.day = $0; save(x) })) {
                ForEach(0..<7, id: \.self) { Text(weekdays[$0]).tag($0) }
            }
        }
        if d.mode == .daily || d.mode == .weekly {
            DatePicker("at", selection: Binding(get: { clockDate(d.time ?? "07:00") }, set: { var x = d; x.time = clockString($0); save(x) }), displayedComponents: .hourAndMinute)
        }
        Toggle("Notify me", isOn: Binding(get: { store.notify.bundles.contains(bundle.id) }, set: { on in Task { await store.setNotify(bundle: bundle.id, on: on) } }))
            .disabled(d.mode == .never)
            .help(d.mode == .never ? "This bundle skips the Inbox, so it never notifies" : d.mode == .now ? "A notification when new mail arrives in this bundle" : "A notification when this bundle's mail shows in your Inbox")
        Text(note(d)).font(.footnote).foregroundStyle(.secondary)
    }

    private func save(_ d: MailBundleDelivery) { Task { await store.setDelivery(bundle.id, d) } }

    private func note(_ d: MailBundleDelivery) -> String {
        let held = mails.filter { $0.state == .inbox && !$0.pinned && Mail.inboxAt($0.summary, delivery: store.delivery) == nil }
        let next = held.compactMap { Mail.deliveryAt($0.summary.at, d) }.min()
        let at = clockDate(d.time).formatted(date: .omitted, time: .shortened)
        switch d.mode {
        case .never: return "This bundle's mail stays out of your Inbox; it is all here."
        case _ where !held.isEmpty && next != nil: return "\(held.count) waiting: \(next!.formatted(.dateTime.weekday(.abbreviated).hour().minute()))."
        case .daily: return "New mail shows in your Inbox each day at \(at)."
        case .weekly: return "New mail shows in your Inbox each \(weekdays[(d.day ?? 0) % 7]) at \(at)."
        default: return "Pinned mail always shows in your Inbox."
        }
    }
}

/// A bundle of the owner's, made or changed: a name, one of eight colors, and rules: mail from these addresses, from
/// these domains (and domains under them), or whose subject has these words. Checked before the built-in bundles, so
/// yours wins; a person's mail can be in one.
struct MailBundleForm: View {
    @ObservedObject var store: MailStore
    var start: MailCustomBundle?
    /// Saved (its id) or deleted (nil).
    var done: (String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var color = 0
    @State private var addresses = ""
    @State private var domains = ""
    @State private var words = ""
    @State private var busy = false
    @State private var error: String?
    @State private var confirmDelete = false

    /// One rule per line, as typed (a comma also splits): blank lines and spaces at the ends left out.
    private func lines(_ s: String) -> [String] {
        s.components(separatedBy: CharacterSet(charactersIn: "\n,")).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name, prompt: Text("School"))
                    .onChange(of: name) { _, v in if v.count > 40 { name = String(v.prefix(40)) } }
                SwiftUI.Section("Color") {
                    HStack(spacing: 10) {
                        ForEach(0..<MailColors.custom.count, id: \.self) { i in
                            Button { color = i } label: {
                                Circle().fill(MailFill(key: .custom(i))).frame(width: 30, height: 30)
                                    .overlay(Circle().strokeBorder(Color.primary, lineWidth: color == i ? 3 : 0))
                                    .overlay(color == i ? Image(systemName: "checkmark").font(.caption.bold()).foregroundStyle(.white) : nil)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Color \(i + 1)")
                            .accessibilityAddTraits(color == i ? .isSelected : [])
                        }
                    }
                }
                SwiftUI.Section {
                    Text("Mail goes in this bundle when it matches any line below. Your bundles are checked before the built-in ones, and a person's mail can be in one.")
                        .font(.footnote).foregroundStyle(.secondary)
                    rules("From these addresses", $addresses, "coach@league.example")
                    rules("From these domains (and any under them)", $domains, "school.example")
                    rules("Subject has these words", $words, "field trip")
                }
                if let error { Text(verbatim: error).foregroundStyle(.dangerText) }
                if start != nil {
                    Button("Delete bundle", role: .destructive) { confirmDelete = true }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(start.map { "Edit \($0.name)" } ?? "New bundle")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(start == nil ? "Make bundle" : "Save") { save() }
                        .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .confirmationDialog("Delete the bundle \u{201C}\(start?.name ?? "")\u{201D}?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete bundle", role: .destructive) { remove() }
            } message: {
                Text("Its mail goes back to the other bundles; nothing in your mailbox changes.")
            }
            .onAppear {
                guard let s = start else { return }
                name = s.name; color = s.color
                addresses = s.addresses.joined(separator: "\n"); domains = s.domains.joined(separator: "\n"); words = s.words.joined(separator: "\n")
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 560)
        #endif
    }

    private func rules(_ label: String, _ text: Binding<String>, _ example: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.subheadline)
            TextField(label, text: text, prompt: Text(example), axis: .vertical)
                .lineLimit(2...6)
                #if os(iOS)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                #endif
        }
    }

    private func save() {
        busy = true
        error = nil
        let b = MailCustomBundle(id: start?.id ?? "", name: name.trimmingCharacters(in: .whitespaces), color: color, addresses: lines(addresses), domains: lines(domains), words: lines(words))
        Task {
            do { done(try await store.saveBundle(b, isNew: start == nil)) } catch { self.error = error.localizedDescription }
            busy = false
        }
    }

    private func remove() {
        guard let s = start else { return }
        busy = true
        Task {
            do { try await store.deleteBundle(s.id); done(nil) } catch { self.error = error.localizedDescription }
            busy = false
        }
    }
}

/// Each mailbox's last refresh or problem, what changes in the mailbox, and which new mail notifies and what it says.
struct MailSettingsSheet: View {
    @ObservedObject var store: MailStore
    @Environment(\.dismiss) private var dismiss
    @State private var foldNotes: [MailFoldNoteEntry]?

    var body: some View {
        NavigationStack {
            Form {
                SwiftUI.Section("Mailboxes") {
                    ForEach(store.list?.mailboxes ?? [], id: \.email) { m in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: m.email)
                            Text(m.last_refresh.flatMap(ISO.date).map { "Refreshed \($0.shortDateTime)" } ?? "Not refreshed yet")
                                .font(.footnote).foregroundStyle(.secondary)
                            if m.read_only == true {
                                Text("Read only: Aeneas changes nothing in it (Settings, Accounts).").font(.footnote).foregroundStyle(.secondary)
                            }
                            if let e = m.last_error { Text(verbatim: e).font(.footnote).foregroundStyle(.dangerText) }
                        }
                    }
                    Text("Opening a mail marks it read in your mailbox too, and Pin flags it there (a flag in your mail app pins it here); Done moves it to Archive there, and Undo moves it back.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                SwiftUI.Section("Notifications") {
                    Toggle("Notify me of mail from people", isOn: Binding(get: { store.notify.people }, set: { v in Task { await store.setNotify(people: v) } }))
                    Picker("Notifications show", selection: Binding(get: { store.notify.detail }, set: { v in Task { await store.setNotify(detail: v) } })) {
                        Text("sender and subject").tag(MailNotify.Detail.full)
                        Text("sender only").tag(MailNotify.Detail.sender)
                        Text("only a count").tag(MailNotify.Detail.count)
                    }
                    Text("A bundle's own switch is in its view, under Show in Inbox.").font(.footnote).foregroundStyle(.secondary)
                }
                MailSortingSettings(store: store, notes: $foldNotes)
                if let blocked = store.list?.blocked, !blocked.isEmpty {
                    SwiftUI.Section {
                        ForEach(blocked, id: \.self) { b in
                            HStack {
                                Text(verbatim: b)
                                Spacer()
                                Button("Unblock") { Task { await store.unblock(b) } }.buttonStyle(.borderless)
                            }
                        }
                    } header: {
                        Text("Blocked senders")
                    } footer: {
                        Text("Their mail goes to Spam.")
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Mailboxes and settings")
            .task { foldNotes = await store.foldNotes() }
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 520)
        #endif
    }
}
