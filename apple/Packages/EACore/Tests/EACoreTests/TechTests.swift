import XCTest
@testable import EACore

/// The Tech Overview's words, as web/src/lib/tech.test.ts checks them on the web.
final class TechTests: XCTestCase {
    private let now = ISO.date("2026-11-19T21:00:00Z")!

    private func ent(_ id: String, _ kind: Kind, _ fields: [String: JSONValue]) -> Entity { Entity(id: id, kind: kind, fields: fields) }
    private func mon(_ id: String, _ name: String, _ type: String, _ state: String, error: String? = nil) -> Entity {
        var f: [String: JSONValue] = ["name": .string(name), "type": .string(type), "state": .string(state)]
        if let error { f["last_error"] = .string(error) }
        return ent(id, .monitor, f)
    }
    private func sensor(_ name: String, _ extra: [String: JSONValue] = [:]) -> Entity {
        var f: [String: JSONValue] = ["name": .string(name), "unit": .string("%"), "last_value": .number(50), "last_at": .string("2026-11-19T20:55:00Z"), "state": .string("ok")]
        for (k, v) in extra { f[k] = v }
        return ent(name, .sensor, f)
    }

    private let deskPc = TechThing(name: "desk-pc", kind: .machine, monitors: ["p1", "o1", "b1"],
                                   sensors: ["desk-pc.cpu.used", "desk-pc.memory.used", "desk-pc.disk.c.used", "desk-pc.disk.p.used"], reachable: true, os: "windows")
    private let pve2 = TechThing(name: "pve2", kind: .machine, monitors: ["x1"])
    private let garage = TechThing(name: "garage", label: "Garage", kind: .place, sensors: ["garage_freezer"])
    private let server = TechThing(name: "server", kind: .machine, reachable: true, hub: true)

    private var monitors: [Entity] {
        [mon("p1", "desk-pc ping", "ping", "up"), mon("o1", "Ollama", "http", "up"), mon("b1", "Desk-pc backup", "backup", "up"),
         mon("x1", "pve2 Proxmox", "tcp", "down", error: "no connection within 5 s")]
    }
    private var sensors: [Entity] {
        [sensor("desk-pc.cpu.used", ["last_value": .number(54)]),
         sensor("desk-pc.memory.used", ["last_value": .number(33.8)]),
         sensor("desk-pc.disk.c.used", ["last_value": .number(89.3), "max": .number(90)]),
         sensor("desk-pc.disk.p.used", ["last_value": .number(90.3), "max": .number(90), "state": .string("high")]),
         sensor("garage_freezer", ["unit": .string("°F"), "last_value": .number(2), "max": .number(10)])]
    }
    private var M: [String: Entity] { Dictionary(uniqueKeysWithValues: monitors.map { ($0.id, $0) }) }
    private var S: [String: Entity] { Dictionary(uniqueKeysWithValues: sensors.map { ($0.str("name"), $0) }) }

    func testSplitsMachinesByTheKindOfDeviceTheySaidTheyAreTheRestUnderNotIdentified() {
        func m(_ name: String, _ category: DeviceCategory? = nil) -> TechThing { TechThing(name: name, kind: .machine, category: category) }
        let sections = Tech.machineSections([m("gw", .network), m("pc", .computer), m("x"), m("cam", .camera)])
        XCTAssertEqual(sections.map(\.title), ["Computers", "Network", "Cameras", "Not identified"])
        XCTAssertEqual(sections.map { $0.things.map(\.name) }, [["pc"], ["gw"], ["cam"], ["x"]])
        XCTAssertEqual(Tech.machineSections([m("a"), m("b")]).map(\.title), ["Not identified"])
        XCTAssertEqual(Tech.machineSections([]), [])
        var dc1 = m("dc1"); dc1.os_name = "Windows Server 2022 Standard"; dc1.vm_of = "pve"; dc1.vm_state = "running"
        var dc2 = m("dc2"); dc2.vm_of = "pve"; dc2.vm_state = "stopped"
        XCTAssertEqual(Tech.identityLine(dc1), "Windows Server 2022 Standard, virtual machine on pve")
        XCTAssertEqual(Tech.identityLine(dc2), "virtual machine on pve")
        XCTAssertEqual(Tech.identityLine(m("x")), "")
        XCTAssertEqual(DeviceCategory.allCases.map(\.one), ["Computer", "Network device", "Printer", "Camera", "Device"])
    }

