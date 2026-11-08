import XCTest
import Security
@testable import EACore

/// Pinning the hub's certificate from a pairing link's `fp`.
final class PinningTests: XCTestCase {
    /// A throwaway self-signed certificate (CN=hub.test, P-256), DER, made for this test with openssl.
    static let der = Data(base64Encoded: "MIIBFTCBvAIJAJ6Pkj2XYP8+MAoGCCqGSM49BAMCMBMxETAPBgNVBAMMCGh1Yi50ZXN0MB4XDTI2MTEwNTIwMzcxNFoXDTM2MTEwMjIwMzcxNFowEzERMA8GA1UEAwwIaHViLnRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASyhrqX69eMTL645awSja+uwrdjXn1xv+Yfp1JpvvyguDB3pinlm9HVD/kH7Kh59S5gbVXyZRCoL5sDiOeCRh0+MAoGCCqGSM49BAMCA0gAMEUCIQDgpULoHuzZrqA//QBMFVkBs3Romce7256sfBnCDkt+dAIgZqQGkSHXxPn9i3OVozWZ8X6buIMJtK6dbhkbfvk0ZQo=")!
    /// `shasum -a 256` of that file.
    static let sha256 = "7980bee0fc7a4dfc1e0878b2597b3e2f27c3fa9bc2d61bcae79d68a2de532bc8"

    func testFingerprintsAreNormalized() {
        XCTAssertEqual(HubPin.normalize(Self.sha256.uppercased()), Self.sha256)
        let colons = stride(from: 0, to: 64, by: 2).map { i -> String in
            let s = Self.sha256.index(Self.sha256.startIndex, offsetBy: i)
            return String(Self.sha256[s..<Self.sha256.index(s, offsetBy: 2)])
        }.joined(separator: ":")
        XCTAssertEqual(HubPin.normalize(colons), Self.sha256, "the colon form openssl prints")
        XCTAssertNil(HubPin.normalize(String(Self.sha256.dropLast())), "one hex digit short")
        XCTAssertNil(HubPin.normalize(String(Self.sha256.dropLast()) + "g"), "not hex")
        XCTAssertNil(HubPin.normalize(""))
        XCTAssertNil(HubPin.normalize(nil))
    }

    func testOnlyAnHTTPSHubKeepsAPin() {
        XCTAssertEqual(HubPin.forHub("https://hub.lan:8443", pin: Self.sha256), Self.sha256)
        XCTAssertNil(HubPin.forHub("http://hub.lan:8787", pin: Self.sha256))
        XCTAssertNil(HubPin.forHub("hub.lan:8787", pin: Self.sha256), "no scheme means http")
    }

    func testTheFingerprintIsTheSHA256OfTheCertificate() {
        XCTAssertEqual(HubPin.fingerprint(Self.der), Self.sha256)
    }

    func testOnlyThePinnedCertificateIsAccepted() {
        XCTAssertEqual(HubPin.decide(pin: Self.sha256, leaf: Self.der), .accept)
        var other = Self.der
        other[other.count - 1] ^= 0x01
        XCTAssertEqual(HubPin.decide(pin: Self.sha256, leaf: other), .reject, "any other certificate is refused")
        XCTAssertEqual(HubPin.decide(pin: Self.sha256, leaf: nil), .reject, "no certificate is refused")
        XCTAssertEqual(HubPin.decide(pin: nil, leaf: other), .standard, "no pin: the system decides")
        XCTAssertEqual(HubPin.decide(pin: "not-a-pin", leaf: other), .standard)
    }

    func testTheLeafIsReadFromTheServersTrust() throws {
        let cert = try XCTUnwrap(SecCertificateCreateWithData(nil, Self.der as CFData))
        var trust: SecTrust?
        XCTAssertEqual(SecTrustCreateWithCertificates(cert, SecPolicyCreateSSL(true, "hub.test" as CFString), &trust), errSecSuccess)
        let t = try XCTUnwrap(trust)
        XCTAssertEqual(HubPin.leafCertificate(t), Self.der)
        XCTAssertEqual(HubPin.decide(pin: Self.sha256, leaf: HubPin.leafCertificate(t)), .accept)
    }

    func testAPinnedHTTPSHubGetsThePinningSession() throws {
        let pinned = try XCTUnwrap(HTTPTransport.make(urlString: "https://hub.lan:8443", token: "k", pin: Self.sha256))
        XCTAssertTrue(pinned.session.delegate is PinnedSessionDelegate)
        XCTAssertEqual((pinned.session.delegate as? PinnedSessionDelegate)?.pin, Self.sha256)
        let again = try XCTUnwrap(HTTPTransport.make(urlString: "https://hub.lan:8443", token: "k", pin: Self.sha256))
        XCTAssertTrue(again.session === pinned.session, "one session per pin, not one per request")
        let plain = try XCTUnwrap(HTTPTransport.make(urlString: "http://hub.lan:8787", token: "k", pin: Self.sha256))
        XCTAssertNil(plain.session.delegate, "an http hub has nothing to pin")
        let unpinned = try XCTUnwrap(HTTPTransport.make(urlString: "https://hub.lan:8443", token: "k"))
        XCTAssertNil(unpinned.session.delegate)
    }

    func testTheConfigsPinReachesTheTransport() throws {
        let c = SharedConfig(suiteName: "eacore-tests-\(UUID().uuidString)")
        c.hubURL = "https://hub.lan:8443"
        c.storeDeviceKey("ead1_k")
        c.hubPin = Self.sha256.uppercased()
        XCTAssertEqual(c.hubPin, Self.sha256)
        let t = try XCTUnwrap(HTTPTransport.make(config: c))
        XCTAssertEqual(t.token, "ead1_k")
        XCTAssertTrue(t.session.delegate is PinnedSessionDelegate)
        c.hubPin = "nonsense"
        XCTAssertNil(c.hubPin, "a bad value clears the pin rather than pinning nothing")
    }
}
