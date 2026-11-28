import XCTest
@testable import EACore

/// Passes every request on to `inner` and notes its path and body.
final class RecordingHub: HubTransport, @unchecked Sendable {
    let inner: HubTransport
    let seen = Recorder()
    init(_ inner: HubTransport) { self.inner = inner }
    func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        seen.add("\(path) \(body.map { String(decoding: $0, as: UTF8.self) } ?? "")")
        return try await inner.send(method: method, path: path, query: query, body: body)
    }
}

/// The hub's own id (`hid`, `hub_id`, since 2026-11-16): one hub is told from another by it, not by the address it
/// was reached at, so another route to the same hub never wipes this device's copy.
@MainActor
final class HubIdTests: XCTestCase {
    let id = RouteChooserTests.hubId
    let other = "01JD5Q8R3K7V2M9N4P6T0W1X2Z"
    let third = "7ZZZZZZZZZZZZZZZZZZZZZZZZZ"
    let phoneId = "11111111-1111-4111-8111-111111111111"
    let remote = "https://hub.example.ts.net"
    let home = "https://192.168.1.20:9787"
    let fp = RouteChooserTests.fp

    private func link(_ s: String) -> SetupLink? { URL(string: s).flatMap(SetupLink.parse) }

    private func config(hub: String, id: String?, routes: LinkRoutes? = nil) -> SharedConfig {
        let c = SharedConfig(suiteName: "eacore-tests-\(UUID().uuidString)")
        c.hubURL = hub
        c.hubId = id
        c.linkRoutes = routes
        c.storeDeviceKey("ead1_a")
        c.deviceId = phoneId
        c.deviceName = "Phone"
        return c
    }

    private func store(queued: Bool = true) async throws -> SyncStore {
        let s = try SyncStore.inMemory()
        try await s.upsertFromHub(Entity(id: "note-a", kind: .note, fields: ["title": "Kept", "path": "a.md"]))
        if queued {
            try await s.applyLocal(Patch(id: "cap-a", kind: .capture, space: .personal, ts: ISO.now(), fields: ["text": "queued", "source": "iphone"], create: true))
        }
        return s
    }

    private func answer(_ hubId: String, address: String? = nil, home: Bool = true) -> LinkRoutes {
        LinkRoutes(hub_id: hubId, method: "tailscale", remote: address ?? remote, home: home ? .init(on: true, urls: [self.home], fp: fp) : nil)
    }

    /// The app's own engine (no `makeClient`): it picks its routes over the test network.
    private func routedEngine(_ net: TestNet, config c: SharedConfig, store: SyncStore) -> SyncEngine {
        let engine = SyncEngine(config: c, platform: .iphone, store: store)
        engine.schedulesNotifications = false
        engine.routes.makeTransport = { r, k in net.transport(r, k) }
        engine.routes.find = { _ in nil }
        engine.routes.homeWait = 0.2
        engine.routes.homeProbeTimeout = 1
        engine.routes.remoteProbeTimeout = 1
        engine.routes.settle = 0.05
        engine.routes.quiet = 0.3
        return engine
    }

