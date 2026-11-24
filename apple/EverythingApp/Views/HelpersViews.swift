import SwiftUI
import EACore
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

// People who help this person with their devices (docs/helpers.md; hub/src/helpers.ts). Made for someone who is not
// technical, helped by a family member they trust fully: large type, one decision per card, plain words. The person
// says yes once; after that the helper never asks them, and everything the helper does is in "What happened".

/// GET /helpers, shared by the offer card at the top of the app and Settings, People who help you. Asked when the app
/// opens or comes back, and every two minutes. Nil on a hub without helpers (before 1.0.6).
@MainActor
final class HelpersStore: ObservableObject {
    static let shared = HelpersStore()
    @Published private(set) var view: HelpersView?
    private var lastAsk = Date.distantPast

    func refresh(_ engine: SyncEngine, force: Bool = true) async {
        guard let c = engine.client else { view = nil; return }
        if !force, Date().timeIntervalSince(lastAsk) < 20 { return }
        lastAsk = Date()
        do {
            view = try await withDeadline(15) { try await c.helpers() }
        } catch let e as HubError {
            if case let .http(status, _) = e, status == 404 || status == 403 { view = nil }
        } catch {}
    }
}

/// A card's look: a rounded panel with room around large text.
struct HelperCard: ViewModifier {
    func body(content: Content) -> some View {
        content
            .font(.title3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
            .background(RoundedRectangle(cornerRadius: 18).fill(Color.secondary.opacity(0.10)))
    }
}

extension View {
    func helperCard() -> some View { modifier(HelperCard()) }
}

/// The one question a helped person is asked: someone offered to help with their devices.
struct HelperOfferCard: View {
    @EnvironmentObject var engine: SyncEngine
    let helper: Helper
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let n = helper.name
        VStack(alignment: .leading, spacing: 14) {
            Text("\(n) offered to help with your computer and phone").font(.title2.bold())
            Text("If you say yes, \(n) can check your computer and fix problems on it, without asking you each time. \(n) can also use the passwords you choose to save for \(n).")
            Text("This does not open your notes, chats or diary.")
            Text("You can stop it any time in Settings, People who help you.").foregroundStyle(.secondary)
            BigButton(title: busy ? "One moment" : "Yes, let \(n) help", symbol: "checkmark", prominent: true) { answer(true) }
                .disabled(busy)
                .accessibilityIdentifier("helpers.accept")
            BigButton(title: "No, thank you") { answer(false) }
                .disabled(busy)
            if let error { Text(error).foregroundStyle(.dangerText) }
        }
        .helperCard()
    }

    private func answer(_ yes: Bool) {
        guard let c = engine.client else { return }
        busy = true
        error = nil
        Task {
            do {
                if yes { try await c.acceptHelper(helper.id) } else { try await c.stopHelper(helper.id) }
                await HelpersStore.shared.refresh(engine)
            } catch { self.error = (error as? HubError)?.errorDescription ?? error.localizedDescription }
            busy = false
        }
    }
}

/// At the top of the app while an offer waits for an answer.
struct HelperOfferInset: View {
    @ObservedObject private var store = HelpersStore.shared

    var body: some View {
        // Whole, never scrolled inside: both answers in sight at once. It is one question, asked once.
        if let offer = store.view?.offered {
            HelperOfferCard(helper: offer)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .fixedSize(horizontal: false, vertical: true)
                .background(.bar)
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}

/// Settings, People who help you.
struct HelpersSettingsView: View {
    @EnvironmentObject var engine: SyncEngine
    @ObservedObject private var store = HelpersStore.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let v = store.view {
                    let active = v.active
                    let who = active.isEmpty ? "your helper" : HelpersView.names(active)
                    if active.isEmpty && v.offered == nil {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Nobody helps you yet").font(.title2.bold())
                            Text("When someone in your family offers to help with your computer and phone, you can say yes here.")
                        }
                        .helperCard()
                    }
                    ForEach(v.helpers.filter(\.isOffered)) { HelperOfferCard(helper: $0) }
                    ForEach(active) { HelperStatusCard(helper: $0) }
                    if !active.isEmpty {
                        #if os(macOS)
                        ThisMacCard(who: who, view: v)
                        #endif
                        HomeDevicesCard(who: who, view: v)
                        PasswordsCard(who: who, view: v)
                    }
                    if !v.log.isEmpty { HelperLogCard(log: v.log) }
                } else {
                    Text("Asking your hub.").foregroundStyle(.secondary).font(.title3)
                }
            }
            .padding(20)
            .frame(maxWidth: 680, alignment: .leading)
        }
        .themedScreen()
        .navigationTitle("People who help you")
        .task { await store.refresh(engine) }
        .refreshable { await store.refresh(engine) }
    }
}

