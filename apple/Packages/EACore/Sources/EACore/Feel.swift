import Foundation

/// How the app feels: shapes that burst on a tap or a new item, the note each tap plays, and the app's own colors.
/// One hub setting for every device (`GET /prefs/feel`), cached locally for offline use. Field names and limits
/// match `hub/src/feel.ts`.
public struct FeelSettings: Codable, Equatable, Sendable {
    public var motion: Bool
    /// A built-in palette (`FeelTheme.order`) or `custom:<palette id>`.
    public var theme: String
    public var palettes: [FeelPalette]
    /// Enabled shapes, any of `FeelShapeKind`.
    public var shapes: [String]
    public var images: [FeelImage]
    /// 0.5 to 2, 1 is normal.
    public var shape_size: Double
    public var density: Double
    public var sound: Bool
    public var volume: Double
    public var key: String
    public var scale: String
    public var synth: String
    public var octave: Int
    public var follow_music: Bool
    /// A held tap sustains its note until the finger lifts.
    public var hold: Bool
    /// While holding, dragging up and down moves through the scale and left and right sweeps a filter.
    public var drag_bend: Bool
    /// `classic`, a built-in id from `AppTheme.builtIns`, or `custom:<id>` of one of `app_themes`.
    public var app_theme: String
    public var app_themes: [AppTheme]
    /// `system | light | dark`; applies to `classic`.
    public var appearance: String
    /// Each calendar events come from, with its own color and the owner's choice (Theme, Calendar colors).
    public var calendars: [CalendarColorEntry]
    /// The phone layout's bottom bar (Theme, Bottom bar; `Bar.swift`). Nil when the hub named none (a hub from before
    /// it) or named one that breaks a rule: `shownBar` is then the default.
    public var bar: BarSetting?
    /// What Today shows and in what order (Theme, Today; `TodayParts.swift`). Nil when the hub named none (a hub from
    /// before it) or named one that breaks a rule: `shownToday` is then the default.
    public var today: TodaySetting?
    /// The calendars whose events the Week screen leaves out, by key (Week, Calendars; `HiddenCalendars`). Nil when the
    /// hub named none (a hub from before it) or named a list that breaks a rule: `hiddenCalendars` is then empty.
    public var hidden_calendars: [String]?
    /// The key and scale actually played: the setting, or the newest music idea's when following music.
    public var effective: Effective?
    public var options: Options?

    public struct Effective: Codable, Equatable, Sendable {
        public var key: String
        public var scale: String
        public var from: Source?
        public init(key: String, scale: String, from: Source? = nil) { self.key = key; self.scale = scale; self.from = from }
    }
    public struct Source: Codable, Equatable, Sendable {
        public var id: String
        public var title: String
        public var key: String
        public init(id: String, title: String, key: String) { self.id = id; self.title = title; self.key = key }
    }
    /// What the hub offers. Only informational: the app carries its own copy of every list.
    public struct Options: Codable, Equatable, Sendable {
        public var keys: [String]
        public var scales: [String]
        public var synths: [String]
        public var themes: [String]
        public var shapes: [String]

        public init(keys: [String] = [], scales: [String] = [], synths: [String] = [], themes: [String] = [], shapes: [String] = []) {
            self.keys = keys; self.scales = scales; self.synths = synths; self.themes = themes; self.shapes = shapes
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            keys = (try? c.decode([String].self, forKey: .keys)) ?? []
            scales = (try? c.decode([String].self, forKey: .scales)) ?? []
            synths = (try? c.decode([String].self, forKey: .synths)) ?? []
            themes = (try? c.decode([String].self, forKey: .themes)) ?? []
            shapes = (try? c.decode([String].self, forKey: .shapes)) ?? []
        }
    }

    public static let defaultShapes = ["triangle", "square", "circle", "hexagon", "diamond"]

    /// Whether taps and new things draw shapes: the Shapes switch is on and the system's Reduce Motion is off, as on
    /// the web (`motionOn`). `reduceMotion` is the platform's own reading (SwiftUI's `accessibilityReduceMotion`).
    public func showsShapes(reduceMotion: Bool) -> Bool { motion && !reduceMotion }

