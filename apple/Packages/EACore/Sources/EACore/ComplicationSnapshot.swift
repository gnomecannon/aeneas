import Foundation

/// What the Watch complications show (the Next line, the running activity, Next up), as the iPhone has it. The iPhone
/// sends it to the Watch over WatchConnectivity whenever it changes (`SyncEngine.onComplicationSnapshot`), so the
/// complications are current without waiting for the Watch app's own sync.
///
/// Since 2026-11-25 `nowTitle` is the task you started, never the first task in Next, and the Next line's plan travels
/// in a field of its own (`line`): a Watch app from before then reads `now` as it always did and shows that title on
/// its Now complication, or "Nothing is next", and passes over `line`.
public struct ComplicationSnapshot: Equatable, Sendable {
    /// The task you started.
    public var nowTitle: String?
    public var activity: String?
    public var activityStart: Date?
    public var nextUpTitle: String?
    public var nextUpAt: Date?
    /// The Next line's plan for today (NextLine.swift).
    public var line: NextLinePlan?

    public init(nowTitle: String?, activity: String?, activityStart: Date?, nextUpTitle: String?, nextUpAt: Date?, line: NextLinePlan? = nil) {
        self.nowTitle = nowTitle
        self.activity = activity
        self.activityStart = activityStart
        self.nextUpTitle = nextUpTitle
        self.nextUpAt = nextUpAt
        self.line = line
    }

    /// From the snapshot this device keeps for its own widgets.
    public init(config: SharedConfig) {
        self.init(nowTitle: config.nowTaskTitle, activity: config.currentActivity, activityStart: config.currentActivityStart,
                  nextUpTitle: config.nextUpTitle, nextUpAt: config.nextUpAt, line: config.nextLinePlan)
    }

    static let kind = "complications"

    /// As a WatchConnectivity user info dictionary: property list values only.
    public var message: [String: Any] {
        var m: [String: Any] = ["kind": Self.kind]
        if let nowTitle { m["now"] = nowTitle }
        if let activity { m["activity"] = activity }
        if let activityStart { m["activityStart"] = activityStart.timeIntervalSince1970 }
        if let nextUpTitle { m["nextUp"] = nextUpTitle }
        if let nextUpAt { m["nextUpAt"] = nextUpAt.timeIntervalSince1970 }
        if let data = line?.data { m["line"] = data }
        return m
    }

    /// Nil for any other message (a hum's result).
    public init?(message m: [String: Any]) {
        guard m["kind"] as? String == Self.kind else { return nil }
        self.init(nowTitle: m["now"] as? String, activity: m["activity"] as? String,
                  activityStart: (m["activityStart"] as? Double).map(Date.init(timeIntervalSince1970:)),
                  nextUpTitle: m["nextUp"] as? String, nextUpAt: (m["nextUpAt"] as? Double).map(Date.init(timeIntervalSince1970:)),
                  line: (m["line"] as? Data).flatMap(NextLinePlan.init(data:)))
    }

    /// The Watch keeps it where its complications read it.
    public func apply(to config: SharedConfig) {
        config.nowTaskTitle = nowTitle
        config.currentActivity = activity
        config.currentActivityStart = activityStart
        config.nextUpTitle = nextUpTitle
        config.nextUpAt = nextUpAt
        config.nextLinePlan = line
    }
}
