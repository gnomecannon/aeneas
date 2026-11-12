import Foundation
import EACore
import IrohLib

/// The Direct link for this process: one iroh endpoint (a fresh key each launch: the hub knows this device by its own
/// device key, sent with every request, not by its iroh key) and one connection per hub, opened when first needed and
/// again when it drops. Nothing is published to any lookup service: the hub is found through the relay its QR code named.
public enum EALink {
    /// Installs the Direct link for this process (call once at launch). Requests to `iroh://<hub key>` then go over it.
    public static func install() {
        DirectLinkBridge.session = { node, relay in DirectLinkSessions.session(node: node, relay: relay) }
    }

    static let alpn = Data("aeneas/link/1".utf8)
}

enum DirectLinkSessions {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var sessions: [String: URLSession] = [:]
    nonisolated(unsafe) private static var relays: [String: String] = [:]

    static func session(node: String, relay: String) -> URLSession {
        lock.lock(); defer { lock.unlock() }
        relays[node] = relay
        if let s = sessions[node] { return s }
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [DirectLinkProtocol.self]
        c.timeoutIntervalForRequest = 20
        c.timeoutIntervalForResource = 3600
        c.urlCache = nil
        let s = URLSession(configuration: c)
        sessions[node] = s
        return s
    }

    static func relay(for node: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        return relays[node]
    }
}

/// One endpoint per relay and one connection per hub key.
actor DirectLinkPool {
    static let shared = DirectLinkPool()
    private var endpoints: [String: Endpoint] = [:]
    private var conns: [String: Connection] = [:]
    private var opening: [String: Task<Connection, Error>] = [:]

    private func endpoint(relay: String) async throws -> Endpoint {
        if let e = endpoints[relay], !e.isClosed() { return e }
        let b = EndpointBuilder()
        b.applyMinimal()
        b.relayMode(mode: try RelayMode.customFromUrls(urls: [relay]))
        let e = try await b.bind()
        endpoints[relay] = e
        return e
    }

    func connection(node: String, relay: String) async throws -> Connection {
        if let c = conns[node], c.closeReason() == nil { return c }
        if let t = opening[node] { return try await t.value }
        let t = Task { () throws -> Connection in
            let ep = try await self.endpoint(relay: relay)
            let addr = EndpointAddr(id: try EndpointId.fromString(s: node), relayUrl: relay, addresses: [])
            return try await ep.connect(addr: addr, alpn: EALink.alpn)
        }
        opening[node] = t
        defer { opening[node] = nil }
        let c = try await t.value
        conns[node] = c
        return c
    }

    func drop(node: String) { conns[node] = nil }

    /// How the connection to a hub runs now, for Settings: nil when none is open.
    func path(node: String) -> (direct: Bool, rttMs: UInt64?)? {
        guard let c = conns[node], c.closeReason() == nil else { return nil }
        let sel = c.paths().first { $0.isSelected }
        return (direct: sel.map { !$0.isRelay } ?? false, rttMs: c.rtt())
    }
}

/// URL loading for `iroh://<hub key>/path`: each request on its own stream of the hub's connection.
final class DirectLinkProtocol: URLProtocol, @unchecked Sendable {
    private var loading: Task<Void, Never>?

    override class func canInit(with request: URLRequest) -> Bool { request.url?.scheme?.lowercased() == "iroh" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let request = self.request
        loading = Task { [weak self] in
            guard let self else { return }
            do { try await self.run(request) } catch is CancellationError { } catch {
                self.client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost, userInfo: [NSLocalizedDescriptionKey: "Direct link: \(error)"]))
            }
        }
    }

    override func stopLoading() { loading?.cancel() }

    private static func body(_ r: URLRequest) -> Data {
        if let b = r.httpBody { return b }
        guard let s = r.httpBodyStream else { return Data() }
        s.open(); defer { s.close() }
        var out = Data(); var buf = [UInt8](repeating: 0, count: 64 * 1024)
        while s.hasBytesAvailable { let n = s.read(&buf, maxLength: buf.count); if n <= 0 { break }; out.append(buf, count: n) }
        return out
    }

    private func run(_ request: URLRequest) async throws {
        guard let url = request.url, let node = url.host?.lowercased(), let relay = DirectLinkSessions.relay(for: node) else { throw URLError(.badURL) }
        let body = Self.body(request)
        var bi: BiStream
        do {
            bi = try await DirectLinkPool.shared.connection(node: node, relay: relay).openBi()
        } catch {
            // A connection that went away (the phone changed networks): once more on a new one.
            await DirectLinkPool.shared.drop(node: node)
            bi = try await DirectLinkPool.shared.connection(node: node, relay: relay).openBi()
        }
        let send = bi.send(), recv = bi.recv()
        try await send.writeAll(buf: HTTPWire.requestHead(request, bodyLength: body.count) + body)
        try await send.finish()
        var buf = Data()
        var head: HTTPWire.Head?
        var chunks: ChunkDecoder?
        while !Task.isCancelled {
            let piece = try await recv.read(sizeLimit: 64 * 1024)
            if piece.isEmpty { break }
            if head == nil {
                buf.append(piece)
                guard let (h, used) = HTTPWire.parseHead(buf) else { continue }
                head = h
                let resp = HTTPURLResponse(url: url, statusCode: h.status, httpVersion: "HTTP/1.1", headerFields: h.headers.filter { $0.key.lowercased() != "transfer-encoding" })!
                client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
                if h.headers.contains(where: { $0.key.lowercased() == "transfer-encoding" && $0.value.lowercased().contains("chunked") }) { chunks = ChunkDecoder() }
                let rest = buf.suffix(from: buf.startIndex + used)
                buf = Data()
                deliver(Data(rest), &chunks)
            } else {
                deliver(piece, &chunks)
            }
            if chunks?.finished == true { break }
        }
        if Task.isCancelled { try? await recv.stop(errorCode: 0); throw CancellationError() }
        guard head != nil else { throw URLError(.badServerResponse) }
        client?.urlProtocolDidFinishLoading(self)
    }

    private func deliver(_ d: Data, _ chunks: inout ChunkDecoder?) {
        let out = chunks != nil ? chunks!.feed(d) : d
        if !out.isEmpty { client?.urlProtocol(self, didLoad: out) }
    }
}

/// How the Direct link to the paired hub runs now, for Settings.
public struct DirectLinkState: Sendable, Equatable {
    public var connected: Bool
    public var direct: Bool
    public var rttMs: UInt64?
}

extension EALink {
    public static func state(hubAddress: String) async -> DirectLinkState? {
        guard let d = DirectHub.parse(hubAddress) else { return nil }
        guard let p = await DirectLinkPool.shared.path(node: d.node) else { return DirectLinkState(connected: false, direct: false, rttMs: nil) }
        return DirectLinkState(connected: true, direct: p.direct, rttMs: p.rttMs)
    }
}
