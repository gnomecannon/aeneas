#if DEBUG && os(macOS)
import AppKit
import EACore

/// Mac screenshot hooks, Debug builds only. Launch arguments:
///   -EASection <section>       open a section, e.g. today or week
///   -EAWindowSize 1280x800     the main window's size with its title bar, in points
/// Screenshots are then taken from outside (screencapture -o -l <window id>), which needs Screen Recording.
@MainActor
enum DebugHooksMac {
    static func applyLaunchArguments(_ model: AppModel) async {
        let d = UserDefaults.standard
        if let s = d.string(forKey: "EASection"), let section = Section(rawValue: s) { model.section = section }
        guard let size = d.string(forKey: "EAWindowSize").flatMap(parse) else { return }
        try? await Task.sleep(for: .seconds(1))
        guard let window = NSApp.windows.first(where: { $0.canBecomeMain }) else { return }
        window.setFrame(NSRect(origin: window.frame.origin, size: size), display: true)
        window.center()
    }

    private static func parse(_ s: String) -> NSSize? {
        let p = s.lowercased().split(separator: "x").compactMap { Double($0) }
        return p.count == 2 ? NSSize(width: p[0], height: p[1]) : nil
    }
}
#endif
