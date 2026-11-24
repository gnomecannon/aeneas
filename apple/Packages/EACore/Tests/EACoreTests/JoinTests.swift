import XCTest
@testable import EACore

/// Joining with a phone's yes: the QR code a Mac or iPad shows, the hub's proof, and the phone's call.
final class JoinTests: XCTestCase {
    // The contract's shared test vector; the hub's tests use the same one.
    static let secret = Data(0..<32)
    static let secretText = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
    static let hubKey = String(repeating: "a", count: 64)
    static let node = String(repeating: "b", count: 64)
    static let link = "everythingapp://setup?hid=0123456789ABCDEFGHJKMNPQRS&code=ABCD-EFGH&name=Test%20Mac&link=direct&node=\(hubKey)&relay=https%3A%2F%2Feuc1-1.relay.n0.iroh.link."
    static let proof = "pmOb6wyZdAoeMeQrFEWiughYPHWeACKZ3207YsF76Gs"

    private func join(_ s: String) -> JoinLink? { URL(string: s).flatMap(JoinLink.parse) }
    private let relay = "https%3A%2F%2Feuc1-1.relay.n0.iroh.link.%2F"

    // MARK: The QR code

    func testAJoinLinkReadsBackWhatTheNewDeviceWrote() throws {
        let made = JoinLink(node: Self.node.uppercased(), relay: "https://euc1-1.relay.n0.iroh.link./", secret: Self.secretText, name: "Robin\u{2019}s Mac + more", platform: .mac)
        XCTAssertEqual(made.node, Self.node, "the key is kept in lowercase, as the hub writes it")
        let url = try XCTUnwrap(made.url)
        XCTAssertEqual(JoinLink.parse(url), made)
        XCTAssertEqual(made.platform.label, "Mac")
        XCTAssertEqual(JoinLink.Kind.windows.label, "Windows PC")
        XCTAssertEqual(JoinLink.Kind.android.label, "Android tablet")
    }

    func testAJoinLinkFromAnotherAppParses() throws {
        let j = try XCTUnwrap(join("everythingapp://join?node=\(Self.node)&relay=\(relay)&s=\(Self.secretText)&name=Office+PC&platform=windows"))
        XCTAssertEqual(j.relay, "https://euc1-1.relay.n0.iroh.link./")
        XCTAssertEqual(j.name, "Office PC", "a plus is a space, as a browser writes it")
        XCTAssertEqual(j.platform, .windows)
        XCTAssertEqual(JoinSecret.decode(j.secret), Self.secret)
        let unnamed = try XCTUnwrap(join("everythingapp://join?node=\(Self.node)&relay=\(relay)&s=\(Self.secretText)&platform=ipad"))
        XCTAssertEqual(unnamed.name, "iPad", "no name: the kind of device")
    }

