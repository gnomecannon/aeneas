import Foundation

/// Someone who helps this person with their devices (hub/src/helpers.ts, docs/helpers.md): usually a family member
/// whose machine this person's hub runs on. The person says yes once; after that the helper never asks them, and
/// everything the helper does is in a log the person can read.
public struct Helper: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    /// offered, active or stopped.
    public var state: String
    public var offered_at: String
    public var accepted_at: String?
    public var stopped_at: String?
    public var stopped_by: String?

    public var isOffered: Bool { state == "offered" }
    public var isActive: Bool { state == "active" }
}

/// One line of the log the person reads: what their helper did, in plain words.
public struct HelperLogLine: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var at: String
    public var helper: String
    /// offered, accepted, stopped, check, change, scan or password.
    public var kind: String
    public var device: String?
    public var text: String
    /// The exact command, for a check or a change.
    public var detail: String?
    public var outcome: String?
}

/// A computer of this person whose Aeneas app lets the helper run commands.
public struct HelperComputer: Codable, Equatable, Sendable {
    public var device_id: String
    public var name: String
    public var os: String
    public var on: Bool
    public var at: String
    public var listening: Bool?
}

/// A device found on the person's home network.
public struct HomeDevice: Codable, Equatable, Sendable, Identifiable {
    public var name: String
    public var ip: String
    public var open: [Int]
    public var kind: String?
    public var id: String { ip }

    public init(name: String, ip: String, open: [Int], kind: String?) {
        self.name = name; self.ip = ip; self.open = open; self.kind = kind
    }
}

public struct HomeScan: Codable, Equatable, Sendable {
    public var at: String
    public var by: String
    public var network: String?
    public var devices: [HomeDevice]
}

/// GET /helpers: the person's own view of who helps them.
public struct HelpersView: Codable, Equatable, Sendable {
    public struct ThisDevice: Codable, Equatable, Sendable {
        public var device_id: String
        public var agent: HelperComputer?
    }
    public struct SavedPassword: Codable, Equatable, Sendable, Identifiable {
        public var title: String
        public var username: String
        public var id: String { title }
    }
    public var helpers: [Helper]
    public var log: [HelperLogLine]
    public var passwords: [SavedPassword]
    public var computers: [HelperComputer]
    public var scan: HomeScan?
    public var this_device: ThisDevice?

    public var offered: Helper? { helpers.first { $0.isOffered } }
    public var active: [Helper] { helpers.filter(\.isActive) }

    /// "Robin" or "Robin and Sam": the helpers' names in a sentence.
    public static func names(_ list: [Helper]) -> String { list.map(\.name).joined(separator: " and ") }

    /// The Settings row's summary, or nil to leave the row out (nobody helps or offered).
    public var summary: String? {
        if !active.isEmpty { return "\(Self.names(active)) \(active.count > 1 ? "help" : "helps") you" }
        let o = helpers.filter(\.isOffered)
        if !o.isEmpty { return "\(Self.names(o)) offered to help" }
        return nil
    }
}

/// Work the helper sent for this computer.
public struct AgentJob: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var device_id: String
    public var command: String
    public var os: String
    public var timeout_s: Double
    public var created_at: String
    /// Sign in to another device in the home and run `command` there (the Windows app does; a Mac answers that it
    /// cannot yet). Older jobs have none.
    public var ssh: SSHTarget?

    /// Another device in the home and how to sign in to it. Its password is never written anywhere or shown.
    public struct SSHTarget: Codable, Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
        public var ip: String
        public var port: Int?
        public var username: String
        public var password: String?
        public var host_key: String?
        public var description: String { "\(username)@\(ip):\(port ?? 22)" }
        public var debugDescription: String { description }
    }

    /// What a Mac answers to a job for another device.
    public static let macCannotSignIn = "This Mac cannot sign in to other devices yet. The Aeneas app for Windows can."
}

public struct AgentJobs: Codable, Equatable, Sendable {
    public var jobs: [AgentJob]
    public var helping: Bool?
}

// MARK: Calls

extension HubClient {
    /// 404 on a hub before 1.0.6: there are no helpers there.
    public func helpers() async throws -> HelpersView { try await get("helpers", as: HelpersView.self) }

    public func acceptHelper(_ id: String) async throws {
        _ = try await send("POST", "helpers/\(Self.segment(id))/accept", body: Data("{}".utf8))
    }

    public func stopHelper(_ id: String) async throws {
        _ = try await send("POST", "helpers/\(Self.segment(id))/stop", body: Data("{}".utf8))
    }

