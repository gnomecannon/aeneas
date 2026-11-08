import SwiftUI
import WatchKit
import AVFoundation
import UserNotifications
import EACore

/// What a tap (or a complication) starts on the voice page.
enum VoiceAction: Equatable { case ask, capture }

/// The Watch's first page: Ask, Capture and Hum, all by voice. Ask and Capture go straight to dictation, with no
/// keyboard or scribble; Hum records with the microphone. Reminders and the rest are on the pages below and in
/// Apple's own apps.
struct WatchVoiceView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject var ask: WatchAskModel
    @ObservedObject var hum: WatchHumModel
    @State private var captureLine: String?
    @State private var saving = false
    /// The last result, shown over the bottom for a few seconds: the buttons fill a small Watch, so the lines under
    /// them are out of sight.
    @State private var banner: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                if hum.recorder.recording {
                    WatchHumRecordingPanel(hum: hum)
                } else {
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)], spacing: 6) {
                        // One question at a time: a second one while the first is answered would be dropped.
                        tile("Ask", "bubble.left.and.text.bubble.right.fill", .blue) { start(.ask) }
                            .disabled(ask.asking != nil)
                        // Double tap (finger and thumb, Series 9 and later) captures without touching the screen.
                        tile("Capture", "mic.fill", .orange) { start(.capture) }
                            .handGestureShortcut(.primaryAction)
                        // A tune caught on the go goes to Music through the iPhone; hidden while Music is off.
                        if model.isOn(.music) {
                            tile("Hum melody", "music.note", .pink) { record(.melody) }
                            tile("Hum rhythm", "metronome.fill", .purple) { record(.rhythm) }
                        }
                    }
                }
                if !model.isOn(.voice) {
                    Text(Self.voiceOff).font(.caption2).foregroundStyle(.orange).multilineTextAlignment(.center)
                }
                if model.removed {
                    Text("This Watch was removed from your hub. Pair it again on your iPhone: Settings, Connection, Devices.")
                        .font(.caption2).foregroundStyle(.orange).multilineTextAlignment(.center)
                }
                if let p = hum.recorder.error ?? hum.problem {
                    Text(p).font(.caption2).foregroundStyle(.orange).multilineTextAlignment(.center)
                }
                if saving {
                    HStack(spacing: 6) { ProgressView().frame(width: 16, height: 16); Text("Saving").font(.caption2).foregroundStyle(.secondary) }
                } else if let line = captureLine {
                    Text(line).font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center).lineLimit(3)
                }
                if ask.asking != nil || !ask.turns.isEmpty {
                    Button { model.conversationOpen = true } label: { conversationPreview }
                        .buttonStyle(.bordered)
                }
                ForEach(hum.recent.prefix(2)) { WatchHumRow(status: $0) }
                OfflineDot()
            }
            .padding(.horizontal, 2)
        }
        .overlay(alignment: .bottom) {
            if let b = banner {
                HStack(spacing: 6) {
                    if saving { ProgressView().frame(width: 14, height: 14) }
                    Text(b).font(.caption2).lineLimit(2).multilineTextAlignment(.leading)
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .frame(maxWidth: .infinity)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .onTapGesture { banner = nil }
            }
        }
        .animation(.default, value: banner)
        // Each step of a hum on its way, from "Sent to your iPhone" to the idea's title.
        .onChange(of: hum.recent.first) { _, s in if let s { show(StyleGuard.dashes(s.line)) } }
        .navigationDestination(isPresented: $model.conversationOpen) { WatchConversationView(ask: ask) }
        // Ask and Capture complications land here and start listening at once.
        .task(id: model.listen) {
            guard let a = model.listen else { return }
            // Lets the app finish coming forward before the dictation screen goes up. Clearing `listen` changes this
            // task's id, which cancels it, so that waits until the pause is over.
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            model.listen = nil
            start(a)
        }
    }

    private var conversationPreview: some View {
        VStack(alignment: .leading, spacing: 2) {
            if let q = ask.asking {
                Text(q).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                HStack(spacing: 4) { ProgressView().frame(width: 14, height: 14); Text("Thinking").font(.footnote) }
            } else if let t = ask.turns.last {
                Text(t.q).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                Text(Speakable.text(StyleGuard.dashes(t.a))).font(.footnote).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func tile(_ title: String, _ icon: String, _ tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: icon).font(.title3)
                Text(title).font(.footnote.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity, minHeight: 64)
        }
        .tint(tint)
        .disabled(saving)
    }

    static let voiceOff = "Voice is off. Turn it on in Settings, Modules."

    private func start(_ a: VoiceAction) {
        // Voice off (Settings, Modules on any device): Ask and Capture listen for nothing and say why.
        guard model.isOn(.voice) else { show(Self.voiceOff); WKHaptic.failure(); return }
        switch a {
        case .ask:
            // The hub reads the shared start of every chat into the model's cache while the owner speaks.
            if let c = engine.client { Task { try? await c.warmAssistant() } }
            Task {
                guard let q = await Dictation.listen() else { return }
                model.conversationOpen = true
                await ask.ask(q, engine: engine)
            }
        case .capture:
            Task {
                guard let text = await Dictation.listen() else { return }
                await capture(text)
            }
        }
    }

    /// Saved as soon as dictation ends: the dictation screen already showed the words before Done.
    /// Sorted by the hub like a phone capture: a reminder, task, log or note, not left to file by hand.
    private func capture(_ text: String) async {
        saving = true
        captureLine = nil
        banner = "Saving"
        let e = await engine.capture(text, source: .watch)
        saving = false
        let what: String
        if e == nil {
            what = "Not saved"
        } else if e?.str("filing") == "pending" {
            what = "In your diary, filing it"
        } else if e?.bool("processed") == true, let k = e?.str("suggested_kind"), !k.isEmpty, k != "none" {
            what = "Saved as a \(k)"
        } else {
            what = engine.status == .online ? "Saved, to sort later" : "Saved, will sync"
        }
        captureLine = "\(what): \(text)"
        show(captureLine ?? what)
        if e == nil { WKHaptic.failure() } else { WKHaptic.success() }
    }

    private func show(_ line: String) {
        banner = line
        Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if banner == line { banner = nil }
        }
    }

    private func record(_ mode: HumMidi.Mode) {
        guard model.isOn(.voice) else { show(Self.voiceOff); WKHaptic.failure(); return }
        hum.mode = mode
        Task { await hum.record() }
    }
}

