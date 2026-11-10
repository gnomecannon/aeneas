import SwiftUI
import PhotosUI
import EACore

/// Chats live on the hub, so a chat started on the phone continues on the Mac. This store keeps the list and the
/// chats already opened on disk so they still show when the hub is out of reach.
@MainActor
final class ChatStore: ObservableObject {
    @Published var items: [AISessionItem] = []
    @Published var current: AISession?
    private var cache: [String: AISession] = [:]
    private let url: URL
    /// The chat last asked for, so a reply from the hub for a chat already left behind does not replace the screen.
    private var wanted: String?

    private struct Disk: Codable { var items: [AISessionItem]; var sessions: [String: AISession] }

    init() {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        url = dir.appendingPathComponent("EverythingApp", isDirectory: true).appendingPathComponent("chats.json")
        if let d = try? Data(contentsOf: url), let disk = try? JSONDecoder().decode(Disk.self, from: d) { items = disk.items; cache = disk.sessions }
    }

    private func save() {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Keep the 30 most recent chats on disk; the hub has the rest.
        let keep = Set(items.prefix(30).map(\.session_id))
        // A reply in progress is the hub's to report; a cached flag would show a spinner forever when offline.
        let disk = Disk(items: items, sessions: cache.filter { keep.contains($0.key) }.mapValues { var s = $0; s.working = nil; return s })
        // Complete protection: the copy of the chats is read only by the open Assistant screen.
        if let d = try? JSONEncoder().encode(disk) { try? DataProtection.write(d, to: url, .complete) }
    }

    func refresh(_ client: HubClient) async {
        guard let list = try? await client.aiSessions() else { return }
        items = list
        save()
    }

    func open(_ id: String, client: HubClient?) async {
        wanted = id
        if let c = cache[id] { current = c }
        guard let client = client, let s = try? await client.aiSession(id) else { return }
        cache[id] = s
        if wanted == id { current = s }
        save()
    }

    /// A new chat exists only on this device until its first message reaches the hub.
    func newChat() {
        let now = ISO8601DateFormatter().string(from: Date())
        wanted = nil
        current = AISession(session_id: UUID().uuidString.lowercased(), title: "New chat", task_type: "auto", created_at: now, last_at: now, messages: [], summary: nil, pending_action: nil)
    }

    /// Show the user's turn at once, before the hub answers.
    func appendLocal(_ m: AIStoredMessage) {
        guard var s = current else { return }
        s.messages.append(m)
        if s.title == "New chat", !m.content.isEmpty { s.title = String(m.content.prefix(60)) }
        current = s
    }

    /// Erase every chat on the hub and every copy on this device.
    func wipeAll(client: HubClient?) async throws {
        try await client?.wipeAISessions()
        items = []
        cache = [:]
        current = nil
        try? FileManager.default.removeItem(at: url)
    }

    func delete(_ id: String, client: HubClient?) async {
        try? await client?.deleteAISession(id)
        items.removeAll { $0.session_id == id }
        cache[id] = nil
        if current?.session_id == id { current = nil }
        save()
    }
}

/// An image picked or taken for the next message, already shrunk to JPEG.
struct PendingImage: Identifiable, Equatable {
    let id = UUID()
    let jpeg: Data
}

struct AssistantView: View {
    @EnvironmentObject var engine: SyncEngine
    @EnvironmentObject var model: AppModel
    @StateObject private var store = ChatStore()
    @StateObject private var dictation = DictationController()
    @State private var allowCloud = SharedConfig.shared.allowCloud
    @State private var input = ""
    @State private var images: [PendingImage] = []
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var creatingImage = false
    @State private var pickingPhotos = false
    @State private var pickingFromGallery = false
    @State private var streaming = ""
    @State private var busy = false
    @State private var error: String?
    @State private var showLedger = false
    @State private var toolStatus: String?
    @State private var pending: PendingAction?
    /// The assistant asked for this iPhone's newest photos: nothing is read or sent until the person says so here.
    @State private var photoAsk: PhotosRequest?
    @State private var photoClient: HubClient?
    @State private var ai: AICapabilities?
    @State private var confirmDelete = false
    @State private var showChats = false
    @State private var busySince = Date()
    /// Set when dictation put words in the box, so the reply to that message is read aloud.
    @State private var voiceTurn = false
    @AppStorage("speakVoiceReplies") private var speakVoiceReplies = true
    /// Talking ends by itself: a pause after you speak sends the message, with no second tap.
    @AppStorage("sendOnPause") private var sendOnPause = true
    @ObservedObject private var speaker = ReplySpeaker.shared

