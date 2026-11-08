import XCTest
@testable import EACore

/// Tenets 1 and 2: every privacy choice on a device starts off, and turning one on is remembered.
final class DevicePrivacyTests: XCTestCase {
    func testEveryChoiceStartsOff() {
        let c = SharedConfig(suiteName: "eacore-privacy-\(UUID().uuidString)")
        XCTAssertFalse(c.includeInICloudBackup)
        XCTAssertFalse(c.showInSpotlight)
        XCTAssertFalse(c.lockScreenTitles)
        c.showInSpotlight = true
        c.lockScreenTitles = true
        XCTAssertTrue(c.showInSpotlight)
        XCTAssertTrue(c.lockScreenTitles)
    }

    func testBackupCoversTheStoreFolder() {
        let c = SharedConfig(suiteName: "eacore-privacy-\(UUID().uuidString)")
        XCTAssertTrue(BackupExclusion.folders(config: c).contains(c.storeURL.deletingLastPathComponent()))
    }

    func testTheAppGroupFollowsTheBundleId() {
        XCTAssertEqual(SharedConfig.groupFor(bundleId: "com.gnomecannon.everythingapp"), "group.com.gnomecannon.everythingapp")
        XCTAssertEqual(SharedConfig.groupFor(bundleId: "io.github.someone.everythingapp.watchkitapp.watchwidgets"), "group.io.github.someone.everythingapp")
        XCTAssertEqual(SharedConfig.groupFor(bundleId: "com.apple.dt.xctest.tool"), "group.everythingapp.local")
    }

    func testRemovalEmptiesTheWidgetSnapshot() {
        let c = SharedConfig(suiteName: "eacore-privacy-\(UUID().uuidString)")
        c.nextUpTitle = "Dentist"
        c.currentActivity = "Writing"
        c.clearSnapshot()
        XCTAssertNil(c.nextUpTitle)
        XCTAssertNil(c.currentActivity)
    }
}