    public func saveHelperPassword(title: String, username: String?, password: String) async throws {
        struct B: Encodable { var title: String; var username: String?; var password: String }
        _ = try await send("PUT", "helpers/passwords", body: try JSONCoding.data(B(title: title, username: username, password: password)))
    }

    public func removeHelperPassword(_ title: String) async throws {
        _ = try await send("DELETE", "helpers/passwords/\(Self.segment(title))")
    }

    public func sendHomeScan(network: String?, devices: [HomeDevice]) async throws {
        struct B: Encodable { var network: String?; var devices: [HomeDevice] }
        _ = try await send("POST", "helpers/scan", body: try JSONCoding.data(B(network: network, devices: devices)))
    }

    /// Whether this computer lets its helper run things on it.
    public func setAgent(on: Bool, os: String, name: String) async throws {
        struct B: Encodable { var on: Bool; var os: String; var name: String }
        _ = try await send("PUT", "agent/me", body: try JSONCoding.data(B(on: on, os: os, name: name)))
    }

    /// Work for this computer: the hub waits up to `wait` seconds for some (HTTPTransport.timeout gives the route 60 s).
    public func agentJobs(wait: Int) async throws -> AgentJobs {
        try await get("agent/jobs", query: ["wait": String(wait)], as: AgentJobs.self)
    }

    public func finishAgentJob(_ id: String, exitCode: Int, output: String) async throws {
        struct B: Encodable { var exit_code: Int; var output: String }
        _ = try await send("POST", "agent/jobs/\(Self.segment(id))", body: try JSONCoding.data(B(exit_code: exitCode, output: output)))
    }

    /// One path segment, escaped (a password's name may have spaces).
    static func segment(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/?#"))) ?? s
    }
}

// MARK: Plain times

public enum HelperTime {
    /// "Today at 3:14 PM", "Yesterday at 9:02 AM", "Monday at 3:14 PM" or "November 3 at 3:14 PM".
    public static func when(_ iso: String, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        guard let d = ISO.date(iso) else { return iso }
        let time = d.formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, calendar: calendar, timeZone: calendar.timeZone))
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: d), to: calendar.startOfDay(for: now)).day ?? 0
        if days == 0 { return "Today at \(time)" }
        if days == 1 { return "Yesterday at \(time)" }
        var f = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        f = days < 7 && days > 0 ? f.weekday(.wide) : f.month(.wide).day()
        return "\(d.formatted(f)) at \(time)"
    }

    /// "Since today at 3:14 PM": the same, inside a sentence.
    public static func since(_ iso: String, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> String {
        var w = when(iso, now: now, calendar: calendar, locale: locale)
        if w.hasPrefix("Today") || w.hasPrefix("Yesterday") { w = w.prefix(1).lowercased() + w.dropFirst() }
        return "Since \(w)"
    }
}

// MARK: What a device on the home network is

public enum HomeDeviceKind {
    /// What a device most likely is, from the ports that answered, its address and the name it announced. The same
    /// rules as the Windows and Android apps (web/src-tauri/src/helper.rs kind_of).
    public static func kind(ip: String, open: [Int], announced: String) -> String {
        let has = { (p: Int) in open.contains(p) }
        let a = announced.lowercased()
        let last = Int(ip.split(separator: ".").last ?? "") ?? 0
        if has(62078) || a.contains("iphone") || a.contains("ipad") { return "iPhone or iPad" }
        if has(9100) || has(631) || a.contains("printer") { return "printer" }
        if has(3389) { return "Windows computer (Remote Desktop on)" }
        // Screen sharing with file sharing is how a Mac answers; Windows does not offer screen sharing on that port.
        if has(548) || (has(5900) && has(445)) || a.contains("macbook") || a.contains("imac") || a.contains("mac mini") || a.contains("mac studio") { return "Mac" }
        if has(8009) || a.contains("chromecast") || a.contains("google") { return "Chromecast or Google speaker" }
        if has(1400) || a.contains("sonos") { return "Sonos speaker" }
        if has(554) { return "camera" }
        if last == 1 && (has(80) || has(443)) { return "router" }
        // File sharing with a web page of its own is a storage box (NAS) far more often than a PC.
        if has(445) && (has(443) || has(8080) || has(5000)) { return "storage box (NAS) or file server" }
        if has(445) { return "Windows computer" }
        if has(22) { return "computer or device with SSH" }
        if has(5900) { return "computer with screen sharing" }
        if has(80) || has(443) || has(8080) { return "device with a web page" }
        return "device"
    }
}