    /// The kind, OS and model are only what the hub sends, and the purpose only the owner's fact: none is worked out here.
    func testReadsWhatTheHubSaysAboutEachMachineAndGuessesNothing() throws {
        let json = #"{"monitors":[],"things":[{"name":"server","kind":"machine","reachable":true,"os":"linux","os_name":"Ubuntu 26.04 LTS","category":"computer","purpose":"Runs the hub and the models"},{"name":"desk-pc","kind":"machine","category":"toaster"},{"name":"printer","kind":"machine","category":"printer","model":"HP LaserJet Pro M404"},{"name":"dc1","kind":"machine","os_name":"","vm_of":"pve2","vm_state":"stopped"},{"name":"nas01","kind":"machine","vm_state":"running"}]}"#
        let things = try XCTUnwrap(try JSONDecoder().decode(OpsBoard.self, from: Data(json.utf8)).things)
        XCTAssertEqual(things[0].os_name, "Ubuntu 26.04 LTS")
        XCTAssertEqual(things[0].category, .computer)
        XCTAssertEqual(things[0].purpose, "Runs the hub and the models")
        XCTAssertNil(things[1].category, "a kind this app does not know reads as not identified")
        XCTAssertEqual(things[2].model, "HP LaserJet Pro M404")
        XCTAssertEqual(Tech.identityLine(things[2]), "HP LaserJet Pro M404")
        XCTAssertNil(things[3].os_name)
        XCTAssertEqual(things[3].vm_of, "pve2")
        XCTAssertEqual(things[3].vm_state, "stopped")
        XCTAssertNil(things[4].vm_state, "a state without its host says nothing")
        let local = Tech.localThings(monitors: [ent("m1", .monitor, ["name": .string("NAS ping"), "type": .string("ping"), "target": .string("nas01")])],
                                    sensors: [], hosts: ["server"])
        XCTAssertTrue(local.allSatisfy { $0.os_name == nil && $0.category == nil && $0.model == nil && $0.vm_of == nil && $0.purpose == nil })
    }

    func testReadsACheckHostFromItsTargetAsTheHubDoes() {
        XCTAssertEqual(Tech.targetHost(type: "tcp", target: "pve2:8006"), "pve2")
        XCTAssertEqual(Tech.targetHost(type: "http", target: "http://127.0.0.1:8787/health"), "127.0.0.1")
        XCTAssertEqual(Tech.targetHost(type: "backup", target: "linux:me@nas01#verify"), "nas01")
        XCTAssertEqual(Tech.targetHost(type: "tcp", target: "[fd7a::1]:22"), "fd7a::1")
        XCTAssertEqual(Tech.targetHost(type: "tls", target: "HTTPS://Example.com:8443"), "example.com")
    }

