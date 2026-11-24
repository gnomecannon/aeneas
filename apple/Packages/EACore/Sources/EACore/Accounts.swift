import Foundation

/// Settings, Accounts (since 2026-11-24): every mail and calendar account once, one sheet to add one, and what comes
/// in from this device's own Apple accounts. A switch turns its module on itself, so adding a mailbox no longer takes
/// a trip to Settings, Modules first. The texts are the web's (web/src/views/settings/Accounts.tsx), kept the same.
public enum AccountTexts {
    /// Under the list of accounts.
    public static let accountsFooter = "Each address once. Your hub keeps these in step, with every device off."
    /// Under Add account's switches.
    public static let addFooter = "A switch here turns its module on for you. No trip to Modules first, and no key to make."
    /// What each switch of an account does, said under it.
    public static let inboxNote = "Its mail shows on the Mail screen"
    public static let receiptsNote = "Receipts, renewal notices and vet mail are filed for you"
    public static let calendarsNote = "Its calendars and Aeneas stay in step, both ways"
    public static let readOnlyNote = "On: Aeneas reads this mailbox and changes nothing in it"
    /// Add account, Google: beside the link to Google's page.
    public static let googleHowTo = "Google makes one in about 2 minutes."
    /// Add account, iCloud: beside the link to account.apple.com.
    public static let icloudHowTo = "At account.apple.com, open Sign-In and Security, then App-Specific Passwords, and make one named Aeneas. It needs two-factor authentication on your Apple Account."

    /// Under "From this iPhone" (iPad, Mac): what its switches are.
    public static func devicesFooter(_ device: String) -> String {
        "What this \(device)'s own accounts hold (iCloud, Google, Exchange). One switch each, and it asks for the permission."
    }

    /// The Reminders row: how many of the lists every device knows come in.
    public static func listsSummary(on: Int, total: Int) -> String {
        total == 0 ? "No lists yet" : "\(on) of \(total) list\(total == 1 ? "" : "s")"
    }

    /// The Calendars row: where events made in Aeneas go, and how many calendars are work.
    public static func calendarsSummary(personal: String, work: Int) -> String {
        work == 0 ? "\(personal), no work calendars" : "\(personal), and \(work) work calendar\(work == 1 ? "" : "s")"
    }

    /// The Contacts row: which device mirrors them (`here`: "this iPhone").
    public static func contactsSummary(device: String?, mine: Bool, here: String) -> String {
        if mine { return "Mirrored by \(here)" }
        guard let device else { return "No device mirrors them" }
        return "Mirrored by \(device.isEmpty ? "another device" : device)"
    }

    /// Asked before this device takes Contacts over from another.
    public static func takeOverContacts(from device: String, here: String) -> String {
        "\(device.isEmpty ? "Another device" : device) mirrors Contacts now. One device does it at a time, so \(here) takes over and that one stops."
    }
}

/// What an account's switch brings in, and the module it needs: switching one on here turns that module on too.
public enum AccountFeature: String, CaseIterable, Sendable {
    case inbox, receipts, calendars

    public var module: AppModule {
        switch self {
        case .inbox: return .mailInbox
        case .receipts: return .mail
        case .calendars: return .calendars
        }
    }

    /// The modules a set of switches needs that are off now.
    public static func modulesToSwitchOn(_ want: Set<AccountFeature>, isOn: (AppModule) -> Bool) -> [String: Bool] {
        var out: [String: Bool] = [:]
        for f in AccountFeature.allCases where want.contains(f) && !isOn(f.module) { out[f.module.rawValue] = true }
        return out
    }
}

/// Add account, filled in: which account, its sign-in, and what it brings in.
public struct NewAccount: Sendable, Equatable {
    public enum Kind: String, CaseIterable, Sendable { case icloud, google, other }
    public var kind: Kind
    public var email: String
    public var password: String
    public var host: String = ""
    public var port: Int = 993
    public var user: String = ""
    /// What it brings in; Calendars counts for iCloud only.
    public var want: Set<AccountFeature> = [.inbox, .receipts]

    public init(kind: Kind, email: String, password: String, host: String = "", port: Int = 993, user: String = "", want: Set<AccountFeature> = [.inbox, .receipts]) {
        self.kind = kind; self.email = email; self.password = password; self.host = host; self.port = port; self.user = user; self.want = want
    }

