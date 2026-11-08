import SwiftUI
import Combine
import EACore

/// One hum on its way from the wrist, as the Watch last heard of it.
struct WatchHumStatus: Codable, Identifiable, Equatable {
    var id: String
    var mode: HumMidi.Mode
    var seconds: Double
    var at: Date
    /// 0 sent or waiting for the iPhone, 1 the iPhone has it, then `WatchHumResult.State.rank`.
    var step: Int
    var line: String
    var failed = false

    var finished: Bool { step >= WatchHumResult.State.done.rank }
}

/// Hum from the wrist, started from the voice page. Records with the iPhone app's `HumRecorder` (a minute at most),
/// hands the WAV to WatchConnectivity through `WatchLink`, which delivers it when the iPhone is in reach, and keeps
/// the last few hums' progress, from "Sent to your iPhone" to the idea's title. Lives on the app model, so leaving
/// the page while recording still sends the take.
@MainActor
final class WatchHumModel: ObservableObject {
    let recorder = HumRecorder(limit: WatchHum.maxSeconds)
    @Published var mode: HumMidi.Mode = .melody
    @Published private(set) var recent: [WatchHumStatus]
    @Published var problem: String?
    private var subs: Set<AnyCancellable> = []

    private static let key = "watch.hums"
    private static let keep = 5

    init() {
        recent = (UserDefaults.standard.data(forKey: Self.key)).flatMap { try? JSONDecoder().decode([WatchHumStatus].self, from: $0) } ?? []
        // The screen watches this model, so the recorder's clock and meter show through it.
        recorder.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &subs)
        // On the next turn of the main loop, so clearing `finished` does not happen inside its own change.
        recorder.$finished.compactMap { $0 }.receive(on: DispatchQueue.main)
            .sink { [weak self] take in self?.send(take) }.store(in: &subs)
    }

    func record() async {
        problem = nil
        await recorder.start()
    }

    func stop() { recorder.stop() }
    func discard() { recorder.cancel() }

    private func send(_ take: HumTake) {
        recorder.finished = nil
        let hum = WatchHum(mode: mode, seconds: take.seconds)
        let reachable = WatchLink.shared.isReachable
        do {
            try WatchLink.shared.queueHum(hum, file: take.url)
        } catch {
            try? FileManager.default.removeItem(at: take.url)
            problem = "Could not keep the recording: \(error.localizedDescription)"
            WKHaptic.failure()
            return
        }
        recent.insert(WatchHumStatus(id: hum.id, mode: hum.mode, seconds: hum.seconds, at: hum.recordedAt, step: 0,
                                     line: reachable ? "Sent to your iPhone" : "Waiting for your iPhone"), at: 0)
        save()
    }

    /// WatchConnectivity finished the transfer.
    func delivered(_ id: String) { advance(id, step: 1, line: "Your iPhone has it") }

    /// What the iPhone said; a short tap on the wrist once the hub has heard it.
    func apply(_ r: WatchHumResult) {
        guard advance(r.id, step: r.state.rank, line: r.line, failed: r.state == .failed) else { return }
        if r.state == .done { WKHaptic.success() } else if r.state == .failed { WKHaptic.failure() }
    }

    /// Steps only go forward: a queued message can arrive after a direct one, and the same outcome can arrive twice.
    @discardableResult
    private func advance(_ id: String, step: Int, line: String, failed: Bool = false) -> Bool {
        guard let i = recent.firstIndex(where: { $0.id == id }) else { return false }
        let cur = recent[i]
        guard step > cur.step || (step == cur.step && !cur.finished) else { return false }
        recent[i].step = step
        recent[i].line = line
        recent[i].failed = failed
        save()
        return true
    }

    private func save() {
        if recent.count > Self.keep { recent.removeLast(recent.count - Self.keep) }
        if let d = try? JSONEncoder().encode(recent) { UserDefaults.standard.set(d, forKey: Self.key) }
    }
}

/// A hum being recorded: the clock, a level meter that shows the microphone hears something, Stop and Discard.
/// Stop sends the take to the iPhone, which sends it to the hub; the result comes back to the voice page.
struct WatchHumRecordingPanel: View {
    @ObservedObject var hum: WatchHumModel

    var body: some View {
        VStack(spacing: 8) {
            HStack(spacing: 4) {
                Circle().fill(.red).frame(width: 7, height: 7)
                Text(hum.mode == .melody ? "Hum a tune" : "Tap or beatbox a rhythm").font(.caption2).foregroundStyle(.secondary)
            }
            Text("\(Self.clock(hum.recorder.elapsed)) of \(Self.clock(WatchHum.maxSeconds))")
                .font(.title3.monospacedDigit())
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.25))
                    Capsule().fill(Color.green).frame(width: max(0, g.size.width * CGFloat(hum.recorder.level)))
                }
            }
            .frame(height: 6)
            .accessibilityHidden(true)
            Button { hum.stop() } label: {
                Label("Stop", systemImage: "stop.fill").frame(maxWidth: .infinity, minHeight: 44)
            }
            .tint(.red)
            Button("Discard", role: .destructive) { hum.discard() }
                .font(.caption2)
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
        }
    }

    /// "0:12".
    static func clock(_ t: TimeInterval) -> String {
        let s = max(0, Int(t))
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }
}

struct WatchHumRow: View {
    let status: WatchHumStatus

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: status.failed ? "exclamationmark.triangle" : status.finished ? "checkmark.circle" : "arrow.up.circle")
                .foregroundStyle(status.failed ? Color.orange : status.finished ? Color.green : Color.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(StyleGuard.dashes(status.line)).font(.footnote).fixedSize(horizontal: false, vertical: true)
                Text("\(status.mode == .melody ? "Melody" : "Rhythm"), \(WatchHumRecordingPanel.clock(status.seconds)), \(status.at.formatted(date: .omitted, time: .shortened))")
                    .font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