    func testNamesReadingsAsPeopleSayThem() {
        XCTAssertEqual(Tech.readingLabel("server.disk.root.used", thing: "server"), "Disk /")
        XCTAssertEqual(Tech.readingLabel("desk-pc.disk.p.used", thing: "desk-pc"), "Disk P:")
        XCTAssertEqual(Tech.readingLabel("server.disk.mnt-b.used", thing: "server"), "Disk mnt-b")
        XCTAssertEqual(Tech.readingLabel("server.cpu.used", thing: "server"), "CPU")
        XCTAssertEqual(Tech.readingLabel("server.memory.used", thing: "server"), "Memory")
        XCTAssertEqual(Tech.readingLabel("server.cpu.temp", thing: "server"), "CPU temperature")
        XCTAssertEqual(Tech.readingLabel("server.cpu1.temp", thing: "server"), "CPU 2 temperature")
        XCTAssertEqual(Tech.readingLabel("nas01.nvme0.temp", thing: "nas01"), "NVMe 1 temperature")
        XCTAssertEqual(Tech.readingLabel("server.gpu0.temp", thing: "server"), "GPU temperature")
        XCTAssertEqual(Tech.readingLabel("server.gpu1.vram", thing: "server"), "GPU 2 memory")
        XCTAssertEqual(Tech.readingLabel("nas01.zfs.tank-pool.pool", thing: "nas01"), "Pool tank-pool")
        XCTAssertEqual(Tech.readingLabel("nas01.zfs.tank-pool.healthy", thing: "nas01"), "Pool tank-pool health")
        XCTAssertEqual(Tech.readingLabel("garage_freezer", thing: "garage"), "Garage freezer")
        // No thing: the whole name, in words.
        XCTAssertEqual(Tech.readingLabel("server.cpu.used", thing: ""), "Server cpu used")
        XCTAssertEqual(Tech.readingValue(name: "nas01.zfs.tank.healthy", value: 0, unit: ""), "degraded")
        XCTAssertEqual(Tech.readingValue(name: "nas01.zfs.tank.healthy", value: 1, unit: ""), "healthy")
        XCTAssertEqual(Tech.readingValue(name: "x", value: 90.34, unit: "%"), "90.3%")
        XCTAssertEqual(Tech.readingValue(name: "x", value: 2, unit: "°F"), "2 °F")
        XCTAssertEqual(Tech.readingValue(name: "x", value: 0.25, unit: ""), "0.3")
        XCTAssertEqual(Tech.readingValue(name: "x", value: nil, unit: "%"), "no reading")
    }

    func testSaysHowEachThingIsDoingAndWhatItsChecksAre() {
        XCTAssertEqual(Tech.status(of: deskPc, monitors: M, sensors: S, now: now), TechStatus(tone: .danger, label: "1 alert"))
        XCTAssertEqual(Tech.status(of: pve2, monitors: M, sensors: S, now: now), TechStatus(tone: .danger, label: "1 down"))
        XCTAssertEqual(Tech.status(of: garage, monitors: M, sensors: S, now: now), TechStatus(tone: .ok, label: "fine"))
        XCTAssertEqual(Tech.status(of: server, monitors: M, sensors: S, now: now), TechStatus(tone: .muted, label: "no readings yet"))
        // The hub's own machine counts its own backup: it read "up" beside a failing one.
        let failing = [HubBackupLine(label: "Nightly copy", ok: false, at: nil, text: "none made yet")]
        XCTAssertEqual(Tech.status(of: server, monitors: M, sensors: S, hubBackup: failing, now: now), TechStatus(tone: .danger, label: "backup needs a look"))
        XCTAssertEqual(Tech.status(of: deskPc, monitors: M, sensors: S, hubBackup: failing, now: now).label, "1 alert")
        XCTAssertEqual(Tech.checksLine(deskPc, monitors: M), "2 checks, backup ok")
        XCTAssertEqual(Tech.checksLine(pve2, monitors: M), "1 of 1 check down")
        XCTAssertEqual(Tech.checksLine(server, monitors: M), "")
    }

    func testShowsCPUMemoryAndTheFullestDiskOnAMachinesCard() {
        let bars = Tech.machineBars(deskPc, sensors: S, now: now)
        XCTAssertEqual(bars.map(\.label), ["CPU", "Memory", "Fullest: Disk P:"])
        XCTAssertEqual(bars.map(\.text), ["54%", "33.8%", "90.3%"])
        XCTAssertEqual(bars.map(\.tone), [.ok, .ok, .danger])
        XCTAssertEqual(bars.last?.value, 90.3)
    }