    private func until(_ timeout: TimeInterval = 3, _ ok: () -> Bool) async -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if ok() { return true }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        return ok()
    }

    // MARK: links and decisions

    func testTheHubIdIsReadFromSetupLinks() throws {
        let l = try XCTUnwrap(link("everythingapp://setup?hub=https%3A%2F%2Fhub.example.ts.net&code=7K3M9P2Q&hid=\(id.lowercased())"))
        XCTAssertEqual(l.hubId, id, "read in any case, kept uppercased")
        let node = String(repeating: "c", count: 64)
        let d = try XCTUnwrap(link("everythingapp://setup?link=direct&node=\(node)&relay=https%3A%2F%2Frelay.example&code=7K3M9P2Q&hid=\(id)"))
        XCTAssertEqual(d.hubId, id)
        XCTAssertNil(try XCTUnwrap(link("everythingapp://setup?hub=https%3A%2F%2Fhub.example.ts.net&code=7K3M9P2Q")).hubId, "an older hub's link has none")
        for bad in [String(id.dropLast()), String(id.dropLast()) + "U", id + "0", "not-a-hub-id"] {
            let l = try XCTUnwrap(link("everythingapp://setup?hub=https%3A%2F%2Fhub.example.ts.net&code=7K3M9P2Q&hid=\(bad)"), bad)
            XCTAssertNil(l.hubId, "\(bad) is not a hub id, and is ignored rather than trusted")
        }
        XCTAssertEqual(HubID.normalize(" \(id.lowercased()) "), id)
    }

    func testOneHubOrTwoByIdElseByAddress() {
        XCTAssertTrue(SyncEngine.sameHub(remote, id: id, home, id: id.lowercased()), "the same hub on another route")
        XCTAssertFalse(SyncEngine.sameHub(remote, id: id, remote, id: other), "another id is another hub, even at the same address")
        XCTAssertTrue(SyncEngine.sameHub(remote, id: nil, remote + "/", id: id), "a hub paired before ids: by address")
        XCTAssertFalse(SyncEngine.sameHub(remote, id: id, home, id: nil), "a link without hid: by address")
        XCTAssertTrue(SyncEngine.sameHub("HTTPS://hub.example.ts.net/", remote), "the address helper is kept")
    }

    func testWhenALinkIsAskedAbout() {
        let code = SetupLink.Credential.code("ABCDEFGH")
        // Another id: asked about, even at this address.
        XCTAssertTrue(SetupLink(hub: remote, credential: code, hubId: other).needsConfirmation(currentHub: remote, currentPin: nil, currentHubId: id))
        // The same id and address: at once.
        XCTAssertFalse(SetupLink(hub: remote, credential: code, hubId: id).needsConfirmation(currentHub: remote, currentPin: nil, currentHubId: id))
        // The same id at another address, naming no certificate: every link carries the id, so it proves nothing.
        let direct = DirectHub.address(node: String(repeating: "c", count: 64), relay: "https://relay.example")
        XCTAssertTrue(SetupLink(hub: direct, credential: code, hubId: id).needsConfirmation(currentHub: remote, currentPin: nil, currentHubId: id))
        // The same id at a new address naming the certificate pinned now: only the hub holds it.
        let moved = "https://192.168.1.21:9787"
        XCTAssertFalse(SetupLink(hub: moved, credential: code, pin: fp, hubId: id).needsConfirmation(currentHub: home, currentPin: fp, currentHubId: id))
        XCTAssertTrue(SetupLink(hub: moved, credential: code, pin: String(repeating: "0", count: 64), hubId: id).needsConfirmation(currentHub: home, currentPin: fp, currentHubId: id))
        // Ids not known on both sides: by address, as before.
        XCTAssertFalse(SetupLink(hub: remote, credential: code, hubId: id).needsConfirmation(currentHub: remote, currentPin: nil, currentHubId: nil))
        XCTAssertTrue(SetupLink(hub: home, credential: code).needsConfirmation(currentHub: remote, currentPin: nil, currentHubId: id))
        // The same hub naming another certificate than the pinned one: asked about, as before.
        XCTAssertTrue(SetupLink(hub: home, credential: code, pin: String(repeating: "0", count: 64), hubId: id).needsConfirmation(currentHub: home, currentPin: fp, currentHubId: id))
    }

    // MARK: pairing

    func testPairingTheSameHubAtAnotherAddressKeepsTheCopy() async throws {
        let c = config(hub: remote, id: id, routes: answer(id))
        let s = try await store()
        UserDefaults.standard.set(Data("{}".utf8), forKey: AppleLinkRecords.reminders)
        defer { UserDefaults.standard.removeObject(forKey: AppleLinkRecords.reminders) }
        let engine = SyncEngine(config: c, platform: .iphone, store: s)
        engine.schedulesNotifications = false
        let hub = OneHub(claimId: phoneId)
        hub.down = true
        let claims = RecordingHub(hub)
        engine.makeClient = { HubClient(transport: hub) }
        engine.pairingClient = { _, _ in HubClient(transport: claims) }
        await engine.start()
        hub.down = false
        // The hub moved from Tailscale to Direct link; a new code from it carries its id.
        let direct = DirectHub.address(node: String(repeating: "c", count: 64), relay: "https://relay.example")
        try await engine.pair(hubURL: direct, code: "ABCD-EFGH", deviceName: nil, hubId: id)
        XCTAssertNotNil(engine.get("note-a"), "the copy stays")
        XCTAssertTrue(hub.pushed.contains { $0.id == "cap-a" }, "the queued capture went to its hub")
        XCTAssertNotNil(UserDefaults.standard.object(forKey: AppleLinkRecords.reminders), "the links to Apple's stores stay")
        XCTAssertTrue(claims.seen.all.contains { $0.hasPrefix("devices/claim") && $0.contains(phoneId) }, "the device keeps its id: \(claims.seen.all)")
        XCTAssertEqual(c.hubURL, direct)
        XCTAssertEqual(c.hubId, id)
        XCTAssertEqual(c.linkRoutes, answer(id), "the same hub's home route stays")
        XCTAssertEqual(c.deviceId, phoneId)
        engine.stop()
    }

    func testAnotherIdAtTheSameAddressIsAnotherHub() async throws {
        let c = config(hub: remote, id: id, routes: answer(id))
        let engine = SyncEngine(config: c, platform: .iphone, store: try await store(queued: false))
        engine.schedulesNotifications = false
        let fresh = OneHub(claimId: "33333333-3333-4333-8333-333333333333")
        let claims = RecordingHub(fresh)
        engine.makeClient = { HubClient(transport: fresh) }
        engine.pairingClient = { _, _ in HubClient(transport: claims) }
        await engine.start()
        XCTAssertNotNil(engine.get("note-a"))
        try await engine.pair(hubURL: remote, code: "ABCD-EFGH", deviceName: nil, hubId: other)
        XCTAssertNil(engine.get("note-a"), "another hub's copy is not this one's")
        XCTAssertEqual(c.hubId, other)
        XCTAssertNil(c.linkRoutes, "nor are its home addresses")
        XCTAssertFalse(claims.seen.all.contains { $0.contains(phoneId) }, "no device id from another hub")
        engine.stop()
    }

    func testAHubPairedBeforeIdsLearnsItsIdAndKeepsItsCopy() async throws {
        let c = config(hub: remote, id: nil)
        let engine = SyncEngine(config: c, platform: .iphone, store: try await store(queued: false))
        engine.schedulesNotifications = false
        let hub = OneHub(claimId: phoneId)
        engine.makeClient = { HubClient(transport: hub) }
        engine.pairingClient = { _, _ in HubClient(transport: hub) }
        await engine.start()
        try await engine.pair(hubURL: remote + "/", code: "ABCD-EFGH", deviceName: nil, hubId: id)
        XCTAssertNotNil(engine.get("note-a"))
        XCTAssertEqual(c.hubId, id)
        engine.stop()
    }

    // MARK: the routes and the id on each connect

    /// The hub's routes move this device from one route to the other (the internet went out at home): the copy, its
    /// queue and the links to Apple's stores stay, since it is the same hub.
    func testARouteChangeNeverForgetsTheCopy() async throws {
        let hub = OneHub()
        let net = TestNet()
        net[remote] = .init(hub: hub, routes: answer(id))
        net[home] = .init(down: true, hub: hub, routes: answer(id))
        let c = config(hub: remote, id: id, routes: answer(id))
        UserDefaults.standard.set(Data("{}".utf8), forKey: AppleLinkRecords.calendar)
        defer { UserDefaults.standard.removeObject(forKey: AppleLinkRecords.calendar) }
        let engine = routedEngine(net, config: c, store: try await store())
        await engine.start()
        XCTAssertEqual(engine.route?.kind, .tailscale)
        XCTAssertTrue(hub.pushed.contains { $0.id == "cap-a" })
        XCTAssertEqual(net.keyed(remote).first?.path, "link/routes", "the hub's id is asked before anything is sent")
        // The internet goes out; the hub still answers at home.
        net[home] = .init(hub: hub, routes: answer(id))
        net[remote] = .init(down: true)
        engine.routes.networkChanged()
        let atHome = await until { engine.route?.kind == .home }
        XCTAssertTrue(atHome)
        await engine.create(kind: .capture, fields: ["text": "made at home", "source": "iphone"], id: "cap-home")
        let sent = await until { hub.pushed.contains { $0.id == "cap-home" } }
        XCTAssertTrue(sent)
        XCTAssertTrue(net.keyed(home).contains { $0.path == "sync/push" }, "sent over the home network")
        XCTAssertNotNil(engine.get("note-a"), "the copy stays")
        let kept = try await engine.store.get("note-a")
        XCTAssertNotNil(kept)
        XCTAssertNotNil(UserDefaults.standard.object(forKey: AppleLinkRecords.calendar), "the links to Apple's stores stay")
        XCTAssertEqual(c.hubURL, remote, "the address it was paired with stays")
        let shown = await until { engine.routeLabel == "Home network" }
        XCTAssertTrue(shown)
        engine.stop()
    }

    func testAnotherHubAtThisAddressStopsTheSync() async throws {
        let hub = OneHub()
        let net = TestNet()
        net[remote] = .init(hub: hub, routes: answer(other, home: false))
        let c = config(hub: remote, id: id)
        let engine = routedEngine(net, config: c, store: try await store())
        await engine.start()
        XCTAssertTrue(hub.pushed.isEmpty, "nothing goes to another hub")
        XCTAssertFalse(net.calls.contains { $0.path.hasPrefix("sync/") || $0.path.hasPrefix("devices") }, "\(net.calls.map(\.path))")
        XCTAssertEqual(engine.lastError, SyncEngine.otherHubMessage)
        XCTAssertEqual(engine.status, .offline)
        XCTAssertEqual(engine.pairingProblem, .otherHub, "the banner offers Pair again")
        XCTAssertTrue(engine.offersPairAgain)
        XCTAssertEqual(engine.outboxCount, 1)
        XCTAssertEqual(c.hubId, id, "the id it was paired with stays")
        XCTAssertNil(c.linkRoutes, "another hub's routes are not kept")
        // Its own hub answers there again.
        net[remote] = .init(hub: hub, routes: answer(id, home: false))
        await engine.sync()
        XCTAssertTrue(hub.pushed.contains { $0.id == "cap-a" })
        XCTAssertNil(engine.lastError)
        XCTAssertNil(engine.pairingProblem)
        engine.stop()
    }

    func testTheFirstAnswerKeepsTheIdAndTheHomeRoute() async throws {
        let hub = OneHub()
        let net = TestNet()
        net[remote] = .init(hub: hub, routes: answer(id))
        net[home] = .init(down: true)
        let c = config(hub: remote, id: nil)
        let engine = routedEngine(net, config: c, store: try await store(queued: false))
        await engine.start()
        XCTAssertEqual(c.hubId, id, "a hub paired before ids: its id is learned on the first connect")
        XCTAssertEqual(c.linkRoutes, answer(id))
        XCTAssertTrue(engine.routes.hasHomeRoute)
        // An older hub has no such route: it syncs as before.
        let older = TestNet()
        let oldHub = OneHub()
        older[remote] = .init(hub: RoutesMissing(oldHub))
        let oc = config(hub: remote, id: nil)
        let oldEngine = routedEngine(older, config: oc, store: try await store())
        await oldEngine.start()
        XCTAssertTrue(oldHub.pushed.contains { $0.id == "cap-a" })
        XCTAssertNil(oc.hubId)
        engine.stop()
        oldEngine.stop()
    }

    func testWakingRacesAgain() async throws {
        let hub = OneHub()
        let net = TestNet()
        net[remote] = .init(hub: hub, routes: answer(id))
        net[home] = .init(down: true)
        let engine = routedEngine(net, config: config(hub: remote, id: id, routes: answer(id)), store: try await store(queued: false))
        await engine.start()
        XCTAssertEqual(engine.route?.kind, .tailscale)
        net[home] = .init(hub: hub, routes: answer(id))
        await engine.start()
        let atHome = await until { engine.route?.kind == .home }
        XCTAssertTrue(atHome, "back home: waking tries the home network again")
        engine.stop()
    }

    /// Moving to another hub sends the old hub's queue to it first, but never to another hub now at its address.
    func testMovingAwaySendsNothingToAnotherHubAtTheOldAddress() async throws {
        let squatter = OneHub()
        let net = TestNet()
        net[remote] = .init(down: true)
        let c = config(hub: remote, id: id)
        let engine = routedEngine(net, config: c, store: try await store())
        await engine.start()
        XCTAssertEqual(engine.outboxCount, 1)
        // Another hub now answers at the old address; the person pairs with their hub somewhere else.
        net[remote] = .init(hub: squatter, routes: answer(other, home: false))
        let addressB = "https://hub-b.example.ts.net"
        let hubB = OneHub(claimId: "33333333-3333-4333-8333-333333333333")
        net[addressB] = .init(hub: hubB, routes: answer(third, address: addressB, home: false))
        engine.pairingClient = { _, _ in HubClient(transport: hubB) }
        try await engine.pair(hubURL: addressB, code: "ABCD-EFGH", deviceName: nil, hubId: third)
        XCTAssertTrue(squatter.pushed.isEmpty, "the queue never went to the other hub")
        XCTAssertFalse(hubB.pushed.contains { $0.id == "cap-a" }, "nor to the new one")
        XCTAssertEqual(c.hubURL, addressB)
        XCTAssertEqual(c.hubId, third)
        engine.stop()
    }
}

/// A hub from before `/link/routes`: that route is a 404, everything else goes to `inner`.
final class RoutesMissing: HubTransport, @unchecked Sendable {
    let inner: HubTransport
    init(_ inner: HubTransport) { self.inner = inner }
    func send(method: String, path: String, query: [String: String], body: Data?) async throws -> (status: Int, data: Data) {
        if path == "link/routes" { return (404, Data(#"{"error":"not found"}"#.utf8)) }
        return try await inner.send(method: method, path: path, query: query, body: body)
    }
}
