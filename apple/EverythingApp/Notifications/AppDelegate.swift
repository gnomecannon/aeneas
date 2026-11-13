import Foundation
import UserNotifications
import EACore
#if os(iOS)
import UIKit

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = NotificationHandler.shared
        ReminderScheduler.shared.registerCategories()
        // The Watch relays every hub call through this process. WatchConnectivity may launch the
        // app in the background for that, so the session is activated here, not from a view.
        // Hums from the Watch come as file transfers and go on to the hub from here.
        WatchLink.shared.onHumReceived = { WatchHumRelay.shared.kick() }
        WatchLink.shared.onUnheardAnswer = { q, a, session in AnswerNotice.post(question: q, answer: a, session: session) }
        WatchLink.shared.activate()
        // Work calendar import: the background refresh task must be registered before launch ends.
        CalendarImporter.shared.engineProvider = { @MainActor in
            await AppModel.shared.ensureStarted()
            return AppModel.shared.engine
        }
        RemindersSync.shared.engineProvider = CalendarImporter.shared.engineProvider
        EventMirrorSync.shared.engineProvider = CalendarImporter.shared.engineProvider
        ContactsSync.shared.engineProvider = CalendarImporter.shared.engineProvider
        CalendarImporter.shared.registerBackgroundTask()
        return true
    }
}
#elseif os(macOS)
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// The global Capture shortcut. Settings changes it through `applyShortcut`.
    @MainActor static var hotKey: HotKey?

    /// Registers the shortcut chosen in Settings (or none). False when another app already uses it.
    @MainActor @discardableResult
    static func applyShortcut(_ id: String) -> Bool {
        if hotKey == nil { hotKey = HotKey { QuickCapturePanel.shared.toggle() } }
        return hotKey?.register(id) ?? false
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = NotificationHandler.shared
        ReminderScheduler.shared.registerCategories()
        Self.applyShortcut(HotKey.chosen(configured: SharedConfig.shared.isConfigured))
        // Work calendar import, as on the iPhone; both write the same meetings, keyed by the calendar server's id.
        CalendarImporter.shared.engineProvider = { @MainActor in
            await AppModel.shared.ensureStarted()
            return AppModel.shared.engine
        }
        RemindersSync.shared.engineProvider = CalendarImporter.shared.engineProvider
        EventMirrorSync.shared.engineProvider = CalendarImporter.shared.engineProvider
        ContactsSync.shared.engineProvider = CalendarImporter.shared.engineProvider
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { NSApp.activate(ignoringOtherApps: true) }
        return true
    }
}
#endif

/// Handles notification taps and the Ack / Snooze actions.
final class NotificationHandler: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationHandler()

    /// Why Acknowledge on a monitor alert did not go through, in a few words.
    static func ackFailure(_ error: Error) -> String {
        if let h = error as? HubError, case .http(let status, _) = h, status == 404 { return "the hub no longer has this incident" }
        return Homelab.errorText(error)
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        // Activity check-in: Still on it does nothing; Stop ends the activity; a tap shows the banner.
        if let logId = info["activity_log_id"] as? String {
            let name = info["activity_name"] as? String ?? ""
            let hours = info["activity_hours"] as? Double ?? 3
            let action = response.actionIdentifier
            _ = await MainActor.run {
                Task { @MainActor in
                    let model = AppModel.shared
                    await model.ensureStarted()
                    switch action {
                    case ActivityCheckin.stillAction: break
                    case ActivityCheckin.stopAction:
                        model.activityCheckin = ActivityCheckin(logId: logId, name: name, hours: hours)
                        await model.answerCheckin(stop: true)
                    default:
                        model.activityCheckin = ActivityCheckin(logId: logId, name: name, hours: hours)
                    }
                }
            }
            return
        }
        // A monitor that went down: Acknowledge on the alert, without opening the app. A tap falls through to its Ops link.
        if response.actionIdentifier == ReminderScheduler.incidentAckAction, let incident = info["incident_id"] as? String {
            let alert = response.notification.request.content.title
            // Awaited, so the app is not suspended in the background before the hub has it.
            await Task { @MainActor in
                let model = AppModel.shared
                await model.ensureStarted()
                // A failure used to pass in silence, so the incident went on re-notifying with no word why.
                guard let c = model.engine.client else {
                    await ReminderScheduler.shared.notifyNotAcknowledged(reason: "this device is not connected to a hub", alert: alert, incidentId: incident)
                    return
                }
                do {
                    let updated = try await c.acknowledgeIncident(id: incident, note: nil)
                    await model.engine.absorb(updated)
                } catch {
                    await ReminderScheduler.shared.notifyNotAcknowledged(reason: Self.ackFailure(error), alert: alert, incidentId: incident)
                }
            }.value
            return
        }
        // An answer Siri could not wait for opens its chat.
        if info["kind"] as? String == "assistant_answer", let session = info["session"] as? String, !session.isEmpty {
            _ = await MainActor.run {
                Task { @MainActor in
                    let model = AppModel.shared
                    await model.ensureStarted()
                    model.openChat(session)
                }
            }
            return
        }
        // Digest and other deep-linking notifications carry a URL.
        if let u = info["url"] as? String, let url = URL(string: u) {
            _ = await MainActor.run {
                Task { @MainActor in
                    let model = AppModel.shared
                    await model.ensureStarted()
                    model.handle(url: url)
                }
            }
            return
        }
        guard let id = info["reminder_id"] as? String else { return }
        let friction = Friction(rawValue: info["friction"] as? String ?? "none") ?? .none
        let typed = (response as? UNTextInputNotificationResponse)?.userText
        await MainActor.run {
            Task { @MainActor in
                let model = AppModel.shared
                await model.ensureStarted()
                switch response.actionIdentifier {
                case ReminderPlanner.ackAction:
                    await model.engine.ack(id)
                case ReminderPlanner.snoozeAction:
                    if friction == .none {
                        _ = await model.engine.snooze(id, minutes: 10, reason: nil)
                    } else {
                        // The snooze sheet alone: opening the item too asked for a second sheet at the same moment, and
                        // only one of the two showed.
                        model.pendingSnoozeReminderId = id
                    }
                case ReminderPlanner.snoozeReasonAction:
                    // The reason typed into the notification; an empty one opens the snooze sheet instead.
                    if await !model.engine.snooze(id, minutes: 10, reason: typed) {
                        model.pendingSnoozeReminderId = id
                    }
                default:
                    model.open(itemId: id)
                }
            }
        }
    }
}