    func testOrdersAMachinesReadingsCPUMemoryDisksFirst() {
        let names = ["server.gpu0.temp", "server.disk.root.used", "server.gpu0.vram", "server.memory.used", "server.cpu.used", "server.zfs.tank.pool"]
        let ordered = names.enumerated().sorted { (Tech.readingOrder($0.element), $0.offset) < (Tech.readingOrder($1.element), $1.offset) }.map(\.element)
        XCTAssertEqual(ordered, ["server.cpu.used", "server.memory.used", "server.disk.root.used", "server.zfs.tank.pool", "server.gpu0.vram", "server.gpu0.temp"])
    }

    func testListsWhatNeedsALookOneRowPerIncidentThenReadingsThenTheHubsBackup() {
        let things = [server, deskPc, pve2, garage]
        let inc = ent("i1", .incident, ["monitor_id": .string("x1"), "name": .string("pve2 Proxmox"), "opened_at": .string("2026-11-19T20:00:00Z"), "last_error": .string("no connection within 5 s")])
        let acked = ent("i2", .incident, ["monitor_id": .string("o1"), "name": .string("Ollama"), "opened_at": .string("2026-11-19T19:00:00Z"), "acknowledged_at": .string("2026-11-19T19:30:00Z")])
        let stale = sensor("garage_freezer", ["unit": .string("°F"), "state": .string("stale"), "last_at": .string("2026-11-19T15:00:00Z")])
        let looks = Tech.needsALook(things: things, monitors: monitors, incidents: [acked, inc], sensors: Array(sensors.prefix(4)) + [stale],
                                    hubBackup: [HubBackupLine(label: "Nightly copy", ok: false, at: nil, text: "none in 30 h")], now: now)
        XCTAssertEqual(looks.map(\.thing), ["pve2", "desk-pc", "garage", "server", "desk-pc"])
        XCTAssertEqual(looks.map(\.title), ["pve2 Proxmox down", "Disk P: on desk-pc at 90.3%", "Garage freezer: no reading for 6 h", "This hub's backup needs a look", "Ollama down"])
        XCTAssertEqual(looks.map { $0.monitorId ?? $0.sensor ?? "" }, ["x1", "desk-pc.disk.p.used", "garage_freezer", "", "o1"])
        XCTAssertEqual(looks[0].detail, "no connection within 5 s")
        XCTAssertEqual(looks[0].incident?.id, "i1")
        XCTAssertEqual(looks[1].detail, "alerts above 90%")
        XCTAssertEqual(looks[3].detail, "Nightly copy: none in 30 h")
        XCTAssertEqual(looks.map(\.acknowledged), [false, false, false, false, true])
        // Down (a check, the hub's own backup) is major; a reading out of bounds or silent is minor.
        XCTAssertEqual(looks.map(\.severity), [.major, .minor, .minor, .major, .major])
        XCTAssertEqual(looks.map(\.tone), [.danger, .warn, .warn, .danger, .muted])

        XCTAssertEqual(Tech.light(looks: looks, things: things, monitors: monitors, sensors: sensors),
                       TechLight(tone: .danger, label: "4 things need a look", detail: "1 acknowledged; 3 machines, 4 checks, 5 readings"))
        XCTAssertEqual(Tech.light(looks: [], things: things, monitors: monitors, sensors: sensors),
                       TechLight(tone: .ok, label: "All good", detail: "3 machines, 4 checks, 5 readings"))
        XCTAssertEqual(Tech.light(looks: [], things: [], monitors: [], sensors: []), TechLight(tone: .muted, label: "Nothing watched yet", detail: ""))
        XCTAssertEqual(Tech.light(looks: [looks[4]], things: things, monitors: monitors, sensors: []).label, "1 acknowledged")
    }