    /// Used when the hub has never answered.
    public static let defaults = FeelSettings(
        motion: true, theme: "aurora", palettes: [], shapes: defaultShapes, images: [], shape_size: 1, density: 1,
        sound: true, volume: 0.4, key: "C", scale: "major_pentatonic", synth: "sine", octave: 4, follow_music: false,
        hold: true, drag_bend: false, app_theme: AppTheme.classicId, app_themes: [], appearance: "system",
        calendars: [], effective: nil, options: nil)

    public init(motion: Bool, theme: String, palettes: [FeelPalette], shapes: [String], images: [FeelImage],
                shape_size: Double, density: Double, sound: Bool, volume: Double, key: String, scale: String,
                synth: String, octave: Int, follow_music: Bool, hold: Bool, drag_bend: Bool, app_theme: String,
                app_themes: [AppTheme], appearance: String, calendars: [CalendarColorEntry] = [], bar: BarSetting? = nil,
                today: TodaySetting? = nil, hidden_calendars: [String]? = nil, effective: Effective?, options: Options?) {
        self.motion = motion; self.theme = theme; self.palettes = palettes; self.shapes = shapes; self.images = images
        self.shape_size = shape_size; self.density = density
        self.sound = sound; self.volume = volume; self.key = key; self.scale = scale; self.synth = synth
        self.octave = octave; self.follow_music = follow_music; self.hold = hold; self.drag_bend = drag_bend
        self.app_theme = app_theme; self.app_themes = app_themes; self.appearance = appearance
        self.calendars = calendars; self.bar = bar; self.today = today; self.hidden_calendars = hidden_calendars
        self.effective = effective; self.options = options
    }

    enum CodingKeys: String, CodingKey {
        case motion, theme, palettes, shapes, images, shape_size, density, sound, volume, key, scale, synth, octave
        case follow_music, hold, drag_bend, app_theme, app_themes, appearance, calendars, bar, today, hidden_calendars, effective, options
    }

