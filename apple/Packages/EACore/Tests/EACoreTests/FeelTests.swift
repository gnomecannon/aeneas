import XCTest
@testable import EACore

/// Deterministic generator so note picking can be checked.
private struct SeqRNG: RandomNumberGenerator {
    var state: UInt64
    mutating func next() -> UInt64 {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return state
    }
}

final class FeelTests: XCTestCase {
    func testRootMIDI() {
        XCTAssertEqual(FeelMusic.rootMIDI(key: "C", octave: 4), 60)
        XCTAssertEqual(FeelMusic.rootMIDI(key: "A", octave: 4), 69)
        XCTAssertEqual(FeelMusic.rootMIDI(key: "A#", octave: 2), 46)
        XCTAssertEqual(FeelMusic.rootMIDI(key: "B", octave: 6), 95)
    }

    func testHz() {
        XCTAssertEqual(FeelMusic.hz(69), 440, accuracy: 0.0001)
        XCTAssertEqual(FeelMusic.hz(60), 261.6256, accuracy: 0.001)
        XCTAssertEqual(FeelMusic.hz(81), 880, accuracy: 0.0001)
    }

    func testScalesMatchHub() {
        XCTAssertEqual(FeelMusic.scales.count, 12)
        XCTAssertEqual(Set(FeelMusic.scaleOrder), Set(FeelMusic.scales.keys))
        XCTAssertEqual(FeelMusic.scales["blues"], [0, 3, 5, 6, 7, 10])
        XCTAssertEqual(FeelMusic.scales["hirajoshi"], [0, 2, 3, 7, 8])
        XCTAssertEqual(FeelMusic.scales["harmonic_minor"], [0, 2, 3, 5, 7, 8, 11])
        XCTAssertEqual(FeelMusic.scaleName("minor_pentatonic"), "Minor pentatonic")
        XCTAssertEqual(FeelMusic.scaleName("dorian"), "Dorian")
    }

    func testTapNotesSpanTwoOctaves() {
        let notes = FeelMusic.tapNotes(key: "C", scale: "major_pentatonic", octave: 4)
        XCTAssertEqual(notes, [60, 62, 64, 67, 69, 72, 74, 76, 79, 81])
        let d = FeelMusic.tapNotes(key: "D", scale: "minor", octave: 3)
        XCTAssertEqual(d.count, 14)
        XCTAssertEqual(d.first, 50)
        XCTAssertEqual(d.last, 50 + 12 + 10)
        // An unknown scale falls back to major pentatonic.
        XCTAssertEqual(FeelMusic.tapNotes(key: "C", scale: "nope", octave: 4), notes)
    }

    func testTriadDegrees() {
        XCTAssertEqual(FeelMusic.triad(key: "C", scale: "major", octave: 4), [60, 64, 67])
        XCTAssertEqual(FeelMusic.triad(key: "A", scale: "minor", octave: 3), [57, 60, 64])
        // Pentatonic degrees 0, 2, 4 are the root, the third note and the fifth note.
        XCTAssertEqual(FeelMusic.triad(key: "C", scale: "major_pentatonic", octave: 4), [60, 64, 69])
        // Degrees past the scale wrap up an octave.
        XCTAssertEqual(FeelMusic.degree(5, key: "C", scale: "major_pentatonic", octave: 4), 72)
        XCTAssertEqual(FeelMusic.degree(-1, key: "C", scale: "major_pentatonic", octave: 4), 57)
    }

    func testPickerNeverRepeats() {
        var picker = FeelNotePicker()
        var rng = SeqRNG(state: 42)
        let notes = FeelMusic.tapNotes(key: "E", scale: "blues", octave: 4)
        var last: Int?
        var seen = Set<Int>()
        for _ in 0..<500 {
            let n = picker.next(from: notes, using: &rng)!
            XCTAssertNotEqual(n, last)
            XCTAssertTrue(notes.contains(n))
            seen.insert(n)
            last = n
        }
        XCTAssertEqual(seen.count, notes.count)
        var one = FeelNotePicker()
        XCTAssertEqual(one.next(from: [60], using: &rng), 60)
        XCTAssertEqual(one.next(from: [60], using: &rng), 60)
        XCTAssertNil(one.next(from: [], using: &rng))
    }