    func testLightsRedWhileSomethingDownIsNotAcknowledgedYellowWhileOnlyReadingsNeedALookGreyOnceAllAreAcknowledged() {
        let things = [server, deskPc, pve2, garage]
        let up = monitors.filter { $0.id != "x1" }
        let inc = ent("i1", .incident, ["monitor_id": .string("x1"), "name": .string("pve2 Proxmox"), "opened_at": .string("2026-11-19T20:00:00Z")])
        let acked = ent("i2", .incident, ["monitor_id": .string("o1"), "name": .string("Ollama"), "opened_at": .string("2026-11-19T19:00:00Z"), "acknowledged_at": .string("2026-11-19T19:30:00Z")])
        let stale = sensor("garage_freezer", ["unit": .string("°F"), "state": .string("stale"), "last_at": .string("2026-11-19T15:00:00Z")])
        func light(_ incidents: [Entity], _ ss: [Entity], _ ms: [Entity]? = nil, backup: [HubBackupLine] = []) -> TechLight {
            let ms = ms ?? up
            return Tech.light(looks: Tech.needsALook(things: things, monitors: ms, incidents: incidents, sensors: ss, hubBackup: backup, now: now),
                              things: things, monitors: ms, sensors: ss)
        }
        // Readings only: yellow, worded as red is.
        XCTAssertEqual(light([], sensors), TechLight(tone: .warn, label: "1 thing needs a look", detail: "3 machines, 3 checks, 5 readings"))
        XCTAssertEqual(light([], Array(sensors.prefix(4)) + [stale]), TechLight(tone: .warn, label: "2 things need a look", detail: "3 machines, 3 checks, 5 readings"))
        // Something down that was acknowledged leaves the reading yellow.
        XCTAssertEqual(light([acked], sensors), TechLight(tone: .warn, label: "1 thing needs a look", detail: "1 acknowledged; 3 machines, 3 checks, 5 readings"))
        // Anything down not yet acknowledged is red: an incident, a check down without one, the hub's own backup.
        XCTAssertEqual(light([inc], sensors).tone, .danger)
        XCTAssertEqual(light([], sensors, monitors), TechLight(tone: .danger, label: "2 things need a look", detail: "3 machines, 4 checks, 5 readings"))
        XCTAssertEqual(light([], [], backup: [HubBackupLine(label: "Nightly copy", ok: false, at: nil, text: "none in 30 h")]),
                       TechLight(tone: .danger, label: "1 thing needs a look", detail: "3 machines, 3 checks"))
        // Every look acknowledged: grey; none: green; nothing checked or read: grey.
        XCTAssertEqual(light([acked], []), TechLight(tone: .muted, label: "1 acknowledged", detail: "3 machines, 3 checks"))
        XCTAssertEqual(light([], []), TechLight(tone: .ok, label: "All good", detail: "3 machines, 3 checks"))
        XCTAssertEqual(Tech.light(looks: [], things: [], monitors: [], sensors: []), TechLight(tone: .muted, label: "Nothing watched yet", detail: ""))
        XCTAssertEqual(Tech.watched(things: [garage], monitors: [], sensors: [sensors[4]]), "1 reading")
    }

    /// A check that went down with its machine is the machine's incident: one row, not two.
    func testACheckDownWithItsMachineIsNotListedAgain() {
        var ollama = mon("o1", "Ollama", "http", "down")
        ollama.fields["joined_incident"] = .string("i1")
        let inc = ent("i1", .incident, ["monitor_id": .string("p1"), "name": .string("desk-pc ping"), "also_down": .array([.string("Ollama")])])
        let looks = Tech.needsALook(things: [deskPc], monitors: [mon("p1", "desk-pc ping", "ping", "down"), ollama], incidents: [inc], sensors: [], now: now)
        XCTAssertEqual(looks.map(\.title), ["desk-pc ping down"])
        XCTAssertEqual(looks[0].detail, "also down with it: Ollama")
    }

