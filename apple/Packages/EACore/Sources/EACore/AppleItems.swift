import Foundation
#if os(iOS)
import UIKit
#endif

/// Which device adds new Apple items (reminders and calendar events) for what was made in the app. Each device that
/// adds one makes its own copy in iCloud, so only one may: an iPad runs iOS like the iPhone, and with `#if os(iOS)` it
/// added the same new tasks to Apple Reminders, and the same new events to Apple Calendar after the iPhone's two
/// minutes. The device's kind decides, here, where EACore can test it.
public enum AppleItems {
    public enum Device: Sendable, Equatable { case iPhone, iPad, mac, other }

    /// Only the iPhone adds Apple Reminders items for tasks made in the app; the Mac and an iPad sync the linked ones.
    public static func addsReminders(on device: Device) -> Bool { device == .iPhone }

    /// The Mac adds and moves calendar events at once and the iPhone after two minutes untouched; an iPad never does.
    public static func addsEvents(on device: Device) -> Bool { device == .mac || device == .iPhone }

    /// The kind of device this is.
    @MainActor public static var thisDevice: Device {
        #if os(macOS)
        return .mac
        #elseif os(iOS)
        switch UIDevice.current.userInterfaceIdiom {
        case .phone: return .iPhone
        case .pad: return .iPad
        default: return .other
        }
        #else
        return .other
        #endif
    }
}
