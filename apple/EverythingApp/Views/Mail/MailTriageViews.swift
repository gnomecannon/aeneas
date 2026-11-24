import SwiftUI
import EACore

// What the hub works out about mail, shown as the web shows it: a mail's cards (its key facts, as text, with Track or
// Open), the trips in the Trips bundle, the hub's model's sorting of new mail (Sort new mail, Needs you), and the
// folding notes ("Folded too much?"). All of it is the sender's words or the model's guess: shown as text, never as a
// page, and the model's words always with the note that they can be wrong.

/// A mail's cards above its body: each one's facts as text, and Track (a package) or Open when it has an https link,
/// opened outside the app like any link in a mail.
struct MailFactsView: View {
    var cards: [MailCard]
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(cards.enumerated()), id: \.offset) { _, c in
                HStack(spacing: 8) {
                    MailCardIcon(card: c, size: 28)
                    Text(verbatim: Mail.cardLine(c)).font(.subheadline).textSelection(.enabled)
                    Spacer(minLength: 4)
                    if let url = Mail.cardLink(c) {
                        Button(c.kind == "package" ? "Track" : "Open") { openURL(url) }
                            .buttonStyle(.bordered).controlSize(.small)
                            .help(url.host ?? "")
                    }
                }
            }
            if cards.contains(where: { $0.source == "text" }) {
                Text("Read from the mail's text: check it against the mail.").font(.footnote).foregroundStyle(.secondary)
            }
        }
    }
}

/// A card's icon on its bundle's color (a package on Transactions', a flight on Trips', a bill on Bills').
struct MailCardIcon: View {
    var card: MailCard
    var size: CGFloat = 16

    var body: some View {
        let b = Mail.bundles.first { $0.id == Mail.cardBundle(card) } ?? Mail.bundles[0]
        RoundedRectangle(cornerRadius: size / 4)
            .fill(MailFill(key: b.colorKey))
            .overlay(Image(systemName: b.symbol).font(.system(size: size * 0.5, weight: .semibold)).foregroundStyle(.white))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// A trip as one box (the Trips bundle): its name and days, then its pieces in time order (the flight out, the hotel,
/// the flight back), each opening its own mail.
struct MailTripBox: View {
    var trip: Mail.Trip<MailThread>
    var open: (MailThread) -> Void

    var body: some View {
        let past = trip.end.addingTimeInterval(86_400) < Date()
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                MailCardIcon(card: MailCard(kind: "flight"), size: 28)
                Text(verbatim: trip.name).fontWeight(.bold)
                Text(verbatim: "\u{00B7} \(Mail.tripDates(start: trip.start, end: trip.end))\(past ? " \u{00B7} Over" : "")").foregroundStyle(.secondary)
            }
            ForEach(Array(trip.parts.enumerated()), id: \.offset) { _, p in
                Button { open(p.mail) } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(verbatim: p.card.at.map { Mail.cardTime($0) } ?? "").font(.caption).foregroundStyle(.secondary).frame(minWidth: 110, alignment: .leading)
                        Text(verbatim: Mail.cardLine({ var c = p.card; c.at = nil; return c }()))
                            .fontWeight(p.mail.isUnread ? .semibold : .regular)
                            .lineLimit(2)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.leading, 36)
            }
        }
        .opacity(past ? 0.7 : 1)
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(trip.name), \(Mail.tripDates(start: trip.start, end: trip.end))")
    }
}

/// New mail the hub's model has not sorted yet, above the Inbox: how much waits, with Sort new mail (the model runs
/// only when the owner asks, here); while a run goes, how much is left; after a run that ended early, why.
struct MailSortRow: View {
    @ObservedObject var store: MailStore
    var row: (text: String, button: Bool)
    @State private var busy = false

    var body: some View {
        HStack(spacing: 10) {
            Text(verbatim: row.text).font(.footnote).foregroundStyle(.secondary)
            Spacer(minLength: 6)
            if row.button {
                Button("Sort new mail") { busy = true; Task { await store.sortNewMail(); busy = false } }
                    .buttonStyle(.bordered).controlSize(.small)
                    .disabled(busy)
            }
        }
    }
}