    func testThemes() {
        let mine = FeelPalette(id: "abc", name: "Mine", colors: ["#112233", "bad"])
        XCTAssertEqual(FeelTheme.hexes(theme: "aurora", palettes: []), ["#7C5CFF", "#2EC5FF", "#3DF5A7", "#FFD166", "#FF5C8A"])
        XCTAssertEqual(FeelTheme.hexes(theme: "candy", palettes: []).count, 8)
        XCTAssertEqual(FeelTheme.hexes(theme: "mono", palettes: []), [])
        XCTAssertEqual(FeelTheme.hexes(theme: "custom:abc", palettes: [mine]), ["#112233"])
        XCTAssertEqual(FeelTheme.hexes(theme: "custom:gone", palettes: [mine]), FeelTheme.palettes["aurora"])
        XCTAssertEqual(FeelTheme.hexes(theme: "unknown", palettes: []), FeelTheme.palettes["aurora"])
        XCTAssertEqual(FeelTheme.name("custom:abc", palettes: [mine]), "Mine")
        XCTAssertEqual(FeelTheme.name("sunset"), "Sunset")
        XCTAssertEqual(FeelTheme.customId("custom:abc"), "abc")
        XCTAssertNil(FeelTheme.customId("aurora"))
        XCTAssertNil(FeelTheme.customId("custom:"))
        for t in FeelTheme.order where t != "mono" {
            for h in FeelTheme.palettes[t]! { XCTAssertNotNil(FeelTheme.rgb(h), h) }
        }
        // Synths, shapes and built-in app themes match hub/src/feel.ts.
        XCTAssertEqual(FeelMusic.synths, ["sine", "glass", "pluck", "bell", "marimba", "chip", "pad"])
        XCTAssertEqual(FeelShapeKind.allCases.map(\.rawValue), ["triangle", "square", "circle", "hexagon", "diamond", "star", "ring", "spark"])
        XCTAssertEqual(AppTheme.builtIns.map(\.id), ["midnight", "paper", "daylight", "forest", "ocean", "sunset", "neon"])
        XCTAssertEqual(AppTheme.resolve("midnight", custom: [])?.background, "#0E1020")
        XCTAssertNil(AppTheme.resolve("classic", custom: []))
        XCTAssertEqual(AppTheme.name("classic", custom: []), "Classic")
    }

    func testBuiltInAppThemesAreReadable() {
        for t in AppTheme.builtIns {
            XCTAssertTrue(t.isReadable, "\(t.id) \(t.textContrast)")
            XCTAssertEqual(t.mode == "dark", FeelColor.luminance(t.background) < 0.2, t.id)
        }
        XCTAssertEqual(FeelColor.contrast("#000000", "#FFFFFF"), 21, accuracy: 0.01)
        XCTAssertEqual(FeelColor.contrast("#777777", "#777777"), 1, accuracy: 0.0001)
        XCTAssertEqual(FeelColor.onColor("#FFD166"), "#000000")
        XCTAssertEqual(FeelColor.onColor("#0E1020"), "#FFFFFF")
        let bad = AppTheme(id: "x", name: "Grey", mode: "light", accent: "#777777", background: "#EEEEEE", surface: "#FFFFFF", text: "#CCCCCC")
        XCTAssertFalse(bad.isReadable)
    }

    func testBendSteps() {
        XCTAssertEqual(FeelBend.steps(dy: 0, scale: "major"), 0)
        XCTAssertEqual(FeelBend.steps(dy: -30, scale: "major"), 0, "inside the dead zone and the first half step")
        XCTAssertEqual(FeelBend.steps(dy: -56, scale: "major"), 1)
        XCTAssertEqual(FeelBend.steps(dy: 100, scale: "major"), -2)
        // Two octaves either way at most: 14 steps for a seven note scale, 10 for a pentatonic one.
        XCTAssertEqual(FeelBend.steps(dy: -10000, scale: "major"), 14)
        XCTAssertEqual(FeelBend.steps(dy: 10000, scale: "major_pentatonic"), -10)
    }

    func testBendNotesStayInTheScale() {
        // C major pentatonic from E4 (64): up one is G4, up three is C5, down one is D4, down three is A3.
        func n(_ base: Int, _ s: Int) -> Int { FeelBend.note(base: base, steps: s, key: "C", scale: "major_pentatonic", octave: 4) }
        XCTAssertEqual(n(64, 0), 64)
        XCTAssertEqual(n(64, 1), 67)
        XCTAssertEqual(n(64, 3), 72)
        XCTAssertEqual(n(64, -1), 62)
        XCTAssertEqual(n(64, -3), 57)
        // From the second octave of tap notes.
        XCTAssertEqual(n(81, 1), 84)
        // A base off the scale (F, 65) starts from E below it.
        XCTAssertEqual(n(65, 1), 67)
        let scale = FeelMusic.tapNotes(key: "D", scale: "dorian", octave: 3)
        for base in scale {
            for s in -14...14 {
                let m = FeelBend.note(base: base, steps: s, key: "D", scale: "dorian", octave: 3)
                let pc = ((m - FeelMusic.rootMIDI(key: "D", octave: 3)) % 12 + 12) % 12
                XCTAssertTrue(FeelMusic.scales["dorian"]!.contains(pc), "\(base) \(s) \(m)")
            }
        }
    }

