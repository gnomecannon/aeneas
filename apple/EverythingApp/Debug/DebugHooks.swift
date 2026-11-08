#if DEBUG && os(iOS)
import Foundation
import EventKit
import EACore

/// Simulator test hooks, Debug builds only. Launch arguments:
///   -EASeedWorkCalendar YES      create a local "Work (simulator)" calendar with two events and select it
///   -EASection <section>         open a section, e.g. settings or today
///   -EASettingsFocus <id>        scroll Settings to a section id, e.g. workCalendar
///   -EASetupURL <url>            open a pairing link (everythingapp://setup?...) as a QR scan would
@MainActor
enum DebugHooks {
    static func applyLaunchArguments(_ model: AppModel) async {
        let d = UserDefaults.standard
        if d.bool(forKey: "EASeedWorkCalendar") { await seedWorkCalendar() }
        if let s = d.string(forKey: "EASection"), let section = Section(rawValue: s) { model.section = section }
        // The link a QR scan or the camera opens, without the system's "Open in EverythingApp?" tap (automated tests).
        if let s = d.string(forKey: "EASetupURL"), let url = URL(string: s) { model.handle(url: url) }
    }

    /// Needs full calendar access, e.g. `xcrun simctl privacy booted grant calendar com.gnomecannon.everythingapp`.
    static func seedWorkCalendar() async {
        guard EKEventStore.authorizationStatus(for: .event) == .fullAccess else { return }
        let store = EKEventStore()
        let title = "Work (simulator)"
        let calendar: EKCalendar
        if let existing = store.calendars(for: .event).first(where: { $0.title == title }) {
            calendar = existing
        } else {
            guard let source = store.sources.first(where: { $0.sourceType == .local }) ?? store.defaultCalendarForNewEvents?.source else { return }
            calendar = EKCalendar(for: .event, eventStore: store)
            calendar.title = title
            calendar.source = source
            do { try store.saveCalendar(calendar, commit: true) } catch { return }
        }
        let cal = Calendar.current
        let today = cal.startOfDay(for: Date())
        let window = store.predicateForEvents(withStart: today.addingTimeInterval(-86400), end: today.addingTimeInterval(3 * 86400), calendars: [calendar])
        for ev in store.events(matching: window) { try? store.remove(ev, span: .thisEvent, commit: false) }
        func add(_ title: String, dayOffset: Int, hour: Int, minutes: Int) {
            let ev = EKEvent(eventStore: store)
            ev.calendar = calendar
            ev.title = title
            ev.startDate = cal.date(bySettingHour: hour, minute: 0, second: 0, of: today.addingTimeInterval(Double(dayOffset) * 86400))
            ev.endDate = ev.startDate.addingTimeInterval(Double(minutes) * 60)
            ev.location = "Room 4B"   // set on purpose: it must not be imported
            ev.notes = "Private agenda"
            try? store.save(ev, span: .thisEvent, commit: false)
        }
        add("Design review", dayOffset: 0, hour: 14, minutes: 60)
        add("One on one with manager", dayOffset: 1, hour: 11, minutes: 30)
        try? store.commit()
        SharedConfig.shared.workCalendarIds = [calendar.calendarIdentifier]
        CalendarImporter.shared.refreshAccess()
    }
}
#endif