    private struct AnyKey: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    /// Lenient: a missing, newer or unknown value falls back to the default instead of losing the whole setting,
    /// and a broken item in a list is dropped alone. An old cache with `theme: "custom"` and `colors` becomes the
    /// palette `mine`, as the hub does.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = FeelSettings.defaults
        func list<T: Decodable>(_ k: CodingKeys, _ t: T.Type) -> [T]? {
            (try? c.decode([Lenient<T>].self, forKey: k)).map { $0.compactMap(\.value) }
        }
        motion = (try? c.decode(Bool.self, forKey: .motion)) ?? d.motion
        theme = (try? c.decode(String.self, forKey: .theme)) ?? d.theme
        palettes = list(.palettes, FeelPalette.self) ?? d.palettes
        shapes = (try? c.decode([String].self, forKey: .shapes)) ?? d.shapes
        images = list(.images, FeelImage.self) ?? d.images
        shape_size = (try? c.decode(Double.self, forKey: .shape_size)) ?? d.shape_size
        density = (try? c.decode(Double.self, forKey: .density)) ?? d.density
        sound = (try? c.decode(Bool.self, forKey: .sound)) ?? d.sound
        volume = (try? c.decode(Double.self, forKey: .volume)) ?? d.volume
        key = (try? c.decode(String.self, forKey: .key)) ?? d.key
        scale = (try? c.decode(String.self, forKey: .scale)) ?? d.scale
        synth = (try? c.decode(String.self, forKey: .synth)) ?? d.synth
        octave = (try? c.decode(Int.self, forKey: .octave)) ?? d.octave
        follow_music = (try? c.decode(Bool.self, forKey: .follow_music)) ?? d.follow_music
        hold = (try? c.decode(Bool.self, forKey: .hold)) ?? d.hold
        drag_bend = (try? c.decode(Bool.self, forKey: .drag_bend)) ?? d.drag_bend
        app_theme = (try? c.decode(String.self, forKey: .app_theme)) ?? d.app_theme
        app_themes = list(.app_themes, AppTheme.self) ?? d.app_themes
        appearance = (try? c.decode(String.self, forKey: .appearance)) ?? d.appearance
        calendars = list(.calendars, CalendarColorEntry.self) ?? d.calendars
        // Absent, or breaking a rule (BarSetting does not decode then): none, and the default bar is drawn.
        bar = try? c.decode(BarSetting.self, forKey: .bar)
        // The same for Today's setting.
        today = try? c.decode(TodaySetting.self, forKey: .today)
        // And for the Week screen's hidden calendars: none, and every calendar is shown.
        hidden_calendars = (try? c.decode([String].self, forKey: .hidden_calendars)).flatMap { HiddenCalendars.isValid($0) ? $0 : nil }
        effective = try? c.decode(Effective.self, forKey: .effective)
        options = try? c.decode(Options.self, forKey: .options)
        if theme == "custom" {
            let old = (try? decoder.container(keyedBy: AnyKey.self).decode([String].self, forKey: AnyKey(stringValue: "colors"))) ?? []
            let colors = old.filter { FeelTheme.rgb($0) != nil }.prefix(FeelPalette.maxColors)
            if !colors.isEmpty, !palettes.contains(where: { $0.id == "mine" }) {
                palettes.append(FeelPalette(id: "mine", name: "My colors", colors: Array(colors)))
            }
            theme = colors.isEmpty ? d.theme : "custom:mine"
        }
        sanitize()
    }

    /// Unknown values back to the defaults, numbers into range, lists without broken or repeated items.
    mutating func sanitize() {
        let d = FeelSettings.defaults
        if !FeelMusic.keys.contains(key) { key = d.key }
        if FeelMusic.scales[scale] == nil { scale = d.scale }
        if !FeelMusic.synths.contains(synth) { synth = d.synth }
        octave = min(6, max(2, octave))
        volume = volume.isFinite ? min(1, max(0, volume)) : d.volume
        shape_size = shape_size.isFinite ? min(2, max(0.5, shape_size)) : 1
        density = density.isFinite ? min(2, max(0.5, density)) : 1
        var seenShapes = Set<String>()
        shapes = shapes.filter { FeelShapeKind(rawValue: $0) != nil && seenShapes.insert($0).inserted }
        palettes = Self.unique(palettes.compactMap { $0.cleaned }, \.id)
        images = Self.unique(images.filter { FeelID.valid($0.id) }, \.id)
        app_themes = Self.unique(app_themes.compactMap { $0.cleaned }, \.id)
        calendars = Array(Self.unique(calendars.compactMap { $0.cleaned }, \.key).prefix(CalendarColorEntry.maxCount))
        if !FeelTheme.order.contains(theme), FeelTheme.customId(theme).flatMap({ id in palettes.first { $0.id == id } }) == nil {
            theme = d.theme
        }
        if app_theme != AppTheme.classicId, AppTheme.resolve(app_theme, custom: app_themes) == nil { app_theme = d.app_theme }
        if !["system", "light", "dark"].contains(appearance) { appearance = d.appearance }
    }

    private static func unique<T>(_ xs: [T], _ id: KeyPath<T, String>) -> [T] {
        var seen = Set<String>()
        return xs.filter { seen.insert($0[keyPath: id]).inserted }
    }

    /// The key to play: `effective.key` when the hub sent one, else the manual key.
    public var playKey: String { effective?.key ?? key }
    public var playScale: String { effective?.scale ?? scale }

    /// The palette chosen for taps, as `#rrggbb` (empty for mono, which draws from the accent color).
    public var paletteHexes: [String] { FeelTheme.hexes(theme: theme, palettes: palettes) }
    /// The app theme in use; nil for Classic.
    public var activeAppTheme: AppTheme? { AppTheme.resolve(app_theme, custom: app_themes) }
    public var enabledImages: [FeelImage] { images.filter(\.enabled) }
    /// The bottom bar to draw and edit: the setting's, or the default while there is none.
    public var shownBar: BarSetting { bar ?? .standard }
    /// What Today shows and in what order: the setting's, or the default while there is none.
    public var shownToday: TodaySetting { today ?? .standard }
    /// The calendars Week leaves out: the setting's, or none while there is none.
    public var hiddenCalendars: [String] { hidden_calendars ?? [] }
}

/// Decodes an element or nothing, so one broken item does not lose the rest of a list.
struct Lenient<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

/// Ids for palettes, images and app themes: lowercase letters, digits and dashes, 1 to 40 long.
public enum FeelID {
    public static func valid(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 40 && id.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
    }

    /// A fresh id that is not in `taken`.
    public static func make(taken: [String]) -> String {
        while true {
            let id = String(UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "").prefix(8))
            if !taken.contains(id) { return id }
        }
    }

    /// A name trimmed to 40 characters, or `fallback` when blank.
    public static func name(_ s: String, fallback: String) -> String {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? fallback : String(t.prefix(40))
    }

    /// "Aurora" → "Aurora copy"; again → "Aurora copy 2", avoiding names in `taken`.
    public static func copyName(_ name: String, taken: [String]) -> String {
        let base = String("\(name) copy".prefix(34))
        if !taken.contains(base) { return base }
        var n = 2
        while taken.contains("\(base) \(n)") { n += 1 }
        return "\(base) \(n)"
    }
}

