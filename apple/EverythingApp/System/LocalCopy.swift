import Foundation
import EACore

/// This app's own copies of the person's data, apart from the sync store (which the engine empties): the chats copy,
/// cached pictures and files, and what was given to Spotlight. Removed when the hub says this device was removed.
@MainActor
enum LocalCopy {
    static func wipeAppFiles() async {
        await SpotlightIndexer.shared.clear()
        let fm = FileManager.default
        if let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            for name in ["chats.json"] { try? fm.removeItem(at: support.appendingPathComponent("EverythingApp", isDirectory: true).appendingPathComponent(name)) }
        }
        // Caches hold pictures, wiki attachments and MIDI from the hub; everything there is this app's own.
        if let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask).first,
           let items = try? fm.contentsOfDirectory(at: caches, includingPropertiesForKeys: nil) {
            for u in items { try? fm.removeItem(at: u) }
        }
    }
}
