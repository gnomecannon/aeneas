import SwiftUI
import EACore
import EATailnet

/// First run: the hub's address, a one-time pairing code from a device that is already paired (or the hub's Welcome
/// page), and this device's name. The code is traded for this device's own key, kept in the Keychain.
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
                Text("Pair this device with your hub. The easiest way: scan the QR code with the Camera. The first time, it is on the hub's Welcome page (step 5, Make a pairing code); later, on any paired device under Settings, Connection, Pair another device. Scanning also lets this device check the hub's own certificate on a home network, so prefer it to typing.")
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
                    TextField("The address the installer printed", text: $hubURL)
                        .textFieldStyle(.roundedBorder)
                        .font(.title3)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("setup.hub")
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
                    Label(e, systemImage: "xmark.circle").foregroundStyle(.red).font(.body)
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
                        .foregroundStyle(testOK ? Color.green : Color.red)
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
                testResult = Self.plain((error as? HubError)?.errorDescription ?? error.localizedDescription)
            }
            testing = false
        }
    }

    private func pair() {
        pairing = true
        error = nil
        Task {
            error = await model.pair(hub: hubURL, code: code, name: deviceName).map(Self.plain)
            if error == nil { code = "" }
            pairing = false
        }
    }

    /// A hub on a home network has its own certificate, which this device can only check with the fingerprint a
    /// scanned code or opened link carries; typed by hand, the system refuses it with a message about an invalid
    /// certificate. Say what to do instead.
    static func plain(_ message: String) -> String {
        let m = message.lowercased()
        guard m.contains("certificate") || m.contains("-1202") || m.contains("trust") else { return message }
        return "This hub uses its own certificate, which this device can check only from the pairing QR code or link. Scan the QR code on the hub's Welcome page (or open its link on this device) instead of typing the address."
    }
}

/// The hub said this device was removed (Settings, Devices on another device). Its key is gone.
struct RemovedDeviceView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Image(systemName: "xmark.shield").font(.system(size: 44)).foregroundStyle(.orange)
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
