#if os(iOS) || os(macOS)
import Foundation
import EventKit
import os

/// Invitations in Apple Calendar on this device (CONTRACT.md section 3, Invitations): the events in the calendars this
/// device brings events from (the work calendars chosen and the personal calendar it copies) where the current user is
/// an attendee who has not answered. Each becomes an `invitation` item with `answer_by: open_in_calendar`, so every
/// device lists it; EventKit can read an answer but cannot change one, so the owner answers it in Calendar. Only the
/// title, times, place and the organizer are read, never notes or the other attendees. The rules are
/// `Invitations.plan`; this reads EventKit. Runs after each personal calendar copy (EventMirrorSync).
@MainActor
public final class DeviceInvitations {
    public static let shared = DeviceInvitations()
    private static let log = Logger(subsystem: SharedConfig.logSubsystem, category: "invitations")
    /// How far ahead the calendars are read.
    static let daysAhead = 60.0
    private var running = false

    /// Read the calendars and bring this device's invitations up to date. `work` and `personal` are calendar ids.
    func run(store: EKEventStore, engine: SyncEngine, work: Set<String>, personal: String?, now: Date = Date()) async {
        guard !running, engine.hasHubCopy, !engine.config.deviceId.isEmpty else { return }
        running = true
        defer { running = false }
        var spaces: [String: Space] = [:]
        if !UserDefaults.standard.bool(forKey: CalendarImporter.workOffKey) { for id in work { spaces[id] = .work } }
        if let personal, spaces[personal] == nil { spaces[personal] = .personal }
        let cals = store.calendars(for: .event).filter { spaces[$0.calendarIdentifier] != nil }
        var found: [Invitations.DeviceInvite] = []
        if !cals.isEmpty {
            let pred = store.predicateForEvents(withStart: now, end: now.addingTimeInterval(Self.daysAhead * 86_400), calendars: cals)
            for ev in store.events(matching: pred).sorted(by: { ($0.startDate ?? .distantFuture) < ($1.startDate ?? .distantFuture) }) {
                guard let me = ev.attendees?.first(where: { $0.isCurrentUser }), let start = ev.startDate else { continue }
                let externalId = ev.calendarItemExternalIdentifier.flatMap { $0.isEmpty ? nil : $0 } ?? ev.calendarItemIdentifier
                let status: Invitations.DeviceInvite.Status
                switch me.participantStatus {
                case .pending: status = .pending
                case .accepted: status = .accepted
                case .tentative: status = .tentative
                case .declined: status = .declined
                default: status = .other
                }
                let org = ev.organizer
                let address = org.flatMap { $0.url.scheme?.lowercased() == "mailto" ? $0.url.absoluteString.dropFirst(7).removingPercentEncoding : nil }
                found.append(Invitations.DeviceInvite(
                    externalId: externalId, eventIdentifier: ev.eventIdentifier ?? ev.calendarItemIdentifier, title: ev.title ?? "",
                    start: start, end: ev.endDate ?? start, allDay: ev.isAllDay, location: ev.location, organizerName: org?.name, organizerAddress: address,
                    status: status, organizedByMe: org?.isCurrentUser ?? false, cancelled: ev.status == .canceled, repeats: ev.hasRecurrenceRules,
                    space: spaces[ev.calendar.calendarIdentifier] ?? .personal))
            }
        }
        let existing = ((try? await engine.store.all(kind: .invitation, includeDeleted: true)) ?? [])
        let patches = Invitations.plan(found: found, existing: existing, device: engine.config.deviceId, now: now)
        for p in patches { _ = await engine.apply(p) }
        if !patches.isEmpty { Self.log.notice("invitations: \(patches.count, privacy: .public) written") }
    }

    /// Open the event in Calendar on this Mac (or its day, when it is not on this Mac); the iPhone and iPad use `calshow:`.
    #if os(macOS)
    public static func calendarURL(eventIdentifier: String, start: Date) -> URL? {
        let store = EKEventStore()
        if EKEventStore.authorizationStatus(for: .event) == .fullAccess, let ev = store.event(withIdentifier: eventIdentifier),
           let id = ev.calendarItemIdentifier.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) {
            return URL(string: "ical://ekevent/\(id)?method=show&options=more")
        }
        return nil
    }
    #endif
}
#endif