    private var sessionId: String? { store.current?.session_id }
    /// Kept short: a long title pushes the New chat and Chats buttons into an overflow menu on the iPhone.
    private var barTitle: String {
        let t = store.current?.title ?? "Assistant"
        return t.count > 17 ? String(t.prefix(16)).trimmingCharacters(in: .whitespaces) + "\u{2026}" : t
    }
    private var ledger: LedgerFields? {
        guard let id = sessionId else { return nil }
        return engine.ledgers.first { $0.str("session_id") == id }?.decoded(LedgerFields.self)
    }

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 10) {
                header
                messages
                composer
            }
            .padding()
            if showLedger, let id = sessionId {
                Divider()
                LedgerPanel(sessionId: id).frame(width: 280)
            }
        }
        .navigationTitle(barTitle)
        #if os(iOS)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .toolbar {
            // Switching chats mid-reply would show the reply in the wrong chat, so both wait until it is stored.
            ToolbarItem(placement: .primaryAction) {
                Button { startChat() } label: { Label("New chat", systemImage: "square.and.pencil") }.disabled(busy)
            }
            ToolbarItem(placement: .primaryAction) {
                Button { showChats = true } label: { Label("Chats", systemImage: "list.bullet") }.disabled(busy)
            }
            if ledger != nil {
                ToolbarItem(placement: .automatic) { Button { showLedger.toggle() } label: { Label("Ledger", systemImage: "sidebar.right") } }
            }
        }
        // Tapping the title opens this chat's own menu; erasing every chat is only in the chat list, two menus deep.
        .toolbarTitleMenu {
            Toggle(isOn: $speakVoiceReplies) { Label("Speak answers to voice messages", systemImage: "speaker.wave.2") }
            Toggle(isOn: $sendOnPause) { Label("Send when I stop talking", systemImage: "waveform.badge.checkmark") }
            Button(role: .destructive) { confirmDelete = true } label: { Label("Erase this chat", systemImage: "trash") }
                .disabled(store.current?.messages.isEmpty ?? true || busy)
        }
        .confirmationDialog("Erase this chat?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Erase chat", role: .destructive) { if let id = sessionId { erase(id) } }
        } message: { Text("It is erased on every device and cannot be undone.") }
        .confirmationDialog(photoAsk.map { "Send \($0.count) \($0.count == 1 ? "photo" : "photos")?" } ?? "Send photos?",
                            isPresented: Binding(get: { photoAsk != nil }, set: { if !$0, photoAsk != nil { answerPhotos(send: false) } }),
                            titleVisibility: .visible) {
            Button("Send") { answerPhotos(send: true) }
            Button("Do not send", role: .cancel) { answerPhotos(send: false) }
        } message: {
            Text("The assistant asked for your newest photos. They go to your hub for this answer only.")
        }
        .sheet(isPresented: $showChats) {
            ChatListSheet(store: store, currentId: sessionId,
                          onOpen: { id in Task { await store.open(id, client: engine.client); syncPending() } },
                          onNew: { startChat() },
                          onErase: { erase($0) },
                          onEraseAll: eraseAll)
        }
        .task {
            // The hub reads the shared start of every chat into the model's cache while the owner types.
            if let c = engine.client { Task { try? await c.warmAssistant() } }
            // Read only; the mic button asks on its first tap.
            dictation.refreshAuthorization()
            if let c = engine.client {
                ai = try? await c.health().ai
                if ai?.cloud != true { allowCloud = false }
                await store.refresh(c)
                if let id = model.openChatId { model.openChatId = nil; await store.open(id, client: c); syncPending() }
                // The newest conversation, not a capture's filing thread: a question typed there would join that capture.
                if store.current == nil, let first = store.items.first(where: { !$0.session_id.hasPrefix("capture-") }) { await store.open(first.session_id, client: c); syncPending() }
            }
            if store.current == nil { store.newChat() }
        }
        // A chat asked for from elsewhere (a capture's thread, Siri) waits while a reply streams, as New chat and Chats
        // do: opening it then put the reply's end into the chat on screen, over the one asked for.
        .onChange(of: model.openChatId) { _, _ in openRequestedChat() }
        .onChange(of: busy) { _, now in if !now { openRequestedChat() } }
        // While the hub is still answering in this chat (from anywhere), re-read it until the reply lands.
        .task(id: store.current?.working?.since) {
            guard let id = sessionId, store.current?.working != nil else { return }
            while !Task.isCancelled, !busy, store.current?.session_id == id, store.current?.working != nil {
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                if Task.isCancelled { return }
                await store.open(id, client: engine.client)
            }
            syncPending()
        }
        .onChange(of: photoItems) { _, items in loadPhotos(items) }
        .sheet(isPresented: $creatingImage) { ImageComposerView() }
        .photosPicker(isPresented: $pickingPhotos, selection: $photoItems, maxSelectionCount: max(1, 4 - images.count), matching: .images)
        .sheet(isPresented: $pickingFromGallery) {
            GalleryPicker { id in
                Task {
                    if images.count < 4, let d = await HubImageCache.shared.data(id, client: engine.client), let jpeg = ImageShrinker.jpeg(from: d) {
                        images.append(PendingImage(jpeg: jpeg))
                    }
                }
            }
        }
        .onChange(of: dictation.listening) { _, on in if !on { placeTranscript() } }
        // Leaving the tab while listening kept the microphone on and the words where the next start cleared them:
        // it stops, and the words go in the box.
        .onDisappear { if dictation.listening { dictation.stop(); placeTranscript() } }
    }

    private func openRequestedChat() {
        guard let id = model.openChatId, !busy else { return }
        model.openChatId = nil
        Task { await store.open(id, client: engine.client); syncPending() }
    }

    private var header: some View {
        VStack(spacing: 8) {
            StatusBanner()
            if ai?.cloud == true {
                HStack {
                    Spacer()
                    // Only offered when the hub has a cloud model (Claude) set up; otherwise it would do nothing.
                    Toggle("Use Claude", isOn: $allowCloud).toggleStyle(.switch).onChange(of: allowCloud) { _, v in SharedConfig.shared.allowCloud = v }
                        .help("Sends this chat to Claude in the cloud, with private details removed. Work items are never sent.")
                }
            }
        }
    }

    private var messages: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if let s = store.current {
                        if s.messages.isEmpty && !busy {
                            Text("Ask anything. It can check and change your data, look things up on the web, read screenshots, make images (or tap +), and run commands on your machines (changes wait for your OK).")
                                .font(.callout).foregroundStyle(.secondary).padding(.top, 8)
                        }
                        ForEach(Array(s.messages.enumerated()), id: \.offset) { i, m in
                            ChatBubble(message: m, styled: engine.styled, speakId: "\(s.session_id):\(i)").id(i)
                        }
                    }
                    if !streaming.isEmpty {
                        ChatBubble(message: AIStoredMessage(role: .assistant, content: streaming), styled: { $0 }).id("streaming")
                    }
                    if busy {
                        WorkingIndicator(status: toolStatus ?? (streaming.isEmpty ? "Thinking" : "Writing"), since: busySince).id("working")
                    } else if let w = store.current?.working {
                        // Started on another device, or before this screen was left and opened again.
                        WorkingIndicator(status: w.status ?? w.tool.map(ToolAction.label) ?? "Thinking", since: Self.date(w.since) ?? Date()).id("working")
                    }
                    if let p = pending, !busy {
                        ApprovalCard(action: p, onRun: { approve(p) }, onCancel: { decline(p) }).id("approval")
                    }
                    if let e = error { Text(e).foregroundStyle(.red).font(.footnote) }
                }
                .padding(.vertical, 4)
            }
            #if os(iOS)
            // Tapping the conversation lowers the keyboard, as in Messages.
            .simultaneousGesture(TapGesture().onEnded { KeyboardWatcher.dismiss() })
            #endif
            .onChange(of: streaming) { _, _ in proxy.scrollTo("working", anchor: .bottom) }
            // While working, the indicator is the last row and stays in view; it is laid out a moment after the turn.
            .onChange(of: busy || store.current?.working != nil) { _, on in
                if on { Task { @MainActor in await Task.yield(); withAnimation { proxy.scrollTo("working", anchor: .bottom) } } }
            }
            .onChange(of: store.current?.messages.count) { _, n in
                if busy || store.current?.working != nil {
                    Task { @MainActor in await Task.yield(); proxy.scrollTo("working", anchor: .bottom) }
                } else if let n = n, n > 0 { proxy.scrollTo(n - 1, anchor: .bottom) }
            }
            .onChange(of: pending) { _, p in if p != nil { proxy.scrollTo("approval", anchor: .bottom) } }
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !images.isEmpty {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(images) { img in
                            ZStack(alignment: .topTrailing) {
                                ImageFromData(data: img.jpeg).frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 8))
                                Button { images.removeAll { $0.id == img.id } } label: { Image(systemName: "xmark.circle.fill") }
                                    .buttonStyle(.borderless).accessibilityLabel("Remove image")
                            }
                        }
                    }
                }
            }
            if dictation.listening {
                Label(dictation.transcript.isEmpty ? (sendOnPause ? "Listening. It sends when you stop talking." : "Listening. Tap the mic again when you are done.") : dictation.transcript, systemImage: "waveform")
                    .font(.callout).foregroundStyle(.secondary).lineLimit(4)
            } else if let e = dictation.error {
                Text(e).font(.caption).foregroundStyle(.orange)
            } else if let n = dictation.notice {
                Text(n).font(.caption).foregroundStyle(.orange)
            }
            ImageJobsStrip()
            HStack(alignment: .bottom, spacing: 8) {
                // One button for pictures: attach from Photos or the gallery, or create a new image.
                Menu {
                    Button { creatingImage = true } label: { Label("Create image", systemImage: "wand.and.stars") }
                    if ai?.images != false {
                        // A PhotosPicker inside a Menu closes with the menu and never opens; the picker hangs off the screen instead.
                        Button { pickingPhotos = true } label: { Label("Attach photo", systemImage: "photo") }
                        Button { pickingFromGallery = true } label: { Label("Attach from Image Gallery", systemImage: "photo.on.rectangle") }
                    }
                } label: {
                    Image(systemName: "plus.circle").font(.system(size: 26))
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .disabled(busy)
                .accessibilityLabel("Pictures")
                TextField("Message", text: $input, axis: .vertical).textFieldStyle(.roundedBorder).font(.title3).lineLimit(1...6)
                // Voice off (Settings, Modules): no microphone button.
                if model.isOn(.voice) {
                    Button {
                        // The microphone would hear the reply being read.
                        if dictation.listening { dictation.stop() } else {
                            speaker.stop()
                            dictation.pauseToStop = sendOnPause ? Self.pauseToSend : nil
                            Task { await dictation.startAsking() }
                        }
                    } label: {
                        Image(systemName: dictation.listening ? "stop.circle.fill" : "mic.circle").font(.system(size: 30))
                            .foregroundStyle(dictation.listening ? Color.red : Color.accentColor)
                    }
                    .buttonStyle(.borderless)
                    // The first tap asks for the microphone; a refusal leaves it off until it is allowed in Settings.
                    .disabled(busy || (!dictation.authorized && dictation.error != nil))
                    .accessibilityLabel(dictation.listening ? "Stop listening" : "Talk")
                }
                if busy || store.current?.working != nil {
                    ProgressView().frame(width: 34, height: 34).accessibilityLabel("Working on your message")
                } else {
                    Button { send() } label: { Image(systemName: "arrow.up.circle.fill").font(.system(size: 34)) }
                        .buttonStyle(.borderless)
                        .disabled((input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty) || engine.client == nil)
                        .keyboardShortcut(.return, modifiers: .command)
                }
            }
        }
    }

    private func startChat() {
        store.newChat()
        pending = nil
        error = nil
        images = []
    }

    private func syncPending() { pending = store.current?.pending_action }

    static func date(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }

    private func erase(_ id: String) {
        Task {
            await store.delete(id, client: engine.client)
            if store.current == nil { startChat() }
        }
    }

    private func eraseAll() {
        Task {
            do { try await store.wipeAll(client: engine.client); startChat() } catch { self.error = (error as? HubError)?.errorDescription ?? error.localizedDescription }
        }
    }

    /// The recognizer may deliver its last words just after stopping; place them shortly after.
    private func placeTranscript() {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 700_000_000)
            let t = dictation.transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty else { return }
            input = input.isEmpty ? t : input + (input.hasSuffix(" ") ? "" : " ") + t
            dictation.transcript = ""
            voiceTurn = true
            // Stopped by a pause (not a tap): sent as it is, the same as tapping send.
            if dictation.stoppedOnPause, sendOnPause, !busy, store.current?.working == nil, engine.client != nil { send() }
        }
    }

    /// How long a pause after speaking ends it. Long enough for a breath in the middle of a sentence.
    static let pauseToSend: TimeInterval = 1.6

    private func loadPhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        Task {
            for item in items.prefix(4 - images.count) {
                guard let data = try? await item.loadTransferable(type: Data.self), let jpeg = ImageShrinker.jpeg(from: data, maxBytes: 3_000_000) else {
                    error = "Could not read that image."
                    continue
                }
                images.append(PendingImage(jpeg: jpeg))
            }
            photoItems = []
        }
    }

    private func send() {
        if dictation.listening { dictation.stop() }
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !images.isEmpty else { return }
        let b64 = images.map { $0.jpeg.base64EncodedString() }
        input = ""
        images = []
        if store.current == nil { store.newChat() }
        store.appendLocal(AIStoredMessage(role: .user, content: text, at: ISO8601DateFormatter().string(from: Date())))
        let spoken = voiceTurn
        voiceTurn = false
        run(ChatRequest(session_id: store.current!.session_id, message: text, images: b64.isEmpty ? nil : b64, allow_cloud: allowCloud), spoken: spoken)
    }

    private func approve(_ a: PendingAction) {
        guard let id = sessionId else { return }
        store.appendLocal(AIStoredMessage(role: .user, content: "Yes, run it.", approval: .init(action_id: a.id, host: a.host, command: a.command, status: "running", exit_code: nil)))
        run(ChatRequest(session_id: id, message: nil, approve_action_id: a.id, allow_cloud: allowCloud))
    }

    private func decline(_ a: PendingAction) {
        pending = nil
        Task {
            do { try await engine.client?.cancelAction(a.id) } catch { self.error = (error as? HubError)?.errorDescription ?? error.localizedDescription }
            if let id = sessionId { await store.open(id, client: engine.client) }
        }
    }

    /// The answer to the assistant's photo request: the newest photos on Send, none otherwise.
    private func answerPhotos(send: Bool) {
        guard let r = photoAsk, let client = photoClient else { return }
        photoAsk = nil
        photoClient = nil
        toolStatus = send ? "Reading your recent photos" : nil
        Task {
            var photos: [DevicePhoto] = []
            #if os(iOS)
            if send { photos = await PhoneLibrary.newest(count: r.count, sinceDays: r.since_days) }
            #endif
            try? await client.sendPhotos(requestId: r.id, photos: photos)
        }
    }

    /// One streamed turn. The hub stores both sides; afterwards the chat is reloaded from it.
    private func run(_ req: ChatRequest, spoken: Bool = false) {
        guard let client = engine.client else { error = "Hub not configured."; return }
        var req = req
        #if os(iOS)
        // With full photo library access on, the assistant may ask this iPhone for recent photos.
        if PhoneLibrary.available { req.device = DeviceCaps(photos: true) }
        #endif
        busy = true
        busySince = Date()
        error = nil
        streaming = ""
        toolStatus = nil
        pending = nil
        // The chat as the hub will hold it once this turn is stored (the user's turn is already shown).
        let sentCount = store.current?.messages.count ?? 0
        Task {
            var done: ChatResponse?
            var failed: String?
            var hubHasTurn = false
            do {
                for try await ev in try client.chatStream(req) {
                    switch ev {
                    case .token(let t): streaming += t
                    case .done(let d): done = d
                    case .failed(let m): failed = m
                    case .tool(let a): toolStatus = ToolAction.label(a.tool) + (a.ok ? "" : " (failed)")
                    case .status(let s): toolStatus = s
                    case .approval(let a): pending = a
                    case .photosRequest(let r):
                        // Asked first: one tap sends them, anything else sends none.
                        toolStatus = "Waiting for you to send photos"
                        photoClient = client
                        photoAsk = r
                    }
                }
            } catch {
                // The connection dropped (the phone locked, the network changed). If the hub already has this turn it is
                // still answering or has answered, so it is not sent twice: reloading shows the reply or the indicator.
                if let s = try? await client.aiSession(req.session_id), s.messages.count >= sentCount {
                    hubHasTurn = true
                } else {
                    do { done = try await client.chat(req) } catch { failed = (error as? HubError)?.errorDescription ?? error.localizedDescription }
                }
            }
            if done == nil && streaming.isEmpty && failed == nil && !hubHasTurn { failed = "No reply came back from the hub. Try again." }
            if let f = failed, done == nil { self.error = f }
            if let p = done?.pending_action { pending = p }
            await store.open(req.session_id, client: client)
            if done == nil, !hubHasTurn, !streaming.isEmpty { store.appendLocal(AIStoredMessage(role: .assistant, content: streaming)) }
            // A dictated message gets its answer spoken, keyed to the reply's bubble so it shows Stop.
            if spoken, speakVoiceReplies, let msgs = store.current?.messages, let i = msgs.lastIndex(where: { $0.role == .assistant }) {
                let reply = done?.reply ?? (streaming.isEmpty ? msgs[i].content : streaming)
                speaker.speak(engine.styled(reply), id: "\(req.session_id):\(i)")
            }
            streaming = ""
            toolStatus = nil
            busy = false
            await store.refresh(client)
            Task { await engine.sync() }
        }
    }
}

