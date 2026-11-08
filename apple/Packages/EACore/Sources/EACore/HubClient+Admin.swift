import Foundation

/// `POST /games/pick` answer: the pick (nil when nothing fits), why, and the runner-up.
public struct GamePick: Decodable, Equatable, Sendable {
    public var pick: Entity?
    public var why: String
    public var runner_up: Entity?
    public var considered: Int?

    enum CodingKeys: String, CodingKey { case pick, why, runner_up, considered }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pick = try c.decodeIfPresent(Entity.self, forKey: .pick)
        why = try c.decodeIfPresent(String.self, forKey: .why) ?? ""
        runner_up = try c.decodeIfPresent(Entity.self, forKey: .runner_up)
        considered = try c.decodeIfPresent(Int.self, forKey: .considered)
    }
}

/// `POST /applications/:id/cover-letter` answer: the saved note and the backend that drafted it.
public struct CoverLetterResponse: Decodable, Sendable {
    public var note: Entity
    public var backend: String
}

/// Why a cover letter draft failed, read from the hub's status and error body.
public enum CoverLetterError: Error, LocalizedError, Sendable {
    /// 503: no model backend is reachable.
    case noModel
    /// 422: the draft named employers that are not in the facts or the job text. Nothing was saved.
    case invented(names: [String], message: String)
    case hub(HubError)

    public var errorDescription: String? {
        switch self {
        case .noModel: return "No model reachable. Try again when the model host is up."
        case .invented(let names, let message):
            return names.isEmpty ? "\(message). Nothing was saved." : "The draft named employers not in your facts or the job text: \(names.joined(separator: ", ")). Nothing was saved."
        case .hub(let h): return h.errorDescription
        }
    }
}

/// Module 7 routes (life admin): checklists, cover letters, the game picker.
extension HubClient {
    private struct ToggleBody: Encodable { var index: Int }
    private struct InstantiateBody: Encodable { var title: String? }
    private struct LetterBody: Encodable { var job_text: String?; var tone: String? }
    private struct PickBody: Encodable { var players: [String]; var hours: Double?; var coop: Bool?; var exclude: [String]? }
    private struct Empty: Encodable {}

    /// `POST /checklists/:id/toggle`: flips `done_at` on one item.
    public func checklistToggle(_ id: String, index: Int) async throws -> Entity {
        try await post("checklists/\(id)/toggle", ToggleBody(index: index), as: Entity.self)
    }

    /// `POST /checklists/:id/instantiate`: a copy of a template with every `done_at` cleared.
    public func checklistInstantiate(_ id: String, title: String? = nil) async throws -> Entity {
        let t = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        return try await post("checklists/\(id)/instantiate", InstantiateBody(title: (t?.isEmpty ?? true) ? nil : t), as: Entity.self)
    }

    /// `POST /applications/:id/cover-letter`. Throws `CoverLetterError` so the 503 and 422 cases can be told apart.
    public func coverLetter(_ id: String, jobText: String?, tone: String?) async throws -> CoverLetterResponse {
        let job = jobText?.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = try JSONCoding.data(LetterBody(job_text: (job?.isEmpty ?? true) ? nil : job, tone: tone))
        let (status, data): (Int, Data)
        do { (status, data) = try await transport.send(method: "POST", path: "applications/\(id)/cover-letter", query: [:], body: body) }
        catch let h as HubError { throw CoverLetterError.hub(h) }
        guard (200..<300).contains(status) else {
            let err = try? JSONCoding.decode(APIError.self, from: data)
            if status == 503 { throw CoverLetterError.noModel }
            if status == 422 { throw CoverLetterError.invented(names: Self.guardNames(err?.detail), message: err?.error ?? "Rejected") }
            throw CoverLetterError.hub(.http(status: status, message: err?.error ?? String(decoding: data.prefix(200), as: UTF8.self)))
        }
        do { return try decode(CoverLetterResponse.self, data) } catch let h as HubError { throw CoverLetterError.hub(h) }
    }

    /// Names the hub's 422 cover-letter guard reported, from whichever shape the detail has.
    static func guardNames(_ detail: JSONValue?) -> [String] {
        guard let d = detail else { return [] }
        if let a = d.arrayValue { return a.map(\.displayString) }
        for k in ["invented", "names", "employers"] {
            if let a = d.objectValue?[k]?.arrayValue { return a.map(\.displayString) }
        }
        return []
    }

    /// `POST /games/pick`: one game every listed player owns.
    public func gamePick(players: [String], hours: Double? = nil, coop: Bool = false, exclude: [String] = []) async throws -> GamePick {
        try await post("games/pick", PickBody(players: players, hours: hours, coop: coop ? true : nil, exclude: exclude), as: GamePick.self)
    }

    /// `POST /games/:id/played`: sets `last_played`.
    public func gamePlayed(_ id: String) async throws -> Entity {
        try await post("games/\(id)/played", Empty(), as: Entity.self)
    }

    /// `GET /games/art/:appid`: a game's Steam header picture, fetched by the hub, so Steam's servers never see
    /// this device.
    public func gameArt(appid: Int) async throws -> Data {
        try await send("GET", "games/art/\(appid)")
    }
}