    func testBendCutoff() {
        XCTAssertEqual(FeelBend.cutoff(dx: 0), 3100, accuracy: 0.01, "rests at 3.1 kHz")
        XCTAssertEqual(FeelBend.cutoff(dx: 30), 6200, accuracy: 0.01, "an octave per 30 points")
        XCTAssertEqual(FeelBend.cutoff(dx: -60), 775, accuracy: 0.01)
        XCTAssertEqual(FeelBend.cutoff(dx: -1000), 60, accuracy: 0.01)
        XCTAssertEqual(FeelBend.cutoff(dx: 1000), 16000, accuracy: 0.01)
        XCTAssertEqual(FeelBend.drive(dx: 0), 0)
        XCTAssertEqual(FeelBend.drive(dx: -20), 0.5)
        XCTAssertEqual(FeelBend.drive(dx: 300), 1)
    }

    func testIdsAndNames() {
        XCTAssertTrue(FeelID.valid("abc-123"))
        XCTAssertFalse(FeelID.valid("ABC"))
        XCTAssertFalse(FeelID.valid(""))
        XCTAssertFalse(FeelID.valid(String(repeating: "a", count: 41)))
        let id = FeelID.make(taken: [])
        XCTAssertTrue(FeelID.valid(id))
        XCTAssertEqual(FeelID.name("  ", fallback: "Colors"), "Colors")
        XCTAssertEqual(FeelID.name(String(repeating: "x", count: 50), fallback: "").count, 40)
        XCTAssertEqual(FeelID.copyName("Aurora", taken: []), "Aurora copy")
        XCTAssertEqual(FeelID.copyName("Aurora", taken: ["Aurora copy"]), "Aurora copy 2")
        XCTAssertLessThanOrEqual(FeelID.copyName(String(repeating: "x", count: 40), taken: []).count, 40)
    }

    func testHexRoundTrip() {
        let c = FeelTheme.rgb("#7C5CFF")!
        XCTAssertEqual(c.r, 124.0 / 255, accuracy: 0.0001)
        XCTAssertEqual(c.g, 92.0 / 255, accuracy: 0.0001)
        XCTAssertEqual(c.b, 1, accuracy: 0.0001)
        XCTAssertEqual(FeelTheme.hex(r: c.r, g: c.g, b: c.b), "#7C5CFF")
        XCTAssertNil(FeelTheme.rgb("#12345"))
        XCTAssertNil(FeelTheme.rgb("#GG0000"))
        XCTAssertEqual(FeelTheme.hex(r: 2, g: -1, b: 0.5), "#FF0080")
    }

