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
        center.setNotificationCategories([cat, reasonCat, act])
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
        // Reminder ids are `<reminder id>|<time>`; activity check-ins and the digest keep their own prefixes.
        let pending = await center.pendingNotificationRequests().map(\.identifier).filter { $0.contains("|") && !$0.hasPrefix("activity|") && !$0.hasPrefix("digest|") }
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

    /// Show a notification right now (used for `notify` events from `/live`).
    /// A plain alert (monitor, sensor, quiz): no Done or Snooze buttons.
    public func notifyAlert(title: String, kind: String) async {
        guard alertsOn else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.sound = .default
        content.threadIdentifier = kind
        try? await center.add(UNNotificationRequest(identifier: "alert|\(kind)|\(Int(Date().timeIntervalSince1970))", content: content, trigger: nil))
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
