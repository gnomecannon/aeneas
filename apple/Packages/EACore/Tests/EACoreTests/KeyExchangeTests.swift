import XCTest
@testable import EACore

/// Trading the hub's shared key for this device's own: when it is tried, what each answer leaves behind, and pairing.
final class CredentialMigrationTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testWhenToTrade() {
        XCTAssertEqual(CredentialMigration.next(hubURL: "http://h", hasKey: false, legacyToken: "t", retryAfter: nil, now: now), .exchange)
        XCTAssertEqual(CredentialMigration.next(hubURL: "http://h", hasKey: false, legacyToken: "t", retryAfter: now.addingTimeInterval(-1), now: now), .exchange)
        XCTAssertEqual(CredentialMigration.next(hubURL: "http://h", hasKey: false, legacyToken: "t", retryAfter: now.addingTimeInterval(60), now: now), .nothing, "waits after a failed try")
        XCTAssertEqual(CredentialMigration.next(hubURL: "http://h", hasKey: true, legacyToken: "t", retryAfter: nil, now: now), .clearLeftoverToken)
        XCTAssertEqual(CredentialMigration.next(hubURL: "http://h", hasKey: true, legacyToken: "", retryAfter: nil, now: now), .nothing)
        XCTAssertEqual(CredentialMigration.next(hubURL: "http://h", hasKey: false, legacyToken: "", retryAfter: nil, now: now), .nothing, "a new install has nothing to trade")
        XCTAssertEqual(CredentialMigration.next(hubURL: "", hasKey: false, legacyToken: "t", retryAfter: nil, now: now), .nothing)
    }

    func testWhatEachAnswerMeans() {
        XCTAssertEqual(CredentialMigration.outcome(nil), .traded)
        XCTAssertEqual(CredentialMigration.outcome(HubError.http(status: 404, message: "not found")), .keepToken(retryIn: 6 * 3600), "a hub from before device keys")
        XCTAssertEqual(CredentialMigration.outcome(HubError.http(status: 401, message: "unauthorized")), .refused)
        XCTAssertEqual(CredentialMigration.outcome(HubError.http(status: 502, message: "")), .keepToken(retryIn: 600))
        XCTAssertEqual(CredentialMigration.outcome(HubError.transport("The Internet connection appears to be offline.")), .keepToken(retryIn: 60))
        XCTAssertEqual(CredentialMigration.outcome(URLError(.timedOut)), .keepToken(retryIn: 60))
    }

    func testDeadlineEndsAHungCall() async {
        let start = Date()
        do {
            _ = try await withDeadline(0.2) { try await Task.sleep(nanoseconds: 5_000_000_000); return 1 }
            XCTFail("should have timed out")
        } catch {
            XCTAssertTrue((error as? HubError)?.errorDescription?.contains("did not answer") == true)
        }
        XCTAssertLessThan(Date().timeIntervalSince(start), 2)
    }
}

@MainActor
final class KeyExchangeTests: XCTestCase {
    let phoneId = "11111111-1111-4111-8111-111111111111"
    let watchId = "22222222-2222-4222-8222-222222222222"

    private func makeEngine(platform: Platform = .iphone, token: String = "shared-token", key: String? = nil) -> (SyncEngine, FakeTransport) {
        let config = SharedConfig(suiteName: "eacore-tests-\(UUID().uuidString)")
        config.hubURL = "http://hub.test"
        config.legacyToken = token
        if let key { config.storeDeviceKey(key) }
        config.deviceId = phoneId
        config.deviceName = "Phone"
        let engine = SyncEngine(config: config, platform: platform, store: try! SyncStore.inMemory())
        engine.schedulesNotifications = false
        let t = FakeTransport()
        engine.exchangeClient = { _ in HubClient(transport: t) }
        engine.pairingClient = { _, _ in HubClient(transport: t) }
        // The client used after the trade: no network in tests (polling, not /live).
        let quiet = FakeTransport()
        engine.makeClient = { HubClient(transport: quiet) }
        return (engine, t)
    }

    func testSignOutLeavesNoWatchKey() {
        let (engine, _) = makeEngine(key: "ead1_phone")
        engine.config.storeWatchKey("ead1_watch")
        XCTAssertFalse(engine.config.watchKey.isEmpty)
        engine.signOut()
        XCTAssertTrue(engine.config.deviceKey.isEmpty)
        XCTAssertTrue(engine.config.watchKey.isEmpty, "a signed-out iPhone keeps no key that opens the hub")
        XCTAssertTrue(engine.config.legacyToken.isEmpty)
    }

