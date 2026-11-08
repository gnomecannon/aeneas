import Foundation

/// Display-side style filter: a port of `applyStyle` in packages/shared.
/// The hub enforces style on AI output; clients apply this only for display.
public enum StyleGuard {
    public struct Pattern: Sendable {
        public var name: String
        public var regex: NSRegularExpression
        public var replacement: String
        public init(name: String, pattern: String, options: NSRegularExpression.Options = [], replacement: String) {
            self.name = name
            self.regex = (try? NSRegularExpression(pattern: pattern, options: options)) ?? NSRegularExpression()
            self.replacement = replacement
        }
    }

    /// Weekday and month names as whole words: "Janet" is not January, "Maybe" is not May.
    private static let rangeWords = "Monday|Mon|Tuesday|Tues|Tue|Wednesday|Wed|Thursday|Thurs|Thur|Thu|Friday|Fri|Saturday|Sat|Sunday|Sun|January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sept|Sep|October|Oct|November|Nov|December|Dec"
    /// AM or PM as a word of its own or after a digit ("5pm"); "team" does not end in a time.
    private static let ampm = "(?:\\b|\\d)[AaPp]\\.?[Mm]\\.?"

    nonisolated(unsafe) public static let defaultPatterns: [Pattern] = [
        // A dash in a range reads as "to": numbers and times, weekdays, months ("Mon to Fri", not "Mon, Fri").
        Pattern(name: "range-dash", pattern: "(?<=\\d|\(ampm)|\\b(?:\(rangeWords))\\.?)[ \\t]{0,3}[\\u2014\\u2013][ \\t]{0,3}(?=\\d|(?:\(rangeWords))\\b)", replacement: " to "),
        // Spaces around a dash are bounded: an unbounded run made every position of a long space run a scan.
        Pattern(name: "em-dash", pattern: "[ \\t]{0,3}[\\u2014\\u2013][ \\t]{0,3}", replacement: ", "),
        Pattern(name: "final-fix", pattern: "\\bfinal fix\\b", options: [.caseInsensitive], replacement: "this change"),
        Pattern(name: "opening-platitude", pattern: "^(great|good|excellent|awesome) (question|point|idea)[.!,]?\\s*", options: [.caseInsensitive, .anchorsMatchLines], replacement: ""),
        Pattern(name: "closing-filler", pattern: "^\\s*(let me know|feel free|hope this helps|if you have any (other )?questions|happy to help|i'?m here to help)[^\\n]*\\n?", options: [.caseInsensitive, .anchorsMatchLines], replacement: ""),
    ]

    /// Vague closing offers ("Want me to add anything else?"), dropped sentence by sentence: as one regex over the
    /// line it took cubic time on long runs of spaces.
    nonisolated(unsafe) private static let vagueOffer = try! NSRegularExpression(pattern: "\\b(let me know|say the word|want me to (add|do|change) anything else|anything else (you need|to add)|if you'?d like,? i can)\\b", options: [.caseInsensitive])
    nonisolated(unsafe) private static let sentenceEnd = try! NSRegularExpression(pattern: "(?<=[.!?])[ \\t]+")

    static func dropVagueOffers(_ text: String) -> String {
        func has(_ s: String) -> Bool { vagueOffer.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil }
        return text.components(separatedBy: "\n").map { line -> String in
            guard has(line) else { return line }
            let marked = sentenceEnd.stringByReplacingMatches(in: line, range: NSRange(location: 0, length: (line as NSString).length), withTemplate: "\u{1F}")
            return marked.components(separatedBy: "\u{1F}").filter { !has($0) }.joined(separator: " ")
        }.joined(separator: "\n")
    }

    nonisolated(unsafe) private static let codeFence = try! NSRegularExpression(pattern: "```[\\s\\S]*?```")
    nonisolated(unsafe) private static let codeSpans = try! NSRegularExpression(pattern: "```[\\s\\S]*?```|`[^`\\n]*`")
    /// A spaced-hyphen range: after a clock time, AM/PM, a day or month name, or between two small numbers.
    nonisolated(unsafe) private static let rangeHyphen = try! NSRegularExpression(pattern: "(?:(?<=\\d:\\d\\d|\(ampm)|\\b(?:\(rangeWords))\\.?)[ \\t]+-[ \\t]+(?=\\d|(?:\(rangeWords))\\b)|(?<=\\b\\d{1,2})[ \\t]+-[ \\t]+(?=\\d{1,2}\\b))")
    nonisolated(unsafe) private static let spacedHyphen = try! NSRegularExpression(pattern: "(?<=[\\p{L}\\p{N})*_.!?'\"%])[ \\t]+-[ \\t]+(?=[\\p{L}\\p{N}(*_'\"$])")

