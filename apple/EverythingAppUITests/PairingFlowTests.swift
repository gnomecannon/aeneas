import XCTest

/// Pairs the app with a running hub using a real one-time code, end to end through the screens: Setup, the permission
/// screen, then Settings, Connection, Devices and a new pairing code. Skipped unless a code is given:
///
///     TEST_RUNNER_EA_HUB=http://127.0.0.1:8790 TEST_RUNNER_EA_CODE=ABCD-EFGH TEST_RUNNER_EA_SHOTS=/tmp/shots \
///       xcodebuild test-without-building ... -only-testing:EverythingAppUITests/PairingFlowTests
///
/// Make the code just before (it lasts 10 minutes): `POST /devices/pairing` on the hub. `EA_SHOTS` is a folder for
/// screenshots (simulator only). `testRemovedScreen` expects the device to have been removed on the hub meanwhile.
final class PairingFlowTests: XCTestCase {
    private let env = ProcessInfo.processInfo.environment
    private var shots: String? { env["EA_SHOTS"] }

    private func shot(_ name: String) {
        let screen = XCUIScreen.main.screenshot()
        let png = screen.pngRepresentation
        let a = XCTAttachment(screenshot: screen)
        a.name = name
        add(a)
        if let dir = shots { try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(name).png")) }
    }

    /// Answers the system's permission questions with Allow.
    private func allowSystemAlerts(_ springboard: XCUIApplication, rounds: Int = 6) {
        for _ in 0..<rounds {
            let alert = springboard.alerts.firstMatch
            guard alert.waitForExistence(timeout: 4) else { return }
            for label in ["Allow", "OK", "Allow Full Access", "Allow While Using App"] where alert.buttons[label].exists {
                alert.buttons[label].tap()
                break
            }
        }
    }

    func testPairWithACode() throws {
        guard let hub = env["EA_HUB"], let code = env["EA_CODE"] else { throw XCTSkip("needs EA_HUB and EA_CODE") }
        let app = XCUIApplication(bundleIdentifier: "com.gnomecannon.everythingapp")
        app.launch()
        XCTAssertTrue(app.staticTexts["Set up"].waitForExistence(timeout: 15), "a new install shows Setup")
        shot("01-setup")

        let hubField = app.textFields["setup.hub"]
        hubField.tap()
        hubField.typeText(hub)
        let codeField = app.textFields["setup.code"]
        codeField.tap()
        codeField.typeText(code)
        let nameField = app.textFields["setup.name"]
        nameField.tap()
        // The field starts with this device's default name.
        let old = (nameField.value as? String) ?? ""
        nameField.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count) + "Pairing test iPhone")
        shot("02-setup-filled")
        app.buttons["setup.pair"].tap()

        XCTAssertTrue(app.navigationBars["What your modules need"].waitForExistence(timeout: 20), "after pairing the modules' permissions are offered")
        shot("03-permissions")
        app.swipeUp()
        shot("03b-permissions-rest")
        app.buttons["permissions.continue"].tap()
        allowSystemAlerts(XCUIApplication(bundleIdentifier: "com.apple.springboard"))

        let gear = app.buttons["Settings"].firstMatch
        XCTAssertTrue(gear.waitForExistence(timeout: 15))
        gear.tap()
        let connection = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Connection' AND NOT (label BEGINSWITH 'Connections')")).firstMatch
        XCTAssertTrue(connection.waitForExistence(timeout: 10))
        connection.tap()
        let ownKey = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "own key")).firstMatch
        XCTAssertTrue(ownKey.waitForExistence(timeout: 10), "signed in with its own key, not the shared one")
        shot("04-connection")

        let make = app.buttons["Make a pairing code"]
        for _ in 0..<4 where !make.isHittable { app.swipeUp() }
        make.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Pairing code'")).firstMatch.waitForExistence(timeout: 10)
                      || app.staticTexts.matching(NSPredicate(format: "label MATCHES '[0-9A-Z]{4}-[0-9A-Z]{4}'")).firstMatch.waitForExistence(timeout: 5),
                      "the code shows in large text")
        shot("05-pair-another")
        let timeLeft = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Works for'")).firstMatch
        for _ in 0..<4 where !timeLeft.exists { app.swipeUp() }
        XCTAssertTrue(timeLeft.exists, "how long the code lasts")

        let thisDevice = app.staticTexts["This device"].firstMatch
        for _ in 0..<6 where !thisDevice.isHittable { app.swipeUp() }
        XCTAssertTrue(thisDevice.exists, "the Devices list marks this device")
        shot("06-devices")

        // A module switched on in Settings, Modules offers what it needs, over the Settings sheet.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        let modules = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Modules'")).firstMatch
        XCTAssertTrue(modules.waitForExistence(timeout: 10))
        modules.tap()
        let reminders = app.switches.matching(NSPredicate(format: "label BEGINSWITH 'Apple Reminders'")).firstMatch
        XCTAssertTrue(reminders.waitForExistence(timeout: 15))
        XCTAssertEqual(reminders.value as? String, "0", "off on a new hub")
        reminders.switches.firstMatch.exists ? reminders.switches.firstMatch.tap() : reminders.tap()
        XCTAssertTrue(app.navigationBars["What your modules need"].waitForExistence(timeout: 15), "switching a module on offers its permission")
        XCTAssertTrue(app.staticTexts["Reminders"].exists)
        shot("06b-module-switched-on")
        app.buttons["permissions.notNow"].tap()
    }

    func testRemovedScreen() throws {
        guard env["EA_EXPECT_REMOVED"] != nil else { throw XCTSkip("needs EA_EXPECT_REMOVED") }
        let app = XCUIApplication(bundleIdentifier: "com.gnomecannon.everythingapp")
        app.launch()
        XCTAssertTrue(app.staticTexts["This device was removed"].waitForExistence(timeout: 30))
        shot("07-removed")
        app.buttons["removed.pair"].tap()
        XCTAssertTrue(app.staticTexts["Set up"].waitForExistence(timeout: 10), "Pair again goes back to Setup")
        shot("08-setup-again")
    }
}
