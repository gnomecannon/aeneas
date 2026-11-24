import Foundation

/// The sources setting on this device (Sources.swift): read at launch, on return to the foreground, when the live
/// stream says it changed, and at the start of every Reminders sync; kept in the app group for offline use, widgets and
/// the next launch.
extension SyncEngine {
    /// Posted (object: the engine) when the sources setting changed; the Reminders, Calendar and Contacts copies follow it.
    public static let sourcesDidChange = Notification.Name("ea.sourcesDidChange")

    /// Take a setting (nil: a hub from before 1.0.18, which has none). Tasks in a list that is now off leave every
    /// list of tasks, and come back when it is on again.
    public func adoptSources(_ s: SourcesSetting?) {
        guard s != sources else { return }
        sources = s
        config.sources = s
        visibility = nil
        byKind = nil
        onSources?(s)
        NotificationCenter.default.post(name: Self.sourcesDidChange, object: self)
        // Widgets, the Watch's complications and planned alerts follow the tasks that show.
        Task { await self.afterChange() }
    }

    /// Read the setting from the hub. True when the hub answered: with its setting, or with 404 from a hub before 1.0.18
    /// (which has none). False when it could not be reached: the copy kept is used.
    @discardableResult
    public func refreshSources() async -> Bool {
        guard let c = client, !config.sampleMode else { return false }
        do {
            let s = try await withDeadline(15) { try await c.sources() }
            adoptSources(s)
            return true
        } catch {
            if case HubError.http(404, _) = error { adoptSources(nil); return true }
            return false
        }
    }

    /// Change the owner's choices (`HubClient.setSources`); the hub answers with the whole setting.
    public func changeSources(_ change: [String: JSONValue]) async throws {
        guard let c = client else { throw HubError.notConfigured }
        adoptSources(try await c.setSources(change))
    }

    /// Tell the hub what this device sees; its answer is the whole setting.
    @discardableResult
    public func reportSources(_ report: SourcesReport) async throws -> SourcesSetting {
        guard let c = client else { throw HubError.notConfigured }
        let s = try await withDeadline(20) { try await c.reportSources(report) }
        adoptSources(s)
        return s
    }

    /// Whether a task shows in the app now (`TaskVisibility`): false while it is in a Reminders list that is off.
    public func shows(_ task: Entity) -> Bool {
        let v = visibility ?? TaskVisibility(sources)
        visibility = v
        return v.shows(task)
    }
}
