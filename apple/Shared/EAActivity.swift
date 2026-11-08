#if canImport(ActivityKit) && os(iOS)
import ActivityKit
import Foundation

/// The Live Activity on the Lock Screen and in the Dynamic Island: a running activity (counting up from its start) or
/// the current focus block (counting down to its end). Shared by the app, which starts and ends it, and the widget
/// extension, which draws it.
struct EAActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var title: String
        var start: Date
        /// A block has an end; a running activity does not.
        var end: Date?
    }
    /// "activity" or "block".
    var kind: String
}
#endif