/// A named set of tap colors, chosen as `custom:<id>`.
public struct FeelPalette: Codable, Equatable, Sendable, Identifiable, Hashable {
    public static let maxColors = 8
    public static let maxCount = 30
    public var id: String
    public var name: String
    public var colors: [String]
    public init(id: String, name: String, colors: [String]) { self.id = id; self.name = name; self.colors = colors }

    /// Valid id, a name, 1 to 8 valid colors; nil when nothing usable is left.
    var cleaned: FeelPalette? {
        let c = colors.filter { FeelTheme.rgb($0) != nil }.prefix(Self.maxColors)
        guard FeelID.valid(id), !c.isEmpty else { return nil }
        return FeelPalette(id: id, name: FeelID.name(name, fallback: "Colors"), colors: Array(c))
    }
}

/// An uploaded image drawn as a shape, served from `/prefs/feel/images/:id`.
public struct FeelImage: Codable, Equatable, Sendable, Identifiable, Hashable {
    public static let maxCount = 24
    public var id: String
    public var name: String
    public var enabled: Bool
    public var type: String
    public init(id: String, name: String, enabled: Bool, type: String = "image/png") {
        self.id = id; self.name = name; self.enabled = enabled; self.type = type
    }
}

/// The shapes a burst can draw, in the hub's order.
public enum FeelShapeKind: String, CaseIterable, Sendable {
    case triangle, square, circle, hexagon, diamond, star, ring, spark
    public var title: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
}

/// The app's own colors. `classic` is the system look and has no entry; every other theme sets all four colors.
public struct AppTheme: Codable, Equatable, Sendable, Identifiable, Hashable {
    public static let classicId = "classic"
    public static let maxCount = 20
    public var id: String
    public var name: String
    /// `light` or `dark`.
    public var mode: String
    public var accent: String
    public var background: String
    public var surface: String
    public var text: String
    /// Status colors: what is fine, what needs a look, what is a problem. Nil uses the classic one for the theme's mode.
    public var ok: String?
    public var warn: String?
    public var danger: String?

    public init(id: String, name: String, mode: String, accent: String, background: String, surface: String, text: String,
                ok: String? = nil, warn: String? = nil, danger: String? = nil) {
        self.id = id; self.name = name; self.mode = mode; self.accent = accent
        self.background = background; self.surface = surface; self.text = text
        self.ok = ok; self.warn = warn; self.danger = danger
    }

    public var isDark: Bool { mode == "dark" }

    /// Built-in themes with the hub's exact colors.
    public static let builtIns: [AppTheme] = [
        AppTheme(id: "midnight", name: "Midnight", mode: "dark", accent: "#7C5CFF", background: "#0E1020", surface: "#181B33", text: "#E8E9F3"),
        AppTheme(id: "paper", name: "Paper", mode: "light", accent: "#B5562B", background: "#F7F3EA", surface: "#FFFDF8", text: "#2B2622"),
        AppTheme(id: "daylight", name: "Daylight", mode: "light", accent: "#0A84FF", background: "#F4F6FA", surface: "#FFFFFF", text: "#1C1C1E"),
        AppTheme(id: "forest", name: "Forest", mode: "dark", accent: "#52B788", background: "#0F1A14", surface: "#17261D", text: "#E3F1E8"),
        AppTheme(id: "ocean", name: "Ocean", mode: "dark", accent: "#2EC5FF", background: "#08151F", surface: "#10222F", text: "#E2F3FA"),
        AppTheme(id: "sunset", name: "Sunset", mode: "dark", accent: "#FF9F43", background: "#1C1016", surface: "#2A1820", text: "#FBE9E1"),
        AppTheme(id: "neon", name: "Neon", mode: "dark", accent: "#FF00E5", background: "#07070B", surface: "#121219", text: "#F2F2FF"),
    ]

    /// `midnight` or `custom:<id>` → the theme; nil for `classic` or anything unknown.
    public static func resolve(_ choice: String, custom: [AppTheme]) -> AppTheme? {
        if let id = FeelTheme.customId(choice) { return custom.first { $0.id == id } }
        return builtIns.first { $0.id == choice }
    }

