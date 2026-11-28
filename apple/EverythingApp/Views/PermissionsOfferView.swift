import SwiftUI
import EACore

/// Right after pairing, or when a module is switched on: what the modules that are on need from this device, each in
/// plain words with the modules it is for and what they read. Continue asks for each in turn; Not now asks for
/// nothing (each feature asks again from its own screen when it is used, and Settings, Review permissions lists them).
/// One turned down before is listed too, with the way to the system's settings: the system never asks it again.
struct PermissionsOfferView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    let offer: PermissionOffer
    @State private var asking = false
    /// Where each stands, read again on coming back from the system's settings.
    @State private var states: [DevicePermission: PermissionState]?

    private func state(_ p: DevicePermission) -> PermissionState? { (states ?? offer.states)[p] }
    /// Only turned down ones are left: Continue has nothing to ask.
    private var nothingToAsk: Bool { offer.needs.allSatisfy { [.denied, .allowed].contains(state($0.permission)) } }

    var body: some View {
        NavigationStack {
            List {
                SwiftUI.Section {
                    Text("The modules you use need these on this device. You can change each one later in the system's Settings.")
                        .font(.callout).foregroundStyle(.secondary)
                }
                ForEach(offer.needs) { n in
                    SwiftUI.Section {
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: n.permission.symbol).font(.title3).foregroundStyle(.tint).frame(width: 28)
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(n.permission.title).font(.headline)
                                    Spacer(minLength: 8)
                                    if let s = state(n.permission), s == .denied || s == .allowed {
                                        Text(s.label).font(.caption.weight(.semibold))
                                            .foregroundStyle(s == .allowed ? AnyShapeStyle(StatusStyle.okText) : AnyShapeStyle(StatusStyle.warnText))
                                    }
                                }
                                Text(n.permission.purpose).font(.callout)
                                Text(n.forLine).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                if state(n.permission) == .denied { PermissionOffNote(permission: n.permission).padding(.top, 2) }
                                ForEach(n.modules.filter { ($0.reads ?? "").isEmpty == false && firstCard(for: $0) == n.id }) { m in
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text("What \(m.title) reads").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                        Text(m.reads ?? "").font(.caption).foregroundStyle(.secondary)
                                    }
                                    .padding(.top, 2)
                                }
                            }
                        }
                        .padding(.vertical, 4)
                        // The Open Settings button stays its own element.
                        .accessibilityElement(children: state(n.permission) == .denied ? .contain : .combine)
                    }
                }
            }
            .navigationTitle("What your modules need")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 10) {
                    // Done when only turned down ones are left: it still turns on what was allowed in the system's
                    // settings meanwhile.
                    BigButton(title: asking ? "Asking" : nothingToAsk ? "Done" : "Continue", symbol: "checkmark", prominent: true) {
                        asking = true
                        Task { await model.grantOffered(offer) }
                    }
                    .disabled(asking)
                    .accessibilityIdentifier("permissions.continue")
                    Button("Not now") { model.permissionOffer = nil }
                        .disabled(asking)
                        .accessibilityIdentifier("permissions.notNow")
                }
                .padding()
                .background(.bar)
            }
        }
        .interactiveDismissDisabled(asking)
        // Back from the system's settings: one turned on there shows as allowed.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { states = await DevicePermissions.states(offer.needs.map(\.permission)) } }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 520)
        #endif
    }

    /// A module's "what it reads" is said once, on the first permission it needs.
    private func firstCard(for m: ModuleInfo) -> String? {
        offer.needs.first { $0.modules.contains { $0.id == m.id } }?.id
    }
}
