import SwiftUI
import EACore
#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// The feel layer: every press plays a note from the chosen scale and bursts a few shapes; held, the note sustains,
/// and with bending on, dragging moves it through the scale and sweeps its filter. Creating something plays a rising
/// arpeggio with a bigger burst, finishing something plays the chord. The setting lives on the hub (`/prefs/feel`),
/// is cached in the app group for offline use, and every change in Settings applies at once.
@MainActor
final class FeelController: ObservableObject {
    static let shared = FeelController()

    @Published private(set) var settings: FeelSettings
    /// The note under the finger right now, for the Try it pad.
    let live = FeelLive()
    let images = FeelImageStore()
    private let config = SharedConfig.shared
    private let synth = FeelSynth()
    private var picker = FeelNotePicker()
    private weak var engine: SyncEngine?
    private var sendTask: Task<Void, Never>?
    private var lastMoment = Date.distantPast
    /// Where the last tap landed, so a celebration starts there.
    private weak var lastShapes: FeelShapes?
    private weak var anyShapes: FeelShapes?
    private var lastPoint: CGPoint?
    private var presses: [ObjectIdentifier: Press] = [:]
    #if os(macOS)
    private var monitors: [Any] = []
    private var anchors: [WeakAnchor] = []
    private struct WeakAnchor { weak var view: FeelAnchorView? }
    private static let mouseKey = ObjectIdentifier(FeelController.self)
    #endif

    /// One finger (or the mouse) from down to up.
    private struct Press {
        var handle: FeelSynth.Handle?
        var base: Int?
        var start: CGPoint?
        var last: CGPoint?
        var step = 0
        var cutoff: Double?
        var travel: CGFloat = 0
        var bend: Bool
        weak var shapes: FeelShapes?
        let began = Date()
    }

    private init() {
        FeelSynth.checkLastLaunch()
        settings = SharedConfig.shared.feel ?? .defaults
        images.load(settings.images)
    }

