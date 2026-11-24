import Foundation

// Tech (since 2026-11-19): one card and one page per thing. The hub groups every check and reading under the machine,
// service or place it belongs to (GET /ops `things`, hub/src/tech.ts); these say how each thing is doing and what
// needs a look, from the checks and readings the screens already have. A port of web/src/lib/tech.ts: the web and
// Apple screens word a thing the same way.

public enum ThingKind: String, Codable, CaseIterable, Sendable {
    case machine, service, place
}

/// What kind of device a machine is, from what it says about itself (hub/src/identify.ts): its OS line, being a
/// Proxmox guest, or what it answers on the network. Never guessed: a device that said nothing has none.
public enum DeviceCategory: String, Codable, CaseIterable, Sendable {
    case computer, network, printer, camera, other

    /// The Overview's section title.
    public var section: String {
        switch self {
        case .computer: return "Computers"
        case .network: return "Network"
        case .printer: return "Printers"
        case .camera: return "Cameras"
        case .other: return "Other devices"
        }
    }

    /// One of them: the machine page's "Computer · Ubuntu 26.04 LTS".
    public var one: String {
        switch self {
        case .computer: return "Computer"
        case .network: return "Network device"
        case .printer: return "Printer"
        case .camera: return "Camera"
        case .other: return "Device"
        }
    }
}

/// One machine, service or place with its checks and readings (`GET /ops` `things`).
public struct TechThing: Codable, Equatable, Hashable, Identifiable, Sendable {
    /// The key, lowercase: what pages use.
    public var name: String
    /// As people wrote it (a place's "Garage"); the key otherwise.
    public var label: String
    public var kind: ThingKind
    /// Monitor ids.
    public var monitors: [String]
    /// Sensor names.
    public var sensors: [String]
    /// One of the machines the person added: the hub reads its CPU, memory and disks and the assistant can run commands on it.
    public var reachable: Bool
    /// linux, macos or windows, for a machine the person added.
    public var os: String?
    /// The machine the hub runs on.
    public var hub: Bool
    /// What the machine itself says it runs ("Ubuntu 26.04 LTS"): machines the hub signs in to, and VMs with a guest
    /// agent. Nothing is inferred for the others.
    public var os_name: String?
    /// What kind of device it is, from what it says about itself; none when it said nothing.
    public var category: DeviceCategory?
    /// The facts that say so, in words ("it offers file sharing"); also why a device is not identified.
    /// The exact name it gives for itself (a printer's make and model), shown beside the kind.
    public var model: String?
    /// A virtual machine or container on this Proxmox host, and its state there.
    public var vm_of: String?
    public var vm_state: String?
    /// What it is for, in the owner's words: its fact `host:<name>` in Memory, which the assistant reads too.
    public var purpose: String?
    /// A computer its own Aeneas app reports (PUT /devices/me/computer): the hub has its readings through the app and
    /// does not sign in to it.
    public var reports_itself: Bool
    public var id: String { name }

    public init(name: String, label: String? = nil, kind: ThingKind, monitors: [String] = [], sensors: [String] = [],
                reachable: Bool = false, os: String? = nil, hub: Bool = false, os_name: String? = nil,
                category: DeviceCategory? = nil, model: String? = nil, vm_of: String? = nil, vm_state: String? = nil, purpose: String? = nil,
                reports_itself: Bool = false) {
        self.name = name; self.label = label ?? name; self.kind = kind; self.monitors = monitors; self.sensors = sensors
        self.reachable = reachable; self.os = os; self.hub = hub; self.os_name = os_name
        self.category = category; self.model = model; self.vm_of = vm_of; self.vm_state = vm_state; self.purpose = purpose
        self.reports_itself = reports_itself
    }

