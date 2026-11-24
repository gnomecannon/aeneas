import SwiftUI
import EACore
import EALink

// Joining with a phone's yes (CONTRACT.md, Devices): a Mac or iPad in Set up shows a QR code, a phone that is already
// paired scans it and says yes, and the phone's hub reaches the new device over Direct link and hands it a pairing link.
// Nothing is typed, so it works for a hub with no address to type (Direct link) and for one with its own certificate.

/// Set up on a Mac or iPad: the code a paired phone scans. The endpoint lives while Set up shows, and stops once a hub
/// has handed this device a link.
struct PhoneJoinCard: View {
    @EnvironmentObject var model: AppModel
    /// The Device name field in Set up: the phone shows it, and the hub pairs this device under it.
    var name: String

    enum Phase: Equatable {
        case starting
        case ready(node: String, relay: String, secret: String)
        case pairing
        case failed(String)
    }

    @State private var phase: Phase = .starting
    /// Bumped by Try again: a new endpoint and a new secret.
    @State private var attempt = 0

    private var kind: JoinLink.Kind { model.platform == .ipad ? .ipad : .mac }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Pair with your phone").font(.title2.bold())
            Text("On a phone that already uses Aeneas, open the Camera and point it at this code, then tap Add on the phone.")
            Group {
                switch phase {
                case .starting:
                    HStack(spacing: 10) { ProgressView(); Text("Getting ready") }
                case .ready(let node, let relay, let secret):
                    let link = JoinLink(node: node, relay: relay, secret: secret, name: name.isEmpty ? SharedConfig.defaultDeviceName : name, platform: kind)
                    if let text = link.url?.absoluteString, let image = PairDeviceSection.qr(text) {
                        image.interpolation(.none).resizable().scaledToFit()
                            .frame(maxWidth: 260)
                            .padding(10).background(Color.white).clipShape(RoundedRectangle(cornerRadius: 10))
                            .frame(maxWidth: .infinity)
                            .accessibilityLabel("QR code for your phone to scan")
                    }
                case .pairing:
                    HStack(spacing: 10) { ProgressView(); Text("Your phone said yes. Pairing...") }
                case .failed(let why):
                    VStack(alignment: .leading, spacing: 10) {
                        Label(why, systemImage: "xmark.circle").foregroundStyle(.dangerText)
                        Button("Try again") { attempt += 1 }
                            .accessibilityIdentifier("setup.join.again")
                    }
                }
            }
            .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
            Text("This works with a hub on Direct link. A hub on Tailscale takes its address and a pairing code below.")
                .font(.callout).foregroundStyle(.secondary)
        }
        .helperCard()
        .task(id: attempt) { await listen() }
    }

    private func listen() async {
        phase = .starting
        let listener = JoinListener()
        // Ends when Set up goes away (the task is cancelled, which stops the endpoint) or after a join.
        for await event in listener.events() {
            switch event {
            case .ready(let node, let relay, let secret):
                if phase != .pairing { phase = .ready(node: node, relay: relay, secret: secret) }
            case .failed(let why):
                phase = .failed(why)
            case .joined(let link):
                phase = .pairing
                // Not this task: Set up goes away as soon as the device is paired, which cancels it, and the rest of
                // pairing (and asking the hub its name) must not stop with it.
                let error = await Task { @MainActor in
                    let e = await model.connect(link)
                    if e == nil { await model.notePaired() }
                    return e
                }.value
                if let error { phase = .failed(SetupView.plain(error, platform: model.platform)) }
                await listener.stop()
            }
        }
    }
}

