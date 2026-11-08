import Foundation

/// A wiki page's markdown as blocks the reader lays out one by one: headings, paragraphs (inline markdown kept for the
/// view), lists (nested, numbered, task), quotes, fenced code, tables and images. Pure and thread safe, so a 300 KB
/// page is parsed off the main thread. Inline styles stay as markdown text; the view turns them into attributed text.
public indirect enum WikiBlock: Equatable, Sendable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case list(WikiList)
    case quote([WikiBlock])
    case code(language: String, text: String)
    case table(WikiTable)
    case image(alt: String, src: String)
    case rule
}

public struct WikiList: Equatable, Sendable {
    public var ordered: Bool
    public var start: Int
    public var items: [WikiListItem]
    public init(ordered: Bool, start: Int = 1, items: [WikiListItem]) { self.ordered = ordered; self.start = start; self.items = items }
}

public struct WikiListItem: Equatable, Sendable {
    /// Nil for a plain item; true or false for a task list item.
    public var checked: Bool?
    public var blocks: [WikiBlock]
    public init(checked: Bool? = nil, blocks: [WikiBlock]) { self.checked = checked; self.blocks = blocks }
}

public struct WikiTable: Equatable, Sendable {
    public enum Align: String, Equatable, Sendable { case leading, center, trailing }
    public var header: [String]
    public var rows: [[String]]
    public var alignments: [Align]
    public init(header: [String], rows: [[String]], alignments: [Align]) { self.header = header; self.rows = rows; self.alignments = alignments }
}

