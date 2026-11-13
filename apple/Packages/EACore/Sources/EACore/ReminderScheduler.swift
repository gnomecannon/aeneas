import Foundation
#if canImport(UserNotifications)
import UserNotifications
#endif

/// One local notification we intend to schedule.
public struct PlannedNotification: Equatable, Identifiable, Sendable {
    public var id: String          // notification request identifier
    public var reminderId: String
    public var title: String
    public var fireAt: Date
    public var friction: Friction
    public var `repeat`: String?
}

/// Pure planning (testable) plus a thin UNUserNotificationCenter wrapper.
public enum ReminderPlanner {
    public static let categoryId = "EA_REMINDER"
    /// Reminders that need a reason to snooze: the snooze action carries a text box (typed, dictated or Scribble on the Watch).
    public static let reasonCategoryId = "EA_REMINDER_REASON"
    public static let ackAction = "EA_ACK"
    public static let snoozeAction = "EA_SNOOZE_10"
    public static let snoozeReasonAction = "EA_SNOOZE_REASON"

    public static func category(for friction: Friction) -> String { friction == .none ? categoryId : reasonCategoryId }

    /// Compute the local notifications for a set of reminder entities.
    /// - Rules: skip deleted; use max(at, snoozed_until); one-shot acknowledged are skipped;
    ///   repeating reminders get `perReminder` future occurrences; overall cap `limit`.
    public static func plan(reminders: [Entity], now: Date = Date(), horizonDays: Int = 30, perReminder: Int = 3, limit: Int = 60, calendar: Calendar = .current) -> [PlannedNotification] {
        var out: [PlannedNotification] = []
        let horizon = calendar.date(byAdding: .day, value: horizonDays, to: now) ?? now.addingTimeInterval(Double(horizonDays) * 86400)
        for e in reminders {
            guard let r = e.reminderFields, let at = ISO.date(r.at) else { continue }
            let rule = r.repeat.flatMap { RepeatRule.parse($0) }
            let acked = !(r.acknowledged_at ?? "").isEmpty
            var fires: [Date] = []
            if let eff = ReminderMath.effectiveDate(r) {
                if eff > now && !(acked && rule == nil) {
                    // For an acknowledged repeating reminder the hub advances `at`; until that
                    // echo arrives, do not fire the acknowledged instance again.
                    if !(acked && rule != nil && (ISO.date(r.acknowledged_at) ?? .distantPast) >= eff) { fires.append(eff) }
                }
            }
            if let rule = rule {
                var cursor = max(fires.last ?? at, now)
                var guardCount = 0
                while fires.count < perReminder, guardCount < 50, let n = rule.next(after: cursor, start: at, calendar: calendar), n <= horizon {
                    guardCount += 1
                    if !fires.contains(n) { fires.append(n) }
                    cursor = n
                }
            }
            for f in fires.sorted() {
                out.append(PlannedNotification(id: "\(e.id)|\(Int(f.timeIntervalSince1970))", reminderId: e.id, title: r.title, fireAt: f, friction: r.friction, repeat: r.repeat))
            }
        }
        out.sort { $0.fireAt < $1.fireAt }
        if out.count > limit { out = Array(out.prefix(limit)) }
        return out
    }
}

/// What a `notify` alert from `/live` shows, and the request id it goes under. Pure, so it is tested.
public struct AlertNotice: Equatable, Sendable {
    /// `alert|monitor|<monitor id>` for a monitor, so a later alert for the same monitor (a re-notify, back up) takes
    /// the earlier one's place, with its Acknowledge. Any other alert has an id of its own: two in the same second
    /// both show (the id used to be the kind and the second, so one replaced the other).
    public var id: String
    public var title: String
    public var body: String
    public var thread: String
    /// A monitor down with its incident: the alert offers Acknowledge.
    public var incidentId: String?
    /// Where a tap goes (a monitor alert opens Ops).
    public var url: String?

    public static let opsURL = "everythingapp://section/ops"

    public init(_ n: NotifyEvent) {
        thread = n.kind
        incidentId = n.kind == "monitor" ? n.incident_id : nil
        url = n.kind == "monitor" ? Self.opsURL : nil
        let name = Self.trimmed(n.name), state = Self.trimmed(n.state), error = Self.trimmed(n.error)
        if n.kind == "monitor" {
            let key = Self.monitorId(fromNotifyId: n.id) ?? (name.isEmpty ? UUID().uuidString.lowercased() : "name:" + name)
            id = "alert|monitor|" + key
        } else {
            let own = Self.trimmed(n.id)
            id = "alert|\(n.kind)|" + (own.isEmpty ? UUID().uuidString.lowercased() : own)
        }
        if n.kind == "monitor", !name.isEmpty, !state.isEmpty {
            let text = Self.monitorText(name: name, state: state, error: error, hubTitle: n.title)
            title = StyleGuard.dashes(text.title)
            body = StyleGuard.dashes(text.body)
        } else {
            // An older hub sends the title alone ("Ollama down: connection refused").
            title = StyleGuard.dashes(n.title)
            body = ""
        }
    }

