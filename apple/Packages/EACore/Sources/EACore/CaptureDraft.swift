import Foundation

/// The capture box after a save returns. The box used to be emptied whatever it held by then, so words typed
/// while the capture was saving were lost.
public enum CaptureDraft {
    /// What stays in the box when `sent` was saved and the box now holds `now`: nothing when it is unchanged, the
    /// words added after it while it saved, or all of it when it was changed some other way (nothing is lost).
    /// `unchanged` is true when the box still holds exactly what was sent.
    public static func remainder(after sent: String, now: String) -> (text: String, unchanged: Bool) {
        if now == sent { return ("", true) }
        if !sent.isEmpty, now.hasPrefix(sent) {
            return (String(now.dropFirst(sent.count).drop(while: { $0.isWhitespace })), false)
        }
        return (now, false)
    }
}

