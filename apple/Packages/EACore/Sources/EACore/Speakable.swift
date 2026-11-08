import Foundation

/// A reply as it should sound when read aloud: markdown marks, link targets and bare URLs dropped, code blocks
/// named rather than spelled out. Inline code keeps its words. Same rules as the web client's `speakableText`.
public enum Speakable {
    private static let rules: [(String, String, NSRegularExpression.Options)] = [
        ("```[\\s\\S]*?(```|$)", " (code block) ", []),
        ("!\\[([^\\]]*)\\]\\([^)]*\\)", "$1", []),
        ("\\[([^\\]]+)\\]\\([^)]*\\)", "$1", []),
        ("https?://\\S+", "a link", []),
        ("`([^`]*)`", "$1", []),
        ("^\\s{0,3}#{1,6}\\s+", "", .anchorsMatchLines),
        ("^\\s{0,3}>\\s?", "", .anchorsMatchLines),
        ("^\\s*(?:[-*+]|\\d+[.)])\\s+", "", .anchorsMatchLines),
        ("(\\*\\*|__)(.+?)\\1", "$2", []),
        ("(^|[^\\w*])[*_]([^*_\\n]+)[*_](?=[^\\w*]|$)", "$1$2", .anchorsMatchLines),
        ("^\\s*(?:-{3,}|\\|.*\\|)\\s*$", "", .anchorsMatchLines),
        ("[ \\t]+", " ", []),
        ("\\n{2,}", "\n", []),
    ]
    private static let compiled: [(NSRegularExpression, String)] = rules.compactMap { p, t, o in
        (try? NSRegularExpression(pattern: p, options: o)).map { ($0, t) }
    }

    public static func text(_ markdown: String) -> String {
        var s = markdown
        for (re, template) in compiled {
            s = re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: template)
        }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
