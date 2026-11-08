import Foundation

private struct SignInBody: Encodable { var hub: String; var client: String }
private struct SignInURL: Decodable { var url: String }
private struct AppBody: Encodable { var client_id: String; var client_secret: String }
private struct KeysBody: Encodable { var keys: [String] }
private struct SpacesSaved: Decodable { var sync: ConfluenceSyncCounts }
private struct Ignored: Decodable {}
private struct Empty: Codable {}

// MARK: Game design wiki
extension HubClient {
    public func wikiIndex() async throws -> WikiIndex { try await get("wiki", as: WikiIndex.self) }

    public func wikiPage(id: String) async throws -> WikiPage { try await get("wiki/page", query: ["id": id], as: WikiPage.self) }

    /// Every word must appear; title hits come first.
    public func wikiSearch(_ q: String, limit: Int = 30) async throws -> [WikiSearchHit] {
        try await get("wiki/search", query: ["q": q, "limit": String(limit)], as: WikiSearchResponse.self).results
    }

    /// An image the hub saved from a Confluence page (`/wiki/media/<page>/<file>`), read with the token.
    public func wikiMedia(_ src: String) async throws -> Data {
        guard let path = WikiLink.mediaPath(src) else { throw HubError.transport("not a wiki image") }
        return try await send("GET", path)
    }
}

// MARK: Confluence through Sign in with Atlassian
extension HubClient {
    /// The hub's own Atlassian app (OAuth 2.0 integration), set once by whoever runs the hub.
    public func setAtlassianApp(clientId: String, secret: String) async throws {
        _ = try await post("connections/atlassian/app", AppBody(client_id: clientId, client_secret: secret), as: Ignored.self, method: "PUT")
    }

    /// Atlassian's consent page for this account. Atlassian sends the browser back to the hub, which answers with
    /// `everythingapp://atlassian?linked=1&message=…` (or `?error=…`).
    public func atlassianSignInURL() async throws -> URL {
        guard let base = http?.baseURL else { throw HubError.transport("Atlassian sign-in needs a direct hub connection") }
        let r = try await post("connections/atlassian/signin", SignInBody(hub: base.absoluteString, client: "apple"), as: SignInURL.self)
        guard let u = URL(string: r.url) else { throw HubError.decoding("bad sign-in URL") }
        return u
    }

    public func atlassianSpaces() async throws -> [AtlassianSpace] { try await get("connections/atlassian/spaces", as: AtlassianSpacesResponse.self).spaces }

    /// The spaces to mirror; the hub reads them straight away, and spaces left out leave the wiki.
    public func setAtlassianSpaces(_ keys: [String]) async throws -> ConfluenceSyncCounts {
        try await post("connections/atlassian/spaces", KeysBody(keys: keys), as: SpacesSaved.self, method: "PUT").sync
    }

    public func syncConfluence() async throws -> ConfluenceSyncCounts { try await post("connections/atlassian/sync", Empty(), as: ConfluenceSyncCounts.self) }

    /// Unlink: the tokens go, and so do the mirrored Confluence pages.
    public func disconnectAtlassian() async throws { _ = try await send("DELETE", "connections/atlassian") }
}