    /// The display name of a choice: "Classic", "Midnight", or a custom theme's name.
    public static func name(_ choice: String, custom: [AppTheme]) -> String {
        resolve(choice, custom: custom)?.name ?? "Classic"
    }

    var cleaned: AppTheme? {
        guard FeelID.valid(id), mode == "light" || mode == "dark" else { return nil }
        for h in [accent, background, surface, text] where FeelTheme.rgb(h) == nil { return nil }
        // A broken status color is left out on its own, so the theme keeps the classic one for it instead of being lost.
        func status(_ h: String?) -> String? { h.flatMap { FeelTheme.rgb($0) == nil ? nil : $0.uppercased() } }
        return AppTheme(id: id, name: FeelID.name(name, fallback: "Theme"), mode: mode, accent: accent.uppercased(),
                        background: background.uppercased(), surface: surface.uppercased(), text: text.uppercased(),
                        ok: status(ok), warn: status(warn), danger: status(danger))
    }

    /// The contrast ratio of text on the weaker of background and surface.
    public var textContrast: Double { min(FeelColor.contrast(text, surface), FeelColor.contrast(text, background)) }
    /// WCAG AA for body text is 4.5.
    public var isReadable: Bool { textContrast >= 4.5 }
}

/// Luminance and contrast of `#rrggbb` colors (WCAG 2 formulas).
public enum FeelColor {
    public static func luminance(_ hex: String) -> Double {
        guard let c = FeelTheme.rgb(hex) else { return 0 }
        func lin(_ x: Double) -> Double { x <= 0.03928 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4) }
        return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
    }

    public static func contrast(_ a: String, _ b: String) -> Double {
        let la = luminance(a), lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    /// Black or white, whichever reads better on `hex` (for a label on an accent button).
    public static func onColor(_ hex: String) -> String { contrast(hex, "#000000") >= contrast(hex, "#FFFFFF") ? "#000000" : "#FFFFFF" }

    /// `a` moved toward `b` by `t` (0 is a, 1 is b), as `#RRGGBB`.
    public static func mix(_ a: String, _ b: String, _ t: Double) -> String {
        guard let x = FeelTheme.rgb(a), let y = FeelTheme.rgb(b) else { return a }
        return FeelTheme.hex(r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t)
    }

    /// A status color as words, as the web does (web/src/feel/appTheme.ts): the color itself when it reads at `min` on
    /// every background given, else moved toward the theme's text color a step at a time until it does (on a light
    /// page amber becomes a deep brown). When nothing short of the text color reads, the text color.
    public static func readable(_ color: String, text: String, min: Double = 4.5, on: [String]) -> String {
        for i in 0...25 {
            let c = mix(color, text, Double(i) * 0.04)
            if on.allSatisfy({ contrast(c, $0) >= min }) { return c }
        }
        return text
    }

    /// Words on a colored fill (an accent button, a green "fine" light): white when it reads at 4.5:1, else a dark ink
    /// from the theme, else whichever of white and black reads better.
    public static func onFill(_ fill: String, ink: String) -> String {
        if contrast("#FFFFFF", fill) >= 4.5 { return "#FFFFFF" }
        if contrast(ink, fill) >= 4.5 { return ink }
        return contrast("#FFFFFF", fill) >= contrast("#000000", fill) ? "#FFFFFF" : "#000000"
    }
}

/// What a status color says: fine, needs a look, or a problem (checks, readings, alerts, deadlines).
public enum StatusTone: String, CaseIterable, Sendable {
    case ok, warn, danger

    /// The words Settings uses for it.
    public var title: String {
        switch self {
        case .ok: return "Fine"
        case .warn: return "Needs a look"
        case .danger: return "Problem"
        }
    }
}

/// Status colors for a theme. A saved theme may carry its own; any it leaves out, and every built-in theme, use the
/// classic ones for its mode (the hub's and the web's, so a theme looks the same everywhere). As words they are made
/// readable on the theme's background and cards; on a fill, the words on it are white or a dark ink.
public struct StatusPalette: Equatable, Sendable {
    /// The classic status colors (web/src/feel/appTheme.ts CLASSIC), for themes that do not choose their own.
    public static let classicLight: [StatusTone: String] = [.ok: "#3A8F5A", .warn: "#C2871A", .danger: "#B4443C"]
    public static let classicDark: [StatusTone: String] = [.ok: "#6CC08A", .warn: "#E0A84A", .danger: "#E07A73"]

