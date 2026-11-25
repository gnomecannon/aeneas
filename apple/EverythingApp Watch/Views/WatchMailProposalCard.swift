import SwiftUI
import EACore

/// A mail the assistant wrote for the owner to send, under its answer on the Watch's Ask page (since 2026-11-24): who
/// it goes to, its subject and words, then Send and Cancel (Undo while it waits, Try again when it was not sent).
/// Nothing is sent until Send is tapped. The Watch has no writing box: changing the mail is on the iPhone.
struct WatchMailProposalCard: View {
    @EnvironmentObject var engine: SyncEngine
    var p: ChatMailProposal
    @State private var view: MailProposal??
    @State private var busy = false
    @State private var err: String?
    @State private var looks = 0

    var body: some View {
        let shown = view.flatMap { $0 }
        let face = Mail.proposalFace(shown, stored: p.state)
        VStack(alignment: .leading, spacing: 4) {
            Text(Mail.ProposalTexts.title).font(.caption2.weight(.semibold))
            if view != nil {
                if face.showMail, let v = shown {
                    Text(verbatim: "To \((v.to + v.cc).joined(separator: ", "))").font(.caption2).foregroundStyle(.secondary)
                    Text(verbatim: v.subject.isEmpty ? "(no subject)" : v.subject).font(.caption2.weight(.semibold))
                    Text(verbatim: v.text).font(.caption2)
                }
                Text(verbatim: face.line).font(.caption2)
                if let e = face.error { Text(verbatim: e).font(.caption2).foregroundStyle(.orange) }
                // Edit is the iPhone's: the Watch shows how instead of a button.
                ForEach(face.buttons.filter { $0 != .edit }, id: \.self) { b in
                    Button(b == .send ? "Send" : b == .cancel ? "Cancel" : b == .undo ? "Undo" : "Try again", role: b == .cancel ? .destructive : nil) { tap(b) }
                        .disabled(busy)
                }
                if face.buttons.contains(.edit) { Text(Mail.ProposalTexts.watchEdit).font(.caption2).foregroundStyle(.secondary) }
            }
            if let err { Text(verbatim: err).font(.caption2).foregroundStyle(.orange) }
        }
        .padding(6)
        .background(Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
        .task(id: "\(p.id):\(looks)") {
            while !Task.isCancelled {
                guard let c = engine.readyClient() else { return }
                do {
                    let v = try await c.mailProposal(p.id)
                    view = .some(v)
                    guard let v, v.state == "waiting" || v.state == "sending" else { return }
                } catch { err = (error as? HubError)?.errorDescription ?? error.localizedDescription; return }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    private func tap(_ b: Mail.ProposalButton) {
        guard let c = engine.readyClient() else { err = "Not connected to the hub"; return }
        busy = true
        err = nil
        Task {
            defer { busy = false }
            do { view = .some(try await c.mailProposalAct(p.id, b)); looks += 1 } catch { err = (error as? HubError)?.errorDescription ?? error.localizedDescription }
        }
    }
}
