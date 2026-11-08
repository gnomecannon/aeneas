import XCTest
@testable import EACore

final class WikiTests: XCTestCase {
    // MARK: decoding

    func testDecodesTheIndexLossilyAndGroupsByProject() throws {
        let json = """
        {"sources": [
          {"key": "repo:Starfall", "kind": "repo", "project": "Starfall", "name": "Starfall repo docs", "url": null, "synced_at": "2026-10-29T12:00:00.000Z", "last_error": null, "pages": 2},
          {"key": "confluence:DUSK", "kind": "confluence", "project": "starfall", "name": "Starfall handbook", "url": "https://x.atlassian.net/wiki/spaces/DUSK", "synced_at": null, "last_error": "token expired", "pages": 1},
          {"key": "repo:Other", "kind": "repo", "project": "Other", "name": "Other repo docs", "pages": 0},
          {"kind": "repo"}
        ], "pages": [
          {"id": "repo:Starfall:README.md", "source": "repo", "source_key": "repo:Starfall", "project": "Starfall", "title": "Starfall", "crumbs": [], "depth": 0, "url": null, "updated_at": "2026-10-29T12:00:00.000Z", "words": 120},
          {"id": "repo:Starfall:Docs/combat/Combat.md", "source": "repo", "source_key": "repo:Starfall", "project": "Starfall", "title": "Combat", "crumbs": ["combat"], "depth": 1, "url": null, "updated_at": "2026-10-29T12:00:00.000Z", "words": 300, "future": true},
          {"id": "confluence:42", "source": "confluence", "source_key": "confluence:DUSK", "project": "starfall", "title": "Handbook home", "crumbs": [], "depth": 0, "url": "https://x.atlassian.net/wiki/spaces/DUSK/pages/42", "updated_at": "2026-10-28T09:00:00.000Z", "words": 50},
          {"title": "no id"}
        ]}
        """
        let index = try JSONCoding.decode(WikiIndex.self, from: json)
        XCTAssertEqual(index.sources.count, 3, "a source without a key is dropped")
        XCTAssertEqual(index.pages.count, 3, "a page without an id is dropped")
        XCTAssertEqual(index.sources[1].last_error, "token expired")
        XCTAssertNil(index.sources[1].synced_at)

        let projects = index.projects
        XCTAssertEqual(projects.map(\.name), ["Starfall", "Other"], "projects merge without regard to case, in the hub's order")
        XCTAssertEqual(projects[0].sources.map(\.source.key), ["confluence:DUSK", "repo:Starfall"], "the Confluence handbook comes first")
        XCTAssertEqual(projects[0].sources[1].pages.map(\.title), ["Starfall", "Combat"])
        XCTAssertEqual(projects[0].sources[1].pages[1].depth, 1)
        XCTAssertEqual(projects[1].sources[0].pages, [])
    }

    func testDecodesAPageAndSearchHits() throws {
        let page = try JSONCoding.decode(WikiPage.self, from: """
        {"id": "repo:Starfall:Docs/Combat.md", "source": "repo", "source_key": "repo:Starfall", "source_name": "Starfall repo docs", "project": "Starfall",
         "title": "Combat", "crumbs": ["Docs"], "url": null, "updated_at": "2026-10-29T12:00:00.000Z", "rev": "abc", "markdown": "# Combat\\n\\nHit things."}
        """)
        XCTAssertEqual(page.title, "Combat")
        XCTAssertNil(page.url)
        XCTAssertEqual(page.crumbs, ["Docs"])
        XCTAssertTrue(page.markdown.hasPrefix("# Combat"))

        let hits = try JSONCoding.decode(WikiSearchResponse.self, from: """
        {"results": [{"id": "a", "title": "Combat", "source": "repo", "project": "Starfall", "snippet": "parry window"}, {"snippet": "no id"}]}
        """).results
        XCTAssertEqual(hits, [WikiSearchHit(id: "a", title: "Combat", source: "repo", project: "Starfall", snippet: "parry window")])
    }