/// Shown from the moment a message is sent until the reply is stored, so a slow model or a long tool call never
/// looks like nothing is happening. The seconds keep counting even while the hub sends nothing.
struct WorkingIndicator: View {
    var status: String
    var since: Date

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            TimelineView(.periodic(from: since, by: 1)) { ctx in
                Text("\(status), \(max(0, Int(ctx.date.timeIntervalSince(since)))) s").monospacedDigit()
            }
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.quaternary.opacity(0.5), in: Capsule())
        .accessibilityElement(children: .combine)
    }
}

/// Every chat, newest first. Erasing one is a swipe or a long press on its own row. Erasing all of them sits two
/// menus deep under the ellipsis and asks again, so it is never one slip away from erasing a single chat.
struct ChatListSheet: View {
    @ObservedObject var store: ChatStore
    var currentId: String?
    var onOpen: (String) -> Void
    var onNew: () -> Void
    var onErase: (String) -> Void
    var onEraseAll: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var eraseTarget: AISessionItem?
    @State private var confirmAll = false

    private func chatRow(_ s: AISessionItem) -> some View {
        Button { onOpen(s.session_id); dismiss() } label: { row(s) }
            .buttonStyle(.plain)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button { eraseTarget = s } label: { Label("Erase", systemImage: "trash") }.tint(.red)
            }
            .contextMenu {
                Button(role: .destructive) { eraseTarget = s } label: { Label("Erase chat", systemImage: "trash") }
            }
    }

    /// "the 1 chat" or "all 5 chats".
    private var count: String { store.items.count == 1 ? "the 1 chat" : "all \(store.items.count) chats" }

    var body: some View {
        NavigationStack {
            List {
                if store.items.isEmpty { Text("No chats yet.").foregroundStyle(.secondary) }
                // Conversations first; each capture's filing chat under its own heading, so they do not crowd them out.
                ForEach(store.items.filter { !$0.session_id.hasPrefix("capture-") }) { s in chatRow(s) }
                let captures = store.items.filter { $0.session_id.hasPrefix("capture-") }
                if !captures.isEmpty {
                    SwiftUI.Section("Captures") { ForEach(captures) { s in chatRow(s) } }
                }
            }
            .navigationTitle("Chats")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button { onNew(); dismiss() } label: { Label("New chat", systemImage: "square.and.pencil") }
                }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Menu {
                            Button(role: .destructive) { confirmAll = true } label: {
                                Label("Erase \(count)", systemImage: "trash.slash")
                            }
                        } label: { Label("Erase all chats", systemImage: "trash.slash") }
                    } label: { Label("More", systemImage: "ellipsis.circle") }
                    .disabled(store.items.isEmpty)
                }
            }
            .confirmationDialog("Erase this chat?", isPresented: Binding(get: { eraseTarget != nil }, set: { if !$0 { eraseTarget = nil } }),
                                titleVisibility: .visible, presenting: eraseTarget) { s in
                Button("Erase \u{201C}\(s.title)\u{201D}", role: .destructive) { onErase(s.session_id) }
            } message: { _ in Text("It is erased on every device and cannot be undone.") }
            .confirmationDialog("Erase \(count)?", isPresented: $confirmAll, titleVisibility: .visible) {
                Button("Erase all chats", role: .destructive) { onEraseAll(); dismiss() }
            } message: {
                Text("Every chat on every device, with its images, command output and troubleshooting ledgers. Saved facts, fix notes and the change journal stay. It cannot be undone.")
            }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 480)
        #endif
    }

    private func row(_ s: AISessionItem) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                // Under Captures the heading already says so.
                Text(s.session_id.hasPrefix("capture-") && s.title.hasPrefix("Capture: ") ? String(s.title.dropFirst(9)) : s.title).lineLimit(1)
                Text(Self.when(s.last_at)).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if s.session_id == currentId { Image(systemName: "checkmark").foregroundStyle(.tint).accessibilityLabel("Open now") }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private static func when(_ iso: String) -> String {
        guard let d = AssistantView.date(iso) else { return "" }
        return d.formatted(.relative(presentation: .named))
    }
}