private struct HelperStatusCard: View {
    @EnvironmentObject var engine: SyncEngine
    let helper: Helper
    @State private var confirm = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let n = helper.name
        VStack(alignment: .leading, spacing: 12) {
            Text("\(n) helps you").font(.title2.bold())
            Text("\(n) can check your computer and fix problems without asking you. Everything \(n) does is listed at the bottom of this page.")
            if let a = helper.accepted_at { Text(HelperTime.since(a)).foregroundStyle(.secondary) }
            BigButton(title: "Stop \(n)'s help", symbol: "hand.raised", role: .destructive) { confirm = true }
                .disabled(busy)
            if let error { Text(error).foregroundStyle(.dangerText) }
        }
        .helperCard()
        .alert("Stop \(n)'s help?", isPresented: $confirm) {
            Button("Stop \(n)'s help", role: .destructive) { stop() }
            Button("Keep \(n)'s help", role: .cancel) {}
        } message: {
            Text("\(n) will not be able to check or fix your devices until you say yes again.")
        }
    }

    private func stop() {
        guard let c = engine.client else { return }
        busy = true
        Task {
            do { try await c.stopHelper(helper.id); await HelpersStore.shared.refresh(engine) }
            catch { self.error = (error as? HubError)?.errorDescription ?? error.localizedDescription }
            busy = false
        }
    }
}

#if os(macOS)
/// On a Mac: whether the helper may run things on it (HelperComputer).
private struct ThisMacCard: View {
    @EnvironmentObject var engine: SyncEngine
    let who: String
    let view: HelpersView
    @State private var on = HelperComputer.shared.isOn

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("This computer").font(.title2.bold())
            if on {
                Text("\(who) can check and fix this Mac while Aeneas is open on it. \(view.this_device?.agent?.listening == true ? "It is ready now." : "It gets ready in a moment.")")
                Text("Some fixes need more than an app may do on a Mac. \(who) will tell you if one does.").foregroundStyle(.secondary)
                BigButton(title: "Do not let \(who) use this computer") { set(false) }
            } else {
                Text("\(who) cannot use this Mac now.")
                BigButton(title: "Let \(who) use this computer", prominent: true) { set(true) }
            }
        }
        .helperCard()
    }

    private func set(_ next: Bool) {
        on = next
        HelperComputer.shared.setOn(next)
        Task { try? await Task.sleep(nanoseconds: 1_000_000_000); await HelpersStore.shared.refresh(engine) }
    }
}
#endif

/// The devices on the home network, found when the person asks (HomeNetwork).
private struct HomeDevicesCard: View {
    @EnvironmentObject var engine: SyncEngine
    let who: String
    let view: HelpersView
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("The devices in your home").font(.title2.bold())
            Text("This looks for the computers, printers, phones and other devices on your home Wi-Fi, so \(who) knows what is there. It takes about 20 seconds.")
            BigButton(title: busy ? "Looking, about 20 seconds" : "Find the devices in my home", symbol: "magnifyingglass", prominent: true) { look() }
                .disabled(busy)
                .accessibilityIdentifier("helpers.scan")
            if let error { Text(error).foregroundStyle(.dangerText) }
            if let s = view.scan, !busy {
                Text("Found \(s.devices.count) \(s.devices.count == 1 ? "device" : "devices"). \(who) can see this list.").font(.title3.weight(.semibold))
                Text("Looked \(HelperTime.when(s.at).prefix(1).lowercased() + HelperTime.when(s.at).dropFirst())").foregroundStyle(.secondary)
                ForEach(s.devices) { d in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(d.name.isEmpty ? (d.kind ?? "Device").capitalizedFirst : d.name).font(.title3.weight(.semibold))
                        Text("\(d.name.isEmpty ? "" : "\((d.kind ?? "device")), ")\(d.ip)").foregroundStyle(.secondary)
                    }
                    Divider()
                }
            }
        }
        .helperCard()
    }

    private func look() {
        guard let c = engine.client else { return }
        busy = true
        error = nil
        Task {
            do {
                let found = try await HomeNetwork.scan()
                try await c.sendHomeScan(network: found.network, devices: found.devices)
                await HelpersStore.shared.refresh(engine)
            } catch { self.error = (error as? HubError)?.errorDescription ?? error.localizedDescription }
            busy = false
        }
    }
}

