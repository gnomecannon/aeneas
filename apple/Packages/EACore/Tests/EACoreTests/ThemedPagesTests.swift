import XCTest

/// Every page opened over a screen takes the app theme. Under a theme, a page opened with SwiftUI's own
/// `NavigationLink { page }` or `navigationDestination(item:)` stood in the system's gray or black behind the
/// theme's cards: a pushed page takes nothing from the screen under it. So the app opens its pages through
/// `PageLink` and `pageDestination` (Views/Theme/AppThemeStyle.swift), which put the theme on them. This reads the
/// app's Swift files and fails on a page opened another way.
final class ThemedPagesTests: XCTestCase {
    /// The file that wraps SwiftUI's own links, the only one that may name them.
    private static let wrappers = "Views/Theme/AppThemeStyle.swift"

    /// What is wrong with one line of the app's code, or nil. A link by value and a destination by type are fine when
    /// what they open is themed: `sectionView` themes a screen, `themedPage()` and `themedScreen()` say so themselves.
    static func fault(in line: String) -> String? {
        // Code only: what follows // is a comment.
        let code = line.range(of: "//").map { String(line[..<$0.lowerBound]) } ?? line
        if code.range(of: #"NavigationLink(?!\(value:)"#, options: .regularExpression) != nil {
            return "opens a page with NavigationLink: use PageLink, so the page takes the app theme"
        }
        if code.range(of: #"navigationDestination\((?!for:)"#, options: .regularExpression) != nil {
            return "opens a page with navigationDestination: use pageDestination, so the page takes the app theme"
        }
        if code.contains("navigationDestination(for:"), !["sectionView(", "themedPage()", "themedScreen()"].contains(where: code.contains) {
            return "names a page by type without the app theme: open it with sectionView, or put themedPage() on it on this line"
        }
        return nil
    }

    func testEveryPageIsOpenedThroughAThemedLink() throws {
        var apple = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { apple.deleteLastPathComponent() }   // EACoreTests, Tests, EACore, Packages: apple/
        let app = apple.appendingPathComponent("EverythingApp").standardizedFileURL
        let files = try XCTUnwrap(FileManager.default.enumerator(at: app, includingPropertiesForKeys: nil)).compactMap { $0 as? URL }
            .filter { $0.pathExtension == "swift" }
        XCTAssertGreaterThan(files.count, 100, "the app's Swift files were not found at \(app.path)")
        var faults: [String] = []
        var links = 0
        for file in files {
            let name = String(file.standardizedFileURL.path.dropFirst(app.path.count + 1))
            guard name != Self.wrappers else { continue }
            for (i, line) in try String(contentsOf: file, encoding: .utf8).components(separatedBy: "\n").enumerated() {
                if line.range(of: #"\bPageLink\b|\.pageDestination\("#, options: .regularExpression) != nil { links += 1 }
                if let fault = Self.fault(in: line) { faults.append("\(name):\(i + 1) \(fault)") }
            }
        }
        XCTAssertEqual(faults, [])
        // The check looked at the files the pages are in (80 lines opened a page when it was written).
        XCTAssertGreaterThan(links, 50)
    }

    func testTheCheckSeesEachWayOfOpeningAPage() {
        // Pages opened in SwiftUI's own ways: each is a fault.
        XCTAssertNotNil(Self.fault(in: "NavigationLink { PersonView(id: p.id) } label: { name(p) }"))
        XCTAssertNotNil(Self.fault(in: "NavigationLink(destination: ItemView(id: r.id)) {"))
        XCTAssertNotNil(Self.fault(in: #"NavigationLink("All entries") { AllLogsView() }"#))
        XCTAssertNotNil(Self.fault(in: ".navigationDestination(item: $opened) { PersonView(id: $0) }"))
        XCTAssertNotNil(Self.fault(in: ".navigationDestination(isPresented: $open) { SettingsPage() }"))
        XCTAssertNotNil(Self.fault(in: ".navigationDestination(for: Person.self) { PersonView(id: $0.id) }"))
        // The app's own ways, and the two of SwiftUI's that open a themed screen.
        XCTAssertNil(Self.fault(in: "PageLink { PersonView(id: p.id) } label: { name(p) }"))
        XCTAssertNil(Self.fault(in: ".pageDestination(item: $opened) { PersonView(id: $0) }"))
        XCTAssertNil(Self.fault(in: "NavigationLink(value: Section.week) { Label(\"Week\", systemImage: \"calendar\") }"))
        XCTAssertNil(Self.fault(in: ".navigationDestination(for: Section.self) { sectionView($0) }"))
        XCTAssertNil(Self.fault(in: ".navigationDestination(for: Person.self) { PersonView(id: $0.id).themedPage() }"))
        // A comment may name them.
        XCTAssertNil(Self.fault(in: "// SwiftUI's NavigationLink { page } left the page unthemed"))
    }
}