/// One chat turn: text, attached images, the command it proposed or approved, and what changed.
struct ChatBubble: View {
    var message: AIStoredMessage
    var styled: (String) -> String
    /// Set for stored replies: they get a button that reads them aloud.
    var speakId: String? = nil
    @ObservedObject private var speaker = ReplySpeaker.shared

    var body: some View {
        VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 4) {
            if !message.content.isEmpty {
                Group {
                    // Replies are markdown (bold, lists, commands in code blocks); shown as plain text the markers showed.
                    if message.role == .user { Text(message.content).textSelection(.enabled) } else { ReplyMarkdown(text: styled(message.content)) }
                }
                .font(.body)
                .padding(12)
                .background(message.role == .user ? Color.accentColor.opacity(0.2) : Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            }
            if let ids = message.images, !ids.isEmpty {
                HStack {
                    // Made by the assistant (generate_image): large, with Share; the owner's own attachments stay small.
                    ForEach(ids, id: \.self) { id in
                        if message.role == .assistant {
                            VStack(alignment: .trailing) { HubImageView(id: id).frame(maxWidth: 360, maxHeight: 360); ImageShareButton(id: id).font(.caption).buttonStyle(.borderless) }
                        } else { HubImageView(id: id).frame(maxWidth: 200, maxHeight: 200) }
                    }
                }
            }
            if let a = message.approval {
                Label("\(message.role == .user ? "Approved" : "Proposed") on \(a.host): \(a.command)\(a.status.map { $0 == "pending" ? "" : " (\($0)\(a.exit_code.map { ", exit \($0)" } ?? ""))" } ?? "")",
                      systemImage: message.role == .user ? "checkmark.shield" : "terminal")
                    .font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(3)
            }
            if let id = speakId, message.role == .assistant, !message.content.isEmpty {
                let reading = speaker.speakingId == id
                Button { speaker.toggle(styled(message.content), id: id) } label: {
                    Label(reading ? "Stop reading" : "Read aloud", systemImage: reading ? "stop.fill" : "speaker.wave.2")
                }
                .font(.caption)
                .buttonStyle(.borderless)
            }
            if let acts = message.actions?.filter(\.writes), !acts.isEmpty {
                Label(acts.map { ToolAction.label($0.tool) + ($0.ok ? "" : " failed") }.joined(separator: ", "), systemImage: "checkmark.circle")
                    .font(.caption).foregroundStyle(acts.allSatisfy(\.ok) ? Color.green : Color.orange)
            }
        }
        .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
    }
}

