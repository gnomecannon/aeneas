import Foundation

/// The HTTP the Direct link carries over each iroh stream: one request, written as HTTP/1.0 so the hub closes the
/// stream when the answer ends, and the answer read back as it arrives (status and headers first, then the body,
/// unchunked when the hub chunks it, as it does for live updates).
enum HTTPWire {
    static func requestHead(_ r: URLRequest, bodyLength: Int) -> Data {
        let u = r.url!
        var target = u.path.isEmpty ? "/" : u.path
        if let q = u.query, !q.isEmpty { target += "?" + q }
        var lines = ["\(r.httpMethod ?? "GET") \(target) HTTP/1.0", "Host: hub"]
        let skip: Set<String> = ["host", "content-length", "connection", "accept-encoding", "transfer-encoding"]
        for (k, v) in r.allHTTPHeaderFields ?? [:] where !skip.contains(k.lowercased()) && !v.contains("\r") && !v.contains("\n") {
            lines.append("\(k): \(v)")
        }
        // Bodies are not compressed: the app reads them as they come.
        lines.append("Accept-Encoding: identity")
        if bodyLength > 0 || ["POST", "PUT", "PATCH"].contains(r.httpMethod ?? "GET") { lines.append("Content-Length: \(bodyLength)") }
        return Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
    }

    struct Head { var status: Int; var headers: [String: String] }

    /// Status and headers once `buf` holds them all, and how many bytes they took.
    static func parseHead(_ buf: Data) -> (Head, Int)? {
        guard let end = buf.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let text = String(decoding: buf[buf.startIndex..<end.lowerBound], as: UTF8.self)
        var lines = text.components(separatedBy: "\r\n")
        let status = lines.removeFirst().split(separator: " ").dropFirst().first.flatMap { Int($0) } ?? 0
        var headers: [String: String] = [:]
        for l in lines {
            guard let c = l.firstIndex(of: ":") else { continue }
            let k = String(l[..<c]).trimmingCharacters(in: .whitespaces)
            let v = String(l[l.index(after: c)...]).trimmingCharacters(in: .whitespaces)
            headers[k] = headers[k].map { "\($0), \(v)" } ?? v
        }
        return (Head(status: status, headers: headers), end.upperBound - buf.startIndex)
    }
}

/// Undoes chunked transfer encoding as bytes arrive, a piece at a time.
struct ChunkDecoder {
    private var buf = Data()
    private var remaining = 0
    private enum State { case size, data, dataEnd, done }
    private var state = State.size
    var finished: Bool { state == .done }

    /// The body bytes `more` completes.
    mutating func feed(_ more: Data) -> Data {
        buf.append(more)
        var out = Data()
        loop: while true {
            switch state {
            case .size:
                guard let nl = buf.range(of: Data("\r\n".utf8)) else { break loop }
                let line = String(decoding: buf[buf.startIndex..<nl.lowerBound], as: UTF8.self)
                buf.removeSubrange(buf.startIndex..<nl.upperBound)
                let hex = line.split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
                guard let n = Int(hex, radix: 16) else { state = .done; break loop }
                if n == 0 { state = .done; break loop }
                remaining = n; state = .data
            case .data:
                if buf.isEmpty { break loop }
                let take = min(remaining, buf.count)
                out.append(buf.prefix(take))
                buf.removeFirst(take)
                remaining -= take
                if remaining == 0 { state = .dataEnd } else { break loop }
            case .dataEnd:
                guard buf.count >= 2 else { break loop }
                buf.removeFirst(2)
                state = .size
            case .done:
                break loop
            }
        }
        return out
    }
}
