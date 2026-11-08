import Foundation

/// A JSON value. Entity `fields` are stored as a dictionary of these so that every
/// kind in the contract can round trip without loss.
public enum JSONValue: Codable, Equatable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "Unsupported JSON value")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n):
            if n.rounded() == n, abs(n) < 1e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
    public var doubleValue: Double? {
        switch self {
        case .number(let n): return n
        case .string(let s): return Double(s)
        default: return nil
        }
    }
    public var boolValue: Bool? { if case .bool(let b) = self { return b }; return nil }
    public var arrayValue: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
    public var objectValue: [String: JSONValue]? { if case .object(let o) = self { return o }; return nil }
    public var isNull: Bool { if case .null = self { return true }; return false }

    /// Value or string form for display. Numbers print without a trailing .0.
    public var displayString: String {
        switch self {
        case .string(let s): return s
        case .number(let n): return n.rounded() == n ? String(Int64(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        case .null: return ""
        case .array(let a): return a.map { $0.displayString }.joined(separator: ", ")
        case .object: return (try? JSONCoding.string(self)) ?? ""
        }
    }

    public static func from(_ any: Any) -> JSONValue {
        switch any {
        case let v as JSONValue: return v
        case let s as String: return .string(s)
        case let b as Bool: return .bool(b)
        case let i as Int: return .number(Double(i))
        case let d as Double: return .number(d)
        case let a as [Any]: return .array(a.map { from($0) })
        case let o as [String: Any]: return .object(o.mapValues { from($0) })
        case is NSNull: return .null
        default: return .string(String(describing: any))
        }
    }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByBooleanLiteral, ExpressibleByNilLiteral, ExpressibleByArrayLiteral, ExpressibleByDictionaryLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(nilLiteral: ()) { self = .null }
    public init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    public init(dictionaryLiteral elements: (String, JSONValue)...) {
        var o: [String: JSONValue] = [:]
        for (k, v) in elements { o[k] = v }
        self = .object(o)
    }
}

public enum JSONCoding {
    public static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }()
    public static let decoder = JSONDecoder()

    public static func data<T: Encodable>(_ value: T) throws -> Data { try encoder.encode(value) }
    public static func string<T: Encodable>(_ value: T) throws -> String { String(decoding: try encoder.encode(value), as: UTF8.self) }
    public static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T { try decoder.decode(type, from: data) }
    public static func decode<T: Decodable>(_ type: T.Type, from string: String) throws -> T { try decoder.decode(type, from: Data(string.utf8)) }

    /// Convert any Encodable value into a JSONValue tree by round tripping through JSON.
    public static func value<T: Encodable>(_ v: T) throws -> JSONValue { try decode(JSONValue.self, from: try data(v)) }
    /// Convert a JSONValue tree into a typed Decodable value.
    public static func typed<T: Decodable>(_ type: T.Type, from v: JSONValue) throws -> T { try decode(type, from: try data(v)) }
}