    func testDecodesTheThingsOfANewHubAndNoneFromAnOldOne() throws {
        let new = #"{"monitors":[],"things":[{"name":"desk-pc","label":"desk-pc","kind":"machine","monitors":["p1"],"sensors":[],"reachable":true,"os":"windows"},{"name":"garage","label":"Garage","kind":"place","monitors":[],"sensors":["garage_freezer"],"reachable":false},{"name":"x","label":"x","kind":"satellite","monitors":[],"sensors":[],"reachable":false}]}"#
        let board = try JSONDecoder().decode(OpsBoard.self, from: Data(new.utf8))
        XCTAssertEqual(board.things?.map(\.name), ["desk-pc", "garage", "x"])
        XCTAssertEqual(board.things?.first?.os, "windows")
        XCTAssertEqual(board.things?[1].label, "Garage")
        XCTAssertEqual(board.things?[1].kind, .place)
        XCTAssertEqual(board.things?[2].kind, .machine, "a kind this app does not know shows with the machines")
        let old = try JSONDecoder().decode(OpsBoard.self, from: Data(#"{"monitors":[]}"#.utf8))
        XCTAssertNil(old.things)
    }

    func testWorksOutTheThingsOnTheDeviceWhenTheHubSaysNone() {
        let ms = [ent("m1", .monitor, ["name": .string("Ollama"), "type": .string("http"), "target": .string("http://desk-pc:11434/")]),
                  ent("m2", .monitor, ["name": .string("Site"), "type": .string("http"), "target": .string("https://example.com/")]),
                  ent("m3", .monitor, ["name": .string("NAS ping"), "type": .string("ping"), "target": .string("10.0.0.16"), "host": .string("NAS01")])]
        let ss = [ent("s1", .sensor, ["name": .string("server.cpu.used"), "location": .string("server")]),
                  ent("s2", .sensor, ["name": .string("garage_freezer"), "location": .string("Garage")]),
                  ent("s3", .sensor, ["name": .string("planter_moisture")])]
        let things = Tech.localThings(monitors: ms, sensors: ss, hosts: ["laptop"])
        XCTAssertEqual(things.map(\.name), ["desk-pc", "laptop", "nas01", "server", "example.com", "garage", "home"])
        XCTAssertEqual(things.map(\.kind), [.machine, .machine, .machine, .machine, .service, .place, .place])
        XCTAssertEqual(things.first { $0.name == "nas01" }?.monitors, ["m3"])
        XCTAssertEqual(things.first { $0.name == "garage" }?.label, "Garage")
        XCTAssertEqual(things.first { $0.name == "home" }?.label, "Home")
        XCTAssertEqual(things.first { $0.name == "server" }?.sensors, ["server.cpu.used"])
    }

    /// A computer its own app reports says so; an older hub says nothing and none does.
    func testReadsWhichComputersTheirOwnAppReports() throws {
        let json = #"{"monitors":[],"things":[{"name":"laptop","kind":"machine","sensors":["laptop.cpu.used"],"reachable":false,"os_name":"macOS 26.1","category":"computer","reports_itself":true},{"name":"server","kind":"machine","reachable":true}]}"#
        let things = try XCTUnwrap(try JSONDecoder().decode(OpsBoard.self, from: Data(json.utf8)).things)
        XCTAssertEqual(things.map(\.reports_itself), [true, false])
        XCTAssertEqual(things.first?.os_name, "macOS 26.1")
    }

    /// Sample mode shows a card for each machine: the recording's board names its things and their checks.
    func testTheSampleBoardHasACardForEachMachine() throws {
        let rec = try JSONDecoder().decode(SampleTransport.Recording.self, from: Data(contentsOf: SampleScreens.bundledRecording))
        let body = try XCTUnwrap(rec.entries["GET ops"]?.body)
        let board = try JSONDecoder().decode(OpsBoard.self, from: Data(body.utf8))
        let things = try XCTUnwrap(board.things)
        XCTAssertFalse(things.isEmpty)
        let ids = Set(board.monitors.map(\.id))
        XCTAssertEqual(Set(things.flatMap(\.monitors)), ids, "every check is on one thing")
        XCTAssertEqual(things.filter(\.hub).count, 1)
        // The laptop its own app reports, with its readings in the recording too.
        let laptop = try XCTUnwrap(things.first { $0.name == "laptop" })
        XCTAssertTrue(laptop.reports_itself)
        XCTAssertFalse(laptop.reachable)
        let sensors = try XCTUnwrap(rec.entries["GET sensors"]?.body)
        for name in laptop.sensors { XCTAssertTrue(sensors.contains("\"name\":\"\(name)\""), name) }
    }
}
