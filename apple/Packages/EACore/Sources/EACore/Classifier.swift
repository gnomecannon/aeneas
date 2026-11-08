import Foundation

/// Rule-based capture classifier: a port of `classifyCapture` in packages/shared.
/// Used offline to suggest a kind before the hub classifier is consulted.
public enum Classifier {
    public struct Result: Equatable, Sendable {
        public var kind: SuggestedKind
        public var fields: [String: JSONValue]
        public init(kind: SuggestedKind, fields: [String: JSONValue]) { self.kind = kind; self.fields = fields }
    }

    private static func re(_ p: String, _ o: NSRegularExpression.Options = [.caseInsensitive]) -> NSRegularExpression { try! NSRegularExpression(pattern: p, options: o) }
    nonisolated(unsafe) private static let remindStart = re("^(remind me|reminder:?)")
    nonisolated(unsafe) private static let remindAny = re("\\b(remind me|don't let me forget)\\b")
    nonisolated(unsafe) private static let remindStrip = re("^(remind me( to)?|reminder:?)\\s*")
    nonisolated(unsafe) private static let todo = re("^(todo|task|to do):?\\s*")
    nonisolated(unsafe) private static let note = re("^(note|idea):?\\s*")
    nonisolated(unsafe) private static let fact = re("^(fact|remember( that)?):?\\s*")
    nonisolated(unsafe) private static let verb = re("^(call|email|buy|fix|order|check|send|pay|book|schedule|cancel|renew|install|update|clean|write|finish|start)\\b")
    nonisolated(unsafe) private static let nonWord = re("\\W+", [])

    // Records, a port of `parseRecord` in packages/shared.
    nonisolated(unsafe) private static let lead = re("^(?:today|tonight|this (?:morning|evening|afternoon)|just now|just|so|ok(?:ay)?|update)[,:]?\\s+")
    nonisolated(unsafe) private static let tail = re("[,]?\\s+(?:today|tonight|this (?:morning|evening|afternoon)|now|right now|at the (?:doctor|gym))$")
    nonisolated(unsafe) private static let weightSaid = re("^(?:i\\s+)?(?:weigh(?:ed)?(?:\\s+in)?(?:\\s+at)?|(?:my\\s+|current\\s+)?weight(?:\\s+(?:is|was|of))?:?|(?:the\\s+)?scale\\s+(?:says|said|reads|read))\\s+(\\d{1,3}(?:[.,]\\d+)?)(?:\\s*(lbs?|pounds?|kgs?|kilos?|kilograms?))?$")
    nonisolated(unsafe) private static let weightBare = re("^(\\d{1,3}(?:[.,]\\d+)?)\\s*(lbs?|pounds?|kgs?|kilos?|kilograms?)$")
    nonisolated(unsafe) private static let bpSaid = re("^(?:my\\s+)?(?:bp|blood pressure)(?:\\s+(?:is|was|of))?:?\\s*(\\d{2,3})\\s*(?:/|over|\\s)\\s*(\\d{2,3})$")
    nonisolated(unsafe) private static let bp = re("\\bbp\\s*(\\d{2,3})\\s*[/ ]\\s*(\\d{2,3})\\b")
    nonisolated(unsafe) private static let sleep = re("^(?:i\\s+)?slept\\s+(?:for\\s+)?(\\d{1,2}(?:\\.\\d+)?)(\\s+and\\s+a\\s+half)?\\s*(?:h|hrs?|hours?)(?:\\s+(?:and\\s+)?(\\d{1,2})\\s*(?:m|mins?|minutes?))?(?:\\s+(?:last night|tonight))?$")
    nonisolated(unsafe) private static let steps = re("^(?:i\\s+)?(?:walked\\s+|did\\s+|got\\s+)?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k)?\\s+steps$")
    nonisolated(unsafe) private static let mood = re("^(?:my\\s+)?(?:mood|feeling)(?:\\s+(?:is|was))?:?\\s*(-?\\d{1,2})(?:\\s*/\\s*\\d+|\\s+out of\\s+\\d+)?$")
    nonisolated(unsafe) private static let med = re("^(?:i\\s+)?(?:took|taken|have taken)\\s+(?:my\\s+)?(.+)$")