    public static func classic(dark: Bool) -> [StatusTone: String] { dark ? classicDark : classicLight }

    /// The fill colors: dots, bars, borders, lights.
    public var fill: [StatusTone: String]
    /// The same colors as words.
    public var text: [StatusTone: String]
    /// Words on a fill of each color.
    public var on: [StatusTone: String]

    /// - Parameters:
    ///   - fill: the status colors to use.
    ///   - text: the theme's text color, which words move toward until they read.
    ///   - backgrounds: what words sit on (the background and the cards).
    ///   - ink: a dark color from the theme for words on a light fill.
    public init(fill: [StatusTone: String], text textColor: String, backgrounds: [String], ink: String) {
        self.fill = fill
        var t: [StatusTone: String] = [:], o: [StatusTone: String] = [:]
        for tone in StatusTone.allCases {
            let c = fill[tone] ?? Self.classicLight[tone]!
            t[tone] = FeelColor.readable(c, text: textColor, on: backgrounds)
            o[tone] = FeelColor.onFill(c, ink: ink)
        }
        text = t
        on = o
    }

    /// A theme's palette: its own status colors, else the classic ones for its mode.
    public init(theme t: AppTheme) {
        let base = Self.classic(dark: t.isDark)
        let fill: [StatusTone: String] = [.ok: t.ok ?? base[.ok]!, .warn: t.warn ?? base[.warn]!, .danger: t.danger ?? base[.danger]!]
        // The web's dark ink for words on a light fill: the background darkened.
        let ink = FeelColor.mix(t.background, "#000000", t.isDark ? 0.4 : 0.85)
        self.init(fill: fill, text: t.text, backgrounds: [t.background, t.surface], ink: ink)
    }
}

extension AppTheme {
    /// The theme's status color for a tone: its own, else the classic one for its mode.
    public func status(_ tone: StatusTone) -> String {
        let own: String? = tone == .ok ? ok : tone == .warn ? warn : danger
        return own ?? StatusPalette.classic(dark: isDark)[tone]!
    }

    /// Whether the theme chose its own color for a tone.
    public func hasOwnStatus(_ tone: StatusTone) -> Bool { (tone == .ok ? ok : tone == .warn ? warn : danger) != nil }

    /// The theme with its own color for a tone, or with nil the classic one again.
    public func withStatus(_ tone: StatusTone, _ hex: String?) -> AppTheme {
        var t = self
        switch tone {
        case .ok: t.ok = hex
        case .warn: t.warn = hex
        case .danger: t.danger = hex
        }
        return t
    }
}

/// Scales, notes and pitches for the tap sounds. Intervals match `hub/src/feel.ts`.
public enum FeelMusic {
    public static let keys = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    public static let scales: [String: [Int]] = [
        "major": [0, 2, 4, 5, 7, 9, 11],
        "minor": [0, 2, 3, 5, 7, 8, 10],
        "major_pentatonic": [0, 2, 4, 7, 9],
        "minor_pentatonic": [0, 3, 5, 7, 10],
        "blues": [0, 3, 5, 6, 7, 10],
        "dorian": [0, 2, 3, 5, 7, 9, 10],
        "phrygian": [0, 1, 3, 5, 7, 8, 10],
        "lydian": [0, 2, 4, 6, 7, 9, 11],
        "mixolydian": [0, 2, 4, 5, 7, 9, 10],
        "harmonic_minor": [0, 2, 3, 5, 7, 8, 11],
        "whole_tone": [0, 2, 4, 6, 8, 10],
        "hirajoshi": [0, 2, 3, 7, 8],
    ]
    /// The order the scales are offered in Settings.
    public static let scaleOrder = ["major", "minor", "major_pentatonic", "minor_pentatonic", "blues", "dorian", "phrygian",
                                    "lydian", "mixolydian", "harmonic_minor", "whole_tone", "hirajoshi"]
    public static let synths = ["sine", "glass", "pluck", "bell", "marimba", "chip", "pad"]
    /// Synths that hold steady while a note is held; the others ring down to a quiet sustain.
    public static let sustaining: Set<String> = ["sine", "glass", "pad", "chip"]