    func testDecodeHubShape() throws {
        let json = """
        {"motion":true,"theme":"custom:p1","palettes":[{"id":"p1","name":"Warm","colors":["#FF0000","#00FF00"]}],
         "shapes":["star","ring"],"images":[{"id":"a1b2","name":"Cat","enabled":true,"type":"image/png"}],
         "shape_size":1.5,"density":0.75,"sound":false,"volume":0.7,"key":"C","scale":"major","synth":"bell","octave":3,
         "follow_music":true,"hold":false,"drag_bend":true,"app_theme":"custom:t1",
         "app_themes":[{"id":"t1","name":"Dusk","mode":"dark","accent":"#ff9f43","background":"#101010","surface":"#202020","text":"#f0f0f0"}],
         "appearance":"dark",
         "effective":{"key":"A#","scale":"dorian","from":{"id":"m1","title":"hummed melody","key":"Bb dorian"}},
         "options":{"keys":["C"],"scales":["major"],"synths":["bell"],"themes":["neon"],"shapes":["star"],
           "app_themes":[{"id":"classic","name":"Classic"},{"id":"midnight","name":"Midnight","mode":"dark","accent":"#7C5CFF","background":"#0E1020","surface":"#181B33","text":"#E8E9F3"}]}}
        """
        let f = try JSONCoding.decode(FeelSettings.self, from: json)
        XCTAssertEqual(f.theme, "custom:p1")
        XCTAssertEqual(f.paletteHexes, ["#FF0000", "#00FF00"])
        XCTAssertEqual(f.shapes, ["star", "ring"])
        XCTAssertEqual(f.enabledImages.map(\.name), ["Cat"])
        XCTAssertEqual(f.shape_size, 1.5)
        XCTAssertEqual(f.density, 0.75)
        XCTAssertFalse(f.hold)
        XCTAssertTrue(f.drag_bend)
        XCTAssertEqual(f.activeAppTheme?.name, "Dusk")
        XCTAssertEqual(f.activeAppTheme?.accent, "#FF9F43")
        XCTAssertEqual(f.appearance, "dark")
        XCTAssertEqual(f.playKey, "A#")
        XCTAssertEqual(f.playScale, "dorian")
        XCTAssertEqual(f.effective?.from?.title, "hummed melody")
        XCTAssertEqual(f.options?.shapes, ["star"])
        XCTAssertEqual(f.octave, 3)
        // Round trip through the local cache format.
        XCTAssertEqual(try JSONCoding.decode(FeelSettings.self, from: try JSONCoding.data(f)), f)
        // Missing fields fall back to the defaults, sine first among them.
        let partial = try JSONCoding.decode(FeelSettings.self, from: #"{"theme":"ocean"}"#)
        XCTAssertEqual(partial.theme, "ocean")
        XCTAssertEqual(partial.volume, 0.4)
        XCTAssertEqual(partial.synth, "sine")
        XCTAssertTrue(partial.hold)
        XCTAssertFalse(partial.drag_bend)
        XCTAssertEqual(partial.shapes, FeelSettings.defaultShapes)
        XCTAssertEqual(partial.app_theme, "classic")
        XCTAssertNil(partial.activeAppTheme)
        XCTAssertEqual(partial.playKey, "C")
        XCTAssertEqual(partial.playScale, "major_pentatonic")
        XCTAssertEqual(FeelSettings.defaults.synth, "sine")
    }

    func testDecodeIsLenient() throws {
        let json = """
        {"theme":"custom:gone","synth":"theremin","key":"H","scale":"nope","octave":9,"volume":3,"shape_size":7,"density":0.1,
         "shapes":["star","blob","star"],"appearance":"sepia","app_theme":"custom:gone","hold":"yes",
         "palettes":[{"id":"ok","name":"Fine","colors":["#123456"]},{"id":"BAD ID","name":"x","colors":["#123456"]},
                     {"id":"empty","name":"x","colors":["nope"]},{"id":"ok","name":"Dup","colors":["#654321"]},{"broken":true}],
         "app_themes":[{"id":"t","name":"T","mode":"sepia","accent":"#000000","background":"#000000","surface":"#000000","text":"#FFFFFF"}],
         "images":[{"id":"i1","name":"A","enabled":false,"type":"image/png"},{"id":"i1","name":"B","enabled":true,"type":"image/png"}]}
        """
        let f = try JSONCoding.decode(FeelSettings.self, from: json)
        XCTAssertEqual(f.theme, "aurora")
        XCTAssertEqual(f.synth, "sine")
        XCTAssertEqual(f.key, "C")
        XCTAssertEqual(f.scale, "major_pentatonic")
        XCTAssertEqual(f.octave, 6)
        XCTAssertEqual(f.volume, 1)
        XCTAssertEqual(f.shape_size, 2)
        XCTAssertEqual(f.density, 0.5)
        XCTAssertEqual(f.shapes, ["star"])
        XCTAssertEqual(f.appearance, "system")
        XCTAssertEqual(f.app_theme, "classic")
        XCTAssertTrue(f.app_themes.isEmpty)
        XCTAssertTrue(f.hold)
        XCTAssertEqual(f.palettes.map(\.name), ["Fine"])
        XCTAssertEqual(f.images.map(\.name), ["A"])
        XCTAssertTrue(f.enabledImages.isEmpty)
    }

    func testOldCustomColorsBecomeAPalette() throws {
        let f = try JSONCoding.decode(FeelSettings.self, from: ##"{"theme":"custom","colors":["#112233","#445566","bad"]}"##)
        XCTAssertEqual(f.theme, "custom:mine")
        XCTAssertEqual(f.palettes, [FeelPalette(id: "mine", name: "My colors", colors: ["#112233", "#445566"])])
        let none = try JSONCoding.decode(FeelSettings.self, from: #"{"theme":"custom","colors":[]}"#)
        XCTAssertEqual(none.theme, "aurora")
        XCTAssertTrue(none.palettes.isEmpty)
    }

    func testImageUploadIsPNG() {
        XCTAssertEqual(HTTPTransport.contentType(path: "prefs/feel/images"), "image/png")
        XCTAssertEqual(HTTPTransport.contentType(path: "prefs/feel"), "application/json")
        XCTAssertEqual(HTTPTransport.contentType(path: "vault/file"), "text/markdown; charset=utf-8")
    }

    func testCacheInSharedConfig() {
        let cfg = SharedConfig(suiteName: "feel-tests-\(UUID().uuidString)")
        XCTAssertNil(cfg.feel)
        var f = FeelSettings.defaults
        f.theme = "sunset"
        cfg.feel = f
        XCTAssertEqual(cfg.feel, f)
        cfg.feelPending = ["volume": .number(0.2)]
        XCTAssertEqual(cfg.feelPending["volume"], .number(0.2))
        cfg.feelPending = [:]
        XCTAssertTrue(cfg.feelPending.isEmpty)
    }

    private func entity(_ kind: Kind, _ fields: [String: JSONValue], deleted: Bool = false) -> Entity {
        var e = try! JSONCoding.decode(Entity.self, from: #"{"id":"x","kind":"\#(kind.rawValue)","space":"personal","created_at":"2026-10-28T00:00:00Z","updated_at":"2026-10-28T00:00:00Z","fields":{},"field_ts":{}}"#)
        e.fields = fields
        if deleted { e.deleted_at = "2026-10-28T00:00:00Z" }
        return e
    }

    func testMoments() {
        let open = entity(.task, ["status": "next"])
        let done = entity(.task, ["status": "done"])
        XCTAssertEqual(FeelMoment.detect(before: nil, after: open, created: true), .create)
        XCTAssertEqual(FeelMoment.detect(before: open, after: done, created: false), .complete)
        XCTAssertNil(FeelMoment.detect(before: done, after: done, created: false))
        XCTAssertNil(FeelMoment.detect(before: nil, after: done, created: false))
        XCTAssertNil(FeelMoment.detect(before: open, after: entity(.task, ["status": "done"], deleted: true), created: false))

        let r0 = entity(.reminder, ["title": "a"])
        let r1 = entity(.reminder, ["title": "a", "acknowledged_at": "2026-10-28T10:00:00Z"])
        XCTAssertEqual(FeelMoment.detect(before: r0, after: r1, created: false), .complete)
        XCTAssertNil(FeelMoment.detect(before: r1, after: r0, created: false))

        let p0 = entity(.procedure, ["current": 0])
        let p1 = entity(.procedure, ["current": 1])
        let pDone = entity(.procedure, ["current": 2, "done_at": "2026-10-28T10:00:00Z"])
        XCTAssertEqual(FeelMoment.detect(before: p0, after: p1, created: false), .complete)
        XCTAssertEqual(FeelMoment.detect(before: p1, after: pDone, created: false), .complete)
        XCTAssertNil(FeelMoment.detect(before: p1, after: p0, created: false))

        XCTAssertNil(FeelMoment.detect(before: entity(.note, ["title": "a"]), after: entity(.note, ["title": "b"]), created: false))
    }

    @MainActor
    func testEngineReportsLocalMomentsOnly() async throws {
        let engine = SyncEngine(config: SharedConfig(suiteName: "feel-engine-\(UUID().uuidString)"), platform: .iphone, store: try SyncStore.inMemory())
        engine.schedulesNotifications = false
        var got: [(FeelMoment, Kind)] = []
        engine.onMoment = { m, k in got.append((m, k)) }
        let t = await engine.create(kind: .task, fields: ["title": "Write", "status": "next"])
        XCTAssertEqual(got.map(\.0), [.create])
        XCTAssertEqual(got.first?.1, .task)
        await engine.markDone(t!.id)
        XCTAssertEqual(got.map(\.0), [.create, .complete])
        _ = await engine.update(t!.id, fields: ["title": "Write more"])
        XCTAssertEqual(got.count, 2)
        // Something loaded by a screen is not a create.
        var loaded = t!
        loaded.id = "loaded-1"
        await engine.absorb(loaded)
        XCTAssertEqual(got.count, 2)
        engine.beginQuiet()
        _ = await engine.create(kind: .log, fields: ["type": "weight", "value": 180, "at": "2026-10-28T10:00:00Z"])
        engine.endQuiet()
        XCTAssertEqual(got.count, 2)
    }
}
