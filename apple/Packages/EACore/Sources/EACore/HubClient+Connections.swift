import Foundation

/// `GET /connections`: linked accounts and imports, with no secrets (the Steam key shows as its last four characters).
public struct Connections: Decodable, Equatable, Sendable {
    public struct Steam: Decodable, Equatable, Sendable {
        public var connected: Bool
        /// The hub has its own Steam Web API key; members only sign in.
        public var hub_key: Bool?
        public var steam_id: String?
        public var persona: String?
        public var profile_url: String?
        public var last_sync: String?
        public var last_error: String?
        public var games: Int?
    }
    public struct Letterboxd: Decodable, Equatable, Sendable {
        public var connected: Bool
        public var username: String?
        public var last_sync: String?
        public var last_error: String?
        public var films: Int?
    }
    public struct Health: Decodable, Equatable, Sendable {
        public var last_import: String?
        public var samples: Int
        public var total: Int
    }
    /// Confluence for the game design wiki. `app` says only whether the hub has its Atlassian app; the secret stays there.
    public struct Atlassian: Decodable, Equatable, Sendable {
        public var connected: Bool
        public var app: Bool?
        public var site_name: String?
        public var site_url: String?
        public var spaces: [String]?
        public var last_sync: String?
        public var last_error: String?
        public var pages: Int?
    }
    /// Gmail, read-only, one entry per linked mailbox. `app` says only whether the hub has its Google app; the secret stays there.
    public struct Google: Decodable, Equatable, Sendable {
        public struct Account: Decodable, Equatable, Sendable, Identifiable {
            /// Records filed from the mailbox's mail (deleted ones not counted).
            public struct Filed: Decodable, Equatable, Sendable {
                public var renewals: Int
                public var pet: Int
                public var events: Int
            }
            public var email: String
            public var linked_at: String?
            public var last_sync: String?
            public var last_error: String?
            public var listed: Int?
            public var to_read: Int?
            public var read: Int?
            public var failed: Int?
            public var filed: Filed?
            public var id: String { email }

            /// What the mail came to, in a line: "Filed 3 renewals, 1 pet record from 40 messages read, 12 still to read."
            public var summary: String {
                func n(_ x: Int, _ one: String, _ many: String) -> String { x == 1 ? "1 \(one)" : "\(x) \(many)" }
                let f = filed ?? Filed(renewals: 0, pet: 0, events: 0)
                let parts = [
                    f.renewals > 0 ? n(f.renewals, "renewal", "renewals") : nil,
                    f.pet > 0 ? n(f.pet, "pet record", "pet records") : nil,
                    f.events > 0 ? n(f.events, "appointment", "appointments") : nil,
                ].compactMap { $0 }
                let left = (to_read ?? 0) > 0 ? ", \(to_read!) still to read" : ""
                return "\(parts.isEmpty ? "Nothing filed yet" : "Filed " + parts.joined(separator: ", ")) from \(n(read ?? 0, "message", "messages")) read\(left)."
            }
        }
        public var app: Bool
        /// Waiting mail is being read now (after Read now). Nil from older hubs.
        public var reading: Bool?
        /// Local times the waiting mail is read when no game is on the GPU, and why a read is waiting, if it is.
        public var times: [String]?
        public var waiting_for_gpu: String?
        public var accounts: [Account]
        public var waiting: Int { accounts.reduce(0) { $0 + ($1.to_read ?? 0) } }
    }
    public var steam: Steam
    public var letterboxd: Letterboxd
    public var health: Health
    /// Nil from a hub older than the wiki.
    public var atlassian: Atlassian?
    /// Nil from a hub older than the Gmail link.
    public var google: Google?
    /// LastPass or 1Password through its CLI, for secrets in the assistant's commands. Nil on older hubs.
    public var password_manager: PasswordManager?