/// A host command the assistant wants to run. Nothing runs until Run is tapped (or the owner says yes).
struct ApprovalCard: View {
    var action: PendingAction
    var onRun: () -> Void
    var onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Waiting for your OK on \(action.host)\(action.purpose.map { ": \($0)" } ?? "")").font(.caption).foregroundStyle(.secondary)
            Text(action.command).font(.callout.monospaced()).textSelection(.enabled)
                .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            if let p = action.preflight {
                VStack(alignment: .leading, spacing: 2) { Text(p.backup); Text(p.verify); Text(p.rollback) }.font(.caption).foregroundStyle(.orange)
            }
            HStack {
                Button("Run it", action: onRun).buttonStyle(.borderedProminent)
                Button("Cancel", role: .cancel, action: onCancel).buttonStyle(.bordered)
            }
        }
        .padding(12)
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(action.risk == "high" ? Color.red : Color.orange, lineWidth: 1.5))
    }
}

/// An image stored with a chat, fetched from the hub (it needs the hub token, so no plain URL).
struct HubImageView: View {
    @EnvironmentObject var engine: SyncEngine
    var id: String
    @State private var data: Data?
    @State private var zoomed = false

    var body: some View {
        Group {
            if let d = data {
                ImageFromData(data: d).clipShape(RoundedRectangle(cornerRadius: 8))
                    .onTapGesture { zoomed = true }
                    .accessibilityAddTraits(.isButton)
                    .accessibilityHint("Opens it full screen")
            } else { RoundedRectangle(cornerRadius: 8).fill(Color.secondary.opacity(0.15)).frame(width: 80, height: 80).overlay(Image(systemName: "photo")) }
        }
        .task(id: id) { data = await HubImageCache.shared.data(id, client: engine.client) }
        #if os(iOS)
        .fullScreenCover(isPresented: $zoomed) { ChatImageZoom(id: id, data: data) }
        #else
        .sheet(isPresented: $zoomed) { ChatImageZoom(id: id, data: data).frame(minWidth: 700, minHeight: 560) }
        #endif
    }
}