    /// "minor_pentatonic" → "Minor pentatonic".
    public static func scaleName(_ id: String) -> String {
        let words = id.replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    public static func intervals(_ scale: String) -> [Int] { scales[scale] ?? scales["major_pentatonic"]! }

    /// MIDI number of the key's root: 12 * (octave + 1) + key index. C4 is 60.
    public static func rootMIDI(key: String, octave: Int) -> Int {
        12 * (octave + 1) + (keys.firstIndex(of: key) ?? 0)
    }

    /// MIDI note of a scale degree; degrees past the scale wrap up an octave (degree 0 is the root).
    public static func degree(_ d: Int, key: String, scale: String, octave: Int) -> Int {
        let iv = intervals(scale)
        let n = iv.count
        let oct = d >= 0 ? d / n : (d - n + 1) / n
        let idx = d - oct * n
        return rootMIDI(key: key, octave: octave) + iv[idx] + 12 * oct
    }

    /// Every note of the scale across two octaves up from the root.
    public static func tapNotes(key: String, scale: String, octave: Int) -> [Int] {
        let iv = intervals(scale)
        let root = rootMIDI(key: key, octave: octave)
        return (0..<2).flatMap { o in iv.map { root + $0 + 12 * o } }
    }

    /// Degrees 0, 2 and 4: played rising for a new item and together for a finished one.
    public static func triad(key: String, scale: String, octave: Int) -> [Int] {
        [0, 2, 4].map { degree($0, key: key, scale: scale, octave: octave) }
    }

    public static func hz(_ midi: Int) -> Double { 440 * pow(2, Double(midi - 69) / 12) }
}

/// Picks a random tap note, never the same one twice in a row.
public struct FeelNotePicker: Sendable {
    public private(set) var last: Int?
    public init() {}

    public mutating func next<R: RandomNumberGenerator>(from notes: [Int], using rng: inout R) -> Int? {
        guard !notes.isEmpty else { return nil }
        let pool = notes.count > 1 ? notes.filter { $0 != last } : notes
        let n = pool.randomElement(using: &rng) ?? notes[0]
        last = n
        return n
    }

    public mutating func next(from notes: [Int]) -> Int? {
        var g = SystemRandomNumberGenerator()
        return next(from: notes, using: &g)
    }
}

/// Tap palettes as `#rrggbb`. `mono` is empty: the app draws it from its accent color. A saved palette is `custom:<id>`.
public enum FeelTheme {
    public static let order = ["aurora", "sunset", "ocean", "forest", "neon", "candy", "mono"]
    public static let palettes: [String: [String]] = [
        "aurora": ["#7C5CFF", "#2EC5FF", "#3DF5A7", "#FFD166", "#FF5C8A"],
        "sunset": ["#FF6B6B", "#FF9F43", "#FECA57", "#FF7EB6", "#A55EEA"],
        "ocean": ["#00B4D8", "#0077B6", "#48CAE4", "#90E0EF", "#06D6A0"],
        "forest": ["#2D6A4F", "#52B788", "#95D5B2", "#B5E48C", "#74C69D"],
        "neon": ["#FF00E5", "#00F0FF", "#39FF14", "#FFF300", "#FF3131"],
        "candy": ["#FFADAD", "#FFD6A5", "#FDFFB6", "#CAFFBF", "#9BF6FF", "#A0C4FF", "#BDB2FF", "#FFC6FF"],
        "mono": [],
    ]

    /// `custom:abc` → `abc`; nil for anything else.
    public static func customId(_ choice: String) -> String? {
        guard choice.hasPrefix("custom:") else { return nil }
        let id = String(choice.dropFirst("custom:".count))
        return id.isEmpty ? nil : id
    }

    /// "aurora" → "Aurora"; `custom:<id>` → the palette's name.
    public static func name(_ choice: String, palettes saved: [FeelPalette] = []) -> String {
        if let id = customId(choice) { return saved.first { $0.id == id }?.name ?? "Aurora" }
        return choice.prefix(1).uppercased() + choice.dropFirst()
    }

    /// The colors to draw with. A saved palette uses its colors; anything unknown draws in aurora; mono returns none.
    public static func hexes(theme: String, palettes saved: [FeelPalette]) -> [String] {
        if let id = customId(theme) {
            let valid = saved.first { $0.id == id }?.colors.filter { rgb($0) != nil } ?? []
            return valid.isEmpty ? palettes["aurora"]! : valid
        }
        return palettes[theme] ?? palettes["aurora"]!
    }

