import Foundation

/// The notes map: where each note sits, worked once per graph with a force layout (Fruchterman and Reingold).
/// Pure and deterministic: no randomness, nodes are ordered by folder, title and id before placing, so the same notes and
/// links always give the same picture whatever order the hub or the local store lists them in.
public enum NoteGraphLayout {

    public struct Node: Identifiable, Equatable, Sendable {
        public var id: String
        public var title: String
        /// Folder path inside the notes folder; "" at the top level.
        public var folder: String
        /// Index into `Result.folders`, for the color.
        public var folderIndex: Int
        public var degree: Int
        /// Position in the unit square, 0...1 on both axes.
        public var x: Double
        public var y: Double
    }

    public struct Edge: Equatable, Sendable {
        public var a: Int
        public var b: Int
    }

    public struct Result: Equatable, Sendable {
        public var nodes: [Node]
        /// Indexes into `nodes`; each pair once, no self links.
        public var edges: [Edge]
        /// Every folder, sorted, so a folder keeps its color while notes come and go elsewhere.
        public var folders: [String]
        public static let empty = Result(nodes: [], edges: [], folders: [])
    }

    /// "Programming/App Ideas/Weather Bot.md" is in "Programming/App Ideas"; a note at the top level is in "".
    public static func folder(ofPath path: String) -> String {
        guard let slash = path.lastIndex(of: "/") else { return "" }
        return String(path[..<slash])
    }

    /// Offline stand-in for GET /notes/graph, from the local notes: a link names another note's title, any case.
    public static func localGraph(_ notes: [Entity]) -> NoteGraph {
        let live = notes.filter { $0.kind == .note && $0.deleted_at == nil }
        let nodes = live.map { n in
            NoteGraph.Node(id: n.id, title: n.str("title"), path: n.str("path"), tags: n.stringArray("tags"), folder: folder(ofPath: n.str("path")))
        }
        var byTitle: [String: String] = [:]
        for n in nodes where byTitle[n.title.lowercased()] == nil { byTitle[n.title.lowercased()] = n.id }
        var edges: [NoteGraph.Edge] = []
        for n in live {
            for t in n.stringArray("links") {
                if let to = byTitle[t.lowercased()], to != n.id { edges.append(NoteGraph.Edge(from: n.id, to: to)) }
            }
        }
        return NoteGraph(nodes: nodes, edges: edges)
    }

    /// Fewer rounds for big vaults: each round compares every pair of notes.
    public static func iterations(for count: Int) -> Int {
        guard count > 1 else { return 0 }
        return max(40, min(300, 24_000_000 / (count * count)))
    }

    public static func layout(_ graph: NoteGraph, iterations rounds: Int? = nil) -> Result {
        let sorted = graph.nodes.map { n in (n, n.folder ?? folder(ofPath: n.path ?? "")) }.sorted { a, b in
            if a.1 != b.1 { return a.1.localizedCaseInsensitiveCompare(b.1) == .orderedAscending }
            let ta = a.0.title.lowercased(), tb = b.0.title.lowercased()
            if ta != tb { return ta < tb }
            return a.0.id < b.0.id
        }
        var index: [String: Int] = [:]
        for (i, n) in sorted.enumerated() where index[n.0.id] == nil { index[n.0.id] = i }
        var seen = Set<[Int]>()
        var edges: [Edge] = []
        for e in graph.edges {
            guard let a = index[e.from], let b = index[e.to], a != b else { continue }
            let key = [min(a, b), max(a, b)]
            if seen.insert(key).inserted { edges.append(Edge(a: key[0], b: key[1])) }
        }
        // Sorted too: floating point sums depend on order, and the picture must not.
        edges.sort { $0.a != $1.a ? $0.a < $1.a : $0.b < $1.b }
        var degree = Array(repeating: 0, count: sorted.count)
        for e in edges { degree[e.a] += 1; degree[e.b] += 1 }
        let folders = Array(Set(sorted.map(\.1))).sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
        let folderIndex = Dictionary(uniqueKeysWithValues: folders.enumerated().map { ($1, $0) })
        let pts = positions(count: sorted.count, edges: edges, iterations: rounds ?? iterations(for: sorted.count))
        let nodes = sorted.enumerated().map { i, n in
            Node(id: n.0.id, title: n.0.title, folder: n.1, folderIndex: folderIndex[n.1] ?? 0, degree: degree[i], x: pts[i].x, y: pts[i].y)
        }
        return Result(nodes: nodes, edges: edges, folders: folders)
    }

    /// Positions in the unit square. Start on a sunflower spiral (even spread, no randomness), then push every pair apart and
    /// pull linked pairs together, with a cooling step limit and a little gravity so loose notes stay near the rest.
    static func positions(count n: Int, edges: [Edge], iterations: Int) -> [(x: Double, y: Double)] {
        guard n > 0 else { return [] }
        guard n > 1 else { return [(0.5, 0.5)] }
        let golden = Double.pi * (3 - 5.0.squareRoot())
        var x = [Double](repeating: 0, count: n), y = [Double](repeating: 0, count: n)
        for i in 0..<n {
            let r = (Double(i) + 0.5).squareRoot() / Double(n).squareRoot()
            x[i] = r * cos(Double(i) * golden)
            y[i] = r * sin(Double(i) * golden)
        }
        let k = (4.0 / Double(n)).squareRoot()   // ideal distance in a 2 by 2 box
        let k2 = k * k
        var dx = [Double](repeating: 0, count: n), dy = [Double](repeating: 0, count: n)
        for round in 0..<iterations {
            for i in 0..<n { dx[i] = 0; dy[i] = 0 }
            for i in 0..<n {
                for j in (i + 1)..<n {
                    var ex = x[i] - x[j], ey = y[i] - y[j]
                    var d2 = ex * ex + ey * ey
                    if d2 < 1e-12 { ex = 1e-6 * Double(i - j); ey = 1e-6; d2 = ex * ex + ey * ey }
                    let f = k2 / d2   // k^2 / d, along the unit vector (e / d)
                    dx[i] += ex * f; dy[i] += ey * f
                    dx[j] -= ex * f; dy[j] -= ey * f
                }
            }
            for e in edges {
                let ex = x[e.a] - x[e.b], ey = y[e.a] - y[e.b]
                let d = (ex * ex + ey * ey).squareRoot()
                let f = d / k   // d^2 / k, along the unit vector
                dx[e.a] -= ex * f; dy[e.a] -= ey * f
                dx[e.b] += ex * f; dy[e.b] += ey * f
            }
            let t = 0.1 * (1 - Double(round) / Double(max(iterations, 1))) + 0.002
            for i in 0..<n {
                dx[i] -= x[i] * 0.6 * k; dy[i] -= y[i] * 0.6 * k
                let d = (dx[i] * dx[i] + dy[i] * dy[i]).squareRoot()
                guard d > 0 else { continue }
                let step = min(d, t)
                x[i] += dx[i] / d * step
                y[i] += dy[i] / d * step
            }
        }
        // Fit into the unit square keeping the aspect ratio, centred.
        let minX = x.min()!, maxX = x.max()!, minY = y.min()!, maxY = y.max()!
        let span = max(maxX - minX, maxY - minY, 1e-9)
        let offX = (1 - (maxX - minX) / span) / 2, offY = (1 - (maxY - minY) / span) / 2
        return (0..<n).map { i in ((x[i] - minX) / span + offX, (y[i] - minY) / span + offY) }
    }
}
