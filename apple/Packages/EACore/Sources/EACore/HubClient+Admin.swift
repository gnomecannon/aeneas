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

/// Module 7 routes (life admin): checklists and the game picker.
extension HubClient {
    private struct ToggleBody: Encodable { var index: Int }
    private struct InstantiateBody: Encodable { var title: String? }
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