    public struct PasswordManager: Decodable, Equatable, Sendable {
        public var linked: Bool
        public var provider: String?
        public var host: String?
        public var account: String?
        public var allowed: [String]
        /// "all": every item except `excluded` (names, Folder/Name, or a folder ending in "/"); "chosen": only
        /// `allowed`. Older hubs send neither, which means chosen.
        public var access: String?
        public var excluded: [String]?
        public var everyItem: Bool { (access ?? "chosen") == "all" }
    }
}

/// Whether the password manager's CLI is on the chosen machine and signed in.
public struct PasswordManagerStatus: Decodable, Equatable, Sendable {
    public var host: String
    public var provider: String?
    public var installed: [String: Bool]
    public var signed_in: Bool
    public var account: String?
    public var install_hint: String?
}

/// An item in the built-in KeePass vault.
public struct KeePassEntry: Decodable, Equatable, Sendable, Identifiable {
    public var title: String
    public var username: String
    public var url: String
    public var id: String { title }
}

/// A machine the hub runs commands on.
public struct CommandHost: Decodable, Equatable, Sendable, Identifiable {
    public var name: String
    public var os: String
    public var local: Bool
    public var id: String { name }
}

/// What a library read did: how many it saw, made and changed.
public struct ImportCounts: Decodable, Equatable, Sendable {
    public var games: Int?
    public var entries: Int?
    public var created: Int
    public var updated: Int
}

/// One Apple Health reading for `POST /imports/health`. `key` is Health's sample id, or "steps:2026-10-28" for a day's total.
public struct HealthSample: Encodable, Equatable, Sendable {
    public var key: String
    public var type: LogType
    public var value: JSONValue
    public var unit: String?
    public var at: String
    /// A workout's end: the hub records it as an "end" log, the way the activity timer does.
    public var end: String?

    public init(key: String, type: LogType, value: JSONValue, unit: String?, at: Date) {
        self.key = key
        self.type = type
        self.value = value
        self.unit = unit
        self.at = ISO.string(at)
    }
}

public struct HealthImportResult: Decodable, Equatable, Sendable {
    public var received: Int
    public var created: Int
    public var updated: Int
    public var deleted: Int
    public var rejected: Int
}

private struct Wrapped: Decodable { var sync: ImportCounts }
private struct SteamKeyBody: Encodable { var api_key: String }
private struct SignInBody: Encodable { var hub: String; var client: String }
private struct SignInURL: Decodable { var url: String }
private struct Ignored: Decodable {}
private struct LetterboxdBody: Encodable { var username: String }
private struct HealthBody: Encodable { var samples: [HealthSample]; var removed: [String] }
private struct Empty: Codable {}
private struct GoogleAppBody: Encodable { var client_id: String; var client_secret: String }
private struct MailListed: Decodable { var listed: Int?; var queued: Int?; var error: String? }

extension HubClient {
    public func connections() async throws -> Connections { try await get("connections", as: Connections.self) }

    /// The hub's own Steam Web API key, set once by whoever runs the hub.
    public func setSteamKey(_ key: String) async throws { _ = try await post("connections/steam/key", SteamKeyBody(api_key: key), as: Ignored.self, method: "PUT") }

    /// Steam's sign-in page for this account. Steam sends the browser back to the hub, which answers with
    /// `everythingapp://steam?linked=1&message=…` (or `?error=…`).
    public func steamSignInURL() async throws -> URL {
        guard let base = http?.baseURL else { throw HubError.transport("Steam sign-in needs a direct hub connection") }
        let r = try await post("connections/steam/signin", SignInBody(hub: base.absoluteString, client: "apple"), as: SignInURL.self)
        guard let u = URL(string: r.url) else { throw HubError.decoding("bad sign-in URL") }
        return u
    }
    public func syncSteam() async throws -> ImportCounts { try await post("connections/steam/sync", Empty(), as: ImportCounts.self) }
    public func disconnectSteam() async throws { _ = try await send("DELETE", "connections/steam") }

    public func connectLetterboxd(username: String) async throws -> ImportCounts {
        try await post("connections/letterboxd", LetterboxdBody(username: username), as: Wrapped.self, method: "PUT").sync
    }
    public func syncLetterboxd() async throws -> ImportCounts { try await post("connections/letterboxd/sync", Empty(), as: ImportCounts.self) }
    public func disconnectLetterboxd() async throws { _ = try await send("DELETE", "connections/letterboxd") }

