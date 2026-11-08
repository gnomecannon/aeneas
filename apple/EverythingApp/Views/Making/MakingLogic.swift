import Foundation
import EACore

/// Pure helpers for the Making screens, ported from web/src/lib/creative.ts so the offline paths behave like the hub.
enum Making {

    // MARK: regex

    /// Capture groups of the first match (index 0 is the whole match), or nil.
    static func match(_ pattern: String, _ s: String, options: NSRegularExpression.Options = []) -> [String]? {
        guard let re = try? NSRegularExpression(pattern: pattern, options: options) else { return nil }
        let ns = s as NSString
        guard let m = re.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            let r = m.range(at: i)
            return r.location == NSNotFound ? "" : ns.substring(with: r)
        }
    }

    static func test(_ pattern: String, _ s: String, options: NSRegularExpression.Options = []) -> Bool { match(pattern, s, options: options) != nil }

    static func replaceFirst(_ pattern: String, in s: String, with t: String) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern),
              let m = re.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) else { return s }
        return (s as NSString).replacingCharacters(in: m.range, with: t)
    }

    static func num(_ d: Double) -> String { JSONValue.number(d).displayString }

    static func plural(_ n: Int, _ one: String, _ many: String? = nil) -> String { n == 1 ? "1 \(one)" : "\(n) \(many ?? one + "s")" }

    // MARK: projects and parts

    struct Part: Codable, Hashable {
        var name: String
        var qty: Double?
        var have: Double?
        var inventory_id: String?
    }

    struct ProjectData: Decodable {
        var name: String?
        var status: String?
        var definition_of_done: String?
        var resume_card: String?
        var plan_doc_path: String?
        var repo: String?
        var parts: [Part]?
        /// `music` puts the project in the Music section with its songs and ideas.
        var area: String?
    }

    static func project(_ e: Entity) -> ProjectData { e.decoded(ProjectData.self) ?? ProjectData() }

    static func parts(of e: Entity) -> [Part] { project(e).parts ?? [] }

    /// have and missing per part. The hub only refreshes `have` when the project is written, so a live
    /// inventory match by name (the hub's own rule, matchParts in hub/src/projects.ts) wins over the stored value.
    /// Every inventory row with the part's name counts, as on the hub; only the first one counted here, so two bins of
    /// one part showed parts missing and made shopping tasks for what was on hand.
    static func partRows(_ parts: [Part], inventory: [Entity]) -> [ProjectPartRow] {
        func norm(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
        return parts.map { p in
            let qty = p.qty ?? 1
            var have = p.have
            var invId = p.inventory_id
            let hits = inventory.filter { norm($0.str("name")) == norm(p.name) }
            if let first = hits.first {
                have = hits.reduce(0) { $0 + ($1.number("qty") ?? 1) }
                invId = first.id
            }
            let h = max(0, have ?? 0)
            return ProjectPartRow(name: p.name, qty: qty, have: h, missing: max(0, qty - h), inventory_id: invId)
        }
    }

    static func missingPartTasks(_ rows: [ProjectPartRow]) -> [String] {
        rows.filter { $0.missing > 0 }.map { $0.missing > 1 ? "Get \(num($0.missing)) x \($0.name)" : "Get \($0.name)" }
    }

    /// One part per line: "2 x 10k resistor", "10k resistor x2" or "10k resistor".
    static func parsePartsText(_ text: String) -> [Part] {
        var out: [Part] = []
        for raw in text.components(separatedBy: "\n") {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            if let m = match(#"^(\d+)\s*[x×]\s+(.+)$"#, line, options: .caseInsensitive) {
                out.append(Part(name: m[2].trimmingCharacters(in: .whitespaces), qty: Double(m[1])))
            } else if let m = match(#"^(.+?)\s*[x×]\s*(\d+)$"#, line, options: .caseInsensitive) {
                out.append(Part(name: m[1].trimmingCharacters(in: .whitespaces), qty: Double(m[2])))
            } else {
                out.append(Part(name: line, qty: 1))
            }
        }
        return out
    }

    static func partsToText(_ parts: [Part]) -> String {
        parts.map { p in
            let q = p.qty ?? 1
            return q != 1 ? "\(num(q)) x \(p.name)" : p.name
        }.joined(separator: "\n")
    }

    // MARK: procedures

    struct Step: Codable, Hashable {
        var text: String
        var command: String?
        var host: String?
        var user: String?
        var done_at: String?
    }

    struct ProcedureData: Decodable {
        var title: String?
        var steps: [Step]?
        var current: Double?
        var started_at: String?
        var done_at: String?
        var project_id: String?
    }

    static func procedure(_ e: Entity) -> ProcedureData { e.decoded(ProcedureData.self) ?? ProcedureData() }

    struct Progress { var current: Int; var total: Int; var done: Bool }

    static func progress(_ f: ProcedureData) -> Progress {
        let total = f.steps?.count ?? 0
        let cur = Int(f.current ?? 0)
        let done = !(f.done_at ?? "").isEmpty || cur >= total
        return Progress(current: min(cur, max(0, total - 1)), total: total, done: done)
    }

    /// Numbered or bulleted lines start a step; a fenced block or an indented line under a step becomes its command;
    /// a single `inline command` on the step line is its command too. Plain prose becomes one step per line.
    static func stepsFromText(_ text: String, host: String? = nil) -> [Step] {
        let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var steps: [Step] = []
        var fence: [String]? = nil
        func attach(_ cmd: String) {
            guard !steps.isEmpty else { return }
            let i = steps.count - 1
            steps[i].command = steps[i].command.map { "\($0)\n\(cmd)" } ?? cmd
        }
        for raw in lines {
            if test(#"^\s*```"#, raw) {
                if let f = fence { attach(f.joined(separator: "\n")); fence = nil } else { fence = [] }
                continue
            }
            if fence != nil { fence!.append(raw); continue }
            let line = raw.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression)
            if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            if let m = match(#"^\s*(?:\d+[.)]|[-*•])\s+(.*)$"#, line) {
                steps.append(stepFromLine(m[1], host: host))
                continue
            }
            if test(#"^(\s{2,}|\t)"#, raw), !steps.isEmpty {
                attach(line.trimmingCharacters(in: .whitespaces))
                continue
            }
            if test(#"^#{1,6}\s"#, line) { continue }
            steps.append(stepFromLine(line.trimmingCharacters(in: .whitespaces), host: host))
        }
        if let f = fence { attach(f.joined(separator: "\n")) }
        return steps
    }

    private static func stepFromLine(_ text: String, host: String?) -> Step {
        var s = Step(text: text.trimmingCharacters(in: .whitespaces))
        if let m = match("`([^`]+)`", text) {
            s.command = m[1]
            var t = replaceFirst("`[^`]+`", in: text, with: "")
            t = t.replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression)
            t = t.replacingOccurrences(of: #"[:,]\s*$"#, with: "", options: .regularExpression).trimmingCharacters(in: .whitespaces)
            s.text = t.isEmpty ? m[1] : t
        }
        let on = match(#"\bon\s+([a-z0-9][a-z0-9.-]*)\b"#, s.text, options: .caseInsensitive)?[1]
        if let h = host ?? on, !h.isEmpty { s.host = h }
        if let u = match(#"\b(?:as|user)\s+([a-z_][a-z0-9_-]*)\b"#, s.text, options: .caseInsensitive)?[1] { s.user = u }
        return s
    }

    /// The same transitions as `POST /procedures/:id/advance` and `/reset`, for when the hub is out of reach.
    static func advanceFields(_ f: ProcedureData, action: ProcedureAction, at: String = ISO.now()) -> [String: JSONValue] {
        var steps = f.steps ?? []
        let cur = Int(f.current ?? 0)
        switch action {
        case .reset:
            for i in steps.indices { steps[i].done_at = nil }
            return ["steps": (try? JSONCoding.value(steps)) ?? .array([]), "current": 0, "done_at": .null, "started_at": .null]
        case .back:
            return ["current": .number(Double(max(0, min(cur, steps.count) - 1)))]
        case .done:
            guard cur < steps.count else { return [:] }
            steps[cur].done_at = at
            let next = cur + 1
            var out: [String: JSONValue] = ["steps": (try? JSONCoding.value(steps)) ?? .array([]), "current": .number(Double(next))]
            if (f.started_at ?? "").isEmpty { out["started_at"] = .string(at) }
            if next >= steps.count { out["done_at"] = .string(at) }
            return out
        }
    }

    enum ProcedureAction { case done, back, reset }

    // MARK: music

    /// What the Music section holds. Reference sheets, templates and settings are notes in Music/Reference (the hub moves any it finds).
    static let musicTypes = ["riff", "progression", "lyric", "song"]
    static let musicStatuses = ["idea", "wip", "done"]

    struct MusicQuick {
        var title: String
        var type: String
        var body: String
        var key: String?
        var bpm: Double?
        var time_sig: String?
        var tuning: String?
    }

    private static let chord = #"^[A-G](?:#|b)?(?:m|maj|min|dim|aug|sus[24]?|add\d+|M|\+|°)?(?:\d+)?(?:/[A-G](?:#|b)?)?$"#
    private static let note = #"^[A-G](?:#|b)?$"#

    /// One line such as "Am F C G 6/8 112bpm drop D": chords, time signature, bpm and tuning recognized, the rest is the title.
    static func parseMusicQuick(_ text: String) -> MusicQuick {
        let tokens = text.trimmingCharacters(in: .whitespacesAndNewlines).split(whereSeparator: { $0.isWhitespace }).map(String.init)
        var chords: [String] = [], words: [String] = []
        var bpm: Double?, time: String?, tuning: String?, key: String?, type: String?
        var i = 0
        let typeWords = "riff|progression|lyric|song"
        while i < tokens.count {
            let t = tokens[i]
            let lower = t.lowercased()
            let nextTok = i + 1 < tokens.count ? tokens[i + 1] : nil
            defer { i += 1 }
            if let m = match(#"^(\d{2,3})bpm$"#, t, options: .caseInsensitive) { bpm = Double(m[1]); continue }
            if test(#"^\d{2,3}$"#, t), nextTok?.lowercased() == "bpm" { bpm = Double(t); i += 1; continue }
            if test(#"^\d{1,2}/\d{1,2}$"#, t) { time = t; continue }
            if lower == "drop" || lower == "open", let n = nextTok, test(note, n, options: .caseInsensitive) {
                tuning = "\(lower) \(n.prefix(1).uppercased())\(n.dropFirst())"
                i += 1
                continue
            }
            if lower == "standard" || lower == "dadgad" || (test("^[a-g#]{6,7}$", t, options: .caseInsensitive) && test("^[A-G]", t) && t.uppercased() == t) {
                tuning = lower == "dadgad" ? "DADGAD" : lower == "standard" ? "standard" : t
                continue
            }
            if lower == "half", nextTok?.lowercased() == "step", i + 2 < tokens.count, tokens[i + 2].lowercased() == "down" {
                tuning = "half step down"
                i += 2
                continue
            }
            if lower == "key" || lower == "in", let n = nextTok, test(chord, n) { key = n; i += 1; continue }
            // An explicit type only as "lyric:" or as the first word, so "garden song" stays a title.
            if test("^(\(typeWords)):$", lower) || (i == 0 && test("^(\(typeWords))$", lower)) {
                type = lower.replacingOccurrences(of: ":", with: "")
                continue
            }
            if test(chord, t) { chords.append(t); continue }
            words.append(t)
        }
        if key == nil, let c = chords.first { key = c }
        let body = chords.joined(separator: " ")
        let w = words.joined(separator: " ").trimmingCharacters(in: .whitespaces)
        let title = !w.isEmpty ? w : (!body.isEmpty ? body : "Untitled")
        return MusicQuick(title: title, type: type ?? (chords.count >= 2 ? "progression" : "riff"), body: body, key: key, bpm: bpm, time_sig: time, tuning: tuning)
    }

    static func musicMeta(key: String?, bpm: Double?, time: String?, tuning: String?) -> [String] {
        var out: [String] = []
        if let k = key, !k.isEmpty { out.append(k) }
        if let b = bpm, b > 0 { out.append("\(num(b)) bpm") }
        if let t = time, !t.isEmpty { out.append(t) }
        if let t = tuning, !t.isEmpty { out.append(t) }
        return out
    }

    static func musicMeta(_ e: Entity) -> [String] {
        musicMeta(key: e.string("key"), bpm: e.number("bpm"), time: e.string("time_sig"), tuning: e.string("tuning"))
    }

    // MARK: quiz

    struct QuizItem: Codable, Hashable {
        var q: String
        var a: String
        var hint: String?
        var topic: String?
        var asked_at: String?
        var result: QuizResult?
    }

    struct QuizData: Decodable {
        var date: String?
        var items: [QuizItem]?
        var completed_at: String?
    }

    static func quiz(_ e: Entity) -> QuizData { e.decoded(QuizData.self) ?? QuizData() }

    enum QuizPhase { case ask, hint, done }
    enum QuizAction { case know, unsure, reveal, wrong }

    struct QuizState: Equatable {
        var index: Int
        var phase: QuizPhase
        var results: [QuizResult?]
    }

    private static func firstOpen(_ results: [QuizResult?], from: Int = 0) -> Int? {
        if from < results.count { for i in from..<results.count where results[i] == nil { return i } }
        for i in 0..<min(from, results.count) where results[i] == nil { return i }
        return nil
    }

    /// Starts at the first unanswered item; done straight away when every item has a result.
    static func initialQuiz(_ items: [QuizItem]) -> QuizState {
        let results = items.map(\.result)
        if let i = firstOpen(results) { return QuizState(index: i, phase: .ask, results: results) }
        return QuizState(index: max(0, items.count - 1), phase: .done, results: results)
    }

    /// "know" marks right; "unsure" shows the hint once, then know, reveal or wrong settle it.
    static func quizStep(_ state: QuizState, _ action: QuizAction) -> (state: QuizState, record: (index: Int, result: QuizResult)?) {
        if state.phase == .done { return (state, nil) }
        if action == .unsure {
            var s = state
            if s.phase == .ask { s.phase = .hint }
            return (s, nil)
        }
        if action == .reveal && state.phase != .hint { return (state, nil) }
        let result: QuizResult = action == .know ? .right : action == .reveal ? .revealed : .wrong
        var results = state.results
        results[state.index] = result
        let out: QuizState
        if let n = firstOpen(results, from: state.index + 1) { out = QuizState(index: n, phase: .ask, results: results) }
        else { out = QuizState(index: state.index, phase: .done, results: results) }
        return (out, (state.index, result))
    }

    struct QuizCounts { var right = 0, wrong = 0, revealed = 0, answered = 0, total = 0 }

    static func quizCounts(_ results: [QuizResult?]) -> QuizCounts {
        var c = QuizCounts(total: results.count)
        for r in results {
            guard let r else { continue }
            c.answered += 1
            switch r {
            case .right: c.right += 1
            case .wrong: c.wrong += 1
            case .revealed: c.revealed += 1
            }
        }
        return c
    }

    // MARK: dates

    static func relative(_ iso: String?) -> String? {
        guard let d = ISO.date(iso) else { return nil }
        if abs(d.timeIntervalSinceNow) < 60 { return "just now" }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        return f.localizedString(for: d, relativeTo: Date())
    }

    static func localDay(_ d: Date = Date()) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: d)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// Whether the error means the hub was out of reach (fall back to a local edit) rather than a refusal.
    static func unreachable(_ error: Error) -> Bool {
        if let h = error as? HubError { return h.isUnreachable }
        return true
    }

    static func message(_ error: Error) -> String {
        if let h = error as? HubError {
            switch h {
            case .http(_, let m): return StyleGuard.dashes(m.isEmpty ? "The hub refused that." : m)
            default: return StyleGuard.dashes(h.errorDescription ?? "Something went wrong.")
            }
        }
        return StyleGuard.dashes(error.localizedDescription)
    }
}