    /// The switches that apply to this kind of account.
    public var wanted: Set<AccountFeature> { kind == .icloud ? want : want.subtracting([.calendars]) }
    /// Everything Add account needs: an address, a password, a server for another provider, and one switch on.
    public var ready: Bool {
        !email.trimmingCharacters(in: .whitespaces).isEmpty && !password.trimmingCharacters(in: .whitespaces).isEmpty
            && (kind != .other || !host.trimmingCharacters(in: .whitespaces).isEmpty) && !wanted.isEmpty
    }
}

extension HubClient {
    /// Add an account as Add account's three steps say, in this order: the modules its switches need are switched on
    /// (`switchOn`), the hub checks the sign-in and keeps it, then the switches are set (a new account brings in Mail
    /// and Receipts and renewals; one left off is switched off, after Calendars so it is never the last use). Returns
    /// the account's key (web addAccount, kept the same).
    public func addAccount(_ a: NewAccount, isOn: (AppModule) -> Bool, switchOn: ([String: Bool]) async throws -> Void) async throws -> String {
        let want = a.wanted
        let need = AccountFeature.modulesToSwitchOn(want, isOn: isOn)
        if !need.isEmpty { try await switchOn(need) }
        let email = a.email.trimmingCharacters(in: .whitespaces).lowercased()
        let password = a.password.trimmingCharacters(in: .whitespaces)
        let inbox: Bool? = want.contains(.inbox) ? nil : false
        let receipts: Bool? = want.contains(.receipts) ? nil : false
        switch a.kind {
        case .icloud:
            let key = "icloud:\(email)"
            guard want.contains(.inbox) || want.contains(.receipts) else {
                _ = try await linkICloudCalendars(email: email, password: password)
                return key
            }
            try await linkICloudMail(email: email, password: password)
            if want.contains(.calendars) { _ = try await linkICloudCalendars(email: email, password: nil) }
            if inbox != nil || receipts != nil { _ = try await setAccountFeatures(key: key, inbox: inbox, receipts: receipts) }
            return key
        case .google, .other:
            let user = a.user.trimmingCharacters(in: .whitespaces)
            try await linkImap(email: email, password: password, gmail: a.kind == .google, host: a.host.trimmingCharacters(in: .whitespaces), port: a.port, user: user.isEmpty ? nil : user)
            let key = "imap:\(email)"
            if inbox != nil || receipts != nil { _ = try await setAccountFeatures(key: key, inbox: inbox, receipts: receipts) }
            return key
        }
    }

    /// A new password for an account (its page, Sign-in, Replace): the hub checks it and keeps the account's switches.
    /// An iCloud account kept for its calendars alone takes it through calendar sync, which would not link its mail
    /// (web replacePassword, kept the same).
    public func replacePassword(_ a: InternetAccount, password: String) async throws {
        let p = password.trimmingCharacters(in: .whitespaces)
        switch a.kind {
        case "icloud":
            if a.features.inbox == true || a.features.receipts == true { try await linkICloudMail(email: a.email, password: p) }
            else { _ = try await linkICloudCalendars(email: a.email, password: p) }
        case "gmail": try await linkImap(email: a.email, password: p, gmail: true)
        default: try await linkImap(email: a.email, password: p, gmail: false, host: a.host, port: a.port, user: a.user)
        }
    }
}

extension InternetAccount {
    /// Its kind in a word or two, on the right of its row (web KIND_SHORT, kept the same).
    public var kindShort: String {
        switch kind {
        case "icloud": return "iCloud"
        case "google": return "Google, older sign-in"
        case "gmail": return "Google"
        default: return "Other mail"
        }
    }

    /// The first letter of its address, for its badge.
    public var badgeLetter: String { email.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?" }

    /// Whether a switch shows on: the account does it and its module is on, as its page shows it.
    public func shows(_ f: AccountFeature, isOn: (AppModule) -> Bool) -> Bool {
        guard isOn(f.module) else { return false }
        switch f {
        case .inbox: return features.inbox == true
        case .receipts: return features.receipts == true
        case .calendars: return features.calendars == true
        }
    }

    /// What it brings in, for its row: "Mail, Receipts and renewals", with ", read only" while that is on. A switch
    /// counts only while its module is on (web broughtIn, kept the same).
    public func broughtIn(isOn: (AppModule) -> Bool) -> String {
        let parts = [
            shows(.inbox, isOn: isOn) ? "Mail" : nil,
            shows(.receipts, isOn: isOn) ? "Receipts and renewals" : nil,
            shows(.calendars, isOn: isOn) ? "Calendars" : nil,
        ].compactMap { $0 }
        let what = parts.isEmpty ? "Nothing switched on" : parts.joined(separator: ", ")
        return read_only == true ? "\(what), read only" : what
    }
}
