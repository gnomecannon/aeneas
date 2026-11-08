#if os(iOS)
import Foundation
import UIKit
import os
import EACore

/// Hums recorded on the Watch arrive as WatchConnectivity file transfers, which `WatchLink` moves into
/// `WatchHumQueue.local`. This sends each to the hub as a capture (`POST /music/hum?from=capture`, which also writes
/// the diary line), follows it until the hub has heard it, and tells the Watch: listening, then the idea's title or
/// the reason it failed. A hum the hub cannot take right now stays queued and goes the next time the app is active.
@MainActor
final class WatchHumRelay {
    static let shared = WatchHumRelay()
    private static let log = Logger(subsystem: SharedConfig.logSubsystem, category: "watchhum")
    /// How long one run waits on the hub hearing a hum (about 1.2 s a second of audio, plus loading the model).
    private static let followFor: TimeInterval = 240
    private static let pollEvery: UInt64 = 3_000_000_000
    /// A hum the hub is still hearing after this is reported as not finished, so the Watch does not wait forever.
    private static let giveUpAfter: TimeInterval = 30 * 60

    private let queue = WatchHumQueue.local
    private var running = false
    private var again = false

    /// Starts a run without waiting for it; app start must not wait on the hub hearing a hum.
    func kick() { Task { await run() } }

    func run() async {
        // One run at a time. A hum that arrives during a run is picked up by one more pass.
        if running { again = true; return }
        running = true
        defer { running = false }
        repeat {
            again = false
            await runOnce()
        } while again
    }

    private func runOnce() async {
        queue.prune()
        guard !queue.pending().isEmpty else { return }
        await AppModel.shared.ensureStarted()
        let engine = AppModel.shared.engine

        // A hum often arrives while the app is in the background; ask for the time to send it.
        holdBackgroundTime()
        defer { releaseBackgroundTime() }

        let stopAt = Date().addingTimeInterval(Self.followFor)
        // Once one upload could not reach the hub, the rest wait for the next run instead of failing one by one.
        var hubDown = false
        while true {
            guard let client = engine.client else {
                for e in queue.pending() where e.ideaId == nil {
                    await tell(WatchHumResult.upload(error: HubError.notConfigured, humId: e.hum.id).result)
                }
                return
            }
            if !hubDown { hubDown = await sendNew(client, engine: engine) }
            let hearing = queue.pending().filter { $0.ideaId != nil }
            if hearing.isEmpty || Date() >= stopAt { return }
            try? await Task.sleep(nanoseconds: Self.pollEvery)
            await follow(hearing, client: client, engine: engine)
        }
    }

    /// Uploads the hums not sent yet, oldest first. True when the hub could not be reached.
    private func sendNew(_ client: HubClient, engine: SyncEngine) async -> Bool {
        for e in queue.pending() where e.ideaId == nil {
            let id = e.hum.id
            guard queue.hasAudio(id) else {
                queue.finish(id)
                await tell(WatchHumResult(id: id, state: .failed, error: "The recording was lost on your iPhone. Hum it again."))
                continue
            }
            do {
                let idea = try await client.uploadHum(fileURL: queue.audioURL(id), mode: e.hum.mode, fromCapture: true, clientId: id)
                await engine.absorb(idea)
                queue.markSent(id, ideaId: idea.id)
                let r = WatchHumResult.heard(idea, humId: id)
                if r.finished { queue.finish(id) }
                Self.log.notice("hum \(id, privacy: .public) sent as \(idea.id, privacy: .public)")
                await tell(r)
            } catch {
                let (r, keep) = WatchHumResult.upload(error: error, humId: id)
                Self.log.error("hum \(id, privacy: .public) not sent, keep=\(keep): \(r.error ?? "", privacy: .public)")
                if keep {
                    await tell(r)
                    return true
                }
                queue.finish(id)
                await tell(r)
            }
        }
        return false
    }

    /// Asks the hub where it is with each hum it is hearing; the Watch hears once it is done or failed.
    private func follow(_ hearing: [WatchHumQueue.Entry], client: HubClient, engine: SyncEngine) async {
        for e in hearing {
            guard let ideaId = e.ideaId else { continue }
            // Only a hub that answered and is still listening counts toward giving up: one out of reach (offline, or
            // restarting) says nothing about the hum, which is heard again when the hub comes back.
            guard let idea = try? await client.entity(ideaId) else { continue }
            let r = WatchHumResult.heard(idea, humId: e.hum.id)
            if r.finished {
                await engine.absorb(idea)
                queue.finish(e.hum.id)
                await tell(r)
                continue
            }
            if let sent = e.sentAt, Date().timeIntervalSince(sent) > Self.giveUpAfter {
                queue.finish(e.hum.id)
                await tell(WatchHumResult(id: e.hum.id, state: .failed, error: "The hub has not finished hearing it. Look in Music on your iPhone.", ideaId: ideaId))
            }
        }
    }

    private var backgroundTask = UIBackgroundTaskIdentifier.invalid

    private func holdBackgroundTime() {
        guard backgroundTask == .invalid else { return }
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Watch hum") { [weak self] in self?.releaseBackgroundTime() }
    }

    private func releaseBackgroundTime() {
        guard backgroundTask != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTask)
        backgroundTask = .invalid
    }

    private func tell(_ r: WatchHumResult) async {
        await WatchLink.shared.sendHumResult(r)
    }
}
#endif