    /// "#7C5CFF" → (0.486, 0.361, 1.0). Nil when it is not `#rrggbb`.
    public static func rgb(_ hex: String) -> (r: Double, g: Double, b: Double)? {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, s.allSatisfy(\.isHexDigit), let v = UInt32(s, radix: 16) else { return nil }
        return (Double((v >> 16) & 0xFF) / 255, Double((v >> 8) & 0xFF) / 255, Double(v & 0xFF) / 255)
    }

    /// (0.486, 0.361, 1.0) → "#7C5CFF".
    public static func hex(r: Double, g: Double, b: Double) -> String {
        func c(_ x: Double) -> Int { Int((min(max(x.isFinite ? x : 0, 0), 1) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", c(r), c(g), c(b))
    }
}

/// Held notes that bend: up and down steps through the scale, left and right works like a synth's filter knob.
public enum FeelBend {
    /// Vertical travel ignored before the first step, then points per scale step.
    public static let deadZone: Double = 12
    public static let pointsPerStep: Double = 44
    /// Horizontal points per octave of filter cutoff.
    public static let pointsPerOctave: Double = 30
    /// Where the knob rests for every note, before any sideways move.
    public static let restCutoff: Double = 3100
    public static let lowCutoff: Double = 60
    public static let highCutoff: Double = 16000
    /// Horizontal points over which the drive that gives the filter overtones to work on comes in fully.
    public static let driveSpan: Double = 40
    /// A press released sooner than this is a quick tap and plays the short note.
    public static let quickTap: Double = 0.3
    /// A held note ends on its own after this long.
    public static let maxHold: Double = 20
    /// Points of finger travel between the small shapes a bent note leaves behind.
    public static let trailSpacing: Double = 40

    /// Scale steps for a vertical move (`dy` in points, down positive); up is higher, at most two octaves either way.
    public static func steps(dy: Double, scale: String) -> Int {
        let limit = 2 * FeelMusic.intervals(scale).count
        let travel = max(0, abs(dy) - deadZone)
        let s = Int((travel / pointsPerStep).rounded()) * (dy < 0 ? 1 : -1)
        return min(limit, max(-limit, s))
    }

    /// The MIDI note `steps` scale steps from `base`. A base off the scale starts from the scale note below it.
    public static func note(base: Int, steps: Int, key: String, scale: String, octave: Int) -> Int {
        guard steps != 0 else { return base }
        let iv = FeelMusic.intervals(scale)
        let rel = base - FeelMusic.rootMIDI(key: key, octave: octave)
        let o = rel >= 0 ? rel / 12 : (rel - 11) / 12
        let pc = rel - 12 * o
        let idx = iv.lastIndex { $0 <= pc } ?? 0
        return FeelMusic.degree(o * iv.count + idx + steps, key: key, scale: scale, octave: octave)
    }

    /// Low-pass cutoff in Hz for a horizontal move: one octave per 30 points from 3.1 kHz, left darker,
    /// right brighter, from 60 Hz to 16 kHz.
    public static func cutoff(dx: Double) -> Double {
        min(highCutoff, max(lowCutoff, restCutoff * pow(2, dx / pointsPerOctave)))
    }

    /// How much saturation feeds the filter (0 to 1): a sine has no overtones for a filter to cut, so any sideways
    /// move brings some in, fully by 40 points.
    public static func drive(dx: Double) -> Double { min(1, abs(dx) / driveSpan) }
}

/// A moment worth a bigger burst and a chord: something new, or something finished.
public enum FeelMoment: String, Sendable, Equatable {
    case create, complete

    /// What a local change means. `created` is true for a create patch made on this device.
    /// A finished task, an acknowledged reminder, or a procedure step done count as complete.
    public static func detect(before: Entity?, after: Entity, created: Bool) -> FeelMoment? {
        if after.isDeleted { return nil }
        if created { return .create }
        guard let b = before else { return nil }
        switch after.kind {
        case .task:
            return after.str("status") == "done" && b.str("status") != "done" ? .complete : nil
        case .reminder:
            return !after.str("acknowledged_at").isEmpty && b.str("acknowledged_at").isEmpty ? .complete : nil
        case .procedure:
            if !after.str("done_at").isEmpty && b.str("done_at").isEmpty { return .complete }
            return (after.number("current") ?? 0) > (b.number("current") ?? 0) ? .complete : nil
        default:
            return nil
        }
    }
}
