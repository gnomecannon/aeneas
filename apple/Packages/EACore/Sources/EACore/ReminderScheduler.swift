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
                out.append(PlannedNotification(id: requestId(reminderId: e.id, fireAt: f), reminderId: e.id, title: r.title, fireAt: f, friction: r.friction, repeat: r.repeat))
            }
        }
        out.sort { $0.fireAt < $1.fireAt }
        if out.count > limit { out = Array(out.prefix(limit)) }
        return out
    }

    /// The request id of a reminder's alert at one time. The hub's announcement of a due reminder uses the same id as
    /// the alert this device planned for that time, so the two are one alert.
    public static func requestId(reminderId: String, fireAt: Date) -> String { "\(reminderId)|\(Int(fireAt.timeIntervalSince1970))" }

    /// Whether the hub's announcement of a due reminder (`/live`) needs an alert on this device. Not when this device
    /// planned its own alert for that time (it shows by itself), and not when an alert for the reminder is already on
    /// screen: the same time, or any time in the last 10 minutes (a snooze made elsewhere can move it). One reminder
    /// used to alert twice, on the always connected Mac every time.
    public static func announcementNeedsAlert(reminderId: String, at: Date?, now: Date, planned: Set<String>,
                                              delivered: [(id: String, date: Date)]) -> Bool {
        if let at {
            let id = requestId(reminderId: reminderId, fireAt: at)
            if planned.contains(id) || delivered.contains(where: { $0.id == id }) { return false }
        }
        let mine = reminderId + "|", older = "live|" + mine
        return !delivered.contains { ($0.id.hasPrefix(mine) || $0.id.hasPrefix(older)) && abs(now.timeIntervalSince($0.date)) < 600 }
    }
}

/// The plan last handed to the notification center. A replan runs after every sync and every edit (each minute on the
/// Watch) and used to take off and schedule every alert again even when nothing about the reminders had changed.
public struct ReplanGate: Sendable {
    private var last: [PlannedNotification]?
    public init() {}

    /// True when `plan` differs from the last one let through, which it then becomes.
    public mutating func admits(_ plan: [PlannedNotification]) -> Bool {
        guard plan != last else { return false }
        last = plan
        return true
    }

    /// An alert of the last plan could not be scheduled (notifications not allowed yet): the same plan goes again.
    public mutating func forget() { last = nil }
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
    /// New mail opens the Mail screen.
    public static let mailURL = "everythingapp://section/mail"
    /// A connection that broke opens Today, whose Needs you has its row with the button to the fix.
    public static let todayURL = "everythingapp://today"

