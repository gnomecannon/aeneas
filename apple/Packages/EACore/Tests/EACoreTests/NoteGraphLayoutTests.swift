import XCTest
@testable import EACore

final class NoteGraphLayoutTests: XCTestCase {

    private func node(_ id: String, _ title: String, _ path: String) -> NoteGraph.Node {
        NoteGraph.Node(id: id, title: title, path: path, tags: [], folder: NoteGraphLayout.folder(ofPath: path))
    }

    /// Two linked clusters (a triangle in Homelab, a pair in Music) and one loose note.
    private var sample: NoteGraph {
        NoteGraph(nodes: [
            node("a", "Pve1", "Homelab/Pve1.md"), node("b", "Storage", "Homelab/Storage.md"), node("c", "Backups", "Homelab/Backups.md"),
            node("d", "Riffs", "Music/Riffs.md"), node("e", "Cubase", "Music/Cubase.md"), node("f", "Inbox", "Inbox.md"),
        ], edges: [
            .init(from: "a", to: "b"), .init(from: "b", to: "c"), .init(from: "c", to: "a"), .init(from: "b", to: "a"),
            .init(from: "d", to: "e"), .init(from: "a", to: "missing"), .init(from: "f", to: "f"),
        ])
    }

    private func dist(_ r: NoteGraphLayout.Result, _ a: String, _ b: String) -> Double {
        let p = r.nodes.first { $0.id == a }!, q = r.nodes.first { $0.id == b }!
        return ((p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y)).squareRoot()
    }

    func testFolderOfPath() {
        XCTAssertEqual(NoteGraphLayout.folder(ofPath: "Programming/App Ideas/Weather Bot.md"), "Programming/App Ideas")
        XCTAssertEqual(NoteGraphLayout.folder(ofPath: "Inbox.md"), "")
    }

    func testDeterministicWhateverTheInputOrder() {
        let g = sample
        let r1 = NoteGraphLayout.layout(g)
        let r2 = NoteGraphLayout.layout(NoteGraph(nodes: g.nodes.reversed(), edges: g.edges.reversed()))
        XCTAssertEqual(r1.nodes.map(\.id), r2.nodes.map(\.id))
        for (p, q) in zip(r1.nodes, r2.nodes) {
            XCTAssertEqual(p.x, q.x, accuracy: 1e-9)
            XCTAssertEqual(p.y, q.y, accuracy: 1e-9)
        }
        XCTAssertEqual(r1, NoteGraphLayout.layout(g))
    }

    func testEdgesAreDedupedAndDanglingOnesDropped() {
        let r = NoteGraphLayout.layout(sample)
        XCTAssertEqual(r.edges.count, 4)   // a-b once, b-c, c-a, d-e; no self link, no missing target
        XCTAssertEqual(r.nodes.first { $0.id == "b" }?.degree, 2)
        XCTAssertEqual(r.nodes.first { $0.id == "f" }?.degree, 0)
        XCTAssertEqual(r.folders, ["", "Homelab", "Music"])
        XCTAssertEqual(r.nodes.first { $0.id == "d" }?.folderIndex, 2)
    }

    func testInsideTheUnitSquareAndLinkedNotesSitCloser() {
        let r = NoteGraphLayout.layout(sample)
        for n in r.nodes {
            XCTAssertTrue(n.x.isFinite && n.y.isFinite)
            XCTAssertTrue((0...1).contains(n.x) && (0...1).contains(n.y), "\(n.id) at \(n.x), \(n.y)")
        }
        XCTAssertLessThan(dist(r, "d", "e"), dist(r, "d", "a"))
        XCTAssertLessThan(dist(r, "a", "b"), dist(r, "a", "e"))
        // Nothing lands on top of anything else.
        for i in r.nodes.indices { for j in r.nodes.indices where j > i { XCTAssertGreaterThan(dist(r, r.nodes[i].id, r.nodes[j].id), 0.02) } }
    }

    func testEmptyAndSingle() {
        XCTAssertEqual(NoteGraphLayout.layout(NoteGraph(nodes: [], edges: [])), .empty)
        let one = NoteGraphLayout.layout(NoteGraph(nodes: [node("x", "Only", "Only.md")], edges: []))
        XCTAssertEqual(one.nodes.count, 1)
        XCTAssertEqual(one.nodes[0].x, 0.5)
        XCTAssertEqual(NoteGraphLayout.iterations(for: 1000), 40)
        XCTAssertEqual(NoteGraphLayout.iterations(for: 10), 300)
    }

    func testLocalGraphLinksByTitleAnyCase() {
        let notes = [
            Entity(id: "1", kind: .note, fields: ["title": "Pve1", "path": "Homelab/Pve1.md", "links": ["storage", "Nowhere", "Pve1"]]),
            Entity(id: "2", kind: .note, fields: ["title": "Storage", "path": "Homelab/Storage.md"]),
            Entity(id: "3", kind: .note, deleted_at: ISO.now(), fields: ["title": "Old", "path": "Old.md"]),
        ]
        let g = NoteGraphLayout.localGraph(notes)
        XCTAssertEqual(g.nodes.map(\.id), ["1", "2"])
        XCTAssertEqual(g.nodes[0].folder, "Homelab")
        XCTAssertEqual(g.edges.map { "\($0.from)>\($0.to)" }, ["1>2"])
    }
}
