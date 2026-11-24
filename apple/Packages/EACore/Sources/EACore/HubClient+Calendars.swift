import Foundation

/// Calendar sync on the hub (`calendars` module, hub `calendar-sync.ts`): the iCloud calendars the owner chooses are
/// kept in step with the app's personal events by the hub, both ways, with no device involved.
public struct HubCalendars: Decodable, Equatable, Sendable {
    public var accounts: [Account]
    /// The hub keeps at least one calendar in step (the Apple apps then leave personal events to it).
    public var active: Bool

    public struct Account: Decodable, Equatable, Sendable, Identifiable {
        public var id: String { email }
        public var email: String
        /// Receipts and renewals reads this address too, with the same app-specific password.
        public var mail: Bool
        /// Read only (Internet Accounts): its calendars are read and never written; new events stay in the app. Nil
        /// from an older hub.
        public var read_only: Bool?
        public var calendars: [Calendar]
        /// Where events made in the app go; nil keeps them in the app.
        public var target: String?
        public var last_sync: String?
        public var last_error: String?

        public init(email: String, mail: Bool = false, read_only: Bool? = nil, calendars: [Calendar] = [], target: String? = nil, last_sync: String? = nil, last_error: String? = nil) {
            self.email = email; self.mail = mail; self.read_only = read_only; self.calendars = calendars; self.target = target; self.last_sync = last_sync; self.last_error = last_error
        }
    }

    public struct Calendar: Decodable, Equatable, Sendable, Identifiable {
        public var id: String { url }
        public var url: String
        public var name: String
        public var color: String?
        public var writable: Bool
        public var chosen: Bool

        public init(url: String, name: String, color: String? = nil, writable: Bool, chosen: Bool) {
            self.url = url; self.name = name; self.color = color; self.writable = writable; self.chosen = chosen
        }
    }

    public init(accounts: [Account] = [], active: Bool = false) { self.accounts = accounts; self.active = active }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accounts = try c.decodeIfPresent([Account].self, forKey: .accounts) ?? []
        active = try c.decodeIfPresent(Bool.self, forKey: .active) ?? false
    }
    private enum CodingKeys: String, CodingKey { case accounts, active }
}

private struct NoBody: Codable {}

extension HubClient {
    /// `GET /calendars`.
    public func calendars() async throws -> HubCalendars { try await get("calendars", as: HubCalendars.self) }

    /// Link an iCloud address for calendar sync. The password may be left out when the address is already linked for
    /// iCloud Mail (the hub uses the same one). The hub checks it with iCloud by finding the calendars.
    public func linkICloudCalendars(email: String, password: String?) async throws -> HubCalendars {
        struct Body: Encodable { var email: String; var password: String? }
        let p = password?.trimmingCharacters(in: .whitespaces)
        return try await post("calendars/icloud", Body(email: email, password: (p?.isEmpty ?? true) ? nil : p), as: HubCalendars.self, method: "PUT")
    }

    /// Choose the calendars kept in step and the one new events go to (nil: they stay in the app).
    public func chooseCalendars(email: String, chosen: [String], target: String?) async throws -> HubCalendars {
        struct Body: Encodable {
            var chosen: [String]; var target: String?
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(chosen, forKey: .chosen)
                // null is "keep them in the app"; it has to be sent, not left out.
                if let target { try c.encode(target, forKey: .target) } else { try c.encodeNil(forKey: .target) }
            }
            enum CodingKeys: String, CodingKey { case chosen, target }
        }
        return try await post("calendars/icloud/\(email)", Body(chosen: chosen, target: target), as: HubCalendars.self, method: "PUT")
    }

    /// Sync now (also tries an address iCloud refused, once).
    public func syncCalendarsNow() async throws -> HubCalendars { try await post("calendars/sync", NoBody(), as: HubCalendars.self) }

    // The address goes in the path as it is, as for iCloud Mail: the transport encodes the path itself.

    /// Stop calendar sync for an address. The answer says what happened to its events and password.
    public func stopCalendarSync(email: String) async throws -> String {
        struct Answer: Decodable { var message: String? }
        let data = try await send("DELETE", "calendars/icloud/\(email)")
        return (try? JSONCoding.decode(Answer.self, from: data))?.message ?? "Calendar sync stopped for \(email)."
    }
}
