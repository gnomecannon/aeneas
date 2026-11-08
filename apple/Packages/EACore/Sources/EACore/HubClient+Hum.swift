import Foundation

/// A .mid file from the hub and the name it gave it (from the idea's title).
public struct HumMIDIFile: Equatable, Sendable {
    public var name: String
    public var data: Data
    public init(name: String, data: Data) { self.name = name; self.data = data }
}

/// Hum to MIDI (hub `hum.ts`, module `music`). Every route answers 404 while the Music module is off.
extension HubClient {
    /// The longest hum the hub takes.
    public static let humMaxSeconds: TimeInterval = 120

    /// `POST /music/hum`: sends a recording (a WAV file; the apps record 22,050 Hz mono 16 bit) straight from disk.
    /// The hub answers at once with the new music idea, `midi.state` listening; the notes, tempo, key and a title
    /// follow by sync a few seconds later. `fromCapture` also writes a line in the day's diary.
    /// `clientId` names the take: sent again after an upload that was cut off, the hub returns the idea it already made.
    public func uploadHum(fileURL: URL, mode: HumMidi.Mode, bpm: Double? = nil, title: String? = nil,
                          projectId: String? = nil, fromCapture: Bool = false, clientId: String? = nil) async throws -> Entity {
        guard let http else { throw HubError.transport("Sending a hum needs a direct connection to the hub") }
        let r = Self.humUploadRequest(http, mode: mode, bpm: bpm, title: title, projectId: projectId, fromCapture: fromCapture, clientId: clientId)
        let (data, resp): (Data, URLResponse)
        do { (data, resp) = try await http.session.upload(for: r, fromFile: fileURL) }
        catch { throw HubError.transport(error.localizedDescription) }
        _ = try Self.checked(resp, data)
        return try decode(Entity.self, data)
    }

    /// The upload request on its own, so the tests can read it. Two minutes of audio is about 5 MB, so the timeout
    /// is a few minutes rather than the usual 20 seconds.
    static func humUploadRequest(_ http: HTTPTransport, mode: HumMidi.Mode, bpm: Double?, title: String?, projectId: String?, fromCapture: Bool, clientId: String? = nil) -> URLRequest {
        var r = http.request(method: "POST", path: "music/hum", query: humQuery(mode: mode, bpm: bpm, title: title, projectId: projectId, fromCapture: fromCapture, clientId: clientId), timeout: 180)
        r.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
        return r
    }

    static func humQuery(mode: HumMidi.Mode, bpm: Double?, title: String?, projectId: String?, fromCapture: Bool, clientId: String? = nil) -> [String: String] {
        var q = ["mode": mode.rawValue]
        if let id = clientId, !id.isEmpty { q["client_id"] = id }
        if let bpm, bpm > 0 { q["bpm"] = JSONValue.number(bpm.rounded()).displayString }
        if let t = title?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { q["title"] = t }
        if let p = projectId, !p.isEmpty { q["project_id"] = p }
        if fromCapture { q["from"] = "capture" }
        return q
    }

    /// `POST /music/<id>/rehear`: the hub hears the kept recording again, as the other mode or at a given tempo.
    /// The idea comes back listening; the new notes follow by sync.
    public func rehearHum(_ id: String, mode: HumMidi.Mode? = nil, bpm: Double? = nil) async throws -> Entity {
        struct B: Encodable { var mode: HumMidi.Mode?; var bpm: Double? }
        return try await post("music/\(id)/rehear", B(mode: mode, bpm: bpm.map { $0.rounded() }), as: Entity.self)
    }

    /// `GET /music/<id>/midi`: snapped to a 1/16 grid, or with `grid` false the timing as hummed. The hub answers
    /// 409 while it is still listening.
    public func humMIDI(_ id: String, grid: Bool = true) async throws -> HumMIDIFile {
        let path = "music/\(id)/midi"
        let query: [String: String] = grid ? [:] : ["grid": "off"]
        guard let http else {
            // The Watch relay carries no headers, so there is no name to read.
            return HumMIDIFile(name: "Hum.mid", data: try await send("GET", path, query: query))
        }
        let r = http.request(method: "GET", path: path, query: query)
        let (data, resp): (Data, URLResponse)
        do { (data, resp) = try await http.session.data(for: r) }
        catch { throw HubError.transport(error.localizedDescription) }
        let h = try Self.checked(resp, data)
        let name = Self.fileName(contentDisposition: h.value(forHTTPHeaderField: "Content-Disposition")) ?? "Hum.mid"
        return HumMIDIFile(name: name.lowercased().hasSuffix(".mid") ? name : name + ".mid", data: data)
    }

    /// `GET /music/<id>/audio`: the kept recording as WAV, 22,050 Hz mono.
    public func humRecording(_ id: String) async throws -> Data {
        try await send("GET", "music/\(id)/audio")
    }

    /// The plain file name in a Content-Disposition header (`filename*=UTF-8''...` wins over `filename="..."`),
    /// with no folders and nothing that would hide it.
    static func fileName(contentDisposition: String?) -> String? {
        guard let header = contentDisposition else { return nil }
        var plain: String?
        var encoded: String?
        for part in header.split(separator: ";") {
            let p = part.trimmingCharacters(in: .whitespaces)
            let lower = p.lowercased()
            if lower.hasPrefix("filename*=") {
                var v = String(p.dropFirst("filename*=".count))
                if let r = v.range(of: "''") { v = String(v[r.upperBound...]) }
                encoded = v.removingPercentEncoding ?? v
            } else if lower.hasPrefix("filename=") {
                var v = String(p.dropFirst("filename=".count))
                if v.count >= 2, v.hasPrefix("\""), v.hasSuffix("\"") { v = String(v.dropFirst().dropLast()) }
                plain = v
            }
        }
        guard let raw = encoded ?? plain else { return nil }
        var name = String(raw.map { "/\\:".contains($0) ? " " : $0 })
        while let first = name.first, first == "." || first.isWhitespace { name.removeFirst() }
        name = name.trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? nil : name
    }

    /// The HTTP response, or the hub's refusal as `HubError.http` with its own sentence.
    private static func checked(_ resp: URLResponse, _ data: Data) throws -> HTTPURLResponse {
        guard let h = resp as? HTTPURLResponse else { throw HubError.transport("No HTTP response") }
        guard (200..<300).contains(h.statusCode) else {
            let msg = (try? JSONCoding.decode(APIError.self, from: data).error) ?? String(decoding: data.prefix(200), as: UTF8.self)
            throw HubError.http(status: h.statusCode, message: msg)
        }
        return h
    }
}