/// Today's conversation with the assistant: newest first, read aloud as answers arrive. Follow-ups are dictated.
struct WatchConversationView: View {
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject var ask: WatchAskModel
    @ObservedObject private var speaker: WatchSpeaker
    @AppStorage(WatchAskModel.speakKey) private var speakAnswers = true

    init(ask: WatchAskModel) {
        self.ask = ask
        _speaker = ObservedObject(wrappedValue: ask.speaker)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Button { followUp() } label: {
                    Label(ask.turns.isEmpty ? "Ask" : "Follow up", systemImage: "mic.fill").frame(maxWidth: .infinity, minHeight: 40)
                }
                .tint(.blue)
                .disabled(ask.asking != nil)
                .handGestureShortcut(.primaryAction)
                if let q = ask.asking {
                    Text(q).font(.caption2).foregroundStyle(.secondary).lineLimit(3)
                    HStack(spacing: 6) { ProgressView().frame(width: 16, height: 16); Text("Thinking").font(.caption2).foregroundStyle(.secondary) }
                }
                if let e = ask.error { Text(e).font(.caption2).foregroundStyle(.orange) }
                ForEach(ask.turns.reversed()) { t in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(t.q).font(.caption2).foregroundStyle(.secondary).lineLimit(3)
                        Text(markdown(t.a)).font(.footnote).fixedSize(horizontal: false, vertical: true)
                        Button { speaker.toggle(t.a, id: t.id) } label: {
                            Label(speaker.speakingId == t.id ? "Stop" : "Read aloud", systemImage: speaker.speakingId == t.id ? "stop.fill" : "speaker.wave.2")
                                .font(.caption2)
                        }
                        .buttonStyle(.bordered)
                    }
                    .padding(.vertical, 4)
                }
                if !ask.turns.isEmpty {
                    Button { ask.newConversation() } label: { Label("New conversation", systemImage: "plus.bubble").frame(maxWidth: .infinity) }
                        .disabled(ask.asking != nil)
                }
                Toggle("Speak answers", isOn: $speakAnswers).font(.caption2)
                OfflineDot().frame(maxWidth: .infinity)
            }
            .padding(.horizontal, 2)
        }
        .navigationTitle("Ask")
        .task { await ask.catchUp(engine: engine) }
        .onDisappear { speaker.stop() }
    }

    private func followUp() {
        guard SharedConfig.shared.moduleOn(.voice) else { ask.error = WatchVoiceView.voiceOff; return }
        if let c = engine.client { Task { try? await c.warmAssistant() } }
        Task {
            guard let q = await Dictation.listen() else { return }
            await ask.ask(q, engine: engine)
        }
    }

    private func markdown(_ s: String) -> AttributedString {
        (try? AttributedString(markdown: StyleGuard.dashes(s), options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
    }
}

/// Straight to the dictation screen: no suggestions and plain input is the one way watchOS opens the microphone
/// at once rather than a choice of keyboard, scribble and dictation.
@MainActor
enum Dictation {
    /// The words, or nil when cancelled or nothing was said.
    static func listen() async -> String? {
        guard let c = WKApplication.shared().visibleInterfaceController ?? WKApplication.shared().rootInterfaceController else { return nil }
        guard await noticeAccepted(on: c) else { return nil }
        let results: [Any]? = await withCheckedContinuation { cont in
            c.presentTextInputController(withSuggestions: nil, allowedInputMode: .plain) { cont.resume(returning: $0) }
        }
        let text = (results?.first as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty ? nil : text
    }

    private static let noticeKey = "ea.watchDictation.noticeAccepted"

    /// Said once before the first dictation on this Watch, as the Voice module promises: the Watch's dictation is
    /// Apple's, and Apple may process the audio on its servers. Not now asks again next time.
    private static func noticeAccepted(on c: WKInterfaceController) async -> Bool {
        if UserDefaults.standard.bool(forKey: noticeKey) { return true }
        return await withCheckedContinuation { cont in
            let ok = WKAlertAction(title: "Use dictation", style: .default) {
                UserDefaults.standard.set(true, forKey: noticeKey)
                cont.resume(returning: true)
            }
            let no = WKAlertAction(title: "Not now", style: .cancel) { cont.resume(returning: false) }
            c.presentAlert(withTitle: "Before you talk",
                           message: "Talking on the Watch uses Apple's dictation, and Apple may turn your voice into text on its servers. EverythingApp keeps only the text.",
                           preferredStyle: .alert, actions: [ok, no])
        }
    }
}

/// The day's conversation with the assistant, on the app model so it outlives the page and Siri can add to it.
/// One conversation per day, so follow-ups keep their context; New conversation starts over.
@MainActor
final class WatchAskModel: ObservableObject {
    typealias Turn = ChatTurn

    static let speakKey = "watch.speakAnswers"
    private static let turnsKey = "watch.askTurns"
    private static let sessionKey = "watch.askSession"
    private static let dayKey = "watch.askDay"
    /// How long Siri waits for an answer before saying it will come as a notification.
    static let siriWait: TimeInterval = 10

    @Published private(set) var turns: [Turn] = []
    /// The question waiting for an answer.
    @Published private(set) var asking: String?
    @Published var error: String?
    let speaker = WatchSpeaker()
    private let defaults = UserDefaults.standard

    private var speakAnswers: Bool { defaults.object(forKey: Self.speakKey) as? Bool ?? true }
    private var today: String { ISO.localDay() }

    init() {
        if defaults.string(forKey: Self.dayKey) == today, let d = defaults.data(forKey: Self.turnsKey) {
            turns = (try? JSONDecoder().decode([Turn].self, from: d)) ?? []
        }
    }

    /// Asks through the iPhone; the answer is added to the conversation and, unless Siri is the one asking, read aloud.
    @discardableResult
    func ask(_ question: String, engine: SyncEngine, speak: Bool = true) async -> Turn? {
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, asking == nil else { return nil }
        guard let c = engine.readyClient() else { error = "Not connected to the hub"; return nil }
        if defaults.string(forKey: Self.dayKey) != today || (defaults.string(forKey: Self.sessionKey) ?? "").isEmpty {
            defaults.set("watch-\(today)-\(UUID().uuidString.prefix(8).lowercased())", forKey: Self.sessionKey)
            defaults.set(today, forKey: Self.dayKey)
            // Saved now: if this first answer never comes, the next launch must not show yesterday's turns as today's.
            turns = []
            save()
        }
        let session = defaults.string(forKey: Self.sessionKey) ?? ""
        asking = q
        error = nil
        speaker.stop()
        defer { asking = nil }
        do {
            // The reply comes through the iPhone, which iOS suspends soon after a locked iPhone is woken for it, and
            // whose request has a limit; past 45 s the answer is also read from the hub's chat, whichever comes first.
            switch try await c.chatOrLate(ChatRequest(session_id: session, message: q)) {
            case .reply(let r):
                var answer = r.reply
                if r.pending_action != nil { answer += "\n\nApprove or decline this on your iPhone." }
                return landed(Turn(q: q, a: answer), speak: speak)
            case .late(let t):
                return landed(t, speak: speak)
            }
        } catch {
            self.error = (error as? HubError) == .phoneUnreachable
                ? "Your iPhone is not reachable. Keep it nearby with Bluetooth on."
                : ((error as? HubError)?.errorDescription ?? error.localizedDescription)
            WKHaptic.failure()
            return nil
        }
    }

    private func landed(_ t: Turn, speak: Bool) -> Turn {
        turns.append(t)
        save()
        WKHaptic.success()
        if speak, speakAnswers { speaker.speak(t.a, id: t.id) }
        return t
    }

    /// For "Ask EverythingApp" from Siri on the wrist: the answer to speak, or, when it takes longer than Siri waits,
    /// a promise of a notification that then carries it.
    func answerForSiri(_ question: String, engine: SyncEngine) async -> String {
        if asking != nil { return "I'm still answering your last question. It's on the Watch's Ask page." }
        return await SiriAnswer.run(question, session: nil, wait: Self.siriWait) { @MainActor in
            guard let t = await self.ask(question, engine: engine, speak: false) else {
                return .init(failure: self.error ?? "I could not ask the assistant.")
            }
            return .init(reply: t.a)
        }
    }

    /// Answers that landed while the Watch app was away (Siri stopped waiting and watchOS suspended the app before
    /// the reply came back) are on the hub: the day's conversation is read back from there when the app comes forward.
    func catchUp(engine: SyncEngine) async {
        guard asking == nil, defaults.string(forKey: Self.dayKey) == today,
              let session = defaults.string(forKey: Self.sessionKey), !session.isEmpty, let c = engine.readyClient() else { return }
        let before = turns
        guard let s = try? await c.aiSession(session) else { return }
        let fromHub = Array(Turn.turns(of: s).suffix(Self.keep))
        // A question asked or answered meanwhile, or a reply being read aloud, keeps what is on screen.
        guard asking == nil, speaker.speakingId == nil, turns == before, defaults.string(forKey: Self.sessionKey) == session,
              fromHub.map(\.a) != turns.map(\.a), fromHub.count >= turns.count else { return }
        turns = fromHub
        save()
    }

    func newConversation() {
        speaker.stop()
        defaults.removeObject(forKey: Self.sessionKey)
        turns = []
        error = nil
        save()
    }

    /// Turns kept on the Watch.
    private static let keep = 20

    private func save() {
        if turns.count > Self.keep { turns.removeFirst(turns.count - Self.keep) }
        defaults.set(try? JSONEncoder().encode(turns), forKey: Self.turnsKey)
    }
}

/// Reads answers through the Watch speaker (or connected headphones), one at a time.
@MainActor
final class WatchSpeaker: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    @Published private(set) var speakingId: String?
    private let synth = AVSpeechSynthesizer()

    override init() {
        super.init()
        synth.delegate = self
    }

    func toggle(_ text: String, id: String) { speakingId == id ? stop() : speak(text, id: id) }

    func speak(_ text: String, id: String) {
        stop()
        let said = Speakable.text(text)
        // A hum being recorded keeps the microphone's audio session: speaking would switch it and cut the take.
        guard !said.isEmpty, !AudioFocus.recording else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        let u = AVSpeechUtterance(string: said)
        u.voice = AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())
        speakingId = id
        synth.speak(u)
    }

    func stop() {
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        speakingId = nil
    }

    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { Task { @MainActor in self.ended() } }
    nonisolated func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { Task { @MainActor in self.ended() } }

    private func ended() {
        guard !synth.isSpeaking else { return }
        speakingId = nil
        guard !AudioFocus.recording else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
