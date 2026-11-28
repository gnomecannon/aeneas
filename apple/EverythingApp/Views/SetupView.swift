import SwiftUI
import EACore
import EATailnet

/// First run: the hub's address, a one-time pairing code from a device that is already paired (or the hub's Welcome
/// page), and this device's name. The code is traded for this device's own key, kept in the Keychain. A Mac or iPad
/// also shows a code for a paired phone to scan (PhoneJoinCard), since it cannot scan one, and a pairing link pasted
/// into either field pairs at once. Also shown over a paired device for Pair again (`AppModel.pairingAgain`), with Back.
struct SetupView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @State private var hubURL: String = ""
    @State private var code: String = ""
    @State private var deviceName: String = ""
    @State private var testing = false
    @State private var testResult: String?
    @State private var testOK = false
    @State private var pairing = false
    @State private var error: String?
    @ObservedObject private var tailnet = TailnetSignIn.shared

    /// No hub yet: how to set one up (the guide on GitHub, also the Mac's Help menu).
    static let hubGuideURL = URL(string: "https://github.com/gnomecannon/aeneas#readme")!

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                // Order by how many people take each path: pairing with their own hub first, an invitation (only family
                // members joining someone else's hub have one) second, no hub yet third, typing last.
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.pairingAgain ? "Pair again" : "Set up").font(.largeTitle.bold())
                    if model.pairingAgain {
                        Button { model.pairingAgain = false } label: { Label("Back", systemImage: "chevron.backward") }
                            .accessibilityIdentifier("setup.back")
                    }
                }
                // A Mac or iPad cannot scan a code, and a hub on Direct link has no address to type: a phone that is
                // already paired scans this device's code instead.
                if model.platform != .iphone {
                    PhoneJoinCard(name: deviceName.trimmingCharacters(in: .whitespacesAndNewlines))
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Pair with your hub").font(.title2.bold())
                        Text("Scan the pairing QR code with the iPhone's Camera.").font(.title3)
                        Text(Self.scanWhere).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
                // What went wrong with a link opened from the Camera or a message: right under the way to scan again.
                if let e = model.setupError {
                    Label(e, systemImage: "xmark.circle").foregroundStyle(.dangerText).font(.body)
                }

                InvitationCard()

                if !model.pairingAgain {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("No hub yet?").font(.title3.weight(.semibold))
                        Link(destination: Self.hubGuideURL) { Label("How to set up a hub", systemImage: "book") }
                            .accessibilityIdentifier("setup.guide")
                        Button { Task { await model.startSample() } } label: { Label("Try it with sample data", systemImage: "sparkles") }
                            .accessibilityIdentifier("setup.sample")
                        Text("A made-up month to look around. Nothing leaves this device.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Or type the address and code").font(.title3.weight(.semibold))
                    Text("Make a code on a paired device: Settings, Connection, Pair another device. A pairing link pasted here pairs at once.")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Hub address").font(.headline)
                    TextField("The address the installer printed, or a pairing link", text: $hubURL)
                        .textFieldStyle(.roundedBorder)
                        .font(.title3)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("setup.hub")
                        .onChange(of: hubURL) { _, t in pasted(t) }
                        #if os(iOS)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        #endif
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Pairing code").font(.headline)
                    TextField("ABCD-EFGH", text: $code)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.title2, design: .monospaced))
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("setup.code")
                        .onChange(of: code) { _, t in pasted(t) }
                        #if os(iOS)
                        .textInputAutocapitalization(.characters)
                        #endif
                    Text("8 letters and numbers. It works once, for 10 minutes.").font(.footnote).foregroundStyle(.secondary)
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Device name").font(.headline)
                    TextField(SharedConfig.defaultDeviceName, text: $deviceName)
                        .textFieldStyle(.roundedBorder)
                        .font(.title3)
                        .accessibilityIdentifier("setup.name")
                }

                BigButton(title: pairing ? "Pairing" : "Pair this device", symbol: "checkmark", prominent: true) { pair() }
                    .disabled(pairing || hubURL.trimmingCharacters(in: .whitespaces).isEmpty || code.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityIdentifier("setup.pair")

                if let e = error {
                    Label(e, systemImage: "xmark.circle").foregroundStyle(.dangerText).font(.body)
                }
                // A hub on Tailscale that this device can't reach: sign in to Tailscale here, and pairing goes again.
                if model.unreachedSetup != nil || tailnet.state != .off {
                    TailscaleHereView(forSetup: true)
                        .padding(14)
                        .background(RoundedRectangle(cornerRadius: 14).fill(Color.secondary.opacity(0.08)))
                }

                BigButton(title: testing ? "Checking" : "Check the address", symbol: "antenna.radiowaves.left.and.right") { test() }
                    .disabled(testing || hubURL.isEmpty)
                if let r = testResult {
                    Label(r, systemImage: testOK ? "checkmark.circle" : "xmark.circle")
                        .foregroundStyle(testOK ? StatusStyle.okText : StatusStyle.dangerText)
                        .font(.body)
                }
            }
            .padding(24)
            .frame(maxWidth: 560)
        }
        #if DEBUG
        // Screenshots of the typed pairing below the fold (`-scrollToRows YES`), as on the Watch: no taps needed.
        .defaultScrollAnchor(UserDefaults.standard.bool(forKey: "scrollToRows") ? .bottom : .top)
        #endif
        .onAppear {
            hubURL = model.config.hubURL
            deviceName = model.config.deviceName
        }
    }

    private func test() {
        testing = true
        testResult = nil
        Task {
            do {
                let h = try await engine.testAddress(hubURL)
                testOK = true
                // The hub tells its version only to a paired device.
                testResult = h.version.map { "The hub answers, version \($0)" } ?? "The hub answers."
            } catch {
                testOK = false
                testResult = Self.plain((error as? HubError)?.errorDescription ?? error.localizedDescription, platform: model.platform)
            }
            testing = false
        }
    }

    private func pair() {
        pairing = true
        error = nil
        Task {
            let platform = model.platform
            error = await model.pair(hub: hubURL, code: code, name: deviceName).map { Self.plain($0, platform: platform) }
            if error == nil { code = "" }
            pairing = false
        }
    }

    /// A pairing link pasted into the address or code field (from a message, or copied on a computer): it carries the
    /// address, the code and the hub's certificate, so it pairs at once, the same as opening it. A Direct link hub has
    /// no address to type at all.
    private func pasted(_ text: String) {
        guard !pairing, let link = SetupLink.find(in: text) else { return }
        var l = link
        // A name typed here wins over the one in the link (what the other device called this one).
        let typed = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.isEmpty, typed != model.config.deviceName { l.name = typed }
        hubURL = link.hub
        if case .code(let c) = link.credential { code = PairingCode.display(c) } else { code = "" }
        pairing = true
        error = nil
        let platform = model.platform
        Task {
            error = await model.connect(l).map { Self.plain($0, platform: platform) }
            if error == nil { code = "" }
            pairing = false
        }
    }

    /// The iPhone's usual way to pair: the Camera and the pairing QR code. The Welcome page's step is named, not
    /// numbered: its number moves with the modules that are on (Machines adds a step before it).
    static let scanWhere = "It is on your hub's Welcome page, in the Your other devices step, or on a paired device under Settings, Connection, Pair another device. Opening the pairing link on this iPhone works too."

    /// A hub on a home network has its own certificate, which this device can only check with the fingerprint a
    /// scanned code or opened link carries; typed by hand, the system refuses it with a message about an invalid
    /// certificate. Say what to do instead, in the ways this kind of device can.
    static func plain(_ message: String, platform: Platform) -> String {
        let m = message.lowercased()
        guard m.contains("certificate") || m.contains("-1202") || m.contains("trust") else { return message }
        if platform == .iphone {
            return "This hub uses its own certificate, which this device can check only from the pairing QR code or link. Scan the pairing QR code (on the hub's Welcome page, or on a paired device under Settings, Connection, Pair another device), or open its link on this phone, instead of typing the address."
        }
        return "This hub uses its own certificate, which this device can check only from a pairing link. Pair with your phone and the code above, or paste a pairing link into the hub address field, instead of typing the address."
    }
}

/// The hub said this device was removed (Settings, Devices on another device). Its key is gone.
struct RemovedDeviceView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Image(systemName: "xmark.shield").font(.system(size: 44)).foregroundStyle(.warnText)
            Text("This device was removed").font(.largeTitle.bold())
            Text("It was removed from your hub, so it no longer syncs, and what it held from the hub was cleared from it. Everything is still on your hub. To use it again, pair it with a new code from a device that is still paired.")
                .foregroundStyle(.secondary)
            BigButton(title: "Pair again", symbol: "qrcode.viewfinder", prominent: true) { model.startPairingAgain() }
                .accessibilityIdentifier("removed.pair")
        }
        .padding(24)
        .frame(maxWidth: 560)
    }
}
