import Foundation

/// An app key: the hub's own registration with a service that lets a program in only once it is registered there,
/// made once by the owner on that service's site with the hub's guide (`service`, `GET /connections/guides/<service>`).
/// Settings, Connections lists them under App keys, each with what it is, why the service asks for it, what in Aeneas
/// uses it and what works without it. The texts are the web's APP_KEYS (web/src/views/settings/Connections.tsx), kept
/// the same.
public struct AppKey: Equatable, Sendable, Identifiable {
    /// The guide that makes it: `google`, `atlassian` or `steam`.
    public var service: String
    public var name: String
    /// The service it is registered with.
    public var by: String
    /// The module that uses it: the key shows only while that module is on.
    public var module: AppModule
    /// One line on what it is for, beside its name.
    public var purpose: String
    public var what: String
    public var why: String
    public var uses: String
    public var without: String
    /// What Replace does, for a key the hub has.
    public var replacing: String
    public var id: String { service }

    /// A key to show, with whether the hub has it.
    public struct Shown: Equatable, Sendable, Identifiable {
        public var key: AppKey
        public var added: Bool
        public var id: String { key.service }
    }

    /// Whether this hub has it; nil while it is not shown (its module off, or a hub too old to say).
    public func added(in c: Connections, isOn: (AppModule) -> Bool) -> Bool? {
        guard isOn(module) else { return nil }
        switch service {
        case "google": return c.google.map(\.app)
        case "atlassian": return c.atlassian.map { $0.app == true || $0.connected }
        default: return c.steam.hub_key == true
        }
    }

    /// The keys to show, in order, each with whether the hub has it.
    public static func shown(in c: Connections, isOn: (AppModule) -> Bool) -> [Shown] {
        all.compactMap { k in k.added(in: c, isOn: isOn).map { Shown(key: k, added: $0) } }
    }

    /// What App keys says above its rows.
    public static let intro = "These are optional. A few services let a program in only once it is registered with them. Aeneas has no server of its own, so your hub holds its own registration, made once by you on that service's site. Each one is used only for the feature it names, and nothing else needs one."

    public static let google = AppKey(
        service: "google", name: "Google app", by: "Google", module: .mail,
        purpose: "For Sign in with Google, which reads Gmail for Receipts and renewals.",
        what: "An OAuth client you make in your own Google Cloud project. It tells Google which program is asking, and that it may only read Gmail (the gmail.readonly permission).",
        why: "Google lets a program use Sign in with Google only once it is registered. Aeneas has no registration with Google, so your hub uses yours, with you as its only user.",
        uses: "Sign in with Google, offered when you add a Google account under Internet Accounts. It reads Gmail read-only, for Receipts and renewals, and never sends, changes or deletes mail.",
        without: "Gmail accounts added with an app password do not need it: they work for Mail and for Receipts and renewals.",
        replacing: "The guide ends by saving the new one in place of the old. Mailboxes signed in through the old one then need Sign in with Google again."
    )

    public static let atlassian = AppKey(
        service: "atlassian", name: "Atlassian app", by: "Atlassian", module: .wiki,
        purpose: "For Confluence pages in the Wiki.",
        what: "An OAuth 2.0 app you make in Atlassian's developer console, allowed only to read Confluence.",
        why: "Atlassian lets a program sign in to Confluence only once it is registered there. Aeneas has no registration with Atlassian, so your hub uses yours.",
        uses: "Sign in with Atlassian, under Confluence in Settings, Connections, so the spaces you pick show in the Wiki, where the assistant can search them.",
        without: "The Wiki still shows a repository's docs, and nothing else uses it.",
        replacing: "The guide ends by saving the new one in place of the old. Confluence then needs Reconnect, to sign in through the new one."
    )

    public static let steam = AppKey(
        service: "steam", name: "Steam key", by: "Steam", module: .games,
        purpose: "For Steam playtime in Games.",
        what: "A Steam Web API key, which you register at steamcommunity.com/dev/apikey.",
        why: "Steam gives a program your games and playtime only when it asks with a key. Aeneas has no key of its own, so your hub uses yours.",
        uses: "Reading your Steam games and playtime for Games, once you sign in with Steam under Steam in Settings, Connections.",
        without: "Games still keeps the games you add by hand. A key stops working when your Steam password changes: then replace it with a new one.",
        replacing: "The guide ends by saving the new key in place of the old, once Steam accepts it."
    )

    /// Every app key, in the order they show.
    public static let all = [google, atlassian, steam]
}