    /// Hook the sync engine's local creates and finishes and start following presses.
    func attach(_ engine: SyncEngine) {
        guard self.engine == nil else { return }
        self.engine = engine
        engine.onMoment = { [weak self] m, kind in self?.moment(m, kind: kind) }
        #if os(iOS)
        NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { FeelController.shared.endAllPresses() }
        }
        #elseif os(macOS)
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { event in
            MainActor.assumeIsolated { FeelController.shared.mouse(event, phase: 0) }
            return event
        } as Any)
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: .leftMouseDragged) { event in
            MainActor.assumeIsolated { FeelController.shared.mouse(event, phase: 1) }
            return event
        } as Any)
        monitors.append(NSEvent.addLocalMonitorForEvents(matching: .leftMouseUp) { event in
            MainActor.assumeIsolated { FeelController.shared.mouse(event, phase: 2) }
            return event
        } as Any)
        NotificationCenter.default.addObserver(forName: NSApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { FeelController.shared.endAllPresses() }
        }
        #endif
        images.sync(settings.images, client: engine.client)
    }

    // MARK: setting

    /// Send anything changed offline, then take the hub's copy. Called at launch and on return to the foreground.
    func refresh() async {
        guard let c = engine?.client else { return }
        if !config.feelPending.isEmpty { await sendPending(); return }
        if let f = try? await c.feel(), config.feelPending.isEmpty { adopt(f) }
    }

    /// Apply a change now, keep it for offline, and send it (after a short pause for sliders and color wells).
    func change(_ patch: [String: JSONValue], debounce: Bool = false) {
        var obj = (try? JSONCoding.value(settings).objectValue) ?? [:]
        obj.merge(patch) { _, new in new }
        guard var next = try? JSONCoding.typed(FeelSettings.self, from: .object(obj)) else { return }
        if !next.follow_music {
            next.effective = FeelSettings.Effective(key: next.key, scale: next.scale)
        } else if !settings.follow_music {
            next.effective = nil
        }
        settings = next
        config.feel = next
        var pending = config.feelPending
        pending.merge(patch) { _, new in new }
        config.feelPending = pending
        sendTask?.cancel()
        sendTask = Task { [weak self] in
            if debounce { try? await Task.sleep(nanoseconds: 450_000_000) }
            guard !Task.isCancelled else { return }
            await self?.sendPending()
        }
    }

    private func sendPending() async {
        let sent = config.feelPending
        guard !sent.isEmpty, let c = engine?.client else { return }
        let fresh: FeelSettings
        do {
            fresh = try await c.setFeel(sent)
        } catch {
            // The hub refused the change (a theme deleted on another device, say): drop it and take the hub's copy.
            if case HubError.http(let status, _) = error, (400..<500).contains(status), status != 401, status != 403 {
                config.feelPending = [:]
                if let f = try? await c.feel() { adopt(f) }
            }
            return
        }
        var left = config.feelPending
        for (k, v) in sent where left[k] == v { left.removeValue(forKey: k) }
        config.feelPending = left
        if left.isEmpty { adopt(fresh) }
    }

    private func adopt(_ f: FeelSettings) {
        if f != settings { settings = f }
        config.feel = f
        images.sync(f.images, client: engine?.client)
    }

    static func list<T: Encodable>(_ xs: [T]) -> JSONValue { .array(xs.compactMap { try? JSONCoding.value($0) }) }

    // MARK: palettes

    /// Add or replace a saved palette; `select` makes it the one taps use.
    func savePalette(_ p: FeelPalette, select: Bool = false) {
        var list = settings.palettes
        if let i = list.firstIndex(where: { $0.id == p.id }) { list[i] = p } else { list.append(p) }
        var patch: [String: JSONValue] = ["palettes": Self.list(list)]
        if select { patch["theme"] = .string("custom:\(p.id)") }
        change(patch, debounce: true)
    }

    func deletePalette(_ id: String) {
        var patch: [String: JSONValue] = ["palettes": Self.list(settings.palettes.filter { $0.id != id })]
        if settings.theme == "custom:\(id)" { patch["theme"] = .string("aurora") }
        change(patch)
    }

    /// A new palette starting from `colors`, named `name`. Returns it, already saved.
    @discardableResult
    func newPalette(name: String, colors: [String], select: Bool = false) -> FeelPalette {
        let p = FeelPalette(id: FeelID.make(taken: settings.palettes.map(\.id)), name: FeelID.name(name, fallback: "Colors"),
                            colors: Array(colors.prefix(FeelPalette.maxColors)))
        savePalette(p, select: select)
        return p
    }

    // MARK: app themes

    func saveAppTheme(_ t: AppTheme, select: Bool = false) {
        var list = settings.app_themes
        if let i = list.firstIndex(where: { $0.id == t.id }) { list[i] = t } else { list.append(t) }
        var patch: [String: JSONValue] = ["app_themes": Self.list(list)]
        if select { patch["app_theme"] = .string("custom:\(t.id)") }
        change(patch, debounce: true)
    }

    func deleteAppTheme(_ id: String) {
        var patch: [String: JSONValue] = ["app_themes": Self.list(settings.app_themes.filter { $0.id != id })]
        if settings.app_theme == "custom:\(id)" { patch["app_theme"] = .string(AppTheme.classicId) }
        change(patch)
    }

    @discardableResult
    func newAppTheme(from base: AppTheme, name: String, select: Bool = false) -> AppTheme {
        var t = base
        t.id = FeelID.make(taken: settings.app_themes.map(\.id))
        t.name = FeelID.name(name, fallback: "Theme")
        saveAppTheme(t, select: select)
        return t
    }

    /// The colors Classic shows today, as a starting point for a new theme.
    static func classicStart(dark: Bool) -> AppTheme {
        dark
            ? AppTheme(id: "classic", name: "Classic", mode: "dark", accent: "#0A84FF", background: "#000000", surface: "#1C1C1E", text: "#FFFFFF")
            : AppTheme(id: "classic", name: "Classic", mode: "light", accent: "#007AFF", background: "#F2F2F7", surface: "#FFFFFF", text: "#000000")
    }

    // MARK: images

    /// Upload a PNG (already shrunk) as an image shape.
    func addImage(png: Data, name: String) async throws {
        guard let c = engine?.client else { throw HubError.transport("Not connected to the hub") }
        let before = Set(settings.images.map(\.id))
        let f = try await c.addFeelImage(png: png, name: FeelID.name(name, fallback: "Image"))
        if let added = f.images.first(where: { !before.contains($0.id) }) { images.store(png, id: added.id) }
        adopt(f)
    }

    func renameImage(_ id: String, to name: String) {
        let list = settings.images.map { i in i.id == id ? FeelImage(id: i.id, name: FeelID.name(name, fallback: i.name), enabled: i.enabled, type: i.type) : i }
        change(["images": Self.list(list)], debounce: true)
    }

    func setImage(_ id: String, enabled: Bool) {
        let list = settings.images.map { i in i.id == id ? FeelImage(id: i.id, name: i.name, enabled: enabled, type: i.type) : i }
        change(["images": Self.list(list)])
    }

    func deleteImage(_ id: String) async throws {
        guard let c = engine?.client else { throw HubError.transport("Not connected to the hub") }
        await sendPending()
        adopt(try await c.deleteFeelImage(id))
    }

    // MARK: colors

    /// The app theme in use; nil for Classic.
    var appTheme: AppTheme? { settings.activeAppTheme }

    var accent: Color { appTheme.flatMap { Self.color($0.accent) } ?? .accentColor }

    /// Colors for the shapes: the palette's, or the accent color at a few strengths for mono.
    var palette: [Color] { colors(for: settings.theme) }

    func colors(for theme: String) -> [Color] {
        if theme == "mono" { return [1, 0.8, 0.6, 0.4].map { accent.opacity($0) } }
        return FeelTheme.hexes(theme: theme, palettes: settings.palettes).compactMap(Self.color)
    }

    /// What a burst draws: the enabled shapes and the enabled images that have loaded.
    var style: FeelShapes.Style {
        var items: [FeelShapes.Item] = settings.shapes.compactMap(FeelShapeKind.init(rawValue:)).map { .shape($0) }
        items += settings.enabledImages.compactMap { images.image($0.id) }.map { .image($0) }
        return FeelShapes.Style(items: items, colors: palette, size: settings.shape_size, density: settings.density)
    }

    nonisolated static func color(_ hex: String) -> Color? {
        FeelTheme.rgb(hex).map { Color(.sRGB, red: $0.r, green: $0.g, blue: $0.b) }
    }

    nonisolated static func hex(_ color: Color) -> String {
        #if os(iOS)
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a)
        return FeelTheme.hex(r: Double(r), g: Double(g), b: Double(b))
        #else
        let c = NSColor(color).usingColorSpace(.sRGB) ?? .black
        return FeelTheme.hex(r: Double(c.redComponent), g: Double(c.greenComponent), b: Double(c.blueComponent))
        #endif
    }

    // MARK: what is allowed right now

    /// The Shapes switch alone decides; the system's Reduce Motion is not consulted (it reads as on for some desktops
    /// with animations on).
    var showsShapes: Bool { settings.motion }

    /// Notes on this device: the shared switch, and on a Mac its own switch too, off until turned on there.
    static let macSoundKey = "ea.feel.soundOnThisMac"
    var soundHere: Bool {
        #if os(macOS)
        return settings.sound && UserDefaults.standard.bool(forKey: Self.macSoundKey)
        #else
        return settings.sound
        #endif
    }

    /// Quiet while the microphone records or a hum plays: a tap note would land in the recording, and on iOS its
    /// ambient session would cut the microphone or the playback off.
    private var soundNow: Bool { soundHere && !AudioFocus.busy }

    /// Background work (Shortcuts, a sync on the way out) must not make noise.
    private var isActive: Bool {
        #if os(iOS)
        return UIApplication.shared.applicationState == .active
        #else
        return true
        #endif
    }

    // MARK: presses

    /// A finger went down (or the mouse button). `shapes` is the window it landed in (nil for a window without the overlay).
    func pressBegan(_ key: ObjectIdentifier, at point: CGPoint?, in shapes: FeelShapes?) {
        guard isActive else { return }
        // A touch UIKit lost track of must not hold a note forever.
        presses = presses.filter { Date().timeIntervalSince($0.value.began) < FeelBend.maxHold }
        if let old = presses.removeValue(forKey: key), let h = old.handle { synth.release(h) }
        if let shapes {
            lastShapes = shapes
            lastPoint = point
            if let point, showsShapes { shapes.burst(.tap, at: point, style: style) }
        }
        var press = Press(start: point, last: point, bend: settings.drag_bend && point != nil, shapes: shapes)
        if soundNow, let n = picker.next(from: FeelMusic.tapNotes(key: settings.playKey, scale: settings.playScale, octave: settings.octave)) {
            press.base = n
            let voice = FeelSynth.Voice(name: settings.synth)
            if settings.hold || press.bend {
                press.handle = synth.press(hz: Float(FeelMusic.hz(n)), voice: voice, volume: Float(settings.volume),
                                           hold: settings.hold, bend: press.bend)
            } else {
                play([n])
            }
            live.show(note: n, cutoff: press.bend ? FeelBend.restCutoff : nil)
        }
        presses[key] = press
    }

    /// The finger moved. With bending on, up and down steps through the scale and left and right sweeps the filter.
    func pressMoved(_ key: ObjectIdentifier, to point: CGPoint) {
        guard var p = presses[key], p.bend, let start = p.start else { return }
        let dx = Double(point.x - start.x), dy = Double(point.y - start.y)
        if let base = p.base {
            let step = FeelBend.steps(dy: dy, scale: settings.playScale)
            var note = FeelBend.note(base: base, steps: p.step, key: settings.playKey, scale: settings.playScale, octave: settings.octave)
            if step != p.step {
                p.step = step
                note = FeelBend.note(base: base, steps: step, key: settings.playKey, scale: settings.playScale, octave: settings.octave)
                if let h = p.handle { synth.bend(h, hz: Float(FeelMusic.hz(note))) }
            }
            // The filter waits for a real sideways move, so a straight drag up or down keeps the plain sound.
            if p.cutoff != nil || abs(dx) > 6 {
                let c = FeelBend.cutoff(dx: dx)
                if p.cutoff.map({ abs(c / $0 - 1) > 0.01 }) ?? true {
                    if let h = p.handle { synth.filter(h, cutoff: Float(c), drive: Float(FeelBend.drive(dx: dx))) }
                    p.cutoff = c
                }
            }
            live.show(note: note, cutoff: p.cutoff ?? FeelBend.restCutoff)
        }
        if let last = p.last { p.travel += hypot(point.x - last.x, point.y - last.y) }
        p.last = point
        if p.travel >= FeelBend.trailSpacing {
            p.travel = 0
            if showsShapes, let shapes = p.shapes { shapes.burst(.trail, at: point, style: style) }
        }
        presses[key] = p
    }

    /// The finger lifted or the touch was cancelled.
    func pressEnded(_ key: ObjectIdentifier) {
        guard let p = presses.removeValue(forKey: key) else { return }
        if let h = p.handle { synth.release(h) }
        if presses.isEmpty { live.clear() }
    }

    /// Leaving the app lets every held note go.
    func endAllPresses() {
        presses.removeAll()
        synth.releaseAll()
        live.clear()
    }

    /// Something was made or finished on this device.
    func moment(_ m: FeelMoment, kind: Kind) {
        guard isActive else { return }
        // A capture that also files a task reports twice; one celebration is enough.
        guard Date().timeIntervalSince(lastMoment) > 0.4 else { return }
        lastMoment = Date()
        celebrate(m)
        if kind == .music_idea, settings.follow_music {
            // The new idea's key may change what plays; ask once it has reached the hub.
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                await self?.refresh()
            }
        }
    }

    /// The create celebration, for "Try it".
    func tryIt() { celebrate(.create) }

    /// A short arpeggio after changing the synth, scale, key or octave.
    func preview() {
        guard soundHere else { return }
        playTriad(arpeggio: true)
    }

    /// A window's overlay appeared; celebrations go there until a tap says otherwise.
    func attachShapes(_ shapes: FeelShapes) {
        if lastShapes == nil { anyShapes = shapes }
    }

    private func celebrate(_ m: FeelMoment) {
        if soundNow { playTriad(arpeggio: m == .create) }
        guard showsShapes, let shapes = lastShapes ?? anyShapes else { return }
        let point = (shapes === lastShapes ? lastPoint : nil) ?? CGPoint(x: shapes.size.width / 2, y: shapes.size.height / 2)
        shapes.burst(m == .create ? .create : .complete, at: point, style: style)
    }

    private func playTriad(arpeggio: Bool) {
        let notes = FeelMusic.triad(key: settings.playKey, scale: settings.playScale, octave: settings.octave)
        let voice = FeelSynth.Voice(name: settings.synth)
        synth.play(notes.enumerated().map { i, n in
            FeelSynth.Note(hz: Float(FeelMusic.hz(n)), voice: voice, delay: arpeggio ? Double(i) * 0.07 : 0)
        }, volume: Float(settings.volume))
    }

    private func play(_ midi: [Int]) {
        let voice = FeelSynth.Voice(name: settings.synth)
        synth.play(midi.map { FeelSynth.Note(hz: Float(FeelMusic.hz($0)), voice: voice) }, volume: Float(settings.volume))
    }

    // MARK: macOS mouse

    #if os(macOS)
    func register(_ anchor: FeelAnchorView) {
        anchors.removeAll { $0.view == nil || $0.view === anchor }
        anchors.append(WeakAnchor(view: anchor))
    }

    /// 0 down, 1 dragged, 2 up.
    private func mouse(_ event: NSEvent, phase: Int) {
        let anchor = event.window.flatMap { w in anchors.lazy.compactMap(\.view).first { $0.window === w } }
        let point = anchor.map { $0.convert(event.locationInWindow, from: nil) }
        switch phase {
        case 0: pressBegan(Self.mouseKey, at: point, in: anchor?.shapes)
        case 1: if let point { pressMoved(Self.mouseKey, to: point) }
        default: pressEnded(Self.mouseKey)
        }
    }
    #endif
}

/// The note under the finger, published apart from the setting so a drag redraws only the Try it pad.
@MainActor @Observable
final class FeelLive {
    private(set) var note: Int?
    private(set) var cutoff: Double?

    func show(note: Int, cutoff: Double?) {
        if self.note != note { self.note = note }
        if self.cutoff != cutoff { self.cutoff = cutoff }
    }

    func clear() {
        if note != nil { note = nil }
        if cutoff != nil { cutoff = nil }
    }

    /// 60 → "C4".
    static func name(_ midi: Int) -> String { "\(FeelMusic.keys[((midi % 12) + 12) % 12])\(midi / 12 - 1)" }
}