    /// A measurement said in plain words ("today I weigh 116.4", "slept 7 hours", "bp 120 over 80"), as log fields.
    /// Nil when the whole text is not one record.
    public static func record(_ text: String, now: String = ISO.now()) -> [String: JSONValue]? {
        var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while let last = t.last, last == "." || last == "!" { t.removeLast() }
        for _ in 0..<3 { t = strip(tail, strip(lead, t)) }
        if let m = match(weightSaid, t) ?? match(weightBare, t).map({ ["", $0[1], $0[2]] }), let v = Double(m[1].replacingOccurrences(of: ",", with: ".")) {
            let kg = m[2].lowercased().hasPrefix("k")
            if v >= (kg ? 20 : 50), v <= (kg ? 350 : 800) {
                return ["type": "weight", "value": .number(v), "unit": .string(kg ? "kg" : "lb"), "at": .string(now)]
            }
        }
        if let m = match(bpSaid, t) ?? match(bp, t) { return ["type": "bp", "value": .string("\(m[1])/\(m[2])"), "at": .string(now)] }
        if let m = match(sleep, t), let h = Double(m[1]) {
            let minutes = (h * 60 + (m[2].isEmpty ? 0 : 30) + (Double(m[3]) ?? 0)).rounded()
            if minutes > 0, minutes <= 1200 { return ["type": "sleep", "value": .number(minutes), "unit": "min", "at": .string(now)] }
        }
        if let m = match(steps, t), let n = Double(m[1].replacingOccurrences(of: ",", with: "")) {
            let v = (n * (m[2].isEmpty ? 1 : 1000)).rounded()
            if v > 0, v < 200_000 { return ["type": "steps", "value": .number(v), "at": .string(now)] }
        }
        if let m = match(mood, t), let v = Int(m[1]) { return ["type": "mood", "value": .number(Double(v)), "at": .string(now)] }
        if let m = match(med, t) { return ["type": "med", "value": .string(m[1].trimmingCharacters(in: .whitespaces)), "at": .string(now)] }
        return nil
    }

    private static func match(_ r: NSRegularExpression, _ s: String) -> [String]? {
        let ns = s as NSString
        guard let m = r.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { m.range(at: $0).location == NSNotFound ? "" : ns.substring(with: m.range(at: $0)) }
    }

    private static func strip(_ r: NSRegularExpression, _ s: String) -> String {
        r.stringByReplacingMatches(in: s, range: NSRange(location: 0, length: (s as NSString).length), withTemplate: "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func classify(_ text: String, now: String = ISO.now()) -> Result {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = t.lowercased()
        if let r = record(t, now: now) { return Result(kind: .log, fields: r) }
        if match(remindStart, t) != nil || match(remindAny, lower) != nil {
            return Result(kind: .reminder, fields: ["title": .string(strip(remindStrip, t)), "friction": "none"])
        }
        if match(todo, t) != nil {
            return Result(kind: .task, fields: ["title": .string(strip(todo, t)), "status": "inbox"])
        }
        if match(note, t) != nil {
            let body = strip(note, t)
            let first = body.split(separator: "\n", omittingEmptySubsequences: false).first.map(String.init) ?? body
            return Result(kind: .note, fields: ["title": .string(String(first.prefix(80))), "body": .string(body)])
        }
        if match(fact, t) != nil {
            let key = nonWord.stringByReplacingMatches(in: String(lower.prefix(40)), range: NSRange(location: 0, length: (String(lower.prefix(40)) as NSString).length), withTemplate: "_")
            return Result(kind: .fact, fields: ["category": "preference", "key": .string(key), "value": .string(strip(fact, t))])
        }
        if t.count < 80, !t.contains("\n"), match(verb, t) != nil {
            return Result(kind: .task, fields: ["title": .string(t), "status": "inbox"])
        }
        return Result(kind: .none, fields: [:])
    }
}
