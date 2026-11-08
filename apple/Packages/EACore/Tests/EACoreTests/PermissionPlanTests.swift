import XCTest
@testable import EACore

/// Which device permissions the modules that are on need, per platform, and when they are offered.
final class PermissionPlanTests: XCTestCase {
    /// What the hub sends since 2026-11-05 (modules.ts), trimmed to the fields that matter here.
    private let hub = """
    {"modules": [
      {"id": "voice", "title": "Voice", "group": "On your devices", "on": true, "reads": "The microphone, only while you hold the button.", "permissions": ["microphone", "speech"]},
      {"id": "notifications", "title": "Reminder alerts", "group": "On your devices", "on": true, "reads": "Nothing: it only shows alerts.", "permissions": ["notifications"]},
      {"id": "apple_reminders", "title": "Apple Reminders", "group": "On your devices", "on": false, "permissions": ["reminders"]},
      {"id": "apple_calendar", "title": "Apple Calendar", "group": "On your devices", "on": true, "permissions": ["calendar"]},
      {"id": "contacts", "title": "Contacts", "group": "On your devices", "on": false, "permissions": ["contacts"]},
      {"id": "music", "title": "Music", "group": "Making", "on": true, "reads": "The microphone, only while you record a hum.", "permissions": ["microphone"]},
      {"id": "images", "title": "Images", "group": "Making", "on": true, "permissions": ["photos"]},
      {"id": "health", "title": "Health", "group": "Body and home", "on": true, "permissions": ["health"]},
      {"id": "games", "title": "Games", "group": "Life admin", "on": true, "setup": {"minutes": "2", "needs": "your own Steam key, for playtime"}},
      {"id": "garden", "title": "Garden", "group": "Body and home", "on": true, "permissions": ["telepathy"]}
    ]}
    """

    private var modules: [ModuleInfo] { try! JSONCoding.decode(ModulesResponse.self, from: hub).modules }

    func testNewFieldsDecode() throws {
        let m = modules
        XCTAssertEqual(m[0].permissions, ["microphone", "speech"])
        XCTAssertEqual(m[0].reads, "The microphone, only while you hold the button.")
        XCTAssertEqual(m[8].setup, ModuleInfo.AdvancedSetup(minutes: "2", needs: "your own Steam key, for playtime"))
        XCTAssertEqual(AppModule(rawValue: "apple_reminders"), .appleReminders)
        XCTAssertEqual(AppModule(rawValue: "apple_calendar"), .appleCalendar)
        XCTAssertNotNil(AppModule(rawValue: "layouts"))
        XCTAssertNotNil(AppModule(rawValue: "mail"))
    }

    func testIPhoneNeedsWhatTheModulesThatAreOnAskFor() {
        let needs = PermissionPlan.needs(modules, platform: .iphone)
        XCTAssertEqual(needs.map(\.permission), [.notifications, .microphone, .speech, .calendar, .health, .photos],
                       "Reminders and Contacts are off; an unknown permission is left out")
        let mic = needs.first { $0.permission == .microphone }
        XCTAssertEqual(mic?.modules.map(\.id), ["voice", "music"], "one microphone question for both")
        XCTAssertEqual(mic?.forLine, "For Voice and Music.")
    }

    func testTheMacAsksForNoHealthOrPhotos() {
        XCTAssertEqual(PermissionPlan.needs(modules, platform: .mac).map(\.permission), [.notifications, .microphone, .speech, .calendar])
    }

    func testTheWatchAsksForAlertsAndTheHumMicrophoneOnly() {
        let needs = PermissionPlan.needs(modules, platform: .watch)
        XCTAssertEqual(needs.map(\.permission), [.notifications, .microphone])
        XCTAssertEqual(needs.last?.modules.map(\.id), ["music"], "voice on the Watch is the system's dictation")
        var noMusic = modules
        noMusic[5].on = false
        XCTAssertEqual(PermissionPlan.needs(noMusic, platform: .watch).map(\.permission), [.notifications])
    }

    func testAnOlderHubWithoutPermissionsUsesTheSameMapping() {
        let old = [
            ModuleInfo(id: "music", title: "Music", on: true),
            ModuleInfo(id: "images", title: "Images", on: true),
            ModuleInfo(id: "health", title: "Health", on: false),
            ModuleInfo(id: "renewals", title: "Renewals", on: true),
        ]
        XCTAssertEqual(PermissionPlan.needs(old, platform: .iphone).map(\.permission), [.microphone, .photos])
        // It lists no device modules; Voice and Reminder alerts were always on there.
        let withDefaults = PermissionPlan.withDeviceDefaults(old)
        XCTAssertEqual(PermissionPlan.needs(withDefaults, platform: .iphone).map(\.permission), [.notifications, .microphone, .speech, .photos])
        XCTAssertEqual(PermissionPlan.withDeviceDefaults(modules).count, modules.count, "a list that names them is left alone")
    }

    func testOnlyQuestionsNeverAskedAreOffered() {
        // The owner's own devices already allowed everything: nothing is offered after the update.
        let granted = PermissionPlan.toAsk(PermissionPlan.needs(modules, platform: .iphone)) { _ in false }
        XCTAssertTrue(granted.isEmpty)
        let some = PermissionPlan.toAsk(PermissionPlan.needs(modules, platform: .iphone)) { $0 == .health }
        XCTAssertEqual(some.map(\.permission), [.health])
    }

    func testOnlyAModuleSwitchedFromOffToOnIsOffered() {
        let before = modules
        var after = before
        after[2].on = true                       // Apple Reminders switched on
        after[0].on = false                      // Voice switched off
        after.append(ModuleInfo(id: "pet", title: "Pet", on: true))  // new from a newer hub: was never off
        XCTAssertEqual(PermissionPlan.switchedOn(before: before, after: after).map(\.id), ["apple_reminders"])
        XCTAssertEqual(PermissionPlan.needs(PermissionPlan.switchedOn(before: before, after: after), platform: .iphone).map(\.permission), [.reminders])
        // An older hub's list (no device modules) followed by a newer hub's: nothing was switched on.
        let old = before.filter { !["voice", "notifications", "apple_reminders", "apple_calendar", "contacts"].contains($0.id) }
        XCTAssertTrue(PermissionPlan.switchedOn(before: old, after: before).isEmpty, "a hub update asks for nothing")
        XCTAssertTrue(PermissionPlan.switchedOn(before: [], after: before).isEmpty, "nothing loaded before: not a switch")
    }

    func testEveryPermissionHasPlainWords() {
        for p in DevicePermission.allCases {
            XCTAssertFalse(p.title.isEmpty)
            XCTAssertFalse(p.purpose.isEmpty)
            XCTAssertFalse(p.purpose.contains("\u{2014}") || p.purpose.contains("\u{2013}"), "no dashes in text a person reads")
        }
    }
}