/// A chat picture full screen with zoom and Share.
struct ChatImageZoom: View {
    @Environment(\.dismiss) private var dismiss
    var id: String
    var data: Data?
    var body: some View {
        NavigationStack {
            ZoomableImage(data: data)
                .background(Color.black)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                    ToolbarItem(placement: .primaryAction) { ImageShareButton(id: id) }
                }
        }
    }
}

struct ImageFromData: View {
    var data: Data
    var body: some View {
        #if os(macOS)
        if let img = NSImage(data: data) { Image(nsImage: img).resizable().scaledToFit() } else { Image(systemName: "photo") }
        #else
        if let img = UIImage(data: data) { Image(uiImage: img).resizable().scaledToFit() } else { Image(systemName: "photo") }
        #endif
    }
}

/// Already-tried ledger for a troubleshooting chat.
struct LedgerPanel: View {
    @EnvironmentObject var engine: SyncEngine
    var sessionId: String

    var body: some View {
        let ledger = engine.ledgers.first { $0.str("session_id") == sessionId }?.decoded(LedgerFields.self)
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Ledger").font(.headline)
                if let l = ledger {
                    Text(l.topic).font(.subheadline.weight(.semibold))
                    group("Tried", l.tried?.map { "\($0.what): \($0.result)" } ?? [])
                    group("Ruled out", l.ruled_out ?? [])
                    group("Confirmed", l.confirmed ?? [])
                    Text(l.open ?? true ? "Open" : "Closed").font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("No ledger yet. The hub opens one when a chat turns into troubleshooting.").font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding()
        }
    }

