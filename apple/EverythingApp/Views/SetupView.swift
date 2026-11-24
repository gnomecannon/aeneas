import SwiftUI
import EACore
import EATailnet

/// First run: the hub's address, a one-time pairing code from a device that is already paired (or the hub's Welcome
/// page), and this device's name. The code is traded for this device's own key, kept in the Keychain. A Mac or iPad
/// also shows a code for a paired phone to scan (PhoneJoinCard), since it cannot scan one, and a pairing link pasted
/// into either field pairs at once.
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

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Set up").font(.largeTitle.bold())
                // A Mac or iPad cannot scan a code, and a hub on Direct link has no address to type: a phone that is
                // already paired scans this device's code instead.
                if model.platform != .iphone { PhoneJoinCard(name: deviceName.trimmingCharacters(in: .whitespacesAndNewlines)) }
                // Someone who was sent an invitation (People on this machine on a family member's hub), large.
                InvitationCard()
                Text(Self.intro(model.platform))
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 6) {
                    Text("No hub yet? Look around first with a made-up month of sample data. Nothing leaves this device, and setting up your hub later wipes it.")
                        .font(.body).foregroundStyle(.secondary)
                    Button { Task { await model.startSample() } } label: { Label("Try it with sample data", systemImage: "sparkles") }
                        .font(.body.weight(.semibold))
                        .accessibilityIdentifier("setup.sample")
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

                if let e = error ?? model.setupError {
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

    /// The ways to pair this kind of device. A Mac cannot scan a code, and someone setting up away from the hub cannot
    /// open its Welcome page, so a Mac or iPad is pointed at the phone card, a code, or a pasted link.
    static func intro(_ platform: Platform) -> String {
        if platform == .iphone {
            return "Pair this device with your hub. The easiest way: scan the pairing QR code with the Camera. The first time, it is on the hub's Welcome page (step 5, Make a pairing code); later, on a paired device under Settings, Connection, Pair another device. Or open the pairing link on this phone. Both let this device check the hub's own certificate on a home network, so prefer them to typing."
        }
        return "Pair this device with your hub. The easiest way is the code above, scanned by a phone that already uses Aeneas. For a hub on Tailscale, type its address and a pairing code made on a paired device (Settings, Connection, Pair another device). You can also paste a pairing link into the hub address field."
    }

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
            Text("It was removed from your hub, so it no longer syncs. What is on it stays here. To use it again, pair it with a new code from a device that is still paired.")
                .foregroundStyle(.secondary)
            BigButton(title: "Pair again", symbol: "qrcode.viewfinder", prominent: true) { model.startPairingAgain() }
                .accessibilityIdentifier("removed.pair")
        }
        .padding(24)
        .frame(maxWidth: 560)
    }
}
