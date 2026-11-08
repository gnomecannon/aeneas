import Foundation

// The game design wiki (contract, Game design wiki): a read-only mirror of a project's repo docs and Confluence
// spaces, kept by the hub. Decoding is lossy: a source or page the app does not understand is dropped, never fatal.

/// One place pages come from: a repo's docs (`repo:<project>`) or a Confluence space (`confluence:<key>`).
public struct WikiSource: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var key: String
    /// `repo` or `confluence`.
    public var kind: String
    public var project: String
    public var name: String
    public var url: String?
    public var synced_at: String?
    public var last_error: String?
    public var pages: Int

    public var id: String { key }
    public var isConfluence: Bool { kind == "confluence" }

    public init(key: String, kind: String, project: String, name: String, url: String? = nil, synced_at: String? = nil, last_error: String? = nil, pages: Int = 0) {
        self.key = key; self.kind = kind; self.project = project; self.name = name
        self.url = url; self.synced_at = synced_at; self.last_error = last_error; self.pages = pages
    }

    enum CodingKeys: String, CodingKey { case key, kind, project, name, url, synced_at, last_error, pages }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? (key.hasPrefix("confluence:") ? "confluence" : "repo")
        project = (try? c.decodeIfPresent(String.self, forKey: .project)) ?? ""
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? key
        url = try? c.decodeIfPresent(String.self, forKey: .url)
        synced_at = try? c.decodeIfPresent(String.self, forKey: .synced_at)
        last_error = try? c.decodeIfPresent(String.self, forKey: .last_error)
        pages = (try? c.decodeIfPresent(Int.self, forKey: .pages)) ?? 0
    }
}

/// A page in the index, without its body.
public struct WikiPageSummary: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    public var source: String
    public var source_key: String
    public var project: String
    public var title: String
    /// Ancestor titles (Confluence) or the folders under `Docs/` (repo).
    public var crumbs: [String]
    public var depth: Int
    public var url: String?
    public var updated_at: String?
    public var words: Int

    public init(id: String, source: String, source_key: String, project: String, title: String, crumbs: [String] = [], depth: Int = 0, url: String? = nil, updated_at: String? = nil, words: Int = 0) {
        self.id = id; self.source = source; self.source_key = source_key; self.project = project; self.title = title
        self.crumbs = crumbs; self.depth = depth; self.url = url; self.updated_at = updated_at; self.words = words
    }

    enum CodingKeys: String, CodingKey { case id, source, source_key, project, title, crumbs, depth, url, updated_at, words }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        source_key = try c.decode(String.self, forKey: .source_key)
        source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? (source_key.hasPrefix("confluence:") ? "confluence" : "repo")
        project = (try? c.decodeIfPresent(String.self, forKey: .project)) ?? ""
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? id
        crumbs = (try? c.decodeIfPresent([String].self, forKey: .crumbs)) ?? []
        depth = (try? c.decodeIfPresent(Int.self, forKey: .depth)) ?? crumbs.count
        url = try? c.decodeIfPresent(String.self, forKey: .url)
        updated_at = try? c.decodeIfPresent(String.self, forKey: .updated_at)
        words = (try? c.decodeIfPresent(Int.self, forKey: .words)) ?? 0
    }
}

/// `GET /wiki`: sources by project (Confluence first), pages in reading order.
public struct WikiIndex: Codable, Equatable, Sendable {
    public var sources: [WikiSource]
    public var pages: [WikiPageSummary]

    public init(sources: [WikiSource] = [], pages: [WikiPageSummary] = []) { self.sources = sources; self.pages = pages }

    enum CodingKeys: String, CodingKey { case sources, pages }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sources = (try? c.decodeIfPresent(LossyList<WikiSource>.self, forKey: .sources))?.items ?? []
        pages = (try? c.decodeIfPresent(LossyList<WikiPageSummary>.self, forKey: .pages))?.items ?? []
    }

    /// Projects in the hub's order; inside each, the Confluence handbook first, then repo docs, each with its pages.
    public var projects: [WikiProject] {
        var order: [String] = []
        var byProject: [String: (name: String, sources: [WikiSource])] = [:]
        for s in sources {
            let k = s.project.lowercased()
            if byProject[k] == nil { order.append(k); byProject[k] = (s.project, []) }
            byProject[k]!.sources.append(s)
        }
        var pagesBySource: [String: [WikiPageSummary]] = [:]
        for p in pages { pagesBySource[p.source_key, default: []].append(p) }
        return order.map { k in
            let g = byProject[k]!
            let sorted = g.sources.enumerated().sorted { a, b in
                a.element.isConfluence != b.element.isConfluence ? a.element.isConfluence : a.offset < b.offset
            }.map(\.element)
            return WikiProject(name: g.name.isEmpty ? "Other" : g.name, sources: sorted.map { WikiSourcePages(source: $0, pages: pagesBySource[$0.key] ?? []) })
        }
    }
}

public struct WikiProject: Equatable, Identifiable, Sendable {
    public var name: String
    public var sources: [WikiSourcePages]
    public var id: String { name }
}

public struct WikiSourcePages: Equatable, Identifiable, Sendable {
    public var source: WikiSource
    public var pages: [WikiPageSummary]
    public var id: String { source.key }
}

/// `GET /wiki/page?id=`: one page with its links resolved for reading.
public struct WikiPage: Codable, Equatable, Sendable {
    public var id: String
    public var source: String
    public var source_key: String
    public var source_name: String
    public var project: String
    public var title: String
    public var crumbs: [String]
    public var url: String?
    public var updated_at: String?
    public var rev: String
    public var markdown: String

