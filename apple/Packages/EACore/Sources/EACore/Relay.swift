import Foundation

/// Watch to iPhone relay envelope. The Watch cannot reach the hub (Tailscale only), so every
/// hub call from the Watch is packed into one of these, sent over WatchConnectivity, performed
/// by the iPhone with its own hub URL and token, and answered with a `RelayResponse`.
public struct RelayRequest: Codable, Equatable, Sendable {
    public var id: String
    public var method: String
    public var path: String
    public var query: [String: String]
    /// Request body, base64.
    public var body: String?

    public init(id: String = UUID().uuidString.lowercased(), method: String, path: String, query: [String: String] = [:], body: Data? = nil) {
        self.id = id
        self.method = method
        self.path = path
        self.query = query
        self.body = body?.base64EncodedString()
    }

    public var bodyData: Data? { body.flatMap { Data(base64Encoded: $0) } }
    public func encoded() throws -> Data { try JSONCoding.data(self) }
    public static func decode(_ data: Data) throws -> RelayRequest { try JSONCoding.decode(RelayRequest.self, from: data) }

    /// Approximate wire size, used to refuse oversized relay requests.
    public var wireSize: Int { (try? encoded().count) ?? 0 }

    /// The Watch asking for one part of an answer that came in parts (see `RelayParts`). Never reaches the hub.
    public static func part(of id: String, index: Int) -> RelayRequest {
        RelayRequest(method: RelayParts.method, path: "relay/part", query: ["id": id, "index": String(index)])
    }

    /// The answer id and part index when this asks for a part.
    public var partOf: (id: String, index: Int)? {
        guard method == RelayParts.method, let id = query["id"], let i = query["index"].flatMap(Int.init) else { return nil }
        return (id, i)
    }
}

public struct RelayResponse: Codable, Equatable, Sendable {
    public var id: String
    /// HTTP status, or 0 when the phone could not perform the request (see `error`).
    public var status: Int
    /// Response body, base64.
    public var data: String
    public var error: String?
    /// Set when the body was too big for one message: it follows compressed, in this many parts (see `RelayParts`).
    public var parts: Int?

    public init(id: String, status: Int, data: Data, error: String? = nil, parts: Int? = nil) {
        self.id = id
        self.status = status
        self.data = data.base64EncodedString()
        self.error = error
        self.parts = parts
    }

    public var bodyData: Data { Data(base64Encoded: data) ?? Data() }
    public func encoded() throws -> Data { try JSONCoding.data(self) }
    public static func decode(_ data: Data) throws -> RelayResponse { try JSONCoding.decode(RelayResponse.self, from: data) }
}

/// Phone side: perform a relayed request with the phone's transport.
public enum RelayHandler {
    /// Largest envelope the Watch will send (WatchConnectivity messages are limited to about 64 KB).
    public static let maxWireSize = 60_000

    public static func perform(_ req: RelayRequest, transport: HubTransport, watchDeviceName: String?) async -> RelayResponse {
        var body = req.bodyData
        // The Watch does not know the phone's name; fill it in when it registers itself.
        if req.path == "devices/register", let name = watchDeviceName, let b = body,
           var obj = (try? JSONSerialization.jsonObject(with: b)) as? [String: Any] {
            obj["name"] = name
            body = try? JSONSerialization.data(withJSONObject: obj)
        }
        do {
            let (status, data) = try await transport.send(method: req.method, path: req.path, query: req.query, body: body)
            return RelayResponse(id: req.id, status: status, data: data)
        } catch {
            let msg = (error as? HubError)?.errorDescription ?? error.localizedDescription
            return RelayResponse(id: req.id, status: 0, data: Data(), error: msg)
        }
    }