    public init(_ n: NotifyEvent) {
        thread = n.kind
        incidentId = n.kind == "monitor" ? n.incident_id : nil
        url = n.kind == "monitor" ? Self.opsURL : n.kind == "mail" ? Self.mailURL : n.kind == "connection" ? Self.todayURL : nil
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
        } else if n.kind == "mail" {
            // New mail: the hub's line (a sender and subject, or a count) holds a sender's own words, so it goes under
            // a title of the app's and cannot read as one of the hub's own alerts.
            title = "New mail"
            body = StyleGuard.dashes(n.title)
        } else if n.kind == "connection", !name.isEmpty {
            // A connection that broke: the service over what broke and what to do ("iCloud", then "iCloud stopped
            // signing in for you@icloud.com. Replace its app-specific password.").
            title = StyleGuard.dashes(name)
            body = StyleGuard.dashes(n.title)
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
    /// Every reminder alert this device planned while running (the newest 500), so the hub's announcement of the same
    /// time does not alert a second time, even after the planned one was dismissed.
    private var planned: [String] = []
    private let plannedLock = NSLock()
    private var gate = ReplanGate()

    public init() {}

    private func remember(_ ids: [String]) {
        plannedLock.withLock {
            let have = Set(planned)
            planned.append(contentsOf: ids.filter { !have.contains($0) })
            if planned.count > 500 { planned.removeFirst(planned.count - 500) }
        }
    }

    private var plannedIds: Set<String> { plannedLock.withLock { Set(planned) } }

    /// Reminder alerts (Settings, Modules) on: off, this device schedules and shows no local notifications.
    private var alertsOn: Bool { SharedConfig.shared.moduleOn(.notifications) }

    /// One kind of alert may show here: Reminder alerts on, and the kind's own switch on (Settings, Notifications).
    /// The hub sends no event of a kind that is off, but what this device plans by itself (a reminder's notification,
    /// an activity's check-in) never passes the hub, and a switch can change while an event is on its way.
    private func shows(_ kind: String) -> Bool { SharedConfig.shared.notifies(kind) }
    private func shows(_ kind: AlertKind) -> Bool { shows(kind.rawValue) }

    /// The check-in this device planned for the activity running now, kept while the app runs, so Activity check-ins
    /// switched off and on again takes it off and puts it back.
    private var checkin: (logId: String, name: String, start: Date, hours: Double)?
    /// Whether activity check-ins could show at the last look, so only a change takes one off or puts it back.
    private var checkinsShown: Bool?

    public func registerCategories() {
        // Done, as on the web and the Watch: it completes the task (a repeating one moves on). It said "Got it".
        let ack = UNNotificationAction(identifier: ReminderPlanner.ackAction, title: "Done", options: [])
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

    /// Replace all pending reminder notifications with the given plan. The same plan as last time changes nothing.
    public func replan(reminders: [Entity], now: Date = Date()) async {
        let plan = ReminderPlanner.plan(reminders: reminders, now: now)
        remember(plan.map(\.id))
        guard plannedLock.withLock({ gate.admits(plan) }) else { return }
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
            do { try await center.add(UNNotificationRequest(identifier: p.id, content: content, trigger: trigger)) }
            catch { plannedLock.withLock { gate.forget() } }
        }
    }

    /// Activity check-in: fire `hours` after an activity start so the question is asked with no hub.
    public func scheduleActivityCheckin(logId: String, name: String, start: Date, hours: Double = 3) async {
        plannedLock.withLock { checkin = (logId, name, start, hours) }
        let fireAt = start.addingTimeInterval(hours * 3600)
        guard fireAt > Date(), shows(.activity) else { return }
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
        plannedLock.withLock { checkin = nil }
        await takeOffActivityCheckins()
    }

    private func takeOffActivityCheckins() async {
        let pending = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix("activity|") }
        center.removePendingNotificationRequests(withIdentifiers: pending)
        center.removeDeliveredNotifications(withIdentifiers: pending)
    }

    /// Activity check-ins switched off (Settings, Notifications, or Reminder alerts in Modules) takes the planned
    /// check-in off; switched on again, the one planned for the activity still running comes back. Asked after every
    /// replan, it does something only when the switch changed since the last time.
    public func replanActivityCheckin() async {
        let on = shows(.activity)
        let changed = plannedLock.withLock { () -> Bool in
            defer { checkinsShown = on }
            return checkinsShown != on
        }
        guard changed else { return }
        guard on else { await takeOffActivityCheckins(); return }
        if let c = plannedLock.withLock({ checkin }) { await scheduleActivityCheckin(logId: c.logId, name: c.name, start: c.start, hours: c.hours) }
    }

    /// Daily digest: a local notification with the digest's first line that deep-links to Today.
    public func notifyDigest(title: String, url: String = "everythingapp://today") async {
        guard shows(.digest) else { return }
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
        guard shows(n.kind) else { return }
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

    /// The hub's announcement of a due reminder (`/live`), for a time this device may not have planned (made elsewhere
    /// moments ago, or past the plan's cap). It goes under the planned alert's id and is skipped when that alert showed
    /// or will (`ReminderPlanner.announcementNeedsAlert`).
    public func notifyNow(reminderId: String, title: String, friction: Friction, at: Date? = nil) async {
        guard shows(.reminder) else { return }
        let now = Date()
        let delivered = await center.deliveredNotifications().map { (id: $0.request.identifier, date: $0.date) }
        guard ReminderPlanner.announcementNeedsAlert(reminderId: reminderId, at: at, now: now, planned: plannedIds, delivered: delivered) else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = friction == .none ? "Reminder" : "Snoozing needs a reason"
        content.sound = .default
        content.categoryIdentifier = ReminderPlanner.category(for: friction)
        content.userInfo = ["reminder_id": reminderId, "friction": friction.rawValue]
        content.threadIdentifier = reminderId
        try? await center.add(UNNotificationRequest(identifier: ReminderPlanner.requestId(reminderId: reminderId, fireAt: at ?? now), content: content, trigger: nil))
    }
}
#endif
