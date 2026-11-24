import Foundation

extension HubClient {
    /// `GET /prefs/sources`: which Apple Reminders lists, calendars and Contacts come in, one setting for every device.
    /// A hub from before 1.0.18 answers 404.
    public func sources() async throws -> SourcesSetting { try await get("prefs/sources", as: SourcesSetting.self) }

    /// `PUT /prefs/sources`: the owner's choices (`lists: [{ key, on?, space? }]`, `new_tasks`, `calendars: [{ key, work }]`,
    /// `contacts: { device }`); only what is named changes. Returns the whole setting.
    public func setSources(_ change: [String: JSONValue]) async throws -> SourcesSetting {
        try await post("prefs/sources", change, as: SourcesSetting.self, method: "PUT")
    }

    /// `PUT /prefs/sources/seen`: the lists and calendars this device sees (and, once, the calendars it had marked as
    /// work itself). Returns the whole setting.
    public func reportSources(_ report: SourcesReport) async throws -> SourcesSetting {
        try await post("prefs/sources/seen", report, as: SourcesSetting.self, method: "PUT")
    }
}