    private func entity(_ json: String) -> Entity { try! JSONCoding.decode(Entity.self, from: Data(json.utf8)) }

    func testTradeKeepsTheDeviceIdAndDropsTheSharedKey() async throws {
        let (engine, t) = makeEngine()
        t.responses = [(200, Data(#"{"device_id":"\#(phoneId)","key":"ead1_phone"}"#.utf8))]
        await engine.exchangeLegacyTokenIfNeeded()
        XCTAssertEqual(t.calls.map(\.path), ["devices/exchange"])
        let body = try XCTUnwrap(t.calls.first?.body).asJSON()
        XCTAssertEqual(body["device_id"] as? String, phoneId, "the device keeps its id so sync carries on")
        XCTAssertEqual(body["platform"] as? String, "iphone")
        XCTAssertEqual(body["name"] as? String, "Phone")
        XCTAssertEqual(engine.config.deviceKey, "ead1_phone")
        XCTAssertEqual(engine.config.legacyToken, "", "the shared key is deleted once traded")
        XCTAssertEqual(engine.config.credential, "ead1_phone")
        XCTAssertEqual(engine.config.deviceId, phoneId)
        XCTAssertNil(engine.config.exchangeRetryAfter)
    }

    func testAnOlderHubKeepsTheSharedKeyQuietly() async {
        let (engine, t) = makeEngine()
        t.responses = [(404, Data(#"{"error":"not found"}"#.utf8))]
        let now = Date()
        await engine.exchangeLegacyTokenIfNeeded(now: now)
        XCTAssertEqual(engine.config.legacyToken, "shared-token")
        XCTAssertEqual(engine.config.credential, "shared-token", "requests keep working with the shared key")
        XCTAssertEqual(engine.config.deviceKey, "")
        XCTAssertEqual(engine.config.exchangeRetryAfter, now.addingTimeInterval(6 * 3600))
        // Not tried again before then.
        await engine.exchangeLegacyTokenIfNeeded(now: now.addingTimeInterval(3600))
        XCTAssertEqual(t.calls.count, 1)
    }

    func testOfflineTriesAgainAtTheNextStart() async {
        let (engine, t) = makeEngine()
        t.error = HubError.transport("offline")
        let now = Date()
        await engine.exchangeLegacyTokenIfNeeded(now: now)
        XCTAssertEqual(engine.config.legacyToken, "shared-token")
        XCTAssertEqual(engine.config.exchangeRetryAfter, now.addingTimeInterval(60))
        t.error = nil
        t.responses = [(200, Data(#"{"device_id":"\#(phoneId)","key":"ead1_later"}"#.utf8))]
        await engine.exchangeLegacyTokenIfNeeded(now: now.addingTimeInterval(61))
        XCTAssertEqual(engine.config.deviceKey, "ead1_later")
        XCTAssertEqual(engine.config.legacyToken, "")
    }

    func testAKeyThatCannotBeStoredKeepsTheSharedKey() async {
        let secrets = InMemorySecretStore()
        let config = SharedConfig(suiteName: "eacore-tests-\(UUID().uuidString)", secrets: secrets)
        config.hubURL = "http://hub.test"
        config.legacyToken = "shared-token"
        let engine = SyncEngine(config: config, platform: .mac, store: try! SyncStore.inMemory())
        engine.schedulesNotifications = false
        let t = FakeTransport()
        t.responses = [(200, Data(#"{"device_id":"\#(phoneId)","key":"ead1_x"}"#.utf8))]
        engine.exchangeClient = { _ in HubClient(transport: t) }
        secrets.locked = true
        await engine.exchangeLegacyTokenIfNeeded()
        XCTAssertEqual(config.legacyToken, "shared-token", "never left with no way in")
    }

    func testALeftoverSharedKeyIsDropped() async {
        let (engine, t) = makeEngine(key: "ead1_have")
        await engine.exchangeLegacyTokenIfNeeded()
        XCTAssertTrue(t.calls.isEmpty)
        XCTAssertEqual(engine.config.legacyToken, "")
        XCTAssertEqual(engine.config.credential, "ead1_have")
    }

    func testTheIPhoneTradesForItsWatchToo() async throws {
        let (engine, t) = makeEngine()
        await engine.absorb(entity(#"{"id":"\#(watchId)","kind":"device","space":"personal","created_at":"2026-10-22T00:00:00.000Z","updated_at":"2026-10-22T00:00:00.000Z","deleted_at":null,"fields":{"name":"Phone Watch","platform":"watch","last_seen":"2026-11-05T00:00:00.000Z"},"field_ts":{}}"#))
        t.responses = [
            (200, Data(#"{"device_id":"\#(phoneId)","key":"ead1_phone"}"#.utf8)),
            (200, Data(#"{"device_id":"\#(watchId)","key":"ead1_watch"}"#.utf8)),
        ]
        await engine.exchangeLegacyTokenIfNeeded()
        XCTAssertEqual(t.calls.map(\.path), ["devices/exchange", "devices/exchange"])
        let w = try XCTUnwrap(t.calls.last?.body).asJSON()
        XCTAssertEqual(w["platform"] as? String, "watch")
        XCTAssertEqual(w["device_id"] as? String, watchId, "the Watch keeps its id too")
        XCTAssertEqual(w["name"] as? String, "Phone Watch")
        XCTAssertEqual(engine.config.watchKey, "ead1_watch")
        XCTAssertEqual(engine.config.watchDeviceId, watchId)
        XCTAssertEqual(engine.config.deviceKey, "ead1_phone")
    }

    func testTheWatchNeverTrades() async {
        let (engine, t) = makeEngine(platform: .watch)
        await engine.exchangeLegacyTokenIfNeeded()
        XCTAssertTrue(t.calls.isEmpty)
    }

    func testPairingWithACodeStoresTheKeyAndOffersPermissions() async throws {
        let (engine, t) = makeEngine(token: "")
        engine.config.hubURL = ""
        engine.config.deviceId = ""
        t.responses = [(200, Data(#"{"device_id":"\#(phoneId)","key":"ead1_new","name":"Den iPad","version":"1"}"#.utf8))]
        try await engine.pair(hubURL: "https://core.tail.ts.net", code: "7k3m-9p2q", deviceName: "iPad")
        XCTAssertEqual(t.calls.first?.path, "devices/claim")
        let body = try XCTUnwrap(t.calls.first?.body).asJSON()
        XCTAssertEqual(body["code"] as? String, "7K3M9P2Q")
        XCTAssertNil(body["device_id"], "a new device on a new hub sends no id")
        XCTAssertEqual(engine.config.deviceKey, "ead1_new")
        XCTAssertEqual(engine.config.legacyToken, "")
        XCTAssertEqual(engine.config.hubURL, "https://core.tail.ts.net")
        XCTAssertEqual(engine.config.deviceId, phoneId)
        XCTAssertEqual(engine.config.deviceName, "Den iPad")
        XCTAssertTrue(engine.config.permissionOfferPending)
        XCTAssertTrue(engine.config.isConfigured)
    }

    func testPairingAgainOnTheSameHubKeepsTheDeviceId() async throws {
        let (engine, t) = makeEngine(token: "")
        t.responses = [(200, Data(#"{"device_id":"\#(phoneId)","key":"ead1_again"}"#.utf8))]
        try await engine.pair(hubURL: "http://hub.test/", code: "7K3M9P2Q", deviceName: nil)
        let body = try XCTUnwrap(t.calls.first?.body).asJSON()
        XCTAssertEqual(body["device_id"] as? String, phoneId)
    }

    func testAWrongCodeChangesNothing() async {
        let (engine, t) = makeEngine(token: "")
        t.responses = [(401, Data(#"{"error":"That pairing code is wrong, used or older than 10 minutes."}"#.utf8))]
        do {
            try await engine.pair(hubURL: "http://other.test", code: "7K3M9P2Q", deviceName: nil)
            XCTFail("should throw")
        } catch {
            XCTAssertEqual(error as? HubError, .http(status: 401, message: "That pairing code is wrong, used or older than 10 minutes."))
        }
        XCTAssertEqual(engine.config.hubURL, "http://hub.test")
        XCTAssertEqual(engine.config.deviceKey, "")
    }

    func testAnOlderTokenLinkIsTradedAtOnceAndNotKept() async throws {
        let (engine, t) = makeEngine(token: "")
        t.responses = [(200, Data(#"{"device_id":"\#(phoneId)","key":"ead1_link"}"#.utf8))]
        try await engine.connect(hubURL: "http://hub.test", token: "devtoken", deviceName: "sim")
        XCTAssertEqual(t.calls.first?.path, "devices/exchange")
        XCTAssertEqual(engine.config.deviceKey, "ead1_link")
        XCTAssertEqual(engine.config.legacyToken, "", "the token from the link is never stored")
    }

    func testAnOlderTokenLinkToAnOlderHubStillConnects() async throws {
        let (engine, t) = makeEngine(token: "")
        t.responses = [(404, Data(#"{"error":"not found"}"#.utf8))]
        try await engine.connect(hubURL: "http://hub.test", token: "devtoken", deviceName: "sim")
        XCTAssertEqual(engine.config.legacyToken, "devtoken", "nothing breaks against a hub without keys")
        XCTAssertTrue(engine.config.isConfigured)
        XCTAssertNotNil(engine.config.exchangeRetryAfter)
    }

    func testARefusedTokenLinkIsNotKept() async {
        let (engine, t) = makeEngine(token: "")
        t.responses = [(401, Data(#"{"error":"unauthorized"}"#.utf8))]
        do { try await engine.connect(hubURL: "http://hub.test", token: "wrong", deviceName: nil); XCTFail("should throw") } catch {}
        XCTAssertEqual(engine.config.legacyToken, "")
    }

    func testARemovedDeviceForgetsItsKey() async {
        let (engine, _) = makeEngine(token: "", key: "ead1_gone")
        let removed = FakeTransport()
        let gone = Data(#"{"error":"unauthorized","device_removed":true}"#.utf8)
        // Every request, the check with the current key among them, hears that the key is removed.
        removed.responses = Array(repeating: (401, gone), count: 20)
        engine.makeClient = { HubClient(transport: removed) }
        var told = false
        engine.onDeviceRemoved = { told = true }
        try? await engine.store.replace(Entity(id: "n1", kind: .note, fields: ["title": "private"]))
        engine.config.nextUpTitle = "Private plan"
        await engine.start()
        for _ in 0..<100 where !engine.deviceRemoved { try? await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertTrue(engine.deviceRemoved)
        XCTAssertTrue(removed.calls.contains { $0.path.hasSuffix("entities/removal-check") }, "the current key was asked before anything was wiped")
        XCTAssertTrue(told)
        XCTAssertEqual(engine.config.deviceKey, "")
        XCTAssertTrue(engine.config.deviceRemoved)
        XCTAssertFalse(engine.config.isConfigured)
        // The local copy and the widget snapshot go with the key.
        var left = (try? await engine.store.all().count) ?? -1
        for _ in 0..<50 where left > 0 { try? await Task.sleep(nanoseconds: 10_000_000); left = (try? await engine.store.all().count) ?? -1 }
        XCTAssertEqual(left, 0)
        XCTAssertTrue(engine.entities.isEmpty)
        XCTAssertNil(engine.config.nextUpTitle)
    }

    /// Paired again with the same hub: a request still in flight with the replaced key hears "removed". The key held
    /// now still works, so nothing is wiped (a second scan of a pairing code wiped the fresh pairing).
    func testARemovalHeardForAReplacedKeyWipesNothing() async {
        let (engine, _) = makeEngine(token: "", key: "ead1_new")
        let t = FakeTransport()
        let gone = Data(#"{"error":"unauthorized","device_removed":true}"#.utf8)
        // The first request (made with the old key) hears "removed"; the check with the current key finds it works.
        t.onSend = { call in
            if call.path.hasSuffix("entities/removal-check") { t.responses = [(404, Data(#"{"error":"not found"}"#.utf8))] }
        }
        t.responses = [(401, gone)]
        engine.makeClient = { HubClient(transport: t) }
        var told = false
        engine.onDeviceRemoved = { told = true }
        try? await engine.store.replace(Entity(id: "n1", kind: .note, fields: ["title": "kept"]))
        await engine.start()
        for _ in 0..<100 where !t.calls.contains(where: { $0.path.hasSuffix("entities/removal-check") }) { try? await Task.sleep(nanoseconds: 10_000_000) }
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertFalse(engine.deviceRemoved)
        XCTAssertFalse(told)
        XCTAssertEqual(engine.config.deviceKey, "ead1_new")
        let kept = (try? await engine.store.all().count) ?? -1
        XCTAssertEqual(kept, 1, "the local copy stays")
    }

    func testARemovedWatchOnlySaysSo() async {
        let (engine, _) = makeEngine(platform: .watch, token: "")
        let removed = FakeTransport()
        removed.responses = [(401, Data(#"{"error":"unauthorized","device_removed":true}"#.utf8))]
        engine.makeClient = { HubClient(transport: removed) }
        await engine.start()
        XCTAssertTrue(engine.deviceRemoved)
        XCTAssertFalse(engine.config.deviceRemoved, "the Watch holds no key and keeps its setup")
    }
}

/// The key the iPhone uses for its Watch's relayed requests.
final class WatchKeysTests: XCTestCase {
    private func config() -> SharedConfig {
        let c = SharedConfig(suiteName: "eacore-tests-\(UUID().uuidString)")
        c.hubURL = "http://hub.test"
        c.deviceName = "Phone"
        return c
    }

    func testOnTheSharedKeyTheWatchUsesItToo() async {
        let c = config()
        c.legacyToken = "shared"
        let keys = WatchKeys(config: c, makeClient: { _ in XCTFail("no claim on the shared key"); return nil })
        let cred = await keys.credential(watchDeviceId: nil)
        XCTAssertEqual(cred, .key("shared"))
    }

    func testTheWatchsOwnKeyComesFirst() async {
        let c = config()
        c.storeDeviceKey("ead1_phone")
        c.storeWatchKey("ead1_watch")
        let cred = await WatchKeys(config: c).credential(watchDeviceId: "w1")
        XCTAssertEqual(cred, .key("ead1_watch"))
        XCTAssertEqual(c.watchDeviceId, "w1", "the id the Watch named is remembered")
    }

    func testAKeyIsClaimedForTheWatchWithThePhonesKey() async throws {
        let c = config()
        c.storeDeviceKey("ead1_phone")
        let t = FakeTransport()
        t.responses = [
            (200, Data(#"{"hub":"http://hub.test","code":"7K3M-9P2Q","expires_at":"2026-11-05T21:00:00.000Z","app":"a","web":"w"}"#.utf8)),
            (200, Data(#"{"device_id":"w1","key":"ead1_watch","name":"Phone Watch"}"#.utf8)),
        ]
        let keys = WatchKeys(config: c, makeClient: { _ in HubClient(transport: t) })
        let cred = await keys.credential(watchDeviceId: "w1")
        XCTAssertEqual(cred, .key("ead1_watch"))
        XCTAssertEqual(t.calls.map(\.path), ["devices/pairing", "devices/claim"])
        let claim = try XCTUnwrap(t.calls.last?.body).asJSON()
        XCTAssertEqual(claim["platform"] as? String, "watch")
        XCTAssertEqual(claim["device_id"] as? String, "w1")
        XCTAssertEqual(claim["name"] as? String, "Phone Watch")
        XCTAssertEqual(c.watchKey, "ead1_watch")
        // Kept: the next request claims nothing.
        let again = await keys.credential(watchDeviceId: "w1")
        XCTAssertEqual(again, .key("ead1_watch"))
        XCTAssertEqual(t.calls.count, 2)
    }

    func testARemovedWatchIsNotPairedAgainOnItsOwn() async {
        let c = config()
        c.storeDeviceKey("ead1_phone")
        c.storeWatchKey("ead1_watch")
        let keys = WatchKeys(config: c, makeClient: { _ in XCTFail("no claim for a removed Watch"); return nil })
        await keys.noteRemoved()
        let cred = await keys.credential(watchDeviceId: nil)
        XCTAssertEqual(cred, .removed)
        XCTAssertEqual(c.watchKey, "")
        await keys.allowAgain()
        XCTAssertFalse(c.watchRemoved)
    }

    func testNoHubNoKey() async {
        let c = config()
        c.hubURL = ""
        let cred = await WatchKeys(config: c).credential(watchDeviceId: nil)
        XCTAssertEqual(cred, .unavailable("iPhone has no hub configured"))
    }
}