    public init(id: String, source: String, source_key: String, source_name: String = "", project: String = "", title: String, crumbs: [String] = [], url: String? = nil, updated_at: String? = nil, rev: String = "", markdown: String) {
        self.id = id; self.source = source; self.source_key = source_key; self.source_name = source_name; self.project = project
        self.title = title; self.crumbs = crumbs; self.url = url; self.updated_at = updated_at; self.rev = rev; self.markdown = markdown
    }

    enum CodingKeys: String, CodingKey { case id, source, source_key, source_name, project, title, crumbs, url, updated_at, rev, markdown }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        source_key = (try? c.decodeIfPresent(String.self, forKey: .source_key)) ?? ""
        source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? (source_key.hasPrefix("confluence:") ? "confluence" : "repo")
        source_name = (try? c.decodeIfPresent(String.self, forKey: .source_name)) ?? source_key
        project = (try? c.decodeIfPresent(String.self, forKey: .project)) ?? ""
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? id
        crumbs = (try? c.decodeIfPresent([String].self, forKey: .crumbs)) ?? []
        url = try? c.decodeIfPresent(String.self, forKey: .url)
        updated_at = try? c.decodeIfPresent(String.self, forKey: .updated_at)
        rev = (try? c.decodeIfPresent(String.self, forKey: .rev)) ?? ""
        markdown = (try? c.decodeIfPresent(String.self, forKey: .markdown)) ?? ""
    }
}

/// One `GET /wiki/search` hit.
public struct WikiSearchHit: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var source: String
    public var project: String
    public var snippet: String

    public init(id: String, title: String, source: String = "repo", project: String = "", snippet: String = "") {
        self.id = id; self.title = title; self.source = source; self.project = project; self.snippet = snippet
    }

    enum CodingKeys: String, CodingKey { case id, title, source, project, snippet }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? id
        source = (try? c.decodeIfPresent(String.self, forKey: .source)) ?? "repo"
        project = (try? c.decodeIfPresent(String.self, forKey: .project)) ?? ""
        snippet = (try? c.decodeIfPresent(String.self, forKey: .snippet)) ?? ""
    }
}

struct WikiSearchResponse: Decodable {
    var results: [WikiSearchHit]
    enum CodingKeys: String, CodingKey { case results }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        results = (try? c.decodeIfPresent(LossyList<WikiSearchHit>.self, forKey: .results))?.items ?? []
    }
}

/// Links between wiki pages and to the images the hub keeps.
public enum WikiLink {
    /// The page id in `everythingapp://wiki?id=<id>`, or nil for any other link.
    public static func pageId(_ url: URL) -> String? {
        guard url.scheme?.lowercased() == "everythingapp", url.host?.lowercased() == "wiki",
              let id = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "id" })?.value,
              !id.isEmpty else { return nil }
        return id
    }

    public static func url(forPage id: String) -> URL? {
        var c = URLComponents()
        c.scheme = "everythingapp"
        c.host = "wiki"
        c.queryItems = [URLQueryItem(name: "id", value: id)]
        return c.url
    }

    /// An image or file the hub saved from a Confluence page; read it with the token, not as a bare URL.
    public static func isMedia(_ src: String) -> Bool { src.hasPrefix("/wiki/media/") }

    /// The hub path for a media link, decoded once so the transport encodes it exactly once.
    public static func mediaPath(_ src: String) -> String? {
        guard isMedia(src) else { return nil }
        let bare = src.split(separator: "?", maxSplits: 1).first.map(String.init) ?? src
        let parts = bare.split(separator: "/").map { String($0).removingPercentEncoding ?? String($0) }
        guard parts.count >= 4, !parts.contains(".."), !parts.contains(".") else { return nil }
        return parts.joined(separator: "/")
    }

    /// A picture in a repo doc points at the GitHub page for the file; the raw file is what an image view can show.
    public static func imageURL(_ src: String) -> URL? {
        guard let u = URL(string: src), let scheme = u.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return nil }
        if u.host?.lowercased() == "github.com", src.contains("/blob/") {
            return URL(string: src.replacingOccurrences(of: "/blob/", with: "/raw/"))
        }
        return u
    }
}

/// What `POST /connections/atlassian/sync` (and a space change) did.
public struct ConfluenceSyncCounts: Decodable, Equatable, Sendable {
    public var spaces: Int
    public var pages: Int
    public var updated: Int
    public var removed: Int
    public var images: Int
}

/// A Confluence space the signed-in account can read.
public struct AtlassianSpace: Decodable, Equatable, Hashable, Identifiable, Sendable {
    public var key: String
    public var name: String
    public var type: String
    public var mirrored: Bool
    public var id: String { key }

    enum CodingKeys: String, CodingKey { case key, name, type, mirrored }

    public init(key: String, name: String, type: String = "", mirrored: Bool = false) {
        self.key = key; self.name = name; self.type = type; self.mirrored = mirrored
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        key = try c.decode(String.self, forKey: .key)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? key
        type = (try? c.decodeIfPresent(String.self, forKey: .type)) ?? ""
        mirrored = (try? c.decodeIfPresent(Bool.self, forKey: .mirrored)) ?? false
    }
}

struct AtlassianSpacesResponse: Decodable {
    var spaces: [AtlassianSpace]
    enum CodingKeys: String, CodingKey { case spaces }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        spaces = (try? c.decodeIfPresent(LossyList<AtlassianSpace>.self, forKey: .spaces))?.items ?? []
    }
}
