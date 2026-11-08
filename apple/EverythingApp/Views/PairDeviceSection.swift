import SwiftUI
import CoreImage.CIFilterBuiltins
import EACore

/// Settings, Connection: a one-time code that pairs another iPhone, iPad, Mac or a browser with this hub. The code is
/// shown large to type, and as a QR code the other device's Camera opens. It works once, for 10 minutes, and gives the
/// new device a key of its own, so a photo of it or an old message is useless afterwards.
struct PairDeviceSection: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var name = ""
    @State private var links: PairingLinks?
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        SwiftUI.Section {
            LabeledContent("New device") {
                TextField("New device", text: $name, prompt: Text("iPad"))
                    .multilineTextAlignment(.trailing)
            }
            if let links {
                if let code = links.code {
                    Text(code)
                        .font(.system(size: 44, weight: .semibold, design: .monospaced))
                        .frame(maxWidth: .infinity)
                        .textSelection(.enabled)
                        .accessibilityLabel("Pairing code \(code.map(String.init).joined(separator: " "))")
                }
                if let image = qr(links.app) {
                    image.interpolation(.none).resizable().scaledToFit().frame(maxWidth: 240).padding(8).background(Color.white).clipShape(RoundedRectangle(cornerRadius: 8))
                        .frame(maxWidth: .infinity)
                        .accessibilityLabel("QR code that pairs the new device")
                }
                if let expires = links.expires {
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        Text(Self.timeLeft(until: expires, now: ctx.date))
                            .font(.callout).foregroundStyle(expires > ctx.date ? Color.secondary : Color.orange)
                            .frame(maxWidth: .infinity)
                    }
                }
                if links.carriesSharedKey {
                    Text("Your hub is older and this code holds its shared key, which lasts. Show it only to your own devices, and update the hub.")
                        .font(.caption).foregroundStyle(.orange)
                }
                Button(links.code == nil ? "Make another" : "Make another code") { make() }.disabled(busy)
                Button("Hide the code") { self.links = nil }
            } else {
                Button(busy ? "Making a code" : "Make a pairing code") { make() }
                    .disabled(engine.client == nil || busy)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        } header: {
            Text("Pair another device")
        } footer: {
            Text("On the new device, scan the QR code with the Camera, or open Aeneas and type the code with this hub's address. The code works once, for 10 minutes.")
        }
        .themedRow()
    }

    private func make() {
        let n = name.trimmingCharacters(in: .whitespaces)
        busy = true
        Task {
            do {
                guard let c = engine.client else { throw HubError.notConfigured }
                links = try await withDeadline(20) { try await c.pairing(name: n.isEmpty ? "New device" : n) }
                error = nil
            } catch {
                self.error = (error as? HubError)?.errorDescription ?? error.localizedDescription
            }
            busy = false
        }
    }

    /// "9 min 41 s left", or that it ran out.
    static func timeLeft(until end: Date, now: Date) -> String {
        let s = Int(end.timeIntervalSince(now).rounded(.down))
        if s <= 0 { return "This code ran out. Make another." }
        return s >= 60 ? "Works for \(s / 60) min \(s % 60) s more" : "Works for \(s) s more"
    }

    private func qr(_ text: String) -> Image? {
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(text.utf8)
        f.correctionLevel = "M"
        guard let out = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)), let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return Image(decorative: cg, scale: 1)
    }
}