    public func importHealth(samples: [HealthSample], removed: [String]) async throws -> HealthImportResult {
        try await post("imports/health", HealthBody(samples: samples, removed: removed), as: HealthImportResult.self)
    }
}

// MARK: Gmail through Sign in with Google
extension HubClient {
    /// The hub's own Google app (OAuth client for a web application), set once by whoever runs the hub.
    public func setGoogleApp(clientId: String, secret: String) async throws {
        _ = try await post("connections/google/app", GoogleAppBody(client_id: clientId, client_secret: secret), as: Ignored.self, method: "PUT")
    }

    /// Google's account chooser for one more mailbox. Google sends the browser back to the hub, which answers with
    /// `everythingapp://google?linked=1&message=…` (or `?error=…`).
    public func googleSignInURL() async throws -> URL {
        guard let base = http?.baseURL else { throw HubError.transport("Google sign-in needs a direct hub connection") }
        let r = try await post("connections/google/signin", SignInBody(hub: base.absoluteString, client: "apple"), as: SignInURL.self)
        guard let u = URL(string: r.url) else { throw HubError.decoding("bad sign-in URL") }
        return u
    }

    /// List every linked mailbox for new mail now. Returns how many new messages the hub will read.
    public func readMailNow() async throws -> Int {
        try await post("connections/google/sync", Empty(), as: [String: MailListed].self).values.reduce(0) { $0 + ($1.queued ?? 0) }
    }

    /// Unlink one mailbox: Google drops the sign-in; what was filed from its mail stays.
    public func disconnectGoogle(email: String) async throws { _ = try await send("DELETE", "connections/google/\(email)") }

    /// `GET /ai/hosts`: the machines the hub runs commands on.
    public func commandHosts() async throws -> [CommandHost] {
        struct R: Decodable { var hosts: [CommandHost] }
        return try await get("ai/hosts", as: R.self).hosts
    }

    public func passwordManagerStatus(provider: String, host: String) async throws -> PasswordManagerStatus {
        try await get("connections/password-manager/status", query: ["provider": provider, "host": host], as: PasswordManagerStatus.self)
    }

    public func linkPasswordManager(provider: String, host: String) async throws {
        struct B: Encodable { var provider: String; var host: String }
        _ = try await post("connections/password-manager", B(provider: provider, host: host), as: Connections.PasswordManager.self, method: "PUT")
    }

    /// LastPass: email, master password and code go to `lpass login` on the hub's machine and are not kept. 1Password: a service account token.
    /// Bitwarden: email, master password, code and (for Vaultwarden or the EU cloud) the server; only the session key is kept.
    /// The built-in vault: its master password, when the file was not made by the hub.
    public func signInPasswordManager(email: String? = nil, password: String? = nil, code: String? = nil, token: String? = nil, server: String? = nil) async throws {
        struct B: Encodable { var email: String?; var password: String?; var code: String?; var token: String?; var server: String? }
        _ = try await post("connections/password-manager/signin", B(email: email, password: password, code: code, token: token, server: server), as: PasswordManagerStatus.self)
    }

    /// Puts a CLI on the hub's machine where that needs no root (Bitwarden's, from npm).
    public func installPasswordManager(provider: String) async throws {
        struct B: Encodable { var provider: String }
        _ = try await post("connections/password-manager/install", B(provider: provider), as: PasswordManagerStatus.self)
    }

    /// The built-in KeePass vault's items, never with a password.
    public func keepassEntries() async throws -> [KeePassEntry] {
        struct R: Decodable { var entries: [KeePassEntry] }
        return try await get("connections/password-manager/keepass/entries", as: R.self).entries
    }

