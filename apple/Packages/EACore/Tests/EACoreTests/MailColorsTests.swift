import XCTest
@testable import EACore

/// Mail's colors read at 4.5:1, as the web's do (web/src/lib/contrast.test.ts), and are the web's own.
final class MailColorsTests: XCTestCase {
    private let lightBackgrounds = MailColors.systemBackgrounds(dark: false)
    private let darkBackgrounds = MailColors.systemBackgrounds(dark: true)

    func testWhiteReadsOnEveryFillInLightAndDark() {
        for (id, p) in MailColors.fills {
            XCTAssertGreaterThanOrEqual(FeelColor.contrast("#FFFFFF", p.light), 4.5, "\(id) light")
            XCTAssertGreaterThanOrEqual(FeelColor.contrast("#FFFFFF", p.dark), 4.5, "\(id) dark")
        }
        for (i, c) in MailColors.custom.enumerated() { XCTAssertGreaterThanOrEqual(FeelColor.contrast("#FFFFFF", c), 4.5, "own color \(i)") }
    }

    func testEveryWordShadeReadsOnThePageAndARow() {
        var keys: [MailColors.Key] = MailColors.words.keys.map { .place($0) }
        keys += (0..<MailColors.custom.count).map { .custom($0) }
        for k in keys {
            let light = MailColors.word(k, dark: false, text: MailColors.systemText(dark: false), backgrounds: lightBackgrounds)
            let dark = MailColors.word(k, dark: true, text: MailColors.systemText(dark: true), backgrounds: darkBackgrounds)
            // In light the web's own shades read on the system's backgrounds as they are. In dark the system's rows
            // (#2C2C2E, and the Mac's #323232) are a little lighter than the web's, so each shade moves a step lighter.
            if case .place(let id) = k { XCTAssertEqual(light, MailColors.words[id]?.light, "\(id) light as on the web") }
            for b in lightBackgrounds { XCTAssertGreaterThanOrEqual(FeelColor.contrast(light, b), 4.5, "\(k) light on \(b)") }
            for b in darkBackgrounds { XCTAssertGreaterThanOrEqual(FeelColor.contrast(dark, b), 4.5, "\(k) dark on \(b)") }
        }
    }

    func testAThemesPageMovesAWordShadeTowardItsText() {
        // A gray theme page where a folder's gray is too faint: it moves toward the theme's text until it reads.
        let w = MailColors.word(.place("folder"), dark: true, text: "#F0F0F0", backgrounds: ["#6A6A6A"])
        XCTAssertGreaterThanOrEqual(FeelColor.contrast(w, "#6A6A6A"), 4.5)
    }

    /// The same colors as web/src/styles.css, so a color means the same place in every app.
    func testTheColorsAreTheWebsOwn() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../..").standardized
        let css = try String(contentsOf: root.appendingPathComponent("web/src/styles.css"), encoding: .utf8).lowercased()
        for (id, p) in MailColors.fills {
            XCTAssertTrue(css.contains("--b-\(id): \(p.light.lowercased());"), "fill \(id) light")
            XCTAssertTrue(css.contains("--b-\(id): \(p.dark.lowercased());"), "fill \(id) dark")
        }
        for (id, p) in MailColors.words {
            XCTAssertTrue(css.contains("--bt-\(id): \(p.light.lowercased());"), "word \(id) light")
            XCTAssertTrue(css.contains("--bt-\(id): \(p.dark.lowercased());"), "word \(id) dark")
        }
        for (i, c) in MailColors.custom.enumerated() { XCTAssertTrue(css.contains(".b-custom.cc\(i) { --c: \(c.lowercased());"), "own color \(i)") }
    }
}
