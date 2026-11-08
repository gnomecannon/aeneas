import Foundation

extension HubClient {
    /// `GET /prefs/feel`: shapes, palettes, tap sound and app colors for every device, with the key and scale to play.
    public func feel() async throws -> FeelSettings { try await get("prefs/feel", as: FeelSettings.self) }

    /// `PUT /prefs/feel` merges the fields given (lists are replaced whole) and returns the whole setting.
    public func setFeel(_ patch: [String: JSONValue]) async throws -> FeelSettings {
        try await post("prefs/feel", patch, as: FeelSettings.self, method: "PUT")
    }

    /// `POST /prefs/feel/images?name=`: a PNG of at most 512 KB becomes an image shape. Returns the whole setting.
    public func addFeelImage(png: Data, name: String) async throws -> FeelSettings {
        try decode(FeelSettings.self, try await send("POST", "prefs/feel/images", query: ["name": name], body: png))
    }

    /// `GET /prefs/feel/images/:id`: the image's bytes.
    public func feelImage(_ id: String) async throws -> Data { try await send("GET", "prefs/feel/images/\(id)") }

    /// `DELETE /prefs/feel/images/:id`. Returns the whole setting.
    public func deleteFeelImage(_ id: String) async throws -> FeelSettings {
        try decode(FeelSettings.self, try await send("DELETE", "prefs/feel/images/\(id)"))
    }
}
