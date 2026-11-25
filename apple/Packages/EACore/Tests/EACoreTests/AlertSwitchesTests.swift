import XCTest
@testable import EACore

/// Alert switches (since 2026-11-20): the list decodes with and without `alerts`, a kind is on until it is switched
/// off (unknown and never fetched too), and what this device plans or shows by itself obeys the switches.
@MainActor
final class AlertSwitchesTests: XCTestCase {
    /// `GET /modules` as the hub answers it, `alerts` beside `modules`. `disk` belongs to no module; `later` is a
    /// kind this app does not know.
    private let answer = """
    {"modules": [
      {"id": "notifications", "title": "Reminder alerts", "summary": "", "group": "On your devices", "on": true},
      {"id": "homelab", "title": "Machines", "summary": "", "group": "Tech", "on": true},
      {"id": "quiz", "title": "Recall quiz", "summary": "", "group": "Notes", "on": false}
    ], "alerts": [
      {"id": "reminder", "title": "Reminders", "summary": "A reminder's time has come.", "module": "notifications", "on": true},
      {"id": "digest", "title": "Morning summary", "summary": "Today's plan, once each morning.", "module": "notifications", "on": false},
      {"id": "activity", "title": "Activity check-ins", "summary": "Still on it?", "on": true},
      {"id": "monitor", "title": "Machines and services", "summary": "Down, or back.", "module": "homelab", "on": false},
      {"id": "disk", "title": "Hub disk space", "summary": "Almost full.", "on": true},
      {"id": "quiz", "title": "Recall quiz", "summary": "The day's questions are ready.", "module": "quiz", "on": true},
      {"id": "later", "title": "Something newer", "summary": "", "module": "garden", "on": true, "extra": 1}
    ]}
    """

    private var alerts: [AlertInfo] { (try? JSONCoding.decode(ModulesResponse.self, from: answer).alerts) ?? [] }

    private func off(_ kinds: AlertKind...) -> [AlertInfo] {
        AlertKind.allCases.map { AlertInfo(id: $0.rawValue, title: $0.rawValue, on: !kinds.contains($0)) }
    }

    private func config() -> SharedConfig {
        let c = SharedConfig(suiteName: "eacore-alerts-\(UUID().uuidString)")
        c.hubURL = "http://hub-a.test"
        c.storeDeviceKey("ead1_a")
        c.deviceId = "11111111-1111-4111-8111-111111111111"
        return c
    }

    private func reminder(_ id: String) -> Entity {
        Entity(id: id, kind: .task, fields: ["title": "Call Jamie", "status": "scheduled", "order": 1, "remind_at": .string(ISO.string(Date().addingTimeInterval(86400)))])
    }

    // MARK: decoding

    func testDecodesAlertsBesideModulesInTheHubsOrder() throws {
        let r = try JSONCoding.decode(ModulesResponse.self, from: answer)
        XCTAssertEqual(r.modules.map(\.id), ["notifications", "homelab", "quiz"])
        let a = try XCTUnwrap(r.alerts)
        XCTAssertEqual(a.map(\.id), ["reminder", "digest", "activity", "monitor", "disk", "quiz", "later"])
        XCTAssertEqual(a[0], AlertInfo(id: "reminder", title: "Reminders", summary: "A reminder's time has come.", module: "notifications", on: true))
        XCTAssertNil(a[2].module, "an alert of no module")
        XCTAssertFalse(a[3].on)
        XCTAssertNil(AlertKind(rawValue: "later"), "a kind from a newer hub still decodes")
    }