/// Passwords the person saves for their helper: names and user names shown, never a password.
private struct PasswordsCard: View {
    @EnvironmentObject var engine: SyncEngine
    let who: String
    let view: HelpersView
    @State private var title = ""
    @State private var username = ""
    @State private var password = ""
    @State private var show = false
    @State private var busy = false
    @State private var message: (ok: Bool, text: String)?
    @State private var removing: HelpersView.SavedPassword?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Passwords for \(who)").font(.title2.bold())
            Text("Save a password here only if you want \(who) to use it, like the password for your computer or for your email. It is kept on your hub, and it is never shown in a chat.")
            ForEach(view.passwords) { p in
                HStack {
                    VStack(alignment: .leading) {
                        Text(p.title).font(.title3.weight(.semibold))
                        if !p.username.isEmpty { Text("User name \(p.username)").foregroundStyle(.secondary) }
                    }
                    Spacer()
                    Button("Remove") { removing = p }.font(.title3).buttonStyle(.bordered).controlSize(.large)
                }
                Divider()
            }
            field("What is it for?") { TextField("My computer", text: $title).accessibilityIdentifier("helpers.pw.title") }
            field("User name, if it has one") {
                TextField("", text: $username)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
            }
            field("Password") {
                Group {
                    if show { TextField("", text: $password) } else { SecureField("", text: $password) }
                }
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
            }
            Toggle("Show the password as I type", isOn: $show).font(.title3)
            BigButton(title: busy ? "Saving" : "Save password", symbol: "lock", prominent: true) { save() }
                .disabled(busy || title.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)
            if let m = message { Text(m.text).foregroundStyle(m.ok ? StatusStyle.okText : StatusStyle.dangerText) }
        }
        .helperCard()
        .alert("Remove the password \(removing?.title ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } })) {
            Button("Remove", role: .destructive) { if let r = removing { remove(r.title) } }
            Button("Keep it", role: .cancel) {}
        } message: { Text("\(who) will not be able to use it any more.") }
    }

    private func field<F: View>(_ label: String, @ViewBuilder _ content: () -> F) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.title3)
            content()
                .font(.title3)
                .textFieldStyle(.roundedBorder)
                .frame(minHeight: 44)
        }
    }

    private func save() {
        guard let c = engine.client else { return }
        busy = true
        message = nil
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let u = username.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            do {
                try await c.saveHelperPassword(title: t, username: u.isEmpty ? nil : u, password: password)
                message = (true, "Saved. \(who) can use \"\(t)\" now.")
                title = ""; username = ""; password = ""
                await HelpersStore.shared.refresh(engine)
            } catch { message = (false, (error as? HubError)?.errorDescription ?? error.localizedDescription) }
            busy = false
        }
    }

    private func remove(_ t: String) {
        guard let c = engine.client else { return }
        Task {
            do { try await c.removeHelperPassword(t); await HelpersStore.shared.refresh(engine) }
            catch { message = (false, (error as? HubError)?.errorDescription ?? error.localizedDescription) }
        }
    }
}

/// Everything the helper did, newest first, in plain words.
private struct HelperLogCard: View {
    let log: [HelperLogLine]
    @State private var open: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("What happened").font(.title2.bold())
            ForEach(log) { l in
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(HelperTime.when(l.at))\(l.device.map { ", on \($0)" } ?? "")").foregroundStyle(.secondary)
                    Text(l.kind == "check" || l.kind == "change" ? "\(l.helper): \(l.text)" : l.text)
                    if let d = l.detail {
                        if open.contains(l.id) {
                            Text(d).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                        } else {
                            Button("Show exactly what was run") { open.insert(l.id) }.font(.body)
                        }
                    }
                }
                Divider()
            }
        }
        .helperCard()
    }
}

/// On the first screen: for someone who was sent an invitation. Paste the whole message, or press Paste, and the app
/// finds the invitation in it and connects, the same as opening the link.
struct InvitationCard: View {
    @EnvironmentObject var model: AppModel
    @State private var text = ""
    @State private var note: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("I have an invitation").font(.title2.bold())
            Text("Copy the whole message you were sent, then press Paste the invitation.")
            BigButton(title: "Paste the invitation", symbol: "doc.on.clipboard", prominent: true) { paste() }
                .accessibilityIdentifier("setup.invitation.paste")
            TextField("Or paste the message here", text: $text, axis: .vertical)
                .lineLimit(3...6)
                .textFieldStyle(.roundedBorder)
                .font(.title3)
                .accessibilityIdentifier("setup.invitation.text")
                .onChange(of: text) { _, t in use(t) }
            if let note { Text(note).foregroundStyle(.dangerText) }
        }
        .helperCard()
    }

    private func paste() {
        #if os(iOS)
        let s = UIPasteboard.general.string ?? ""
        #elseif os(macOS)
        let s = NSPasteboard.general.string(forType: .string) ?? ""
        #else
        let s = ""
        #endif
        if s.isEmpty { note = "There is nothing copied yet. Copy the whole message you were sent, then press Paste the invitation." } else { text = s }
    }

    private func use(_ t: String) {
        guard !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { note = nil; return }
        if let link = SetupLink.find(in: t) {
            note = nil
            model.useSetupLink(link)
        } else {
            note = "There is no invitation in that. Copy the whole message you were sent, then paste it here."
        }
    }
}

private extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}
