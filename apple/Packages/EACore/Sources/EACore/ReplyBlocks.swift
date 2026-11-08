import Foundation

/// An assistant reply split into blocks for display: headings, bullet and numbered list items, plain lines, code
/// blocks and paragraph gaps. Inline markdown (bold, italics, code, links) stays inside each block's text.
public enum ReplyBlock: Hashable, Sendable {
    case heading(String)
    case bullet(String, indent: Int)
    case numbered(String, label: String)
    case text(String)
    case code(String)
    case gap
}

public enum ReplyBlocks {
    /// Code lines without the blank ones a reply leaves at the end.
    static func joined(_ lines: [String]) -> String {
        var l = lines
        while let last = l.last, last.trimmingCharacters(in: .whitespaces).isEmpty { l.removeLast() }
        return l.joined(separator: "\n")
    }

    public static func parse(_ text: String) -> [ReplyBlock] {
        var out: [ReplyBlock] = []
        var code: [String]? = nil
        for raw in text.components(separatedBy: "\n") {
            let t = raw.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("```") {
                if let c = code { out.append(.code(joined(c))); code = nil } else { code = [] }
                continue
            }
            if code != nil { code!.append(raw); continue }
            if t.isEmpty { if !out.isEmpty && out.last != .gap { out.append(.gap) }; continue }
            if let r = t.range(of: #"^#{1,6}\s+"#, options: .regularExpression) { out.append(.heading(String(t[r.upperBound...]))); continue }
            if let r = raw.range(of: #"^\s*[-*\u2022]\s+"#, options: .regularExpression) {
                let lead = raw.prefix { $0 == " " }.count
                out.append(.bullet(String(raw[r.upperBound...]), indent: min(lead / 2, 3)))
                continue
            }
            if let r = t.range(of: #"^\d{1,3}[.)]\s+"#, options: .regularExpression) {
                out.append(.numbered(String(t[r.upperBound...]), label: String(t[..<r.upperBound]).trimmingCharacters(in: .whitespaces)))
                continue
            }
            out.append(.text(t))
        }
        // An unclosed fence still shows its lines as code.
        if let c = code { out.append(.code(joined(c))) }
        while out.last == .gap { out.removeLast() }
        return out
    }
}