public enum WikiMarkdown {
    public static func parse(_ markdown: String) -> [WikiBlock] {
        var lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n").map(expandLeadingTabs)
        // Front matter at the top of a repo doc is settings, not reading.
        if lines.first?.trimmingCharacters(in: .whitespaces) == "---",
           let end = lines.dropFirst().prefix(60).firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" }),
           lines[1..<end].contains(where: { $0.range(of: #"^[A-Za-z0-9_-]+:"#, options: .regularExpression) != nil }) {
            lines.removeSubrange(0...end)
        }
        return blocks(lines)
    }

    // MARK: blocks

    static func blocks(_ lines: [String]) -> [WikiBlock] {
        var out: [WikiBlock] = []
        var para: [String] = []
        var i = 0
        func flush() {
            if !para.isEmpty { out += paragraphBlocks(para) }
            para = []
        }
        while i < lines.count {
            let line = lines[i]
            let indent = indentOf(line)
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.isEmpty { flush(); i += 1; continue }

            // Indented code, only where it cannot be a paragraph continuing.
            if indent >= 4 && para.isEmpty {
                var code: [String] = []
                while i < lines.count, indentOf(lines[i]) >= 4 || lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                    code.append(strip(lines[i], 4))
                    i += 1
                }
                while code.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { code.removeLast() }
                out.append(.code(language: "", text: code.joined(separator: "\n")))
                continue
            }
            if indent < 4, let f = fence(t) {
                flush()
                var code: [String] = []
                i += 1
                while i < lines.count {
                    let c = lines[i].trimmingCharacters(in: .whitespaces)
                    if c.count >= f.count, c.allSatisfy({ $0 == f.char }) { i += 1; break }
                    code.append(strip(lines[i], indent))
                    i += 1
                }
                out.append(.code(language: f.info, text: code.joined(separator: "\n")))
                continue
            }
            if indent < 4, let h = heading(t) { flush(); out.append(h); i += 1; continue }
            // A line of = or - under a paragraph makes it a heading.
            if indent < 4, !para.isEmpty, t.allSatisfy({ $0 == "=" }) || (t.allSatisfy({ $0 == "-" }) && t.count >= 2) {
                let text = para.map { $0.trimmingCharacters(in: .whitespaces) }.joined(separator: " ")
                para = []
                out.append(.heading(level: t.hasPrefix("=") ? 1 : 2, text: text))
                i += 1
                continue
            }
            if indent < 4, isRule(t) { flush(); out.append(.rule); i += 1; continue }
            if indent < 4, t.hasPrefix(">") {
                flush()
                var inner: [String] = []
                while i < lines.count {
                    let q = lines[i].trimmingCharacters(in: .whitespaces)
                    guard q.hasPrefix(">") else { break }
                    var rest = q.dropFirst()
                    if rest.first == " " { rest = rest.dropFirst() }
                    inner.append(String(rest))
                    i += 1
                }
                out.append(.quote(blocks(inner)))
                continue
            }
            if indent < 4, i + 1 < lines.count, t.contains("|"), let aligns = delimiterRow(lines[i + 1]) {
                let header = cells(t)
                if header.count == aligns.count {
                    flush()
                    i += 2
                    var rows: [[String]] = []
                    while i < lines.count {
                        let r = lines[i].trimmingCharacters(in: .whitespaces)
                        if r.isEmpty || startsBlock(lines[i]) { break }
                        var c = cells(r)
                        if c.count < header.count { c += Array(repeating: "", count: header.count - c.count) }
                        rows.append(Array(c.prefix(header.count)))
                        i += 1
                    }
                    out.append(.table(WikiTable(header: header, rows: rows, alignments: aligns)))
                    continue
                }
            }
            if indent < 4, let m = marker(line), para.isEmpty || !m.ordered || m.number == 1 {
                flush()
                let (list, next) = parseList(lines, from: i, first: m)
                out.append(.list(list))
                i = next
                continue
            }
            para.append(line)
            i += 1
        }
        flush()
        return out
    }

    // MARK: lists

    struct Marker: Equatable {
        var indent: Int
        var ordered: Bool
        var number: Int
        /// `-`, `*`, `+`, `.` or `)`: a different one starts a new list.
        var delimiter: Character
        /// Where the item's text starts.
        var content: Int
    }

    static func marker(_ line: String) -> Marker? {
        let chars = Array(line)
        var i = 0
        while i < chars.count, chars[i] == " " { i += 1 }
        let indent = i
        guard i < chars.count else { return nil }
        var ordered = false
        var number = 0
        var delimiter: Character
        if "-*+".contains(chars[i]) {
            delimiter = chars[i]
            i += 1
        } else {
            var digits = ""
            while i < chars.count, chars[i].isASCII, chars[i].isNumber, digits.count < 9 { digits.append(chars[i]); i += 1 }
            guard !digits.isEmpty, i < chars.count, chars[i] == "." || chars[i] == ")" else { return nil }
            delimiter = chars[i]
            ordered = true
            number = Int(digits) ?? 1
            i += 1
        }
        // The marker needs a space after it, or the end of the line.
        if i == chars.count { return Marker(indent: indent, ordered: ordered, number: number, delimiter: delimiter, content: i + 1) }
        guard chars[i] == " " || chars[i] == "\t" else { return nil }
        var spaces = 0
        var j = i
        while j < chars.count, chars[j] == " " || chars[j] == "\t" { spaces += 1; j += 1 }
        if spaces > 4 || j == chars.count { spaces = 1 }
        return Marker(indent: indent, ordered: ordered, number: number, delimiter: delimiter, content: i + spaces)
    }

    static func parseList(_ lines: [String], from start: Int, first: Marker) -> (WikiList, Int) {
        var items: [WikiListItem] = []
        var i = start
        var current = first
        while i < lines.count, let m = marker(lines[i]), m.ordered == first.ordered, m.delimiter == first.delimiter, m.indent < first.content {
            current = m
            var content: [String] = [String(lines[i].dropFirst(min(m.content, lines[i].count)))]
            i += 1
            var blankRun = 0
            while i < lines.count {
                let l = lines[i]
                let t = l.trimmingCharacters(in: .whitespaces)
                if t.isEmpty { blankRun += 1; content.append(""); i += 1; continue }
                let ind = indentOf(l)
                if ind >= current.content {
                    content.append(strip(l, current.content))
                } else if marker(l) != nil, ind > current.indent {
                    // A nested list indented less than the text above it still belongs to this item.
                    content.append(strip(l, ind))
                } else if blankRun == 0, marker(l) == nil, !startsBlock(l) {
                    // A wrapped line that lost its indent continues the item's paragraph.
                    content.append(t)
                } else {
                    break
                }
                blankRun = 0
                i += 1
            }
            // Blank lines after the last item belong to whatever follows.
            content.removeLast(blankRun)
            i -= blankRun
            while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).isEmpty, i + 1 < lines.count,
                  let next = marker(lines[i + 1]), next.ordered == first.ordered, next.delimiter == first.delimiter, next.indent < first.content {
                i += 1
            }
            var checked: Bool?
            if let head = content.first {
                let h = head.trimmingCharacters(in: .whitespaces)
                for (box, done) in [("[ ]", false), ("[x]", true), ("[X]", true)] where h == box || h.hasPrefix(box + " ") {
                    checked = done
                    content[0] = String(h.dropFirst(box.count)).trimmingCharacters(in: .whitespaces)
                }
            }
            items.append(WikiListItem(checked: checked, blocks: blocks(content)))
        }
        return (WikiList(ordered: first.ordered, start: first.ordered ? first.number : 1, items: items), i)
    }

    // MARK: paragraphs and images