    /// The question and answer of a chat the Watch asked and the hub answered, so the iPhone can tell the Watch another
    /// way when its app is no longer in front to take the reply. Nil for any other request or a failed one.
    public static func answeredChat(_ req: RelayRequest, _ resp: RelayResponse) -> (question: String, answer: String, session: String)? {
        guard req.method == "POST", req.path == "ai/chat", (200..<300).contains(resp.status), let b = req.bodyData,
              let r = try? JSONDecoder().decode(ChatRequest.self, from: b), let q = r.message, !q.isEmpty,
              let a = try? JSONDecoder().decode(ChatResponse.self, from: resp.bodyData), !a.reply.isEmpty else { return nil }
        return (q, a.pending_action != nil ? a.reply + "\n\nApprove or decline this on your iPhone." : a.reply, r.session_id)
    }

    /// The bytes the phone answers with: the response as is when it fits one message, else a header naming the
    /// part count, with the parts kept in `store` for the Watch to fetch.
    public static func reply(_ resp: RelayResponse, store: RelayPartStore) -> Data {
        if let wire = try? resp.encoded(), wire.count <= maxWireSize { return wire }
        guard let split = RelayParts.split(resp) else {
            return (try? RelayResponse(id: resp.id, status: 0, data: Data(), error: "Answer too large for the Watch").encoded()) ?? Data()
        }
        store.put(resp.id, split.parts)
        return (try? split.header.encoded()) ?? Data()
    }
}

/// Answers too big for one WatchConnectivity message (about 64 KB, and a reply over it fails as "message reply
/// failed"): a page of the sync feed runs to hundreds of KB, and one capture with a picture is 500 KB on its own.
/// The phone compresses the body and splits it; the Watch asks for the parts one by one and joins them.
public enum RelayParts {
    static let method = "PART"
    /// Raw bytes per part; a part goes back as the whole reply, with no envelope or base64.
    public static let partSize = 56_000

    /// The header to answer with and the parts that follow it, or nil when the body cannot be compressed.
    public static func split(_ resp: RelayResponse) -> (header: RelayResponse, parts: [Data])? {
        guard let packed = try? (resp.bodyData as NSData).compressed(using: .lzfse) as Data else { return nil }
        let parts = stride(from: 0, to: max(packed.count, 1), by: partSize).map { packed.subdata(in: $0..<min($0 + partSize, packed.count)) }
        return (RelayResponse(id: resp.id, status: resp.status, data: Data(), error: resp.error, parts: parts.count), parts)
    }

    /// The whole response from its header and every part, in order.
    public static func join(_ header: RelayResponse, _ parts: [Data]) throws -> RelayResponse {
        guard parts.count == header.parts, !parts.contains(where: \.isEmpty) else {
            throw HubError.transport("The iPhone no longer has the rest of the answer")
        }
        var packed = Data(capacity: parts.reduce(0) { $0 + $1.count })
        for p in parts { packed.append(p) }
        let body = try (packed as NSData).decompressed(using: .lzfse) as Data
        return RelayResponse(id: header.id, status: header.status, data: body, error: header.error)
    }
}

/// Phone side: the parts of big answers, until the Watch has fetched the last one or two minutes have passed.
public final class RelayPartStore: @unchecked Sendable {
    public static let keep: TimeInterval = 120
    private var held: [String: (parts: [Data], at: Date)] = [:]
    private let lock = NSLock()

    public init() {}

    public func put(_ id: String, _ parts: [Data], now: Date = Date()) {
        lock.lock(); defer { lock.unlock() }
        held = held.filter { now.timeIntervalSince($0.value.at) < Self.keep }
        held[id] = (parts, now)
    }

    /// One part, or nil when it is unknown or expired. The answer is dropped once its last part is taken. Each part
    /// taken restarts the two minutes, so a long answer fetched slowly over Bluetooth is not dropped halfway.
    public func take(_ id: String, _ index: Int, now: Date = Date()) -> Data? {
        lock.lock(); defer { lock.unlock() }
        guard let h = held[id], now.timeIntervalSince(h.at) < Self.keep, h.parts.indices.contains(index) else { return nil }
        if index == h.parts.count - 1 { held[id] = nil } else { held[id] = (h.parts, now) }
        return h.parts[index]
    }

    public var count: Int { lock.lock(); defer { lock.unlock() }; return held.count }
}