    func testAnOlderHubSendsNoAlerts() throws {
        let r = try JSONCoding.decode(ModulesResponse.self, from: #"{"modules": [{"id": "pet", "title": "Pet", "on": false}]}"#)
        XCTAssertNil(r.alerts)
        XCTAssertEqual(r.modules.map(\.id), ["pet"])
        // Written back out (the live event in tests), nothing is made up for it.
        XCTAssertFalse(try JSONCoding.string(r).contains("alerts"))
    }

    func testAlertsThatDoNotReadAsAListKeepTheModules() throws {
        let r = try JSONCoding.decode(ModulesResponse.self, from: #"{"modules": [{"id": "pet", "on": true}], "alerts": "soon"}"#)
        XCTAssertEqual(r.modules.map(\.id), ["pet"])
        XCTAssertNil(r.alerts)
    }

    func testAThinAlertIsOnUnderItsId() throws {
        XCTAssertEqual(try JSONCoding.decode(AlertInfo.self, from: #"{"id": "mail"}"#), AlertInfo(id: "mail", title: "mail", summary: "", module: nil, on: true))
        XCTAssertEqual(try JSONCoding.decode(AlertInfo.self, from: #"{"id": "mail", "on": false, "module": 4}"#), AlertInfo(id: "mail", title: "mail", on: false))
    }

    func testLiveModulesEventCarriesTheAlerts() throws {
        guard case .modules(let m, let a, _) = HubClient.liveEvent(SSEMessage(event: "modules", data: answer)) else { return XCTFail("not a modules event") }
        XCTAssertEqual(m.count, 3)
        XCTAssertEqual(a?.map(\.id), ["reminder", "digest", "activity", "monitor", "disk", "quiz", "later"])
        XCTAssertEqual(a?.isOn(.monitor), false)
    }

    // MARK: the list

    func testUnknownOrNotLoadedMeansOn() {
        XCTAssertTrue(alerts.isOn(.reminder))
        XCTAssertFalse(alerts.isOn(.digest))
        XCTAssertFalse(alerts.isOn("monitor"))
        XCTAssertTrue(alerts.isOn(.mail), "a kind the hub did not list is on")
        XCTAssertTrue(alerts.isOn("not yet invented"))
        XCTAssertTrue([AlertInfo]().isOn(.reminder), "nothing loaded yet, or an older hub: every kind is on")
    }

    func testSettingsLeavesOutAlertsOfModulesThatAreOff() throws {
        let r = try JSONCoding.decode(ModulesResponse.self, from: answer)
        let shown = alerts.shown(with: r.modules)
        XCTAssertEqual(shown.map(\.id), ["reminder", "digest", "activity", "monitor", "disk", "later"], "the quiz module is off; a module the hub did not list counts as on")
        var none = r.modules
        for i in none.indices { none[i].on = false }
        XCTAssertEqual(alerts.shown(with: none).map(\.id), ["activity", "disk", "later"], "alerts of no module always show")
        XCTAssertEqual(alerts.shown(with: []).count, alerts.count, "modules not loaded yet: everything shows")
    }

    // MARK: the client

    func testClientReadsAndSwitchesAlerts() async throws {
        let t = FakeTransport()
        t.responses = [(200, Data(answer.utf8)), (200, Data(#"{"alerts": [{"id": "reminder", "title": "Reminders", "summary": "", "module": "notifications", "on": false}]}"#.utf8))]
        let c = HubClient(transport: t)
        let r = try await c.modulesAndAlerts()
        XCTAssertEqual(t.calls.last?.method, "GET")
        XCTAssertEqual(t.calls.last?.path, "modules")
        XCTAssertEqual(r.alerts?.count, 7)
        let after = try await c.setAlerts(["reminder": false])
        XCTAssertEqual(t.calls.last?.method, "PUT")
        XCTAssertEqual(t.calls.last?.path, "modules/alerts")
        XCTAssertEqual(try JSONSerialization.jsonObject(with: t.calls.last?.body ?? Data()) as? [String: Bool], ["reminder": false])
        XCTAssertFalse(after.isOn(.reminder))
    }

    func testARefusedSwitchReadsAsTheHubsSentence() async {
        let t = FakeTransport()
        t.responses = [(422, Data(#"{"error": "unknown kind of alert: later"}"#.utf8))]
        do { _ = try await HubClient(transport: t).setAlerts(["later": false]); XCTFail("expected an error") }
        catch { XCTAssertEqual(error as? HubError, .http(status: 422, message: "unknown kind of alert: later")) }
    }

    // MARK: the stored switches

    func testStoredSwitchesAreOnUntilSwitchedOffAndOnAgain() {
        let cfg = SharedConfig(suiteName: "eacore-alerts-\(UUID().uuidString)")
        XCTAssertNil(cfg.alerts)
        XCTAssertTrue(cfg.alertOn(.reminder), "never fetched: on")
        XCTAssertTrue(cfg.alertOn("not yet invented"))
        cfg.alerts = off(.reminder, .activity)
        XCTAssertFalse(cfg.alertOn(.reminder))
        XCTAssertFalse(cfg.alertOn("activity"))
        XCTAssertTrue(cfg.alertOn(.digest))
        XCTAssertTrue(cfg.alertOn("not yet invented"), "a kind the hub does not list stays on")
        cfg.alerts = off()
        XCTAssertTrue(cfg.alertOn(.reminder), "switched on again")
        cfg.alerts = off(.digest)
        cfg.alerts = nil
        XCTAssertTrue(cfg.alertOn(.digest), "an older hub sends none: every kind is on again")
    }

    func testANotificationNeedsItsKindAndReminderAlertsOn() {
        let cfg = SharedConfig(suiteName: "eacore-alerts-\(UUID().uuidString)")
        XCTAssertTrue(cfg.notifies(.reminder))
        XCTAssertTrue(cfg.notifies("monitor"))
        cfg.alerts = off(.monitor)
        XCTAssertFalse(cfg.notifies("monitor"), "a hub alert of a kind that is off does not show")
        XCTAssertTrue(cfg.notifies(.sensor))
        XCTAssertTrue(cfg.notifies(.digest))
        cfg.modules = [ModuleInfo(id: "notifications", title: "Reminder alerts", group: "On your devices", on: false)]
        XCTAssertFalse(cfg.notifies(.sensor), "Reminder alerts off in Modules stops every notification of this device")
        XCTAssertTrue(cfg.alertOn(.sensor), "the kind's own switch is unchanged")
    }

    func testARemovedDevicesSwitchesGoWithItsSnapshot() {
        let cfg = SharedConfig(suiteName: "eacore-alerts-\(UUID().uuidString)")
        cfg.alerts = off(.reminder)
        cfg.clearSnapshot()
        XCTAssertNil(cfg.alerts)
        XCTAssertTrue(cfg.alertOn(.reminder))
    }

    // MARK: what the device plans itself

    /// Reminders switched off takes the planned reminder notifications off, as Reminder alerts off in Modules does,
    /// and on brings them back. `onReplan` stands in for the notification centre.
    func testRemindersSwitchedOffTakesPlannedAlertsOffAndOnBringsThemBack() async throws {
        let c = config()
        let store = try SyncStore.inMemory()
        try await store.upsertFromHub(reminder("t1"))
        let engine = SyncEngine(config: c, platform: .iphone, store: store)
        var plans: [[String]] = []
        engine.onReplan = { plans.append($0.map(\.id)) }
        engine.makeClient = { HubClient(transport: OneHub()) }
        await engine.start()
        XCTAssertEqual(plans.last, ["t1"])
        XCTAssertEqual(engine.alerts, [], "nothing from the hub yet: no switches, every kind on")

        await engine.applyAlerts(off(.reminder))
        XCTAssertEqual(plans.last, [], "the planned reminder alerts are taken off")
        XCTAssertEqual(c.alerts, off(.reminder), "kept for the next launch, the widgets and the Watch")
        XCTAssertFalse(engine.alerts.isOn(.reminder))
        // A sync or an edit replans: still nothing while the switch is off.
        await engine.replanNotifications()
        XCTAssertEqual(plans.last, [])

        await engine.applyAlerts(off())
        XCTAssertEqual(plans.last, ["t1"], "switched on again, they come back")

        // A kind this device does not plan ahead changes no plan.
        let count = plans.count
        await engine.applyAlerts(off(.quiz, .monitor))
        XCTAssertEqual(plans.count, count)

        // Reminder alerts off in Modules still takes everything off, whatever the kind's switch says.
        c.modules = [ModuleInfo(id: "notifications", title: "Reminder alerts", group: "On your devices", on: false)]
        await engine.replanNotifications()
        XCTAssertEqual(plans.last, [])
        c.modules = nil

        // A hub with no switches (an older one): the stored ones go and every kind is on.
        await engine.applyAlerts(off(.reminder))
        XCTAssertEqual(plans.last, [])
        await engine.applyAlerts(nil)
        XCTAssertEqual(plans.last, ["t1"])
        XCTAssertNil(c.alerts)
        XCTAssertEqual(engine.alerts, [])
        engine.stop()
    }

    func testTheEngineStartsFromTheStoredSwitches() throws {
        let c = config()
        c.alerts = off(.digest)
        let engine = SyncEngine(config: c, platform: .watch, store: try SyncStore.inMemory())
        XCTAssertEqual(engine.alerts, off(.digest))
    }

    func testSwitchingAKindAsksTheHubAndTakesItsAnswer() async throws {
        let c = config()
        let engine = SyncEngine(config: c, platform: .iphone, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        let t = FakeTransport()
        engine.makeClient = { HubClient(transport: t) }
        await engine.start()
        t.responses = [(200, try JSONCoding.data(AlertsResponse(alerts: off(.sensor))))]
        try await engine.setAlerts(["sensor": false])
        XCTAssertEqual(t.calls.last?.path, "modules/alerts")
        XCTAssertEqual(t.calls.last?.method, "PUT")
        XCTAssertFalse(engine.alerts.isOn(.sensor))
        XCTAssertFalse(c.alertOn(.sensor))
        // Refused: the switches stay as they were, and the caller hears why.
        t.responses = [(422, Data(#"{"error": "unknown kind of alert: later"}"#.utf8))]
        do { try await engine.setAlerts(["later": false]); XCTFail("expected an error") }
        catch { XCTAssertEqual(error as? HubError, .http(status: 422, message: "unknown kind of alert: later")) }
        XCTAssertEqual(engine.alerts, off(.sensor))
        engine.stop()
    }

    /// The hub still writes a check-in on the running activity's log while Activity check-ins is off. A device that
    /// finds it by a pull (the Watch every minute) asks nothing then.
    func testAPolledActivityCheckinObeysItsSwitch() async throws {
        func asked(_ switches: [AlertInfo]?) async throws -> [String] {
            let c = config()
            c.alerts = switches
            let log = Entity(id: "log-1", kind: .log, fields: [
                "type": "activity", "value": "Homelab", "at": .string(ISO.string(Date().addingTimeInterval(-3 * 3600))),
                "checkins": [.string(ISO.string(Date().addingTimeInterval(-30)))],
            ])
            let engine = SyncEngine(config: c, platform: .watch, store: try SyncStore.inMemory())
            engine.schedulesNotifications = false
            var names: [String] = []
            engine.onActivityCheckin = { names.append($0.name) }
            engine.makeClient = { HubClient(transport: OneHub([log])) }
            await engine.start()
            engine.stop()
            return names
        }
        let on = try await asked(nil)
        XCTAssertEqual(on, ["Homelab"])
        let alsoOn = try await asked(off(.reminder))
        XCTAssertEqual(alsoOn, ["Homelab"])
        let switchedOff = try await asked(off(.activity))
        XCTAssertEqual(switchedOff, [])
    }
}