    func testBrokenJoinLinksAreRefused() {
        let ok = "everythingapp://join?node=\(Self.node)&relay=\(relay)&s=\(Self.secretText)&name=Mac&platform=mac"
        XCTAssertNotNil(join(ok))
        XCTAssertNil(join(ok.replacingOccurrences(of: "everythingapp://join", with: "everythingapp://setup")), "not a join link")
        XCTAssertNil(join(ok.replacingOccurrences(of: Self.node, with: String(Self.node.dropLast()))), "a key of 63 characters")
        XCTAssertNil(join(ok.replacingOccurrences(of: Self.node, with: String(repeating: "g", count: 64))), "a key that is not hex")
        XCTAssertNil(join(ok.replacingOccurrences(of: Self.secretText, with: String(Self.secretText.dropLast()))), "a secret of 42 characters")
        XCTAssertNil(join(ok.replacingOccurrences(of: Self.secretText, with: Self.secretText + "A")), "a secret of 44 characters")
        XCTAssertNil(join(ok.replacingOccurrences(of: Self.secretText, with: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")), "padding is not part of it")
        XCTAssertNil(join(ok.replacingOccurrences(of: Self.secretText, with: String(repeating: "!", count: 43))), "not base64url")
        XCTAssertNil(join(ok.replacingOccurrences(of: "&relay=\(relay)", with: "")), "no relay")
        XCTAssertNil(join(ok.replacingOccurrences(of: relay, with: "http%3A%2F%2Frelay.example")), "a relay that is not https")
        XCTAssertNil(join(ok.replacingOccurrences(of: relay, with: "https%3A%2F%2F")), "a relay with no host")
        XCTAssertNil(join(ok.replacingOccurrences(of: "platform=mac", with: "platform=iphone")), "a phone does not join this way")
        XCTAssertNil(join(ok.replacingOccurrences(of: "&platform=mac", with: "")), "no platform")
    }

    func testSecretsAreFreshAndWrittenAs43Characters() {
        let a = JoinSecret.make(), b = JoinSecret.make()
        XCTAssertEqual(a.count, 32)
        XCTAssertNotEqual(a, b)
        XCTAssertEqual(JoinSecret.encode(a).count, 43)
        XCTAssertEqual(JoinSecret.decode(JoinSecret.encode(a)), a)
        XCTAssertEqual(JoinSecret.encode(Self.secret), Self.secretText)
    }

    // MARK: The hub's proof

    private func offer(link: String = JoinTests.link, proof: String = JoinTests.proof, v: Int = 1) -> Data {
        try! JSONSerialization.data(withJSONObject: ["v": v, "link": link, "proof": proof])
    }

    func testTheSharedVectorHolds() throws {
        XCTAssertEqual(JoinCheck.proof(secret: Self.secret, hubKey: Self.hubKey, node: Self.node, link: Self.link), Self.proof)
        guard case .accepted(let l) = JoinCheck.check(offer(), remoteKey: Self.hubKey, node: Self.node, secrets: [Self.secret]) else {
            return XCTFail("the hub's offer was refused")
        }
        XCTAssertEqual(l.credential, .code("ABCDEFGH"))
        XCTAssertEqual(l.name, "Test Mac")
        XCTAssertEqual(l.hubId, "0123456789ABCDEFGHJKMNPQRS")
        XCTAssertEqual(DirectHub.parse(l.hub)?.node, Self.hubKey)
        XCTAssertEqual(DirectHub.parse(l.hub)?.relay, "https://euc1-1.relay.n0.iroh.link.")
        // The key the connection came from may be written in capitals; it is the same key.
        if case .refused = JoinCheck.check(offer(), remoteKey: Self.hubKey.uppercased(), node: Self.node, secrets: [Self.secret]) { XCTFail("same key") }
    }

    func testTheCodeBeforeTheOneOnScreenStillCountsWhileItIsAccepted() {
        let newer = JoinSecret.make()
        if case .refused = JoinCheck.check(offer(), remoteKey: Self.hubKey, node: Self.node, secrets: [newer, Self.secret]) { XCTFail("the previous secret is accepted") }
        XCTAssertEqual(JoinCheck.check(offer(), remoteKey: Self.hubKey, node: Self.node, secrets: [newer]),
                       .refused("The hub's proof does not match the code on this device. Scan the code on its screen again."))
    }

    func testAWrongProofIsRefused() {
        var wrong = Array(Self.proof)
        wrong[5] = wrong[5] == "A" ? "B" : "A"
        for p in [String(wrong), "", "not base64!", String(Self.proof.dropLast(4))] {
            guard case .refused = JoinCheck.check(offer(proof: p), remoteKey: Self.hubKey, node: Self.node, secrets: [Self.secret]) else { return XCTFail(p) }
        }
        // A proof made for another device (its own key in the message) does not fit this one.
        guard case .refused = JoinCheck.check(offer(), remoteKey: Self.hubKey, node: String(repeating: "c", count: 64), secrets: [Self.secret]) else { return XCTFail("another node") }
        // Nor does the link changed after the proof was made.
        let other = Self.link.replacingOccurrences(of: "ABCD-EFGH", with: "WXYZ-2345")
        guard case .refused = JoinCheck.check(offer(link: other), remoteKey: Self.hubKey, node: Self.node, secrets: [Self.secret]) else { return XCTFail("changed link") }
    }

    func testOnlyTheHubTheLinkNamesMayHandItOver() {
        // Another endpoint that knows the secret (it saw the QR code) cannot send its own hub's link.
        let stranger = String(repeating: "c", count: 64)
        let theirs = Self.link.replacingOccurrences(of: Self.hubKey, with: stranger)
        let theirProof = JoinCheck.proof(secret: Self.secret, hubKey: stranger, node: Self.node, link: theirs)
        XCTAssertEqual(JoinCheck.check(offer(link: theirs, proof: theirProof), remoteKey: Self.hubKey, node: Self.node, secrets: [Self.secret]),
                       .refused("The pairing link names another hub than the one that sent it."))
        XCTAssertEqual(JoinCheck.check(offer(), remoteKey: stranger, node: Self.node, secrets: [Self.secret]),
                       .refused("The pairing link names another hub than the one that sent it."))
    }

    func testOnlyACompleteDirectLinkPairingLinkIsTaken() {
        func refused(_ link: String, _ why: String) {
            let p = JoinCheck.proof(secret: Self.secret, hubKey: Self.hubKey, node: Self.node, link: link)
            guard case .refused = JoinCheck.check(offer(link: link, proof: p), remoteKey: Self.hubKey, node: Self.node, secrets: [Self.secret]) else { return XCTFail(why) }
        }
        refused("everythingapp://setup?hub=https%3A%2F%2Fcore.tail1234.ts.net&code=ABCD-EFGH", "not a Direct link hub")
        refused("everythingapp://setup?link=direct&node=\(Self.hubKey)&relay=https%3A%2F%2Frelay.example&token=lasting", "a lasting key instead of a code")
        refused("everythingapp://setup?link=direct&node=\(Self.hubKey)&relay=https%3A%2F%2Frelay.example", "no code")
        guard case .refused = JoinCheck.check(offer(v: 2), remoteKey: Self.hubKey, node: Self.node, secrets: [Self.secret]) else { return XCTFail("another version") }
        guard case .refused = JoinCheck.check(Data("{}".utf8), remoteKey: Self.hubKey, node: Self.node, secrets: [Self.secret]) else { return XCTFail("empty") }
        XCTAssertEqual(JoinCheck.check(Data("not json".utf8), remoteKey: Self.hubKey, node: Self.node, secrets: [Self.secret]), .refused("That was not a join this device can read."))
    }

    func testTheAnswersAreAsTheHubReadsThem() throws {
        XCTAssertEqual(try Data(JoinCheck.answer(ok: true)).asJSON() as NSDictionary, ["ok": true] as NSDictionary)
        XCTAssertEqual(try Data(JoinCheck.answer(ok: false, error: "No.")).asJSON() as NSDictionary, ["ok": false, "error": "No."] as NSDictionary)
    }

    // MARK: The phone's call

    private let sample = JoinLink(node: JoinTests.node, relay: "https://euc1-1.relay.n0.iroh.link./", secret: JoinTests.secretText, name: "Office Mac", platform: .mac)

    func testThePhoneSendsTheLinkAndReadsEachAnswer() async throws {
        let t = FakeTransport()
        t.responses = [(200, Data(#"{"device_id":"d9","name":"Office Mac"}"#.utf8)), (202, Data(#"{"name":"Office Mac","state":"sent"}"#.utf8))]
        let c = HubClient(transport: t)
        let added = try await c.join(sample)
        XCTAssertEqual(added, .added(name: "Office Mac"))
        let sent = try await c.join(sample)
        XCTAssertEqual(sent, .sent(name: "Office Mac"))
        XCTAssertEqual(t.calls.first?.method, "POST")
        XCTAssertEqual(t.calls.first?.path, "devices/join")
        let body = try XCTUnwrap(t.calls.first?.body).asJSON()
        XCTAssertEqual(body as NSDictionary, ["node": JoinTests.node, "relay": "https://euc1-1.relay.n0.iroh.link./", "s": JoinTests.secretText, "name": "Office Mac", "platform": "mac"] as NSDictionary)
        XCTAssertEqual(HTTPTransport.timeout(path: "devices/join"), 110, "the hub may take about 100 seconds")
    }

    func testARefusalSaysTheHubsOwnSentence() async {
        let t = FakeTransport()
        t.responses = [(502, Data(#"{"error":"Office Mac did not answer. Check that it shows the code, then try again."}"#.utf8))]
        do {
            _ = try await HubClient(transport: t).join(sample)
            XCTFail("a 502 is a failure")
        } catch {
            XCTAssertEqual(JoinAnswer.failureText(error, name: "Office Mac"), "Office Mac did not answer. Check that it shows the code, then try again.")
        }
        XCTAssertEqual(JoinAnswer.failureText(HubError.http(status: 404, message: "not found"), name: "x"), "Your hub is too old to add a computer this way. Update the hub, then try again.")
        XCTAssertEqual(JoinAnswer.failureText(HubError.http(status: 502, message: "<html>Bad gateway</html>"), name: "Office Mac"), "Your hub could not add Office Mac.")
        XCTAssertEqual(JoinAnswer.failureText(HubError.transport("The hub did not answer within 110 seconds"), name: "x"), "Could not reach your hub: The hub did not answer within 110 seconds")
    }
}

/// A pairing link pasted into Set up, and a link for the hub this device already uses.
final class PastedSetupLinkTests: XCTestCase {
    func testTheAppLinkIsFoundInsideText() throws {
        let l = try XCTUnwrap(SetupLink.find(in: "Open this: everythingapp://setup?hub=https%3A%2F%2Fcore.tail1234.ts.net&code=7K3M9P2Q&name=iPad, thanks"))
        XCTAssertEqual(l.hub, "https://core.tail1234.ts.net")
        XCTAssertEqual(l.credential, .code("7K3M9P2Q"))
        XCTAssertEqual(l.name, "iPad", "the comma after it is not part of the name")
    }

    func testTheWebLinkIsFoundToo() throws {
        let fp = String(repeating: "ab", count: 32)
        let l = try XCTUnwrap(SetupLink.find(in: "https://core.tail1234.ts.net/app/#/setup?hub=https%3A%2F%2Fhub.lan%3A8787&code=7k3m-9p2q&name=Mac&fp=\(fp)"))
        XCTAssertEqual(l.hub, "https://hub.lan:8787")
        XCTAssertEqual(l.credential, .code("7K3M9P2Q"))
        XCTAssertEqual(l.pin, fp, "the certificate it names is kept")
        let direct = try XCTUnwrap(SetupLink.find(in: "https://x/app/#/setup?link=direct&node=\(JoinTests.hubKey)&relay=https%3A%2F%2Frelay.example&code=7K3M9P2Q"))
        XCTAssertEqual(DirectHub.parse(direct.hub)?.node, JoinTests.hubKey)
    }

    func testARelayThatEndsInADotKeepsIt() throws {
        let exact = try XCTUnwrap(URL(string: JoinTests.link).flatMap(SetupLink.parse))
        XCTAssertEqual(SetupLink.find(in: JoinTests.link), exact)
        XCTAssertEqual(SetupLink.find(in: "Pair with \(JoinTests.link)."), exact, "a full stop after a link that ends in its relay")
        XCTAssertEqual(SetupLink.find(in: "(\(JoinTests.link))"), exact)
        // A link that ends with its hub id loses the full stop.
        let hid = "everythingapp://setup?code=7K3M9P2Q&link=direct&node=\(JoinTests.hubKey)&relay=https%3A%2F%2Frelay.example&hid=0123456789ABCDEFGHJKMNPQRS"
        XCTAssertEqual(SetupLink.find(in: "Here: \(hid).")?.hubId, "0123456789ABCDEFGHJKMNPQRS")
    }

    func testNothingUsableGivesNothing() {
        XCTAssertNil(SetupLink.find(in: "https://core.tail1234.ts.net:8787"), "a plain address is typed, not a link")
        XCTAssertNil(SetupLink.find(in: "ABCD-EFGH"))
        XCTAssertNil(SetupLink.find(in: "everythingapp://setup?hub=https%3A%2F%2Fh&code=ABC"), "a code that is not 8 characters")
        XCTAssertNil(SetupLink.find(in: "https://h/app/#/setup?name=x"))
        XCTAssertNil(SetupLink.find(in: "everythingapp://join?node=\(JoinTests.node)"), "a join link is not a setup link")
    }

    func testALinkForTheSameHubOnlyPairsAgain() throws {
        let hub = "https://core.tail1234.ts.net"
        let hid = "0123456789ABCDEFGHJKMNPQRS"
        let l = try XCTUnwrap(URL(string: "everythingapp://setup?hub=https%3A%2F%2Fcore.tail1234.ts.net&code=7K3M9P2Q&hid=\(hid)").flatMap(SetupLink.parse))
        XCTAssertTrue(l.pairsAgain(currentHub: hub, currentPin: nil, currentHubId: hid))
        XCTAssertTrue(l.pairsAgain(currentHub: hub + "/", currentPin: nil, currentHubId: nil), "the same address, its id not known here")
        XCTAssertFalse(l.pairsAgain(currentHub: "https://other.example", currentPin: nil, currentHubId: nil), "another hub is asked about as a switch")
        XCTAssertFalse(l.pairsAgain(currentHub: hub, currentPin: nil, currentHubId: "ZZZZZZZZZZZZZZZZZZZZZZZZZZ"), "another id at the same address is another hub")
        let pinned = try XCTUnwrap(URL(string: "everythingapp://setup?hub=https%3A%2F%2Fhub.lan&code=7K3M9P2Q&fp=\(String(repeating: "ab", count: 32))").flatMap(SetupLink.parse))
        XCTAssertFalse(pinned.pairsAgain(currentHub: "https://hub.lan", currentPin: String(repeating: "cd", count: 32)), "another certificate is asked about as a switch")
        XCTAssertTrue(pinned.pairsAgain(currentHub: "https://hub.lan", currentPin: String(repeating: "ab", count: 32)))
    }
}
