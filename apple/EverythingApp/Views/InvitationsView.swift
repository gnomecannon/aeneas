import SwiftUI
import EACore
#if os(macOS)
import AppKit
#endif

/// The invitations waiting for an answer (CONTRACT.md section 3, Invitations), as Calendar's invitations list: each
/// with Accept, Maybe and Decline, which the hub answers through where it came from (the iCloud calendar, or a reply
/// mail with Undo), or Open in Calendar for one only Apple Calendar holds (EventKit cannot change an answer). Answered
/// ones are under Answered, folded. Opened from Week (its Invitations button) and from Today's Needs you.
struct InvitationsView: View {
    @EnvironmentObject var engine: SyncEngine
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var busy: String?
    @State private var errors: [String: String] = [:]
    /// An answer stays on its row for two seconds, then the row moves to Answered.
    @State private var held: [String: Invitations.Answer] = [:]
    @State private var showAnswered = false

    var body: some View {
        let list = Invitations.list(engine.list(.invitation), now: Date())
        let pendingIds = Set(list.pending.map(\.id))
        let shown = list.pending + list.answered.filter { held[$0.id] != nil && !pendingIds.contains($0.id) }
        let rest = list.answered.filter { held[$0.id] == nil }
        List {
            if shown.isEmpty {
                Text(Invitations.Texts.none).foregroundStyle(.secondary)
            } else {
                SwiftUI.Section {
                    ForEach(shown) { row($0, answered: false) }
                }
            }
            if !rest.isEmpty {
                SwiftUI.Section {
                    DisclosureGroup(isExpanded: $showAnswered) {
                        ForEach(rest) { row($0, answered: true) }
                    } label: {
                        Text("\(Invitations.Texts.answered) (\(rest.count))")
                    }
                }
            }
        }
        .navigationTitle(Invitations.Texts.title)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        }
    }

    @ViewBuilder
    private func row(_ e: Entity, answered: Bool) -> some View {
        let who = Invitations.organizer(e)
        let reply = Invitations.replyLine(e)
        let chosen = Invitations.chosen(e)
        VStack(alignment: .leading, spacing: 6) {
            Text(StyleGuard.dashes(e.str("title"))).font(.body.weight(.semibold))
            if !who.isEmpty { Text(StyleGuard.dashes(who)).font(.subheadline).foregroundStyle(.secondary) }
            Text(Invitations.when(e) + (e.bool("repeats") == true ? ", repeats" : "")).font(.subheadline)
            if !e.str("location").isEmpty { Text(StyleGuard.dashes(e.str("location"))).font(.subheadline).foregroundStyle(.secondary) }
            if Invitations.inCalendarApp(e) {
                Button(Invitations.Texts.openInCalendar) { openInCalendar(e) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            } else {
                HStack(spacing: 8) {
                    ForEach(Invitations.Answer.allCases) { a in
                        let on = chosen == a
                        Button(a.label) { answer(e, a) }
                            .buttonStyle(on ? AnyPrimitiveButtonStyle(.borderedProminent) : AnyPrimitiveButtonStyle(.bordered))
                            .accessibilityAddTraits(on ? .isSelected : [])
                    }
                }
                .controlSize(.small)
                .disabled(busy == e.id || (reply != nil && reply?.retry == false))
            }
            if let a = held[e.id], reply == nil { Text(a.done).font(.footnote) }
            if let r = reply {
                HStack(spacing: 8) {
                    Text(verbatim: r.text).font(.footnote).foregroundStyle(r.retry ? AnyShapeStyle(.dangerText) : AnyShapeStyle(.primary))
                    if r.retry { Button(Invitations.Texts.retry) { act(e, "retry") }.buttonStyle(.bordered).controlSize(.small) }
                    if r.undo { Button(Invitations.Texts.undo) { act(e, "undo") }.buttonStyle(.bordered).controlSize(.small) }
                }
                .disabled(busy == e.id)
            }
            if answered, let c = chosen { Text(Invitations.Texts.state(c.rawValue)).font(.footnote).foregroundStyle(.secondary) }
            if let err = errors[e.id], !err.isEmpty { Text(verbatim: err).font(.footnote).foregroundStyle(.dangerText) }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
    }

    private func answer(_ e: Entity, _ a: Invitations.Answer) {
        run(e) { c in try await c.answerInvitation(e.id, answer: a) } after: {
            held[e.id] = a
            Task { try? await Task.sleep(for: .seconds(2)); held[e.id] = nil }
        }
    }

    private func act(_ e: Entity, _ what: String) {
        run(e) { c in try await c.invitationAct(e.id, what) } after: {}
    }

    private func run(_ e: Entity, _ call: @escaping (HubClient) async throws -> InvitationAnswered, after: @escaping () -> Void) {
        guard let c = engine.client else { errors[e.id] = Invitations.Texts.offline; return }
        busy = e.id
        errors[e.id] = nil
        Task {
            defer { busy = nil }
            do {
                let out = try await call(c)
                await engine.absorb(out.invitation)
                after()
            } catch {
                // The hub's own words, without the status code: "HTTP 409:" in front only puzzles.
                errors[e.id] = (error as? HubError).map { if case .http(_, let m) = $0 { return m }; return $0.errorDescription ?? $0.localizedDescription } ?? error.localizedDescription
            }
        }
    }

    /// The Calendar app at the event: its day on the iPhone and iPad (`calshow:`), the event itself on the Mac when it
    /// is on this Mac, else Calendar.
    private func openInCalendar(_ e: Entity) {
        let start = e.date("start") ?? Date()
        #if os(macOS)
        let event = e.fields["from"]?.objectValue?["event"]?.stringValue ?? ""
        if let url = DeviceInvitations.calendarURL(eventIdentifier: event, start: start) { NSWorkspace.shared.open(url); return }
        if let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.iCal") { NSWorkspace.shared.openApplication(at: app, configuration: .init()) }
        #else
        if let url = Invitations.calshowURL(start) { openURL(url) }
        #endif
    }
}

/// A button style chosen at run time (the chosen answer filled in, the others bordered).
struct AnyPrimitiveButtonStyle: PrimitiveButtonStyle {
    private let make: (Configuration) -> AnyView
    init<S: PrimitiveButtonStyle>(_ style: S) { make = { AnyView(style.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
}

/// Week's toolbar button: the tray, with how many wait beside it.
struct InvitationsButtonLabel: View {
    var count: Int
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: count > 0 ? "tray.full" : "tray")
            if count > 0 { Text("\(count)").font(.caption.weight(.semibold)).monospacedDigit() }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(count > 0 ? "\(Invitations.Texts.title), \(count) waiting" : Invitations.Texts.title)
    }
}