    nonisolated(unsafe) private static let imagePattern = try! NSRegularExpression(
        pattern: #"\[?!\[((?:[^\[\]]|\[[^\]]*\])*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)(?:\]\([^)]*\))?"#)

    /// Paragraph lines joined the markdown way (a wrapped line is a space, two trailing spaces or a backslash a line
    /// break), with any pictures taken out as their own blocks, in order.
    static func paragraphBlocks(_ lines: [String]) -> [WikiBlock] {
        var text = ""
        for (n, raw) in lines.enumerated() {
            var l = raw.trimmingCharacters(in: CharacterSet(charactersIn: " "))
            let hard = raw.hasSuffix("  ") || l.hasSuffix("\\")
            if l.hasSuffix("\\") { l.removeLast() }
            text += l
            if n < lines.count - 1 { text += hard ? "\n" : " " }
        }
        let ns = text as NSString
        let matches = imagePattern.matches(in: text, range: NSRange(location: 0, length: ns.length))
        guard !matches.isEmpty else { return [.paragraph(text)] }
        var out: [WikiBlock] = []
        var at = 0
        for m in matches {
            let before = ns.substring(with: NSRange(location: at, length: m.range.location - at)).trimmingCharacters(in: .whitespacesAndNewlines)
            if !before.isEmpty { out.append(.paragraph(before)) }
            out.append(.image(alt: ns.substring(with: m.range(at: 1)), src: ns.substring(with: m.range(at: 2))))
            at = m.range.location + m.range.length
        }
        let rest = ns.substring(from: at).trimmingCharacters(in: .whitespacesAndNewlines)
        if !rest.isEmpty { out.append(.paragraph(rest)) }
        return out
    }

    // MARK: tables

    /// The `| --- | :-: |` row under a table header: one alignment per column, or nil when the line is not one.
    static func delimiterRow(_ line: String) -> [WikiTable.Align]? {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.contains("-"), t.allSatisfy({ "|:- ".contains($0) }) else { return nil }
        let parts = cells(t)
        guard !parts.isEmpty, t.contains("|") || parts.count == 1 else { return nil }
        var out: [WikiTable.Align] = []
        for p in parts {
            guard p.contains("-"), p.range(of: #"^:?-+:?$"#, options: .regularExpression) != nil else { return nil }
            out.append(p.hasPrefix(":") && p.hasSuffix(":") ? .center : p.hasSuffix(":") ? .trailing : .leading)
        }
        return out
    }

    /// A table row's cells: split on pipes outside code spans, `\|` kept as a pipe.
    static func cells(_ row: String) -> [String] {
        var s = Substring(row.trimmingCharacters(in: .whitespaces))
        if s.hasPrefix("|") { s = s.dropFirst() }
        if s.hasSuffix("|") && !s.hasSuffix("\\|") { s = s.dropLast() }
        var out: [String] = []
        var cell = ""
        var inCode = false
        var escaped = false
        for ch in s {
            if escaped {
                cell.append(ch == "|" ? "|" : "\\\(ch)")
                escaped = false
                continue
            }
            if ch == "\\" { escaped = true; continue }
            if ch == "`" { inCode.toggle() }
            if ch == "|" && !inCode {
                out.append(cell.trimmingCharacters(in: .whitespaces))
                cell = ""
                continue
            }
            cell.append(ch)
        }
        if escaped { cell.append("\\") }
        out.append(cell.trimmingCharacters(in: .whitespaces))
        return out
    }

    // MARK: small helpers

    static func heading(_ t: String) -> WikiBlock? {
        let level = t.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(level) else { return nil }
        let rest = t.dropFirst(level)
        guard rest.isEmpty || rest.first == " " else { return nil }
        var text = rest.trimmingCharacters(in: .whitespaces)
        // Closing hashes are decoration.
        if let r = text.range(of: #"\s+#+$"#, options: .regularExpression) { text.removeSubrange(r) } else if text.allSatisfy({ $0 == "#" }) { text = "" }
        return .heading(level: level, text: text)
    }

    static func fence(_ t: String) -> (char: Character, count: Int, info: String)? {
        guard let c = t.first, c == "`" || c == "~" else { return nil }
        let n = t.prefix(while: { $0 == c }).count
        guard n >= 3 else { return nil }
        let info = t.dropFirst(n).trimmingCharacters(in: .whitespaces)
        if c == "`" && info.contains("`") { return nil }
        return (c, n, String(info.split(separator: " ").first ?? ""))
    }

    static func isRule(_ t: String) -> Bool {
        guard let c = t.first, "-*_".contains(c) else { return false }
        let marks = t.filter { $0 != " " }
        return marks.count >= 3 && marks.allSatisfy { $0 == c }
    }

    /// Does this line start a block of its own (so it cannot continue a paragraph or table)?
    static func startsBlock(_ line: String) -> Bool {
        guard indentOf(line) < 4 else { return false }
        let t = line.trimmingCharacters(in: .whitespaces)
        return heading(t) != nil || fence(t) != nil || t.hasPrefix(">") || isRule(t) || marker(line) != nil
    }

    static func indentOf(_ line: String) -> Int { line.prefix(while: { $0 == " " }).count }

    /// Drop up to `n` leading spaces.
    static func strip(_ line: String, _ n: Int) -> String {
        String(line.dropFirst(min(n, indentOf(line))))
    }

    static func expandLeadingTabs(_ line: String) -> String {
        guard line.first == "\t" || line.first == " " else { return line }
        var out = ""
        var rest = Substring(line)
        while let c = rest.first, c == " " || c == "\t" {
            out += c == "\t" ? String(repeating: " ", count: 4 - out.count % 4) : " "
            rest = rest.dropFirst()
        }
        return out + rest
    }
}