    enum CodingKeys: String, CodingKey {
        case name, label, kind, monitors, sensors, reachable, os, hub, os_name, category, model, vm_of, vm_state, purpose, reports_itself
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? name
        // A kind a later hub adds shows with the machines rather than taking the whole board down.
        kind = ThingKind(rawValue: (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "") ?? .machine
        monitors = (try? c.decodeIfPresent([String].self, forKey: .monitors)) ?? []
        sensors = (try? c.decodeIfPresent([String].self, forKey: .sensors)) ?? []
        reachable = (try? c.decodeIfPresent(Bool.self, forKey: .reachable)) ?? false
        os = try? c.decodeIfPresent(String.self, forKey: .os)
        hub = (try? c.decodeIfPresent(Bool.self, forKey: .hub)) ?? false
        func text(_ key: CodingKeys) -> String? { (try? c.decodeIfPresent(String.self, forKey: key)).flatMap { $0.isEmpty ? nil : $0 } }
        os_name = text(.os_name)
        // A category a later hub adds reads as none (Not identified) rather than taking the whole board down.
        category = text(.category).flatMap(DeviceCategory.init(rawValue:))
        model = text(.model)
        vm_of = text(.vm_of)
        vm_state = vm_of == nil ? nil : text(.vm_state)
        purpose = text(.purpose)
        reports_itself = (try? c.decodeIfPresent(Bool.self, forKey: .reports_itself)) ?? false
    }
}

/// One section of the Overview's machines.
public struct MachineSection: Equatable, Identifiable, Sendable {
    public var title: String
    public var things: [TechThing]
    public var id: String { title }
    public init(title: String, things: [TechThing]) { self.title = title; self.things = things }
}

/// How something is doing, as a color word: red with what is wrong, green when fine, grey before anything is known.
public enum TechTone: String, Sendable {
    case ok, danger, muted
}

public struct TechStatus: Equatable, Sendable {
    public var tone: TechTone
    public var label: String
    public init(tone: TechTone, label: String) { self.tone = tone; self.label = label }
}

/// One bar on a machine's card: CPU, memory or its fullest disk.
public struct TechBar: Equatable, Identifiable, Sendable {
    public var label: String
    /// 0 to 100.
    public var value: Double
    public var tone: TechTone
    /// "54%".
    public var text: String
    public var id: String { label }
    public init(label: String, value: Double, tone: TechTone, text: String) { self.label = label; self.value = value; self.tone = tone; self.text = text }
}

/// One row of what needs a look.
public struct TechLook: Equatable, Identifiable, Sendable {
    public var key: String
    /// The thing it is on, for its page; empty when no thing holds it.
    public var thing: String
    public var title: String
    public var detail: String?
    /// A check that is down: Propose a fix asks about this monitor.
    public var monitorId: String?
    /// Its open incident, for Acknowledge.
    public var incident: Entity?
    /// A reading out of bounds or silent: Propose a fix asks about this sensor.
    public var sensor: String?
    public var acknowledged: Bool
    public var id: String { key }
}

/// The light at the top of Tech.
public struct TechLight: Equatable, Sendable {
    public var tone: TechTone
    public var label: String
    public var detail: String
    public init(tone: TechTone, label: String, detail: String) { self.tone = tone; self.label = label; self.detail = detail }
}

/// A reading's state as the hub keeps it (`state`), or worked out the same way when the hub has not said.
public enum ReadingState: String, Sendable {
    case ok, low, high, stale

    /// Stale past `stale_minutes` (180 by default), low under `min`, high over `max`.
    public static func of(_ s: Entity, now: Date = Date()) -> ReadingState {
        if let st = ReadingState(rawValue: s.str("state")) { return st }
        guard let v = s.number("last_value"), let at = s.date("last_at") else { return .stale }
        let staleMin = s.number("stale_minutes").flatMap { $0 > 0 ? $0 : nil } ?? 180
        if now.timeIntervalSince(at) / 60 > staleMin { return .stale }
        if let lo = s.number("min"), v < lo { return .low }
        if let hi = s.number("max"), v > hi { return .high }
        return .ok
    }
}

public enum Tech {
    // MARK: Checks and readings