/// One mail of the Needs you digest: who, Today and Reply marks, and the model's one line (else the subject). It
/// opens the mail where it is listed.
struct MailNeedRow: View {
    var thread: MailThread

    var body: some View {
        let s = thread.summary
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(verbatim: thread.people).fontWeight(.semibold).lineLimit(1)
                if s.triage?.urgency == "today" { chip("Today") }
                if s.triage?.needs_reply == true { chip("Reply") }
            }
            Text(verbatim: s.triage?.summary ?? (s.subject.isEmpty ? "(no subject)" : s.subject)).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private func chip(_ t: String) -> some View {
        Text(t).font(.caption2.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 1)
            .foregroundStyle(.white).background(Capsule().fill(MailFill(key: .place("inbox"))))
    }
}

/// "Something important folded away?": the first lines the fold hides, to mark the ones that matter, and Don't fold
/// this mail. Saved as a note on the mail on the hub (with it, never sent anywhere), to improve how mail is folded.
struct MailFoldNoteSheet: View {
    @ObservedObject var store: MailStore
    var mail: MailSummary
    var lines: [String]
    /// Saved: whether the mail is now shown unfolded.
    var saved: (Bool) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var marked: Set<String> = []
    @State private var unfold = true
    @State private var err: String?

    var body: some View {
        NavigationStack {
            Form {
                if !lines.isEmpty {
                    SwiftUI.Section {
                        ForEach(lines, id: \.self) { l in
                            Toggle(isOn: Binding(get: { marked.contains(l) }, set: { if $0 { marked.insert(l) } else { marked.remove(l) } })) { Text(verbatim: l) }
                        }
                    } footer: {
                        Text("Mark the lines that matter. They stay on your hub as a note for improving how mail is folded.")
                    }
                }
                Toggle("Don't fold this mail", isOn: $unfold)
                if let err { Text(verbatim: err).foregroundStyle(.dangerText) }
            }
            .formStyle(.grouped)
            .navigationTitle("Something important folded away?")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            do {
                                try await store.saveFoldNote(mail.id, lines: lines.filter(marked.contains), noFold: unfold)
                                saved(unfold)
                                dismiss()
                            } catch { err = error.localizedDescription }
                        }
                    }
                    .disabled(marked.isEmpty && !unfold)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 380)
        #endif
    }
}

/// Triage on or off, and the folding notes the owner made (read by the sheet when it opens), for the Mailboxes and
/// settings sheet.
struct MailSortingSettings: View {
    @ObservedObject var store: MailStore
    @Binding var notes: [MailFoldNoteEntry]?

    var body: some View {
        // Only a hub that sorts mail has the switch (an older one sends no `triage`).
        if let on = store.list?.triage {
            SwiftUI.Section("Sorting") {
                Toggle(isOn: Binding(get: { on }, set: { v in Task { await store.setTriage(v) } })) {
                    Text("Sort new mail with your hub's model (Needs you)")
                }
                let auto = store.list?.triage_state?.auto
                Text("\(auto == nil ? "" : auto == true ? "It runs after each refresh. " : "It runs when you press Sort new mail. ")Its one-line summaries are kept a week; turning this off erases them.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        if let notes, !notes.isEmpty {
            SwiftUI.Section {
                ForEach(notes) { n in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: "\(n.subject.isEmpty ? "(no subject)" : n.subject) \u{00B7} \(n.from)\(n.note.no_fold ? " \u{00B7} not folded" : "")")
                        Text(verbatim: "Folded at: \(n.note.cut.isEmpty ? "(the page's own fold)" : n.note.cut)").font(.footnote).foregroundStyle(.secondary)
                        ForEach(n.note.lines, id: \.self) { l in Text(verbatim: "\u{2713} \(l)").font(.footnote) }
                    }
                }
                Button("Clear the notes") { Task { await store.clearFoldNotes(); self.notes = [] } }
            } header: {
                Text("Folding notes (\(notes.count))")
            } footer: {
                Text("Where folding hid something you marked. Kept with each mail on your hub, never sent anywhere.")
            }
        }
    }
}
