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
      {"id": "music", "title": "Song ideas", "group": "Making", "on": true, "reads": "The microphone, only while you record a hum.", "permissions": ["microphone"]},
      {"id": "images", "title": "Images", "group": "Making", "on": true, "permissions": ["photos"]},
      {"id": "health", "title": "Health", "group": "Body and home", "on": true, "permissions": ["health"]},
      {"id": "games", "title": "Games", "group": "Media", "on": true, "setup": {"minutes": "2", "needs": "your own Steam key, for playtime"}},
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
        XCTAssertNil(AppModule(rawValue: "layouts"), "Layout sketches was taken out on 2026-11-25")
        XCTAssertNil(AppModule(rawValue: "jobs"), "Job search was taken out on 2026-11-25")
        XCTAssertNotNil(AppModule(rawValue: "mail"))
    }

    func testIPhoneNeedsWhatTheModulesThatAreOnAskFor() {
        let needs = PermissionPlan.needs(modules, platform: .iphone)
        XCTAssertEqual(needs.map(\.permission), [.notifications, .microphone, .speech, .calendar, .health, .photos],
                       "Reminders and Contacts are off; an unknown permission is left out")
        let mic = needs.first { $0.permission == .microphone }
        XCTAssertEqual(mic?.modules.map(\.id), ["voice", "music"], "one microphone question for both")
        XCTAssertEqual(mic?.forLine, "For Voice and Song ideas.")
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

    func testASwitchedOnModuleOffersWhatWasTurnedDownWithItsWayToSettings() {
        let needs = PermissionPlan.needs(modules, platform: .iphone)
        let states: [DevicePermission: PermissionState] = [
            .notifications: .allowed, .microphone: .denied, .speech: .notAsked, .calendar: .denied, .health: .askedBefore, .photos: .allowed,
        ]
        let state = { (p: DevicePermission) in states[p] ?? .notAsked }
        // Switched on: every one not allowed, turned down ones too (they show Open Settings).
        XCTAssertEqual(PermissionPlan.toOffer(needs, reason: .switchedOn, state: state).map(\.permission), [.microphone, .speech, .calendar, .health])
        // After pairing: a "no" said before is not brought up again; Health asked before is, so Continue turns its sync on.
        XCTAssertEqual(PermissionPlan.toOffer(needs, reason: .paired, state: state).map(\.permission), [.speech, .health])
        // Everything allowed: nothing to show either way.
        XCTAssertTrue(PermissionPlan.toOffer(needs, reason: .switchedOn) { _ in .allowed }.isEmpty)
    }

    func testAModuleIsTurnedOnHereOnlyWhenEachOfItsPermissionsIsAllowed() {
        let needs = PermissionPlan.needs(modules, platform: .iphone)
        let states: [DevicePermission: PermissionState] = [.microphone: .allowed, .speech: .denied, .health: .askedBefore, .photos: .allowed, .calendar: .notAsked]
        let ready = PermissionPlan.ready(needs, platform: .iphone) { states[$0] ?? .allowed }
        XCTAssertEqual(ready.map(\.id), ["notifications", "music", "health", "images"],
                       "Voice waits for speech recognition, Apple Calendar for its question; Health asked before counts")
        // The Mac too: Voice waits while speech recognition is turned down.
        XCTAssertFalse(PermissionPlan.ready(needs, platform: .mac) { states[$0] ?? .allowed }.contains { $0.id == "voice" })
    }

    func testModulesThatNeedAnAccountSayWhereToSetItUp() throws {
        let none = try JSONCoding.decode(Connections.self, from: #"{"steam": {"connected": false}, "letterboxd": {"connected": true}, "health": {"samples": 0, "total": 0}, "atlassian": {"connected": false}, "internet": []}"#)
        XCTAssertFalse(ModuleSetup.isSetUp("games", none))
        XCTAssertTrue(ModuleSetup.isSetUp("films", none))
        XCTAssertFalse(ModuleSetup.isSetUp("wiki", none))
        XCTAssertFalse(ModuleSetup.isSetUp("mail_inbox", none))
        XCTAssertFalse(ModuleSetup.isSetUp("calendars", none))
        XCTAssertTrue(ModuleSetup.isSetUp("pet", none), "a module that needs nothing is set up")
        XCTAssertEqual(ModuleSetup.place("mail_inbox", none), .addAccount)
        XCTAssertEqual(ModuleSetup.place("games", none), .connections)
        XCTAssertNil(ModuleSetup.need("pet"))
        XCTAssertNotNil(ModuleSetup.need("mail"))

        let mailOnly = try JSONCoding.decode(Connections.self, from: #"{"steam": {"connected": true}, "letterboxd": {"connected": false}, "health": {"samples": 0, "total": 0}, "internet": [{"key": "a", "kind": "icloud", "email": "jamie@example.com", "features": {"inbox": true, "receipts": false, "calendars": false}}]}"#)
        XCTAssertTrue(ModuleSetup.isSetUp("mail_inbox", mailOnly))
        XCTAssertFalse(ModuleSetup.isSetUp("mail", mailOnly), "Receipts and renewals is switched on the account itself")
        XCTAssertEqual(ModuleSetup.place("mail", mailOnly), .accounts, "an account is linked: its own switches, not Add account")
        XCTAssertTrue(ModuleSetup.isSetUp("wiki", mailOnly), "an older hub that does not say counts as set up")
        for id in ["mail_inbox", "mail", "calendars", "wiki", "games", "films"] {
            let words = ModuleSetup.need(id) ?? ""
            XCTAssertFalse(words.contains("\u{2014}") || words.contains("\u{2013}"))
        }
    }

    func testEveryPermissionHasPlainWords() {
        for p in DevicePermission.allCases {
            XCTAssertFalse(p.title.isEmpty)
            XCTAssertFalse(p.purpose.isEmpty)
            XCTAssertFalse(p.purpose.contains("\u{2014}") || p.purpose.contains("\u{2013}"), "no dashes in text a person reads")
        }
    }
}
