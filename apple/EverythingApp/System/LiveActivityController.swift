#if canImport(ActivityKit) && os(iOS)
import ActivityKit
import Foundation
import EACore

/// Keeps one Live Activity in step with the app: a running activity (counting up), else the Now task's focus block
/// while it is on (counting down), else none. Runs after each change, so an activity started on the Mac or the Watch
/// shows here too.
@MainActor
final class LiveActivityController {
    static let shared = LiveActivityController()

    private struct Want: Equatable {
        var kind: String
        var state: EAActivityAttributes.ContentState
    }

    private var recheck: Task<Void, Never>?

    func update(_ engine: SyncEngine) async {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let want = desired(engine)
        // A block ends on the clock, not on a change: look again when it does.
        recheck?.cancel()
        if let end = want?.state.end {
            recheck = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(max(1, end.timeIntervalSinceNow + 1) * 1_000_000_000))
                if !Task.isCancelled { await self?.update(engine) }
            }
        }
        let current = Activity<EAActivityAttributes>.activities
        guard let want else {
            for a in current { await a.end(nil, dismissalPolicy: .immediate) }
            return
        }
        // The same kind of thing: update in place when it changed. A different kind: end it and start fresh.
        if let a = current.first, a.attributes.kind == want.kind {
            if a.content.state != want.state { await a.update(ActivityContent(state: want.state, staleDate: want.state.end)) }
            for extra in current.dropFirst() { await extra.end(nil, dismissalPolicy: .immediate) }
            return
        }
        for a in current { await a.end(nil, dismissalPolicy: .immediate) }
        _ = try? Activity.request(attributes: EAActivityAttributes(kind: want.kind), content: ActivityContent(state: want.state, staleDate: want.state.end))
    }

    private func desired(_ engine: SyncEngine) -> Want? {
        if let a = engine.currentActivity {
            return Want(kind: "activity", state: .init(title: a.name, start: a.start, end: nil))
        }
        let now = Date()
        if let t = engine.nowTask, let b = t.decoded(TaskFields.self)?.block, let s = ISO.date(b.start), let e = ISO.date(b.end), s <= now, e > now {
            return Want(kind: "block", state: .init(title: t.str("title"), start: s, end: e))
        }
        return nil
    }
}
#endif
