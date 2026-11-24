import SwiftUI
import CoreImage.CIFilterBuiltins
import EACore
#if canImport(UIKit)
import UIKit
#endif

/// Settings, Connection: a one-time code that pairs another iPhone, iPad, Mac or a browser with this hub. The code is
/// shown large to type, and as a QR code the other device's Camera opens. It works once, for 10 minutes, and gives the
/// new device a key of its own, so a photo of it or an old message is useless afterwards.
struct PairDeviceSection: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var name = ""
    @State private var links: PairingLinks?
    @State private var error: String?
    @State private var busy = false
    /// The Mac's Copy was used for the code on screen.
    @State private var copied = false

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
                if let image = Self.qr(links.app) {
                    image.interpolation(.none).resizable().scaledToFit().frame(maxWidth: 240).padding(8).background(Color.white).clipShape(RoundedRectangle(cornerRadius: 8))
                        .frame(maxWidth: .infinity)
                        .accessibilityLabel("QR code that pairs the new device")
                }
                #if os(macOS)
                // A Mac cannot scan its own screen: the link the QR code holds, to copy or send to the new device.
                HStack(spacing: 8) {
                    Text(links.app).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(2).truncationMode(.middle).textSelection(.enabled)
                    Spacer(minLength: 0)
                    Button(copied ? "Copied" : "Copy") {
                        MakingClipboard.copy(links.app)
                        copied = true
                    }
                    .controlSize(.small)
                    .accessibilityLabel(copied ? "Copied" : "Copy the link")
                }
                #endif
                if let expires = links.expires {
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        Text(Self.timeLeft(until: expires, now: ctx.date))
                            .font(.callout).foregroundStyle(expires > ctx.date ? AnyShapeStyle(.secondary) : AnyShapeStyle(.warnText))
                            .frame(maxWidth: .infinity)
                    }
                }
                if links.link == "direct" {
                    Text("Direct link needs Aeneas 1.0.3 or newer on the new device. If scanning does nothing, update the app there first.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if links.carriesSharedKey {
                    Text("Your hub is older and this code holds its shared key, which lasts. Show it only to your own devices, and update the hub.")
                        .font(.caption).foregroundStyle(.warnText)
                }
                Button(links.code == nil ? "Make another" : "Make another code") { make() }.disabled(busy)
                Button("Hide the code") { self.links = nil }
            } else {
                Button(busy ? "Making a code" : "Make a pairing code") { make() }
                    .disabled(engine.client == nil || busy)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.dangerText) }
        } header: {
            Text("Pair another device")
        } footer: {
            Text(Self.footer)
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
                copied = false
                error = nil
            } catch {
                self.error = (error as? HubError)?.errorDescription ?? error.localizedDescription
            }
            busy = false
        }
    }

    /// A new phone scans this code. A Mac, iPad, Windows PC or Android tablet shows a code of its own instead, which a
    /// paired phone scans (JoinRequestSheet), since a computer cannot scan this one.
    private static var footer: String {
        #if os(iOS)
        let camera = UIDevice.current.userInterfaceIdiom == .phone ? "this phone's Camera" : "the Camera of a phone that uses Aeneas"
        #else
        let camera = "the Camera of a phone that uses Aeneas"
        #endif
        return "Scan the QR code with a new phone's Camera, or type the code with this hub's address in Aeneas on the new device. The code works once, for 10 minutes. A Mac, iPad, Windows PC or Android tablet can also be added by opening Aeneas on it and pointing \(camera) at the code it shows."
    }

    /// "9 min 41 s left", or that it ran out.
    static func timeLeft(until end: Date, now: Date) -> String {
        let s = Int(end.timeIntervalSince(now).rounded(.down))
        if s <= 0 { return "This code ran out. Make another." }
        return s >= 60 ? "Works for \(s / 60) min \(s % 60) s more" : "Works for \(s) s more"
    }

    /// A QR code for `text`, drawn sharp at any size (also the join code in Set up, PhoneJoinCard).
    static func qr(_ text: String) -> Image? {
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(text.utf8)
        f.correctionLevel = "M"
        guard let out = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)), let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return Image(decorative: cg, scale: 1)
    }
}