    @ViewBuilder
    private func group(_ title: String, _ items: [String]) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(items, id: \.self) { Text(StyleGuard.dashes($0)).font(.caption) }
            }
        }
    }
}

/// An assistant reply as formatted text: paragraphs with bold, italics, inline code and links; headings; bullet and
/// numbered lists; code blocks in a monospaced box with Copy.
struct ReplyMarkdown: View {
    var text: String

    private func inline(_ s: String) -> Text {
        if let a = try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) { return Text(a) }
        return Text(s)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(ReplyBlocks.parse(text).enumerated()), id: \.offset) { _, b in
                switch b {
                case .heading(let s): inline(s).font(.headline).padding(.top, 2)
                case .bullet(let s, let indent):
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text("\u{2022}").foregroundStyle(.secondary)
                        inline(s)
                    }
                    .padding(.leading, CGFloat(indent) * 14)
                case .numbered(let s, let label):
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(label).monospacedDigit().foregroundStyle(.secondary)
                        inline(s)
                    }
                case .text(let s): inline(s)
                case .code(let s):
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(s).font(.system(.callout, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(8)
                            .background(Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
                        Button("Copy") { MakingClipboard.copy(s) }.font(.caption).buttonStyle(.borderless)
                    }
                case .gap: Color.clear.frame(height: 4)
                }
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