    func testDecodesTheAtlassianConnection() throws {
        let base = #""steam": {"connected": false, "hub_key": false}, "letterboxd": {"connected": false}, "health": {"last_import": null, "samples": 0, "total": 0}"#
        let older = try JSONCoding.decode(Connections.self, from: "{\(base)}")
        XCTAssertNil(older.atlassian, "a hub older than the wiki has no atlassian part")

        let off = try JSONCoding.decode(Connections.self, from: #"{\#(base), "atlassian": {"connected": false, "app": true}}"#)
        XCTAssertEqual(off.atlassian?.connected, false)
        XCTAssertEqual(off.atlassian?.app, true)

        let on = try JSONCoding.decode(Connections.self, from: #"{\#(base), "atlassian": {"connected": true, "app": true, "site_name": "dusk", "site_url": "https://dusk.atlassian.net", "spaces": ["DUSK"], "last_sync": "2026-10-29T12:00:00.000Z", "last_error": null, "pages": 14}}"#)
        XCTAssertEqual(on.atlassian?.spaces, ["DUSK"])
        XCTAssertEqual(on.atlassian?.pages, 14)

        let spaces = try JSONCoding.decode(AtlassianSpacesResponse.self, from: #"{"spaces": [{"key": "DUSK", "name": "Starfall", "type": "global", "mirrored": true}, {"name": "no key"}]}"#).spaces
        XCTAssertEqual(spaces, [AtlassianSpace(key: "DUSK", name: "Starfall", type: "global", mirrored: true)])
        let counts = try JSONCoding.decode(ConfluenceSyncCounts.self, from: #"{"spaces": 1, "pages": 14, "updated": 2, "removed": 0, "images": 3}"#)
        XCTAssertEqual(counts.images, 3)
    }

    // MARK: links

    func testWikiLinks() throws {
        XCTAssertEqual(WikiLink.pageId(URL(string: "everythingapp://wiki?id=repo%3AStarfall%3ADocs%2FCombat.md")!), "repo:Starfall:Docs/Combat.md")
        XCTAssertEqual(WikiLink.pageId(URL(string: "EverythingApp://WIKI?id=confluence:42")!), "confluence:42")
        XCTAssertNil(WikiLink.pageId(URL(string: "everythingapp://wiki")!))
        XCTAssertNil(WikiLink.pageId(URL(string: "everythingapp://wiki?id=")!))
        XCTAssertNil(WikiLink.pageId(URL(string: "everythingapp://steam?id=1")!))
        XCTAssertNil(WikiLink.pageId(URL(string: "https://example.com/wiki?id=1")!))
        let round = try XCTUnwrap(WikiLink.url(forPage: "repo:Starfall:Docs/a b.md"))
        XCTAssertEqual(WikiLink.pageId(round), "repo:Starfall:Docs/a b.md")

        XCTAssertEqual(WikiLink.mediaPath("/wiki/media/819201/helmet%20preview.png"), "wiki/media/819201/helmet preview.png")
        XCTAssertNil(WikiLink.mediaPath("/wiki/media/../../etc/passwd"))
        XCTAssertNil(WikiLink.mediaPath("https://example.com/a.png"))
        XCTAssertEqual(WikiLink.imageURL("https://github.com/o/r/blob/HEAD/Docs/art/map.png")?.absoluteString, "https://github.com/o/r/raw/HEAD/Docs/art/map.png")
        XCTAssertEqual(WikiLink.imageURL("https://example.com/a.png")?.absoluteString, "https://example.com/a.png")
        XCTAssertNil(WikiLink.imageURL("art/map.png"))
    }

    // MARK: markdown

    func testHeadingsParagraphsAndBreaks() {
        let blocks = WikiMarkdown.parse("""
        # Combat #

        A wrapped
        line and a hard\\
        break with **bold**.

        Setext
        ------
        ### Third
        #hashtag stays text
        """)
        XCTAssertEqual(blocks, [
            .heading(level: 1, text: "Combat"),
            .paragraph("A wrapped line and a hard\nbreak with **bold**."),
            .heading(level: 2, text: "Setext"),
            .heading(level: 3, text: "Third"),
            .paragraph("#hashtag stays text"),
        ])
        XCTAssertEqual(WikiMarkdown.parse("two trailing spaces  \nbreak too"), [.paragraph("two trailing spaces\nbreak too")])
    }

    func testNestedListsAndTasks() {
        let blocks = WikiMarkdown.parse("""
        - one
          - one a
            - one a i
        - two
        wrapped

        3. third
        4. fourth
          - nested under a number

        - [ ] open
        - [x] done
        """)
        guard blocks.count == 3, case .list(let bullets) = blocks[0], case .list(let numbers) = blocks[1], case .list(let tasks) = blocks[2] else {
            return XCTFail("expected three lists, got \(blocks)")
        }
        XCTAssertFalse(bullets.ordered)
        XCTAssertEqual(bullets.items.count, 2)
        XCTAssertEqual(bullets.items[0].blocks.first, .paragraph("one"))
        guard case .list(let inner) = bullets.items[0].blocks.last, case .list(let innermost) = inner.items[0].blocks.last else {
            return XCTFail("expected nesting, got \(bullets.items[0].blocks)")
        }
        XCTAssertEqual(inner.items[0].blocks.first, .paragraph("one a"))
        XCTAssertEqual(innermost.items, [WikiListItem(blocks: [.paragraph("one a i")])])
        XCTAssertEqual(bullets.items[1].blocks, [.paragraph("two wrapped")], "a line that lost its indent continues the item")

        XCTAssertTrue(numbers.ordered)
        XCTAssertEqual(numbers.start, 3)
        XCTAssertEqual(numbers.items.count, 2)
        guard case .list(let under) = numbers.items[1].blocks.last else { return XCTFail("a bullet under a number nests") }
        XCTAssertEqual(under.items.first?.blocks, [.paragraph("nested under a number")])

        XCTAssertEqual(tasks.items.map(\.checked), [false, true])
        XCTAssertEqual(tasks.items[1].blocks, [.paragraph("done")])
    }

    func testCodeQuotesRulesAndTables() {
        let blocks = WikiMarkdown.parse("""
        ```swift
        let x = 1

            indented inside
        ```

        > **Note**
        > Callout text
        >
        > - a list in a quote

        ***

        | Weapon | Damage | Notes |
        |:-------|-------:|:-----:|
        | Sword  | 12 | `a|b` and \\| pipe |
        | Bow | 8
        after the table
        """)
        XCTAssertEqual(blocks.first, .code(language: "swift", text: "let x = 1\n\n    indented inside"))
        guard case .quote(let q) = blocks[1] else { return XCTFail("expected a quote, got \(blocks[1])") }
        XCTAssertEqual(q.first, .paragraph("**Note**\nCallout text".replacingOccurrences(of: "\n", with: " ")))
        if case .list = q.last {} else { XCTFail("a list inside the quote") }
        XCTAssertEqual(blocks[2], .rule)
        XCTAssertEqual(blocks[3], .table(WikiTable(
            header: ["Weapon", "Damage", "Notes"],
            rows: [["Sword", "12", "`a|b` and | pipe"], ["Bow", "8", ""], ["after the table", "", ""]],
            alignments: [.leading, .trailing, .center])))
    }

    func testImagesBecomeTheirOwnBlocks() {
        let blocks = WikiMarkdown.parse("""
        Before ![Helmet](/wiki/media/42/helmet%20preview.png "title") after.

        [![Map](https://example.com/map.png)](https://example.com/big.png)
        """)
        XCTAssertEqual(blocks, [
            .paragraph("Before"),
            .image(alt: "Helmet", src: "/wiki/media/42/helmet%20preview.png"),
            .paragraph("after."),
            .image(alt: "Map", src: "https://example.com/map.png"),
        ])
    }

    func testFrontMatterTabsAndTildeFences() {
        let blocks = WikiMarkdown.parse("---\ntitle: Combat\ntags: [design]\n---\n# Combat\n~~~\n```not a fence end\n~~~\n-\tTabbed item")
        XCTAssertEqual(blocks.first, .heading(level: 1, text: "Combat"))
        XCTAssertEqual(blocks[1], .code(language: "", text: "```not a fence end"))
        guard case .list(let l) = blocks[2] else { return XCTFail("expected a list") }
        XCTAssertEqual(l.items.first?.blocks, [.paragraph("Tabbed item")])
        // A rule at the very top that is not front matter stays a rule.
        XCTAssertEqual(WikiMarkdown.parse("---\n\nText").first, .rule)
    }

    func testALargePageParsesQuickly() {
        let section = "## Part\n\nSome **text** with a [link](everythingapp://wiki?id=x).\n\n- a\n- b\n  - c\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode\n```\n\n"
        let big = String(repeating: section, count: 2500)
        XCTAssertGreaterThan(big.utf8.count, 300_000)
        let start = Date()
        let blocks = WikiMarkdown.parse(big)
        XCTAssertEqual(blocks.count, 2500 * 5)
        XCTAssertLessThan(Date().timeIntervalSince(start), 5)
    }
}
