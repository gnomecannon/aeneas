import Foundation

/// Invitations (CONTRACT.md section 3): the owner's Accept, Maybe and Decline, which the hub answers through where the
/// invitation came from, and Undo and Try again for an answer that goes by mail.
public struct InvitationAnswered: Decodable, Sendable {
    public var invitation: Entity
}

private struct AnswerBody: Encodable { var answer: String }
private struct NoBody: Encodable {}

extension HubClient {
    /// `POST /invitations/:id/answer`.
    public func answerInvitation(_ id: String, answer: Invitations.Answer) async throws -> InvitationAnswered {
        try await post("invitations/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)/answer", AnswerBody(answer: answer.rawValue), as: InvitationAnswered.self)
    }

    /// `POST /invitations/:id/undo` or `/retry`.
    public func invitationAct(_ id: String, _ what: String) async throws -> InvitationAnswered {
        try await post("invitations/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)/\(what == "retry" ? "retry" : "undo")", NoBody(), as: InvitationAnswered.self)
    }
}