    /// A spaced hyphen between words is a dash too. Prose only: code fences and inline code keep theirs, and a list
    /// bullet at the start of a line is not between words.
    static func proseHyphens(_ text: String) -> String {
        let ns = text as NSString
        func fix(_ s: String) -> String {
            let ranged = rangeHyphen.stringByReplacingMatches(in: s, range: NSRange(location: 0, length: (s as NSString).length), withTemplate: " to ")
            return spacedHyphen.stringByReplacingMatches(in: ranged, range: NSRange(location: 0, length: (ranged as NSString).length), withTemplate: ", ")
        }
        var out = ""
        var last = 0
        for m in codeSpans.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            out += fix(ns.substring(with: NSRange(location: last, length: m.range.location - last)))
            out += ns.substring(with: m.range)
            last = m.range.location + m.range.length
        }
        return out + fix(ns.substring(from: last))
    }
    nonisolated(unsafe) private static let emoji = try! NSRegularExpression(pattern: "[\\x{1F300}-\\x{1FAFF}\\x{2600}-\\x{27BF}\\x{2705}\\x{274C}\\x{2611}\\x{2612}]")
    nonisolated(unsafe) private static let blankRuns = try! NSRegularExpression(pattern: "\\n{3,}")

    public struct Result: Equatable, Sendable { public var text: String; public var applied: [String] }

    /// Build extra patterns from active `rule` entities with `enforce` in (filter, both).
    public static func patterns(fromRules rules: [Entity]) -> [Pattern] {
        rules.compactMap { e in
            guard e.kind == .rule, !e.isDeleted, let r = e.decoded(RuleFields.self), r.active ?? true,
                  r.enforce != .prompt, let p = r.pattern, !p.isEmpty else { return nil }
            var opts: NSRegularExpression.Options = []
            let flags = r.flags ?? "g"
            if flags.contains("i") { opts.insert(.caseInsensitive) }
            if flags.contains("m") { opts.insert(.anchorsMatchLines) }
            if flags.contains("s") { opts.insert(.dotMatchesLineSeparators) }
            guard (try? NSRegularExpression(pattern: p, options: opts)) != nil else { return nil }
            return Pattern(name: r.text, pattern: p, options: opts, replacement: r.replacement ?? "")
        }
    }

    public static func apply(_ text: String, extra: [Pattern] = []) -> Result {
        var applied: [String] = []
        var out = text
        for p in defaultPatterns + extra {
            let before = out
            out = p.regex.stringByReplacingMatches(in: out, range: NSRange(location: 0, length: (out as NSString).length), withTemplate: NSRegularExpression.escapedTemplate(for: p.replacement))
            if out != before { applied.append(p.name) }
        }
        let offers = dropVagueOffers(out)
        if offers != out { applied.append("vague-offer"); out = offers }
        let hyphens = proseHyphens(out)
        if hyphens != out { applied.append("spaced-hyphen"); out = hyphens }
        // strip emoji inside code fences
        let ns = out as NSString
        var rebuilt = ""
        var last = 0
        var emojiStripped = false
        for m in codeFence.matches(in: out, range: NSRange(location: 0, length: ns.length)) {
            rebuilt += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let block = ns.substring(with: m.range)
            let cleaned = emoji.stringByReplacingMatches(in: block, range: NSRange(location: 0, length: (block as NSString).length), withTemplate: "")
            if cleaned != block { emojiStripped = true }
            rebuilt += cleaned
            last = m.range.location + m.range.length
        }
        rebuilt += ns.substring(from: last)
        if emojiStripped { applied.append("emoji-in-code") }
        out = blankRuns.stringByReplacingMatches(in: rebuilt, range: NSRange(location: 0, length: (rebuilt as NSString).length), withTemplate: "\n\n")
        out = out.trimmingCharacters(in: .whitespacesAndNewlines)
        var seen = Set<String>()
        return Result(text: out, applied: applied.filter { seen.insert($0).inserted })
    }

    /// Cheap version for labels: only the dash replacements (ranges first).
    public static func dashes(_ text: String) -> String {
        guard text.contains("\u{2014}") || text.contains("\u{2013}") else { return text }
        var out = text
        for p in defaultPatterns.prefix(2) {
            out = p.regex.stringByReplacingMatches(in: out, range: NSRange(location: 0, length: (out as NSString).length), withTemplate: p.replacement)
        }
        return out
    }
}
