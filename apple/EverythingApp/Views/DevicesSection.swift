import SwiftUI
import EACore

/// Settings, Connection, Devices: every device paired with the hub (`GET /devices`), with Remove on each. Removing a
/// device ends its key at once; it is told so the next time it asks. On this device the button signs it out. A device
/// that cannot reach its hub can still forget it here, so it is never stuck with a hub that is gone.
struct DevicesSection: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var engine: SyncEngine
    @State private var devices: [PairedDevice]?
    @State private var message: String?
    @State private var tooOld = false
    @State private var confirm: PairedDevice?
    /// The hub did not answer the list or Remove this device: Forget the hub on this device is offered.
    @State private var unreachable = false
    @State private var confirmForget = false
    @State private var watchRemoved = SharedConfig.shared.watchRemoved

    var body: some View {
        SwiftUI.Section {
            if tooOld {
                Text("Your hub does not list devices yet. Update the hub to see them and remove one.")
                    .font(.callout).foregroundStyle(.secondary)
            } else if let devices {
                if devices.isEmpty { Text("No devices").foregroundStyle(.secondary) }
                ForEach(devices) { d in row(d) }
            } else if message == nil {
                ProgressView().frame(maxWidth: .infinity)
            }
            #if os(iOS)
            if watchRemoved {
                Button("Pair the Watch again") {
                    Task {
                        await WatchKeys.shared.allowAgain()
                        watchRemoved = false
                        message = "The Watch gets a new key the next time it syncs."
                    }
                }
            }
            #endif
            if let message { Text(message).font(.caption).foregroundStyle(.secondary) }
            if unreachable {
                Text("This device cannot reach your hub. It can still stop using it.")
                    .font(.callout).foregroundStyle(.secondary)
                Button("Forget the hub on this device", role: .destructive) { confirmForget = true }
                    .accessibilityIdentifier("devices.forget")
            }
        } header: {
            Text("Devices")
        } footer: {
            Text("Each device has its own key. Remove one you no longer use, or one that was lost: it stops syncing at once and has to be paired again.")
        }
        .themedRow()
        .task { await load() }
        .confirmationDialog(confirmTitle, isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible, presenting: confirm) { d in
            Button(d.current == true ? "Remove this device" : "Remove \(d.name)", role: .destructive) { remove(d) }
        } message: { d in
            Text(d.current == true
                 ? "This device signs out and stops syncing. What is on it stays here. To use it again, pair it with a new code."
                 : "\(d.name) stops syncing at once. To use it again, pair it with a new code.")
        }
        .confirmationDialog("Forget the hub on this device?", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("Forget the hub", role: .destructive) { model.forgetHub() }
        } message: {
            Text("Your hub still lists this device until you remove it from another device, under Settings, Connection, Devices. This device stops syncing and goes back to Set up. What is on it stays here.")
        }
    }

    private var confirmTitle: String { confirm?.current == true ? "Remove this device?" : "Remove \(confirm?.name ?? "this device")?" }

    private func row(_ d: PairedDevice) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Image(systemName: Self.symbol(d.platform)).frame(width: 24).foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(d.name.isEmpty ? d.platform : d.name)
                    if d.current == true { Text("This device").font(.caption2.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 1).background(.tint.opacity(0.15), in: Capsule()) }
                }
                Text(Self.detail(d)).font(.caption).foregroundStyle(.secondary)
                // This device's button is longer, so it gets a line of its own.
                if d.current == true {
                    Button("Remove this device", role: .destructive) { confirm = d }
                        .buttonStyle(.borderless)
                        .font(.callout)
                }
            }
            Spacer()
            if d.current != true {
                Button("Remove", role: .destructive) { confirm = d }
                    .buttonStyle(.borderless)
                    .font(.callout)
            }
        }
    }

    static func symbol(_ platform: String) -> String {
        switch platform {
        case "iphone": return "iphone"
        case "ipad": return "ipad"
        case "mac": return "laptopcomputer"
        case "watch": return "applewatch"
        case "windows": return "pc"
        case "android": return "smartphone"
        default: return "globe"
        }
    }

    static func detail(_ d: PairedDevice) -> String {
        var parts: [String] = []
        if let s = ISO.date(d.last_seen) { parts.append("Seen \(s.formatted(.relative(presentation: .named)))") } else { parts.append("Not seen yet") }
        if d.own_key == false { parts.append("on the shared key") }
        return parts.joined(separator: ", ")
    }

    private func load() async {
        guard let c = engine.client else { return }
        do {
            devices = try await withDeadline(20) { try await c.devices() }
            tooOld = false
            unreachable = false
        } catch HubError.http(let status, _) where status == 404 {
            tooOld = true
        } catch {
            message = (error as? HubError)?.errorDescription ?? error.localizedDescription
            unreachable = AppModel.unreachable(error)
        }
    }

    private func remove(_ d: PairedDevice) {
        confirm = nil
        Task {
            if d.current == true {
                if let e = await model.removeThisDevice() { message = e.message; unreachable = e.unreachable }
                return
            }
            guard let c = engine.client else { return }
            do {
                try await withDeadline(20) { try await c.removeDevice(d.id) }
                message = "\(d.name) was removed."
                if d.platform == "watch", d.id == SharedConfig.shared.watchDeviceId {
                    #if os(iOS)
                    await WatchKeys.shared.noteRemoved()
                    watchRemoved = true
                    #endif
                }
                await load()
            } catch {
                message = (error as? HubError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}
