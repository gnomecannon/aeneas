#if os(macOS)
import AppKit
import Carbon.HIToolbox

/// The global Capture shortcut via Carbon RegisterEventHotKey (no accessibility permission needed). Chosen in Settings,
/// Privacy on this device; the same choices as the Windows app, plus Control+Option+Space, which Macs set up before
/// the choice existed keep. Control+Shift+Space is the default on both (Control+Option+Space is also macOS's own
/// "next input source" shortcut).
final class HotKey {
    struct Choice: Identifiable, Hashable {
        var id: String
        var label: String
        var key: Int
        var modifiers: Int
    }

    static let choices: [Choice] = [
        Choice(id: "Control+Shift+Space", label: "Control Shift Space", key: kVK_Space, modifiers: controlKey | shiftKey),
        Choice(id: "Control+Shift+K", label: "Control Shift K", key: kVK_ANSI_K, modifiers: controlKey | shiftKey),
        Choice(id: "Alt+Shift+Space", label: "Option Shift Space", key: kVK_Space, modifiers: optionKey | shiftKey),
        Choice(id: "Control+Option+Space", label: "Control Option Space", key: kVK_Space, modifiers: controlKey | optionKey),
    ]
    static let defaultChoice = "Control+Shift+Space"
    static let settingKey = "mac.captureShortcut"

    /// The chosen shortcut's id, or "off". A Mac set up before the choice existed keeps Control+Option+Space.
    static func chosen(configured: Bool, defaults: UserDefaults = .standard) -> String {
        if let s = defaults.string(forKey: settingKey), s == "off" || choices.contains(where: { $0.id == s }) { return s }
        let first = configured ? "Control+Option+Space" : defaultChoice
        defaults.set(first, forKey: settingKey)
        return first
    }

    /// How a choice reads in Settings and the menu bar ("Off" for none).
    static func label(_ id: String) -> String { choices.first { $0.id == id }?.label ?? "Off" }

    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private let action: () -> Void

    init(action: @escaping () -> Void) { self.action = action }

    /// Registers the chosen shortcut, replacing any earlier one. "off" leaves none. False when another app holds it.
    @discardableResult
    func register(_ id: String) -> Bool {
        unregister()
        guard let c = Self.choices.first(where: { $0.id == id }) else { return true }
        if handlerRef == nil {
            var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let selfPtr = Unmanaged.passUnretained(self).toOpaque()
            InstallEventHandler(GetApplicationEventTarget(), { _, _, userData -> OSStatus in
                guard let userData = userData else { return noErr }
                let hk = Unmanaged<HotKey>.fromOpaque(userData).takeUnretainedValue()
                DispatchQueue.main.async { hk.action() }
                return noErr
            }, 1, &eventType, selfPtr, &handlerRef)
        }
        let hid = EventHotKeyID(signature: OSType(0x45415050), id: 1) // "EAPP"
        return RegisterEventHotKey(UInt32(c.key), UInt32(c.modifiers), hid, GetApplicationEventTarget(), 0, &hotKeyRef) == noErr
    }

    private func unregister() {
        if let r = hotKeyRef { UnregisterEventHotKey(r); hotKeyRef = nil }
    }

    deinit {
        unregister()
        if let h = handlerRef { RemoveEventHandler(h) }
    }
}
#endif
