import Foundation

// Module 4 routes that are not plain synced data: sensor series and CSV, the food picker.
// Pet custody is derived on the device from the synced `<pet> week` plan rule, the same rule the hub uses.

/// One point of a sensor's 24 h series from `GET /sensors`.
public struct SensorPoint: Codable, Equatable, Hashable, Sendable {
    public var at: String
    public var value: Double
    public init(at: String, value: Double) { self.at = at; self.value = value }
    public var date: Date? { ISO.date(at) }
}

/// One row of `GET /sensors`: the sensor entity with `series_24h` added next to its envelope.
public struct SensorWithSeries: Decodable, Sendable {
    public var entity: Entity
    public var series_24h: [SensorPoint]

    enum CodingKeys: String, CodingKey { case series_24h }

    public init(from decoder: Decoder) throws {
        entity = try Entity(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        series_24h = try c.decodeIfPresent([SensorPoint].self, forKey: .series_24h) ?? []
    }
}

public struct FoodPickRequest: Encodable, Sendable {
    public var meal: String
    public var mode: String?
    public var budget: Double?
    public var exclude: [String]?
    public init(meal: String, mode: String? = nil, budget: Double? = nil, exclude: [String]? = nil) {
        self.meal = meal; self.mode = mode; self.budget = budget; self.exclude = exclude
    }
}

/// `POST /food/pick`: one option (or none, with `why` saying what to add) and a runner up.
public struct FoodPickResult: Decodable, Sendable {
    public var pick: Entity?
    public var why: String
    public var runner_up: Entity?
    public var constraints_used: [String]

    enum CodingKeys: String, CodingKey { case pick, why, runner_up, constraints_used }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pick = try c.decodeIfPresent(Entity.self, forKey: .pick)
        why = try c.decodeIfPresent(String.self, forKey: .why) ?? ""
        runner_up = try c.decodeIfPresent(Entity.self, forKey: .runner_up)
        constraints_used = try c.decodeIfPresent([String].self, forKey: .constraints_used) ?? []
    }
}

extension HubClient {
    /// `GET /sensors`: every sensor with its hub state and a downsampled 24 h series.
    public func sensors() async throws -> [SensorWithSeries] { try await get("sensors", as: [SensorWithSeries].self) }

    /// `POST /sensors/:name/propose`: tapping an alert. The hub starts (or reopens) a chat where the assistant finds
    /// the cause and proposes one fix, which runs only when approved there.
    public func proposeSensorFix(name: String) async throws -> String {
        struct R: Decodable { var session_id: String }
        let path = "sensors/\(name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name)/propose"
        return try await post(path, [String: String](), as: R.self).session_id
    }

    /// `GET /sensors/:name/csv?days=`: `at,value,unit` rows as text.
    public func sensorCSV(name: String, days: Int = 30) async throws -> String {
        let path = "sensors/\(name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name)/csv"
        return String(decoding: try await send("GET", path, query: ["days": String(days)]), as: UTF8.self)
    }

    public func foodPick(_ req: FoodPickRequest) async throws -> FoodPickResult { try await post("food/pick", req, as: FoodPickResult.self) }

    /// `POST /food/picked`: the hub records `last_picked` and `times_picked` and returns the option.
    public func foodPicked(id: String) async throws -> Entity {
        struct B: Encodable { var id: String }
        return try await post("food/picked", B(id: id), as: Entity.self)
    }
}
