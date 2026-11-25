import SwiftUI
import EACore

/// A mail the assistant wrote for the owner to send (since 2026-11-24), under its reply in the chat, as the web's card
/// (web/src/views/Assistant.tsx MailProposalCard): From, To and Cc, Subject and the whole text, then Send, Edit and
/// Cancel. Nothing is sent until Send is tapped; Send puts it in the hub's outbox with its 10 seconds of Undo (the
/// card says Sending, with Undo), Edit opens New mail on the Mail screen filled with it, Cancel drops it. Once sent,
/// cancelled or opened to edit, the card says so and its buttons go; one the hub no longer keeps says so too.
struct MailProposalCard: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    var p: ChatMailProposal
    /// nil until asked; then the card, or `.none` once the hub no longer keeps it.
    @State private var view: MailProposal??
    @State private var busy = false
    @State private var err: String?
    @State private var looks = 0

    var body: some View {
        let shown = view.flatMap { $0 }
        let face = Mail.proposalFace(shown, stored: p.state)
        VStack(alignment: .leading, spacing: 8) {
            Text(Mail.ProposalTexts.title).font(.subheadline.weight(.semibold))
            if view == nil {
                ProgressView().controlSize(.small)
            } else {
                if face.showMail, let v = shown {
                    Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 4) {
                        row("From", v.from.name.isEmpty ? v.from.address : "\(v.from.name) <\(v.from.address)>")
                        row("To", v.to.joined(separator: ", "))
                        if !v.cc.isEmpty { row("Cc", v.cc.joined(separator: ", ")) }
                        if !v.files.isEmpty { row("Files", v.files.map(\.name).joined(separator: ", ")) }
                        row("Subject", v.subject.isEmpty ? "(no subject)" : v.subject)
                    }
                    .font(.footnote)
                    Text(verbatim: v.text)
                        .font(.callout)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                }
                Text(verbatim: face.line).font(.footnote).foregroundStyle(face.buttons.isEmpty ? .secondary : .primary)
                if let e = face.error { Text(verbatim: e).font(.footnote).foregroundStyle(.dangerText) }
                if !face.buttons.isEmpty {
                    HStack(spacing: 8) {
                        ForEach(Array(face.buttons.enumerated()), id: \.offset) { i, b in
                            if i == 0 {
                                Button(label(b)) { tap(b) }.buttonStyle(.borderedProminent)
                            } else {
                                Button(label(b), role: b == .cancel ? .destructive : nil) { tap(b) }.buttonStyle(.bordered)
                            }
                        }
                    }
                    .controlSize(.small)
                    .disabled(busy)
                }
            }
            if let err { Text(verbatim: err).font(.footnote).foregroundStyle(.dangerText) }
        }
        .padding(12)
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.secondary.opacity(0.35), lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Mail.ProposalTexts.title)
        // Asked when the card shows, and every second while the mail waits or is on its way.
        .task(id: "\(p.id):\(looks)") {
            while !Task.isCancelled {
                do {
                    let v = try await load()
                    view = .some(v)
                    guard let v, v.state == "waiting" || v.state == "sending" else { return }
                } catch { err = (error as? HubError)?.errorDescription ?? error.localizedDescription; return }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    private func row(_ name: String, _ value: String) -> some View {
        GridRow {
            Text(name).foregroundStyle(.secondary).gridColumnAlignment(.trailing)
            Text(verbatim: value).textSelection(.enabled)
        }
    }

    private func label(_ b: Mail.ProposalButton) -> String {
        switch b {
        case .send: return "Send"
        case .edit: return "Edit"
        case .cancel: return "Cancel"
        case .undo: return "Undo"
        case .retry: return "Try again"
        }
    }

    /// The card from the hub (a made-up one in Debug builds' demo chat, -EAMailProposalDemo).
    private func load() async throws -> MailProposal? {
        #if DEBUG
        if p.id.hasPrefix("fake-proposal") { return MailProbe.fakeProposal(p.id) }
        #endif
        guard let c = engine.client else { throw HubError.notConfigured }
        return try await c.mailProposal(p.id)
    }

    private func tap(_ b: Mail.ProposalButton) {
        busy = true
        err = nil
        Task {
            defer { busy = false }
            do {
                #if DEBUG
                if p.id.hasPrefix("fake-proposal") {
                    if b == .edit { MailWriting.shared.openNewMail(try MailProbe.fakeProposalEdit(p.id).writing); model.section = .mail } else { view = .some(MailProbe.fakeProposalAct(p.id, b)) }
                    looks += 1
                    return
                }
                #endif
                guard let c = engine.client else { throw HubError.notConfigured }
                if b == .edit {
                    let e = try await c.mailProposalEdit(p.id)
                    MailWriting.shared.openNewMail(e.writing)
                    model.section = .mail
                    looks += 1
                    return
                }
                view = .some(try await c.mailProposalAct(p.id, b))
                looks += 1
            } catch { err = (error as? HubError)?.errorDescription ?? error.localizedDescription }
        }
    }
}
