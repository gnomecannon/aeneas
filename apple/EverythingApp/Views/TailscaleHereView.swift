import SwiftUI
import EACore
import EATailnet
#if os(iOS)
import SafariServices
#endif

/// "Tailscale in Aeneas": for a hub on Tailscale, sign in to Tailscale inside the app instead of installing the
/// Tailscale app. Shown in Settings, Connection, and on the setup screen when a Tailscale hub could not be reached.
struct TailscaleHereView: View {
    @ObservedObject private var tailnet = TailnetSignIn.shared
    @EnvironmentObject var model: AppModel
    @State private var showInfo = false
    @State private var confirmSignOut = false
    @State private var page: URL?
    /// On the setup screen: say why it is offered.
    var forSetup = false

    static let info = "Aeneas signs in to Tailscale for itself, so this device doesn't need the Tailscale app. It joins your Tailscale network as one more device, named \"aeneas-\" and this device's name, and only Aeneas uses it: it isn't a VPN for the rest of the device. You sign in on Tailscale's own page; Aeneas never sees your password. Tailscale sees what it sees with its own app: your account, this device's name and when it's online. Sign out here at any time. If the Tailscale app is already on this device and on, you don't need this."

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(forSetup ? "This hub is on Tailscale" : "Tailscale in Aeneas").font(.headline)
                Spacer()
                Button { withAnimation { showInfo.toggle() } } label: {
                    Image(systemName: showInfo ? "info.circle.fill" : "info.circle")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("About Tailscale in Aeneas")
                .accessibilityIdentifier("tailnet.info")
            }
            if showInfo {
                Text(Self.info).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            switch tailnet.state {
            case .off:
                Text(forSetup
                     ? "This device can't reach it. Sign in to Tailscale here, with the account your hub uses, and Aeneas tries again."
                     : "Without the Tailscale app on this device, sign in to Tailscale here instead.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Button { tailnet.start(deviceName: model.config.deviceName) } label: {
                    Label("Sign in to Tailscale here", systemImage: "person.badge.key")
                }
                .accessibilityIdentifier("tailnet.start")
            case .starting:
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Starting Tailscale").foregroundStyle(.secondary)
                    Spacer()
                    Button("Cancel") { Task { await tailnet.signOut() } }
                }
            case .signIn(let url):
                Text("Sign in on Tailscale's page with the account your hub uses. Aeneas carries on by itself once you're in.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button { open(url) } label: { Label("Open Tailscale's sign-in page", systemImage: "safari") }
                        .accessibilityIdentifier("tailnet.signin")
                    Spacer()
                    Button("Cancel") { Task { await tailnet.signOut() } }
                        .accessibilityIdentifier("tailnet.cancel")
                }
            case .connected(let network):
                Label(network.map { "Connected to \($0)" } ?? "Connected", systemImage: "checkmark.circle")
                    .foregroundStyle(.green)
                Button("Sign out of Tailscale here", role: .destructive) { confirmSignOut = true }
            case .failed(let message):
                Label(message, systemImage: "xmark.circle").foregroundStyle(.red).font(.callout)
                Button("Try again") { tailnet.resume() }
            }
        }
        .onChange(of: tailnet.state) { _, s in
            // The sign-in page opens by itself once; it closes by itself once Tailscale is connected.
            if case .signIn(let url) = s, page == nil { open(url) }
            if case .connected = s { page = nil }
        }
        .confirmationDialog("Sign out of Tailscale here?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) { Task { await tailnet.signOut() } }
        } message: {
            Text("This device leaves your Tailscale network and can't reach your hub through it until you sign in again. Remove it from your Tailscale account too, on Tailscale's Machines page.")
        }
        #if os(iOS)
        .sheet(item: $page) { url in SafariPage(url: url).ignoresSafeArea() }
        #endif
    }

    private func open(_ url: URL) {
        #if os(iOS)
        page = url
        #else
        NSWorkspace.shared.open(url)
        #endif
    }
}

#if os(iOS)
extension URL: @retroactive Identifiable { public var id: String { absoluteString } }

private struct SafariPage: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
}
#endif