    /// Add or change an item; an empty password is made up on the hub and never sent back.
    public func putKeepassEntry(title: String, username: String?, password: String?, url: String?) async throws {
        struct B: Encodable { var title: String; var username: String?; var password: String?; var url: String? }
        _ = try await post("connections/password-manager/keepass/entries", B(title: title, username: username, password: password, url: url), as: KeePassEntry.self, method: "PUT")
    }

    public func removeKeepassEntry(title: String) async throws {
        _ = try await send("DELETE", "connections/password-manager/keepass/entries", query: ["title": title])
    }

    public func keepassMaster() async throws -> String {
        struct R: Decodable { var password: String }
        return try await get("connections/password-manager/keepass/master", as: R.self).password
    }

    /// The vault as a .kdbx file, for any KeePass app.
    public func keepassFile() async throws -> Data { try await send("GET", "connections/password-manager/keepass/file") }

    /// Use a KeePass file the owner already has in place of the built-in one. Returns how many items it holds.
    public func importKeepass(_ data: Data, password: String) async throws -> Int {
        struct B: Encodable { var data: String; var password: String }
        struct R: Decodable { var items: Int }
        return try await post("connections/password-manager/keepass/import", B(data: data.base64EncodedString(), password: password), as: R.self).items
    }

    public func unlinkPasswordManager() async throws { _ = try await send("DELETE", "connections/password-manager") }

    public func passwordManagerItems(query: String) async throws -> [String] {
        struct R: Decodable { var items: [String] }
        return try await get("connections/password-manager/items", query: ["q": query], as: R.self).items
    }

    public func allowPasswordManagerItems(_ names: [String]) async throws {
        struct B: Encodable { var names: [String] }
        _ = try await post("connections/password-manager/allowed", B(names: names), as: Connections.PasswordManager.self, method: "PUT")
    }

    /// Every item except the excluded ones ("all"), or only the chosen ones ("chosen"); either part may be left out.
    public func setPasswordManagerAccess(access: String? = nil, excluded: [String]? = nil) async throws {
        struct B: Encodable { var access: String?; var excluded: [String]? }
        _ = try await post("connections/password-manager/access", B(access: access, excluded: excluded), as: Connections.PasswordManager.self, method: "PUT")
    }
}

// MARK: CSV export
extension HubClient {
    /// Every item of one kind as CSV (`GET /export/csv/<kind>`); `filter` narrows by field, e.g. ["type": "weight"].
    public func exportCSV(kind: Kind, filter: [String: String] = [:]) async throws -> Data {
        try await send("GET", "export/csv/\(kind.rawValue)", query: filter.mapValues { Optional($0) })
    }
}

// MARK: Profile

/// Who the hub belongs to and their pet's name (empty: no pet).
public struct HubProfile: Decodable, Equatable, Sendable {
    public var name: String
    public var pet: String
    public var named: Bool?
}

extension HubClient {
    public func profile() async throws -> HubProfile {
        try await get("profile", as: HubProfile.self)
    }
}

// MARK: Bringing data in

/// One import: an upload (a ChatGPT export, a Google Takeout, a notes folder...) or pasted text, and how far it is.
public struct ImportJob: Decodable, Equatable, Sendable, Identifiable {
    public struct Counts: Decodable, Equatable, Sendable { public var notes: Int; public var people: Int; public var tasks: Int; public var facts: Int; public var skipped: Int }
    public struct Learned: Decodable, Equatable, Sendable { public var done: Int; public var total: Int }
    public var id: String
    public var name: String
    public var kinds: [String]
    public var state: String
    public var learn: Bool
    public var finished_at: String?
    public var counts: Counts
    public var learned: Learned
    public var detail: String
    public var error: String?
    public var active: Bool { ["waiting", "reading", "learning"].contains(state) }
}

