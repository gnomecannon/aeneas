import XCTest

/// Verifies the everythingapp://setup URL handler, including cold launch.
/// iOS asks "Open in EverythingApp?" for scheme URLs that come from outside the app;
/// the test answers that prompt on SpringBoard, which `xcrun simctl openurl` alone cannot.
final class SetupURLTests: XCTestCase {
    private let bundleId = "com.gnomecannon.everythingapp"
    private let setupURL = URL(string: "everythingapp://setup?hub=http%3A%2F%2Flocalhost%3A8788&token=devtoken&name=sim")!

    private func openAndConfirm(_ url: URL, app: XCUIApplication) {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        app.open(url)
        let open = springboard.buttons["Open"]
        if open.waitForExistence(timeout: 5) { open.tap() }
    }

    func testSetupURLOnColdLaunchShowsToday() {
        let app = XCUIApplication(bundleIdentifier: bundleId)
        app.terminate()
        openAndConfirm(setupURL, app: app)
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15), "app did not launch from the URL")
        // The app opens on Today (the first tab since the 2026-10-28 navigation).
        XCTAssertTrue(app.buttons["Today"].waitForExistence(timeout: 15), "Today did not replace Setup")
        XCTAssertFalse(app.staticTexts["Set up"].exists)
    }

    func testSetupURLWhileRunningShowsToday() {
        let app = XCUIApplication(bundleIdentifier: bundleId)
        app.launch()
        openAndConfirm(setupURL, app: app)
        XCTAssertTrue(app.buttons["Today"].waitForExistence(timeout: 15))
    }
}