    /// The monitor in a monitor alert's id, `monitor:<monitor id>:<state>:<at>`.
    public static func monitorId(fromNotifyId id: String?) -> String? {
        guard let id, id.hasPrefix("monitor:") else { return nil }
        let rest = id.dropFirst("monitor:".count)
        let monitor = rest.firstIndex(of: ":").map { String(rest[..<$0]) } ?? String(rest)
        return monitor.isEmpty ? nil : monitor
    }

    /// "Ollama down" over the error. A re-notify ("Ollama still down since Nov 13, 9:14 PM (6 h): <error>") keeps
    /// "still" in the title and puts since when in the body, before the error.
    static func monitorText(name: String, state: String, error: String, hubTitle: String) -> (title: String, body: String) {
        let still = "\(name) still \(state)"
        guard hubTitle.hasPrefix(still) else { return ("\(name) \(state)", error) }
        var since = String(hubTitle.dropFirst(still.count))
        if !error.isEmpty, since.hasSuffix(": " + error) { since = String(since.dropLast(error.count + 2)) }
        since = since.trimmingCharacters(in: .whitespaces)
        if let first = since.first { since = first.uppercased() + since.dropFirst() }
        return (still, [since, error].filter { !$0.isEmpty }.joined(separator: ": "))
    }

    private static func trimmed(_ s: String?) -> String { (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
}

#if canImport(UserNotifications)
/// Schedules the planned notifications with UNUserNotificationCenter. Re-run after every sync.
public final class ReminderScheduler: @unchecked Sendable {
    public static let shared = ReminderScheduler()
    private let center = UNUserNotificationCenter.current()

    public init() {}

    /// Reminder alerts (Settings, Modules) on: off, this device schedules and shows no local notifications.
    private var alertsOn: Bool { SharedConfig.shared.moduleOn(.notifications) }

    public func registerCategories() {
        let ack = UNNotificationAction(identifier: ReminderPlanner.ackAction, title: "Got it", options: [])
        let snooze = UNNotificationAction(identifier: ReminderPlanner.snoozeAction, title: "Snooze 10 min", options: [.foreground])
        let cat = UNNotificationCategory(identifier: ReminderPlanner.categoryId, actions: [ack, snooze], intentIdentifiers: [], options: [])
        let snoozeWhy = UNTextInputNotificationAction(identifier: ReminderPlanner.snoozeReasonAction, title: "Snooze 10 min", options: [],
                                                      textInputButtonTitle: "Snooze", textInputPlaceholder: "Why are you snoozing?")
        let reasonCat = UNNotificationCategory(identifier: ReminderPlanner.reasonCategoryId, actions: [ack, snoozeWhy], intentIdentifiers: [], options: [])
        let still = UNNotificationAction(identifier: ActivityCheckin.stillAction, title: "Still on it", options: [])
        let stop = UNNotificationAction(identifier: ActivityCheckin.stopAction, title: "Stop", options: [])
        let act = UNNotificationCategory(identifier: ActivityCheckin.categoryId, actions: [still, stop], intentIdentifiers: [], options: [])
        // A monitor that went down: Acknowledge from the alert (iPhone, Watch, Mac) stops the 6 hour reminders.
        let ackIncident = UNNotificationAction(identifier: Self.incidentAckAction, title: "Acknowledge", options: [])
        let incident = UNNotificationCategory(identifier: Self.incidentCategoryId, actions: [ackIncident], intentIdentifiers: [], options: [])
        center.setNotificationCategories([cat, reasonCat, act, incident])
    }

    /// Asked only from the permission screen after setup or a module switched on, or from Settings, Notifications.
    public func requestPermission() async -> Bool {
        (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    }

    public func authorizationStatus() async -> UNAuthorizationStatus {
        await center.notificationSettings().authorizationStatus
    }

    /// Replace all pending reminder notifications with the given plan.
    public func replan(reminders: [Entity], now: Date = Date()) async {
        let plan = ReminderPlanner.plan(reminders: reminders, now: now)
        // Reminder ids are `<reminder id>|<time>`; activity check-ins, the digest and alerts keep their own prefixes.
        let pending = await center.pendingNotificationRequests().map(\.identifier).filter { $0.contains("|") && !$0.hasPrefix("activity|") && !$0.hasPrefix("digest|") && !$0.hasPrefix("alert|") }
        center.removePendingNotificationRequests(withIdentifiers: pending)
        for p in plan {
            let content = UNMutableNotificationContent()
            content.title = p.title
            content.body = p.friction == .none ? "Reminder" : "Snoozing needs a reason"
            content.sound = .default
            content.categoryIdentifier = ReminderPlanner.category(for: p.friction)
            content.userInfo = ["reminder_id": p.reminderId, "friction": p.friction.rawValue]
            content.threadIdentifier = p.reminderId
            let comps = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: p.fireAt)
            let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: false)
            try? await center.add(UNNotificationRequest(identifier: p.id, content: content, trigger: trigger))
        }
    }

    /// Activity check-in: fire `hours` after an activity start so the question is asked with no hub.
    public func scheduleActivityCheckin(logId: String, name: String, start: Date, hours: Double = 3) async {
        let fireAt = start.addingTimeInterval(hours * 3600)
        guard fireAt > Date(), alertsOn else { return }
        let content = UNMutableNotificationContent()
        content.title = "On \(name) for \(Int(hours)) h"
        content.body = "Still on it, or stop?"
        content.sound = .default
        content.categoryIdentifier = ActivityCheckin.categoryId
        content.userInfo = ["activity_log_id": logId, "activity_name": name, "activity_hours": hours]
        content.threadIdentifier = "activity"
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, fireAt.timeIntervalSinceNow), repeats: false)
        try? await center.add(UNNotificationRequest(identifier: "activity|\(logId)", content: content, trigger: trigger))
    }

    /// Cancel every pending activity check-in (the activity ended).
    public func cancelActivityCheckins() async {
        let pending = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix("activity|") }
        center.removePendingNotificationRequests(withIdentifiers: pending)
        center.removeDeliveredNotifications(withIdentifiers: pending)
    }

    /// Daily digest: a local notification with the digest's first line that deep-links to Today.
    public func notifyDigest(title: String, url: String = "everythingapp://today") async {
        guard alertsOn else { return }
        let content = UNMutableNotificationContent()
        content.title = "Today"
        content.body = title
        content.sound = .default
        content.userInfo = ["url": url]
        content.threadIdentifier = "digest"
        try? await center.add(UNNotificationRequest(identifier: "digest|\(Int(Date().timeIntervalSince1970))", content: content, trigger: nil))
    }

    public static let incidentCategoryId = "monitor-incident"
    public static let incidentAckAction = "incident-ack"

    /// Show a notification right now (used for `notify` events from `/live`).
    /// A plain alert (sensor, quiz, a monitor back up); a monitor down with its incident gets Acknowledge, and a tap
    /// opens Ops. A monitor's newer alert replaces its earlier one (`AlertNotice.id`).
    public func notifyAlert(_ n: NotifyEvent) async {
        guard alertsOn else { return }
        let a = AlertNotice(n)
        let content = UNMutableNotificationContent()
        content.title = a.title
        if !a.body.isEmpty { content.body = a.body }
        content.sound = .default
        content.threadIdentifier = a.thread
        if let url = a.url { content.userInfo["url"] = url }
        if let incidentId = a.incidentId {
            content.categoryIdentifier = Self.incidentCategoryId
            content.userInfo["incident_id"] = incidentId
        }
        try? await center.add(UNNotificationRequest(identifier: a.id, content: content, trigger: nil))
    }

    /// Acknowledge on a monitor alert did not reach the hub: say so and why. A tap opens Ops; Acknowledge tries again.
    public func notifyNotAcknowledged(reason: String, alert: String, incidentId: String) async {
        guard alertsOn else { return }
        let content = UNMutableNotificationContent()
        content.title = StyleGuard.dashes("Not acknowledged: \(reason)")
        if !alert.isEmpty { content.body = alert }
        content.sound = .default
        content.threadIdentifier = "monitor"
        content.categoryIdentifier = Self.incidentCategoryId
        content.userInfo = ["url": AlertNotice.opsURL, "incident_id": incidentId]
        try? await center.add(UNNotificationRequest(identifier: "alert|ack|\(incidentId)", content: content, trigger: nil))
    }

    public func notifyNow(reminderId: String, title: String, friction: Friction) async {
        guard alertsOn else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = friction == .none ? "Reminder" : "Snoozing needs a reason"
        content.sound = .default
        content.categoryIdentifier = ReminderPlanner.category(for: friction)
        content.userInfo = ["reminder_id": reminderId, "friction": friction.rawValue]
        content.threadIdentifier = reminderId
        try? await center.add(UNNotificationRequest(identifier: "live|\(reminderId)|\(Int(Date().timeIntervalSince1970))", content: content, trigger: nil))
    }
}
#endif