extension HubClient {
    /// Upload a file straight from disk (an export can be gigabytes), with no time limit.
    public func uploadImport(fileURL: URL, learn: Bool) async throws -> ImportJob {
        guard let http else { throw HubError.transport("Importing needs a direct connection to the hub") }
        var r = http.request(method: "POST", path: "imports/upload", query: ["name": fileURL.lastPathComponent, "learn": learn ? "1" : "0"])
        r.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        r.timeoutInterval = 6 * 3600
        let (data, resp): (Data, URLResponse)
        do { (data, resp) = try await http.session.upload(for: r, fromFile: fileURL) }
        catch { throw HubError.transport(error.localizedDescription) }
        guard let code = (resp as? HTTPURLResponse)?.statusCode else { throw HubError.transport("No HTTP response") }
        guard (200..<300).contains(code) else {
            struct E: Decodable { var error: String? }
            throw HubError.transport((try? JSONDecoder().decode(E.self, from: data).error) ?? "HTTP \(code)")
        }
        return try JSONDecoder().decode(ImportJob.self, from: data)
    }

    public func importText(title: String, text: String, learn: Bool) async throws {
        struct B: Encodable { var title: String; var text: String; var learn: Bool }
        _ = try await post("imports/text", B(title: title, text: text, learn: learn), as: ImportJob.self)
    }

    public func importJobs() async throws -> [ImportJob] {
        struct R: Decodable { var jobs: [ImportJob] }
        return try await get("imports/jobs", as: R.self).jobs
    }

    public func stopImport(id: String) async throws {
        _ = try await post("imports/jobs/\(id)/stop", [String: String](), as: ImportJob.self)
    }
}

/// `GET /connections/guides/:service`: making the person's own key or app (Gmail, Confluence, Steam playtime), step
/// by step, with this hub's own values to copy. The same guide the web app shows.
public struct OwnKeyGuide: Decodable, Equatable, Sendable {
    public struct Copy: Decodable, Equatable, Sendable, Hashable { public var label: String; public var value: String }
    public struct Link: Decodable, Equatable, Sendable { public var label: String; public var url: String }
    public struct Field: Decodable, Equatable, Sendable, Hashable { public var id: String; public var label: String; public var secret: Bool; public var placeholder: String? }
    public struct Route: Decodable, Equatable, Sendable { public var path: String }
    public struct Step: Decodable, Equatable, Sendable {
        public var title: String
        public var text: String
        public var copy: [Copy]?
        public var link: Link?
        public var fields: [Field]?
        public var save: Route?
        public var test: Route?
    }
    public var service: String
    public var title: String
    public var minutes: String
    public var done: Bool
    public var after: String
    public var warning: String?
    public var steps: [Step]
}

public struct OwnKeyCheck: Decodable, Equatable, Sendable { public var ok: Bool; public var message: String }

extension HubClient {
    public func ownKeyGuide(service: String) async throws -> OwnKeyGuide {
        try await get("connections/guides/\(service)", as: OwnKeyGuide.self)
    }

    /// The guide's last step: its fields to the route the hub named, which may only be its own setup routes.
    public func ownKeySave(path: String, values: [String: String]) async throws {
        guard ["/connections/google/app", "/connections/atlassian/app", "/connections/steam/key"].contains(path) else { throw HubError.http(status: 422, message: "not a setup route") }
        _ = try await post(String(path.dropFirst()), values, as: JSONValue.self, method: "PUT")
    }

    public func ownKeyTest(path: String) async throws -> OwnKeyCheck {
        guard path == "/connections/google/app/test" else { throw HubError.http(status: 422, message: "not a check route") }
        struct Empty: Encodable {}
        return try await post(String(path.dropFirst()), Empty(), as: OwnKeyCheck.self)
    }
}

// MARK: Meals tax

/// The state's rate on restaurant meals at a position (`POST /calc/meals-tax`).
public struct MealsTax: Decodable, Equatable, Sendable {
    public var state: String
    public var name: String
    public var pct: Double
    public var note: String
}

extension HubClient {
    /// Sends the position rounded to about a kilometre, to this hub only.
    public func mealsTax(latitude: Double, longitude: Double) async throws -> MealsTax {
        struct Body: Encodable { var lat: Double; var lon: Double }
        let r = { (n: Double) in (n * 100).rounded() / 100 }
        return try await post("calc/meals-tax", Body(lat: r(latitude), lon: r(longitude)), as: MealsTax.self)
    }
}