    /// The host a check is about when it names none: the machine or address in its target (as the hub reads it).
    public static func targetHost(type: String, target: String) -> String {
        var t = target.trimmingCharacters(in: .whitespacesAndNewlines)
        // A backup target is `<os>:<ssh destination>`, with `#job` after it.
        if type == "backup" { t = replace(#"^(mac|macos|windows|linux):"#, in: t, caseless: true); t = replace("#.*$", in: t) }
        t = replace(#"^[a-z][a-z0-9+.-]*://"#, in: t, caseless: true)
        t = replace("[/?#].*$", in: t)
        t = replace("^[^@]*@", in: t)
        if let v6 = groups(#"^\[([^\]]+)\]"#, t) { return v6[0].lowercased() }
        return replace(#":\d+$"#, in: t).lowercased()
    }

    /// A check counts unless it was switched off.
    public static func isOn(_ monitor: Entity) -> Bool { monitor.bool("enabled") != false }
    static func isDown(_ monitor: Entity) -> Bool { monitor.str("state") == "down" }
    static func isUp(_ monitor: Entity) -> Bool { monitor.str("state") == "up" }

    /// A reading out of its bounds or silent, with its alert on.
    public static func alerting(_ sensor: Entity, now: Date = Date()) -> Bool {
        sensor.bool("alert") != false && ReadingState.of(sensor, now: now) != .ok
    }

    /// How a thing is doing: red with what is wrong, green when everything checked is fine, grey before anything is.
    /// The hub's own machine counts its own backup (`hubBackup`): it read "up" beside a backup that was failing.
    public static func status(of t: TechThing, monitors: [String: Entity], sensors: [String: Entity], hubBackup: [HubBackupLine] = [], now: Date = Date()) -> TechStatus {
        let ms = t.monitors.compactMap { monitors[$0] }.filter(isOn)
        let ss = t.sensors.compactMap { sensors[$0] }
        let down = ms.filter(isDown).count
        let alerts = ss.filter { alerting($0, now: now) }.count
        let backup = t.hub && hubBackup.contains { !$0.ok }
        if down > 0 || alerts > 0 || backup {
            let parts = [down > 0 ? "\(down) down" : "", alerts > 0 ? "\(alerts) alert\(alerts == 1 ? "" : "s")" : "", backup ? "backup needs a look" : ""].filter { !$0.isEmpty }
            return TechStatus(tone: .danger, label: parts.joined(separator: ", "))
        }
        if ms.isEmpty && ss.isEmpty { return TechStatus(tone: .muted, label: t.reachable ? "no readings yet" : "nothing checked") }
        let known = ms.contains(where: isUp) || ss.contains { $0.number("last_value") != nil }
        return known ? TechStatus(tone: .ok, label: t.kind == .place ? "fine" : "up") : TechStatus(tone: .muted, label: "not checked yet")
    }

    /// "3 checks", "1 of 3 checks down", "backup ok": a card's one line about its checks.
    public static func checksLine(_ t: TechThing, monitors: [String: Entity]) -> String {
        let ms = t.monitors.compactMap { monitors[$0] }.filter(isOn)
        guard !ms.isEmpty else { return "" }
        let backups = ms.filter { $0.str("type") == "backup" }
        let checks = ms.filter { $0.str("type") != "backup" }
        var parts: [String] = []
        if !checks.isEmpty {
            let down = checks.filter(isDown).count
            let s = checks.count == 1 ? "" : "s"
            parts.append(down > 0 ? "\(down) of \(checks.count) check\(s) down" : "\(checks.count) check\(s)")
        }
        if !backups.isEmpty {
            parts.append(backups.contains(where: isDown) ? "backup failing" : backups.allSatisfy(isUp) ? "backup ok" : "backup not checked yet")
        }
        return parts.joined(separator: ", ")
    }

    /// A reading as people say it: "server.disk.root.used" on server is "Disk /", "garage_freezer" in the Garage is
    /// "Garage freezer". `thing` is the machine or place it is on; empty when none.
    public static func readingLabel(_ sensor: String, thing: String) -> String {
        let own = !thing.isEmpty && sensor.lowercased().hasPrefix(thing.lowercased() + ".")
        let rest = own ? String(sensor.dropFirst(thing.count + 1)) : sensor
        func nth(_ n: String, _ what: String) -> String { n == "0" ? what : "\(what) \(Double(n).map { number($0 + 1) } ?? n)" }
        if rest == "cpu.used" { return "CPU" }
        if rest == "memory.used" { return "Memory" }
        if let m = groups(#"^disk\.(.+)\.used$"#, rest) {
            if m[0] == "root" { return "Disk /" }
            return groups("^[a-z]$", m[0]) != nil ? "Disk \(m[0].uppercased()):" : "Disk \(m[0])"
        }
        if let m = groups(#"^cpu(\d*)\.temp$"#, rest) { return "\(nth(m[0].isEmpty ? "0" : m[0], "CPU")) temperature" }
        if let m = groups(#"^nvme(\d+)\.temp$"#, rest) { return "NVMe \(Double(m[0]).map { number($0 + 1) } ?? m[0]) temperature" }
        if let m = groups(#"^gpu(\d+)\.temp$"#, rest) { return "\(nth(m[0], "GPU")) temperature" }
        if let m = groups(#"^gpu(\d+)\.vram$"#, rest) { return "\(nth(m[0], "GPU")) memory" }
        if let m = groups(#"^zfs\.(.+)\.pool$"#, rest) { return "Pool \(m[0])" }
        if let m = groups(#"^zfs\.(.+)\.healthy$"#, rest) { return "Pool \(m[0]) health" }
        let words = replace("[._]+", in: rest, with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// A reading's value in words: a pool's health reads healthy or degraded, the rest "90.3%" or "2 °F".
    public static func readingValue(name: String, value: Double?, unit: String) -> String {
        guard let value else { return "no reading" }
        if name.hasSuffix(".healthy") { return value >= 1 ? "healthy" : "degraded" }
        // Math.round on the web: halves go up.
        let v = (value * 10 + 0.5).rounded(.down) / 10
        return unit == "%" ? "\(number(v))%" : number(v) + (unit.isEmpty ? "" : " \(unit)")
    }

    public static func readingValue(_ sensor: Entity) -> String {
        readingValue(name: sensor.str("name"), value: sensor.number("last_value"), unit: sensor.str("unit"))
    }

    /// A machine card's bars: CPU, memory and its fullest disk or pool, those it reports.
    public static func machineBars(_ t: TechThing, sensors: [String: Entity], now: Date = Date()) -> [TechBar] {
        let rows = t.sensors.compactMap { sensors[$0] }.filter { $0.number("last_value") != nil }
        func bar(_ s: Entity, _ label: String? = nil) -> TechBar {
            TechBar(label: label ?? readingLabel(s.str("name"), thing: t.name), value: max(0, min(100, s.number("last_value") ?? 0)),
                    tone: alerting(s, now: now) ? .danger : .ok, text: readingValue(s))
        }
        var out: [TechBar] = []
        if let cpu = rows.first(where: { $0.str("name").hasSuffix(".cpu.used") }) { out.append(bar(cpu)) }
        if let mem = rows.first(where: { $0.str("name").hasSuffix(".memory.used") }) { out.append(bar(mem)) }
        // Fullest first; equal ones keep the hub's order, as the web's stable sort does.
        let disks = rows.enumerated()
            .filter { matches(#"\.disk\..+\.used$|\.zfs\..+\.pool$"#, $0.element.str("name")) }
            .sorted { ($0.element.number("last_value") ?? 0, -$0.offset) > ($1.element.number("last_value") ?? 0, -$1.offset) }
            .map(\.element)
        if let fullest = disks.first {
            let label = readingLabel(fullest.str("name"), thing: t.name)
            out.append(bar(fullest, disks.count > 1 ? "Fullest: \(label)" : label))
        }
        return out
    }

    /// The Overview's machine sections: one per kind of device, then the ones that did not say what they are (Not
    /// identified). Empty sections are left out.
    public static func machineSections(_ machines: [TechThing]) -> [MachineSection] {
        var out = DeviceCategory.allCases.map { c in MachineSection(title: c.section, things: machines.filter { $0.category == c }) }
        out.append(MachineSection(title: "Not identified", things: machines.filter { $0.category == nil }))
        return out.filter { !$0.things.isEmpty }
    }

    /// A card's one line about what the machine is: what it runs, or the VM it is, or nothing.
    public static func identityLine(_ t: TechThing) -> String {
        // What it is, never how it is doing: a VM that is off is still a virtual machine (its status says the rest).
        let vm = t.vm_of.map { "virtual machine on \($0)" } ?? ""
        return [t.os_name ?? t.model ?? "", vm].filter { !$0.isEmpty }.joined(separator: ", ")
    }

    /// CPU, memory and disks first on a machine's page, then GPU memory, then temperatures and the rest.
    public static func readingOrder(_ name: String) -> Int {
        if name.hasSuffix(".cpu.used") { return 0 }
        if name.hasSuffix(".memory.used") { return 1 }
        if matches(#"\.(disk\..+\.used|zfs\..+)$"#, name) { return 2 }
        if matches(#"\.gpu\d+\.vram$"#, name) { return 3 }
        return 4
    }

    // MARK: What needs a look

    /// Everything that needs a look now, worst first: checks that are down (one row per incident: a machine that
    /// stopped answering takes its services with it), readings out of bounds or silent, and the hub's own backup.
    public static func needsALook(things: [TechThing], monitors: [Entity], incidents: [Entity], sensors: [Entity],
                                  hubBackup: [HubBackupLine] = [], now: Date = Date()) -> [TechLook] {
        var thingOfMonitor: [String: TechThing] = [:]
        var thingOfSensor: [String: TechThing] = [:]
        for t in things {
            for id in t.monitors where thingOfMonitor[id] == nil { thingOfMonitor[id] = t }
            for n in t.sensors where thingOfSensor[n] == nil { thingOfSensor[n] = t }
        }
        var out: [TechLook] = []
        var covered = Set<String>()
        for inc in incidents where (inc.string("closed_at") ?? "").isEmpty {
            let monitorId = inc.str("monitor_id")
            covered.insert(monitorId)
            for m in monitors where m.string("joined_incident") == inc.id { covered.insert(m.id) }
            let also = inc.stringArray("also_down")
            let detail = [inc.str("last_error"), also.isEmpty ? "" : "also down with it: \(also.joined(separator: ", "))"].filter { !$0.isEmpty }.joined(separator: "; ")
            out.append(TechLook(key: "inc-\(inc.id)", thing: thingOfMonitor[monitorId]?.name ?? "", title: "\(inc.str("name")) down",
                                detail: detail.isEmpty ? nil : detail, monitorId: monitorId, incident: inc, sensor: nil,
                                acknowledged: !(inc.string("acknowledged_at") ?? "").isEmpty))
        }
        for m in monitors where !covered.contains(m.id) && isOn(m) && isDown(m) {
            let err = m.str("last_error")
            out.append(TechLook(key: "mon-\(m.id)", thing: thingOfMonitor[m.id]?.name ?? "", title: "\(m.str("name")) down",
                                detail: err.isEmpty ? nil : err, monitorId: m.id, incident: nil, sensor: nil, acknowledged: false))
        }
        for s in sensors where alerting(s, now: now) {
            let name = s.str("name"), unit = s.str("unit")
            let t = thingOfSensor[name]
            let label = readingLabel(name, thing: t?.name ?? "")
            let place = t.map { $0.kind == .machine ? " on \($0.label)" : "" } ?? ""
            let state = ReadingState.of(s, now: now)
            let title: String
            if state == .stale {
                if let at = s.date("last_at") {
                    let hours = max(1, Int((now.timeIntervalSince(at) / 3600 + 0.5).rounded(.down)))
                    title = "\(label)\(place): no reading for \(hours) h"
                } else {
                    title = "\(label)\(place): no reading yet"
                }
            } else {
                title = "\(label)\(place) at \(readingValue(s))"
            }
            let unitText = unit == "%" ? "%" : unit.isEmpty ? "" : " \(unit)"
            let bound = state == .high ? s.number("max").map { "alerts above \(number($0))\(unitText)" }
                : state == .low ? s.number("min").map { "alerts below \(number($0))\(unitText)" } : nil
            out.append(TechLook(key: "sensor-\(name)", thing: t?.name ?? "", title: title, detail: bound, monitorId: nil, incident: nil,
                                sensor: name, acknowledged: false))
        }
        let bad = hubBackup.filter { !$0.ok }
        if !bad.isEmpty {
            out.append(TechLook(key: "hub-backup", thing: things.first { $0.hub }?.name ?? "", title: "This hub's backup needs a look",
                                detail: bad.map { "\($0.label): \($0.text)" }.joined(separator: "; "), monitorId: nil, incident: nil,
                                sensor: nil, acknowledged: false))
        }
        // Not yet acknowledged first; the order above otherwise.
        return out.enumerated().sorted { ($0.element.acknowledged ? 1 : 0, $0.offset) < ($1.element.acknowledged ? 1 : 0, $1.offset) }.map(\.element)
    }

    /// The light at the top of Tech: what needs a look, or that all is well and how much is watched.
    public static func light(looks: [TechLook], things: [TechThing], monitors: [Entity], sensors: [Entity]) -> TechLight {
        func n(_ c: Int, _ word: String) -> String { "\(c) \(word)\(c == 1 ? "" : "s")" }
        let open = looks.filter { !$0.acknowledged }.count
        let machines = things.filter { $0.kind == .machine }.count
        let checks = monitors.filter(isOn).count
        let watched = [machines > 0 ? n(machines, "machine") : "", checks > 0 ? n(checks, "check") : "", sensors.isEmpty ? "" : n(sensors.count, "reading")]
            .filter { !$0.isEmpty }.joined(separator: ", ")
        if !looks.isEmpty {
            let acked = looks.count - open
            return TechLight(
                tone: open > 0 ? .danger : .muted,
                label: open > 0 ? "\(n(open, "thing")) need\(open == 1 ? "s" : "") a look" : "\(acked) acknowledged",
                detail: [open > 0 && acked > 0 ? "\(acked) acknowledged" : "", watched].filter { !$0.isEmpty }.joined(separator: "; ")
            )
        }
        if checks == 0 && sensors.isEmpty { return TechLight(tone: .muted, label: "Nothing watched yet", detail: "") }
        return TechLight(tone: .ok, label: "All good", detail: watched)
    }

    // MARK: Without the hub's grouping

    /// The things worked out on the device, the way the hub groups them (hub/src/tech.ts), for when its board has none:
    /// the hub is out of reach, or older than 2026-11-19. Without the hub's list of machines it can reach, no thing is
    /// `reachable` and a name is not matched to its other names. `hosts`: other machines named by fix notes, changes
    /// and snippets.
    public static func localThings(monitors: [Entity], sensors: [Entity], hosts: [String] = []) -> [TechThing] {
        var things: [String: TechThing] = [:]
        var order: [String] = []
        func key(_ raw: String) -> String {
            let n = replace(#"\.local$"#, in: raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
            if n.hasSuffix("-wifi"), things[String(n.dropLast(5))] != nil { return String(n.dropLast(5)) }
            return n
        }
        func touch(_ name: String, _ kind: ThingKind, label: String? = nil) {
            if var t = things[name] {
                // A machine stays a machine: a ping or a reading of its own outranks a web check that named it first.
                if kind == .machine && t.kind != .machine { t.kind = .machine; things[name] = t }
            } else {
                things[name] = TechThing(name: name, label: label ?? name, kind: kind)
                order.append(name)
            }
        }
        for m in monitors.sorted(by: { $0.str("name").localizedStandardCompare($1.str("name")) == .orderedAscending }) {
            let type = m.str("type")
            let host = m.str("host").trimmingCharacters(in: .whitespaces)
            let k = key(host.isEmpty ? targetHost(type: type, target: m.str("target")) : host)
            guard !k.isEmpty else { continue }
            let machine = type == "ping" || type == "backup" || !k.contains(".") || matches(#"^\d{1,3}(\.\d{1,3}){3}$"#, k) || k.contains(":")
            touch(k, machine ? .machine : .service)
            things[k]?.monitors.append(m.id)
        }
        for h in hosts { let k = key(h); if !k.isEmpty { touch(k, .machine) } }
        for s in sensors.sorted(by: { $0.str("name").localizedStandardCompare($1.str("name")) == .orderedAscending }) {
            let name = s.str("name")
            let loc = s.str("location").trimmingCharacters(in: .whitespacesAndNewlines)
            let k = loc.isEmpty ? "home" : key(loc)
            // A machine's own readings are named after it (server.disk.root.used); a board somewhere is a place.
            let own = !loc.isEmpty && name.lowercased().hasPrefix(loc.lowercased() + ".")
            if things[k] == nil { touch(k, own ? .machine : .place, label: loc.isEmpty ? "Home" : loc) }
            things[k]?.sensors.append(name)
        }
        let rank: [ThingKind: Int] = [.machine: 0, .service: 1, .place: 2]
        return order.compactMap { things[$0] }.sorted { (rank[$0.kind] ?? 0, $0.name) < (rank[$1.kind] ?? 0, $1.name) }
    }

    // MARK: Words and patterns

    /// A number as the web writes it: 90, 90.3.
    public static func number(_ d: Double) -> String {
        d.rounded() == d && abs(d) < 1e15 ? String(Int64(d)) : String(d)
    }

    private static func regex(_ pattern: String, caseless: Bool = false) -> NSRegularExpression? {
        try? NSRegularExpression(pattern: pattern, options: caseless ? [.caseInsensitive] : [])
    }

    private static func replace(_ pattern: String, in s: String, with template: String = "", caseless: Bool = false) -> String {
        guard let re = regex(pattern, caseless: caseless) else { return s }
        return re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: template)
    }

    private static func matches(_ pattern: String, _ s: String) -> Bool {
        regex(pattern)?.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    /// The capture groups of the first match (the whole match when there are none), or nil.
    private static func groups(_ pattern: String, _ s: String) -> [String]? {
        guard let m = regex(pattern)?.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
        if m.numberOfRanges <= 1 { return [String(s[Range(m.range, in: s)!])] }
        return (1..<m.numberOfRanges).map { i in Range(m.range(at: i), in: s).map { String(s[$0]) } ?? "" }
    }
}
