import XCTest
@testable import EACore

/// Which device adds new Apple items for what was made in the app: one only, so iCloud never gets the same one twice.
final class AppleItemsTests: XCTestCase {
    func testOnlyTheIPhoneAddsReminders() {
        XCTAssertTrue(AppleItems.addsReminders(on: .iPhone))
        XCTAssertFalse(AppleItems.addsReminders(on: .iPad), "an iPad runs iOS too, and added the same new tasks as the iPhone")
        XCTAssertFalse(AppleItems.addsReminders(on: .mac))
        XCTAssertFalse(AppleItems.addsReminders(on: .other))
    }

    func testTheMacAndTheIPhoneAddEventsAndAnIPadNever() {
        XCTAssertTrue(AppleItems.addsEvents(on: .mac))
        XCTAssertTrue(AppleItems.addsEvents(on: .iPhone))
        XCTAssertFalse(AppleItems.addsEvents(on: .iPad), "after the iPhone's two minutes it added the same new event")
        XCTAssertFalse(AppleItems.addsEvents(on: .other))
    }

    @MainActor func testThisDeviceIsKnown() {
        #if os(macOS)
        XCTAssertEqual(AppleItems.thisDevice, .mac)
        XCTAssertFalse(AppleItems.addsReminders(on: AppleItems.thisDevice), "the Mac never adds reminders")
        #endif
    }
}
