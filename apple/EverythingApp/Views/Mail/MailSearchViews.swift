import SwiftUI
import EACore

// Searching all kept mail on the hub (every folder, whole texts) and all mail with one person, as on the web, and the
// Mail screen's keys list.

/// A search hit as a row: who (those it went to, for the owner's own), where it is, the subject and the words around
/// the first match, and when.
struct MailHitRow: View {
    var hit: MailSearchHit

    var body: some View {
        let s = hit.summary
        HStack(alignment: .top, spacing: 10) {
            Color.clear.frame(width: 8, height: 8)
            Circle().fill(Color.secondary.opacity(0.22))
                .overlay(Text(verbatim: Mail.initials(hit.isOwners ? hit.to[0] : s.from)).font(.system(size: 14, weight: .semibold)))
                .frame(width: 38, height: 38)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(verbatim: hit.isOwners ? "To: \(hit.to.map(Mail.personLabel).joined(separator: ", "))" : Mail.personLabel(s.from))
                        .fontWeight(.semibold).lineLimit(1)
                    Text(verbatim: Mail.whereLabel(hit)).font(.caption2.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 1)
                        .background(Capsule().fill(Color.secondary.opacity(0.18)))
                    Spacer(minLength: 6)
                    Text(verbatim: Mail.whenLabel(s.at)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Text(verbatim: s.subject.isEmpty ? "(no subject)" : s.subject).font(.subheadline).lineLimit(1)
                if !hit.snippet.isEmpty { Text(verbatim: hit.snippet).font(.subheadline).foregroundStyle(.secondary).lineLimit(2) }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// A search hit open: who sent it (the real address) and where it is, Show it in its place for mail in the Inbox,
/// Snoozed or Done, All mail with its sender, then the message whole. On the Mac in place in the list (`inline`).
struct MailHitView: View {
    @ObservedObject var store: MailStore
    var id: String
    /// Showing all mail with one person now: no All mail with here.
    var inPersonView: Bool
    var showInPlace: (MailSearchHit) -> Void
    var showPerson: (MailAddress) -> Void
    /// In place in the list (the Mac): no scrolling of its own, no title, and its heading closes it (`closed`).
    var inline = false
    var closed: () -> Void = {}

    var body: some View {
        Group {
            if let h = store.hit(id) {
                if inline {
                    content(h)
                } else {
                    ScrollView {
                        content(h)
                            .padding()
                            .frame(maxWidth: 820, alignment: .leading)
                            .frame(maxWidth: .infinity)
                    }
                }
            } else {
                MailEmpty(title: "Not here any more", text: "This mail is no longer among what the search found.")
            }
        }
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .modifier(MailPageTitle(title: "Search", shown: !inline))
    }

    private func content(_ h: MailSearchHit) -> some View {
        let s = h.summary
        return VStack(alignment: .leading, spacing: 14) {
            MailOpenHeading(inline: inline, close: closed) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: s.subject.isEmpty ? "(no subject)" : s.subject).font(.title3.weight(.semibold)).mailSelectable(!inline)
                    Text(verbatim: "\(Mail.personLabel(s.from)) <\(s.from.address)>").font(.subheadline).mailSelectable(!inline)
                    Text(verbatim: "\(ISO.date(s.at)?.shortDateTime ?? "") \u{00B7} \(Mail.whereLabel(h))").font(.caption).foregroundStyle(.secondary)
                }
            }
            FlowLayout(spacing: 8) {
                if h.isListed {
                    Button { showInPlace(h) } label: { Label("Show it in its place", systemImage: "tray") }
                }
                if !s.isMine && !inPersonView {
                    Button { showPerson(s.from) } label: { Label("All mail with \(firstName(s.from))", systemImage: "person") }
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            MailMessageBody(store: store, mail: s)
        }
    }

    private func firstName(_ a: MailAddress) -> String { Mail.personLabel(a).split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? a.address }
}

/// The Mail screen's keys, for a keyboard on the Mac or the iPad. The Mac, where mail opens in place in the list as on
/// the web, has the web's keys (Return opens, Esc closes, Space selects).
struct MailKeysSheet: View {
    @Environment(\.dismiss) private var dismiss

    private var keys: [(keys: String, does: String)] {
        #if os(macOS)
        Mail.keysInPlace
        #else
        Mail.keys
        #endif
    }

    var body: some View {
        NavigationStack {
            Form {
                ForEach(keys, id: \.keys) { k in
                    LabeledContent(k.does) { Text(verbatim: k.keys).font(.body.monospaced()) }
                }
                Text("The keys work while the list has the focus, never while you type.").font(.footnote).foregroundStyle(.secondary)
                #if os(macOS)
                Text("Command-click selects or unselects a mail, and Shift-click selects every mail up to it.").font(.footnote).foregroundStyle(.secondary)
                #endif
            }
            .formStyle(.grouped)
            .navigationTitle("Keyboard keys")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 440)
        #endif
    }
}
