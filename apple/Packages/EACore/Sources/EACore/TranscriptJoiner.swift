import Foundation

/// Joins what the speech recognizer reports while the owner talks. After a pause it may start a fresh utterance in the
/// same recognition task without marking the last one final: its text is then only the new words ("It needs to be a
/// really cool one." after "So I'm going to create a flag, um,"). The earlier words are kept, not overwritten.
public struct TranscriptJoiner: Sendable {
    /// Text from utterances that are over.
    public private(set) var committed = ""
    /// The utterance being heard now, as last reported.
    private var current = ""

    public init() {}

    /// Everything said so far.
    public var text: String { Self.join(committed, current) }

    /// A new report for the utterance being heard. Returns the whole transcript.
    @discardableResult
    public mutating func update(_ next: String) -> String {
        if Self.isNewUtterance(previous: current, next: next) { committed = Self.join(committed, current) }
        current = next
        return text
    }

    /// The recognition run ended (final result, or a restart): what was heard is kept, and the next run starts fresh.
    public mutating func endRun() {
        committed = text
        current = ""
    }

    /// A report that starts over instead of revising: its first word differs and it is clearly shorter. Revisions keep
    /// the start ("so I'm" becomes "So I'm going") or change a word without losing most of the text.
    public static func isNewUtterance(previous: String, next: String) -> Bool {
        let old = words(previous), new = words(next)
        guard !old.isEmpty, !new.isEmpty else { return false }
        return old[0] != new[0] && new.count <= old.count - 2
    }

    static func words(_ s: String) -> [String] {
        s.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }
    }

    static func join(_ a: String, _ b: String) -> String {
        let x = a.trimmingCharacters(in: .whitespaces), y = b.trimmingCharacters(in: .whitespaces)
        return x.isEmpty ? y : y.isEmpty ? x : "\(x) \(y)"
    }
}
