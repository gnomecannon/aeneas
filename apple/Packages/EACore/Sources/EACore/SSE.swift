import Foundation

/// Minimal Server-Sent Events parser. Feed it lines; it emits (event, data) pairs.
public struct SSEMessage: Equatable, Sendable {
    public var event: String
    public var data: String
    public var id: String?
}

public struct SSEParser: Sendable {
    private var event = ""
    private var data: [String] = []
    private var id: String?

    public init() {}

    /// Feed one line (without the trailing newline). Returns a message when a blank line ends one.
    public mutating func feed(line: String) -> SSEMessage? {
        if line.isEmpty {
            guard !data.isEmpty || !event.isEmpty else { return nil }
            let msg = SSEMessage(event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n"), id: id)
            event = ""; data = []; id = nil
            return msg
        }
        if line.hasPrefix(":") { return nil }
        let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        let field = String(parts[0])
        var value = parts.count > 1 ? String(parts[1]) : ""
        if value.hasPrefix(" ") { value.removeFirst() }
        switch field {
        case "event": event = value
        case "data": data.append(value)
        case "id": id = value
        default: break
        }
        return nil
    }
}

/// Splits a byte stream into lines and keeps blank lines.
///
/// `URLSession.AsyncBytes.lines` skips empty lines, and SSE uses the empty line to end each
/// event, so reading through `.lines` merged a whole chat reply into one undecodable message.
public struct SSELineBuffer: Sendable {
    private var buf: [UInt8] = []
    public init() {}

    /// Feed one byte. Returns a complete line (without `\n` or a trailing `\r`) when one ends.
    public mutating func append(_ byte: UInt8) -> String? {
        guard byte == 0x0A else { buf.append(byte); return nil }
        if buf.last == 0x0D { buf.removeLast() }
        let line = String(decoding: buf, as: UTF8.self)
        buf.removeAll(keepingCapacity: true)
        return line
    }

    /// Whatever is left when the stream ends, if anything.
    public mutating func flush() -> String? {
        guard !buf.isEmpty else { return nil }
        defer { buf.removeAll() }
        return String(decoding: buf, as: UTF8.self)
    }
}