/// The phone's side: another device's code, opened from the Camera. Asked once; on Add the hub does the rest.
struct JoinRequestSheet: View {
    @EnvironmentObject var model: AppModel
    let link: JoinLink
    @State private var working = false
    @State private var result: (text: String, ok: Bool)?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(link.platform.label, systemImage: DevicesSection.symbol(link.platform.rawValue))
                .font(.headline).foregroundStyle(.secondary)
            Text("Add \(link.name) to your hub?").font(.title2.bold())
            Text("Only do this for a computer in front of you that shows this code.")
            if let result {
                Label(result.text, systemImage: result.ok ? "checkmark.circle" : "xmark.circle")
                    .foregroundStyle(result.ok ? StatusStyle.okText : StatusStyle.dangerText)
                BigButton(title: "Done", prominent: true) { model.pendingJoin = nil }
                    .accessibilityIdentifier("join.done")
            } else if working {
                HStack(spacing: 10) { ProgressView(); Text("Reaching \(link.name)...") }
            } else {
                HStack(spacing: 12) {
                    BigButton(title: "Cancel") { model.pendingJoin = nil }
                        .accessibilityIdentifier("join.cancel")
                    BigButton(title: "Add", symbol: "plus", prominent: true) { add() }
                        .accessibilityIdentifier("join.add")
                }
            }
            Spacer(minLength: 0)
        }
        .font(.title3)
        .padding(24)
        .frame(maxWidth: 560, alignment: .leading)
        // While the hub works, a swipe must not hide how it ends.
        .interactiveDismissDisabled(working)
        #if os(iOS)
        .presentationDetents([.medium, .large])
        #else
        .frame(minWidth: 420, minHeight: 260)
        #endif
    }

    private func add() {
        working = true
        Task {
            result = await model.join(link)
            working = false
        }
    }
}

/// Questions and answers about pairing links and join codes, over whatever is on screen. On the iPhone Settings is a
/// sheet, and nothing opens under it, so they are attached to that sheet too; `active` keeps only one copy presenting.
struct PairingPrompts: ViewModifier {
    @EnvironmentObject var model: AppModel
    var active: Bool

    private func shown<T>(_ value: ReferenceWritableKeyPath<AppModel, T?>) -> Binding<Bool> {
        Binding(get: { active && model[keyPath: value] != nil }, set: { if !$0, active { model[keyPath: value] = nil } })
    }

    func body(content: Content) -> some View {
        content
            .alert("Switch this device to another hub?", isPresented: shown(\.pendingSetup), presenting: model.pendingSetup) { p in
                Button("Switch hubs", role: .destructive) {
                    model.pendingSetup = nil
                    Task { await model.connectAndReport(p.link) }
                }
                Button("Keep the current hub", role: .cancel) { model.pendingSetup = nil }
            } message: { p in
                // The same address names another certificate than the one this device checks for (AppModel.useSetupLink).
                Text(p.link.hubId != nil && p.currentId != nil && p.link.hubId != p.currentId
                     ? "This link is for another hub than the one this device uses now (\(p.current)). Switch only if you made this link yourself."
                     : AppModel.sameHub(p.hub, p.current)
                     ? "This link is for \(p.hub), the hub this device uses now, but it names another certificate than the one this device trusts. Switch only if you made this link yourself."
                     : "This link connects to \(p.hub). This device uses \(p.current) now. Switch only if you made this link yourself.")
            }
            .alert("This device is already paired with \(model.currentHubLabel). Pair it again?", isPresented: shown(\.pendingRepair), presenting: model.pendingRepair) { link in
                Button("Pair again") {
                    model.pendingRepair = nil
                    Task { await model.connectAndReport(link) }
                }
                Button("Cancel", role: .cancel) { model.pendingRepair = nil }
            }
            .alert(model.pairingNotice?.title ?? "", isPresented: shown(\.pairingNotice), presenting: model.pairingNotice) { _ in
                Button("OK") { model.pairingNotice = nil }
            } message: { n in
                if let m = n.message { Text(m) }
            }
            .sheet(item: Binding(get: { active ? model.pendingJoin : nil }, set: { if $0 == nil, active { model.pendingJoin = nil } })) { j in
                JoinRequestSheet(link: j).environmentObject(model)
            }
    }
}

extension View {
    func pairingPrompts(active: Bool) -> some View { modifier(PairingPrompts(active: active)) }
}
