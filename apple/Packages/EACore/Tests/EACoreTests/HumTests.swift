import XCTest
import AVFoundation
@testable import EACore

/// Answers every request in a test URLSession with one canned reply and keeps what was asked.
final class HumStubProtocol: URLProtocol {
    struct Reply { var status: Int; var headers: [String: String]; var body: Data }
    static var reply = Reply(status: 200, headers: [:], body: Data())
    static var seen: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.seen.append(request)
        let r = HTTPURLResponse(url: request.url!, statusCode: Self.reply.status, httpVersion: "HTTP/1.1", headerFields: Self.reply.headers)!
        client?.urlProtocol(self, didReceive: r, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.reply.body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    static func client() -> HubClient {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [HumStubProtocol.self]
        return HubClient(baseURL: URL(string: "http://hub.test:8787")!, token: "test-token", session: URLSession(configuration: cfg))
    }
}

final class HumTests: XCTestCase {
    private let ideaId = "0f9e8d7c-6b5a-4321-8fed-cba987654321"

    private func idea(fields: String) -> String {
        #"{"id":"\#(ideaId)","kind":"music_idea","space":"personal","created_at":"2026-11-03T20:00:00.000Z","updated_at":"2026-11-03T20:00:05.000Z","deleted_at":null,"fields":\#(fields),"field_ts":{}}"#
    }

    override func setUp() {
        HumStubProtocol.seen = []
        HumStubProtocol.reply = .init(status: 200, headers: [:], body: Data())
    }

    // MARK: decoding

    func testIdeaWithoutMidiDecodesAsBefore() throws {
        let e = try JSONCoding.decode(Entity.self, from: idea(fields: #"{"title":"Am F C G","type":"progression","body":"","key":"Am","bpm":112,"status":"idea","tags":[]}"#))
        XCTAssertNil(e.humMidi)
        let f = try e.decode(MusicIdeaFields.self)
        XCTAssertEqual(f.title, "Am F C G")
        XCTAssertEqual(f.type, "progression")
        XCTAssertEqual(f.bpm, 112)
        XCTAssertNil(f.midi)
    }

    func testListeningIdeaDecodes() throws {
        let e = try JSONCoding.decode(Entity.self, from: idea(fields: #"{"title":"Hummed melody","type":"riff","body":"","status":"idea","tags":["hummed","melody"],"audio_ref":"hum:x","midi":{"source":"hum","mode":"melody","state":"listening","seconds":7.5,"notes":[]}}"#))
        let m = try XCTUnwrap(e.humMidi)
        XCTAssertEqual(m.mode, .melody)
        XCTAssertEqual(m.state, .listening)
        XCTAssertEqual(m.seconds, 7.5)
        XCTAssertTrue(m.notes.isEmpty)
        XCTAssertEqual(m.kindName, "Hummed melody")
        XCTAssertEqual(try e.decode(MusicIdeaFields.self).midi, m)
    }

    func testHeardMelodyDecodes() throws {
        let e = try JSONCoding.decode(Entity.self, from: idea(fields: #"{"title":"Melody in A minor, 120 BPM","type":"riff","key":"A minor","bpm":120,"midi":{"source":"hum","mode":"melody","state":"done","seconds":4.2,"notes":[{"p":57,"s":0,"d":0.5,"v":90},{"p":60,"s":0.5,"d":0.25,"v":100},{"p":64,"s":1,"d":1,"v":70}]}}"#))
        let m = try XCTUnwrap(e.humMidi)
        XCTAssertEqual(m.state, .done)
        XCTAssertEqual(m.notes, [.init(p: 57, s: 0, d: 0.5, v: 90), .init(p: 60, s: 0.5, d: 0.25, v: 100), .init(p: 64, s: 1, d: 1, v: 70)])
        XCTAssertEqual(m.length, 2)
        XCTAssertEqual(m.countText, "3 notes")
        XCTAssertEqual(m.pitchRange, 54...66, "two semitones either side, widened to an octave")
        XCTAssertEqual(HumMidi.noteName(60), "C4")
        XCTAssertEqual(HumMidi.noteName(57), "A3")
    }

    func testRhythmAndFailureDecode() throws {
        let r = try JSONCoding.decode(Entity.self, from: idea(fields: #"{"title":"Rhythm, 96 BPM","type":"riff","midi":{"mode":"rhythm","state":"done","notes":[{"p":36,"s":0,"d":0.156,"v":120},{"p":38,"s":0.625,"d":0.156,"v":100},{"p":42,"s":0.3125,"d":0.156,"v":60}]}}"#)).humMidi
        XCTAssertEqual(r?.mode, .rhythm)
        XCTAssertEqual(r?.source, "hum", "source defaults like the shared schema")
        XCTAssertEqual(r?.countText, "3 hits")
        XCTAssertEqual(r?.notes.map { HumMidi.drum($0.p) }, [.kick, .snare, .hat])

        let f = try JSONCoding.decode(Entity.self, from: idea(fields: #"{"title":"Tapped rhythm","type":"riff","midi":{"source":"hum","mode":"rhythm","state":"failed","error":"no hits were heard; tap or clap closer to the microphone","notes":[]}}"#)).humMidi
        XCTAssertEqual(f?.state, .failed)
        XCTAssertEqual(f?.error, "no hits were heard; tap or clap closer to the microphone")
    }

    func testOddMidiNeverHidesTheIdea() throws {
        // A newer state, a float pitch and one broken note: the rest still reads.
        let e = try JSONCoding.decode(Entity.self, from: idea(fields: #"{"title":"x","type":"riff","midi":{"mode":"melody","state":"tidying","notes":[{"p":60.0,"s":0,"d":0.5,"v":80},{"p":"high"},{"p":200,"s":-1,"d":0.1,"v":0}]}}"#))
        let m = try XCTUnwrap(e.humMidi)
        XCTAssertEqual(m.state, .done)
        XCTAssertEqual(m.notes, [.init(p: 60, s: 0, d: 0.5, v: 80), .init(p: 127, s: 0, d: 0.1, v: 1)])

        let junk = try JSONCoding.decode(Entity.self, from: idea(fields: #"{"title":"y","type":"riff","midi":"not an object"}"#))
        XCTAssertNil(junk.humMidi)
        XCTAssertEqual(try junk.decode(MusicIdeaFields.self).title, "y")
    }

    // MARK: requests

    func testUploadQuery() {
        XCTAssertEqual(HubClient.humQuery(mode: .melody, bpm: nil, title: nil, projectId: nil, fromCapture: false), ["mode": "melody"])
        XCTAssertEqual(HubClient.humQuery(mode: .rhythm, bpm: 96, title: "  Verse groove ", projectId: "p1", fromCapture: true),
                       ["mode": "rhythm", "bpm": "96", "title": "Verse groove", "project_id": "p1", "from": "capture"])
        XCTAssertEqual(HubClient.humQuery(mode: .melody, bpm: 0, title: "", projectId: "", fromCapture: false), ["mode": "melody"])
    }

    func testUploadRequestShape() throws {
        let http = try XCTUnwrap(HTTPTransport.make(urlString: "hub.test:8787/", token: "test-token"))
        let r = HubClient.humUploadRequest(http, mode: .rhythm, bpm: 100, title: nil, projectId: nil, fromCapture: true)
        XCTAssertEqual(r.httpMethod, "POST")
        XCTAssertEqual(r.url?.path, "/music/hum")
        XCTAssertEqual(r.url?.query, "bpm=100&from=capture&mode=rhythm")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Content-Type"), "audio/wav")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
        XCTAssertGreaterThanOrEqual(r.timeoutInterval, 120)
        // A take's id goes along, so the same take sent again is the same idea on the hub.
        let again = HubClient.humUploadRequest(http, mode: .melody, bpm: nil, title: nil, projectId: nil, fromCapture: true, clientId: "3F2A9C1E-0000-4000-8000-000000000001")
        XCTAssertEqual(again.url?.query, "client_id=3F2A9C1E-0000-4000-8000-000000000001&from=capture&mode=melody")
    }

    func testUploadSendsTheFileAndReadsTheIdea() async throws {
        let wav = FileManager.default.temporaryDirectory.appendingPathComponent("hum-test-\(UUID().uuidString).wav")
        try Data("RIFF....WAVEfmt ".utf8).write(to: wav)
        defer { try? FileManager.default.removeItem(at: wav) }
        HumStubProtocol.reply = .init(status: 202, headers: ["Content-Type": "application/json"],
                                      body: Data(idea(fields: #"{"title":"Hummed melody","type":"riff","tags":["hummed","melody"],"midi":{"source":"hum","mode":"melody","state":"listening","seconds":3,"notes":[]}}"#).utf8))
        let e = try await HumStubProtocol.client().uploadHum(fileURL: wav, mode: .melody, fromCapture: true)
        let r = try XCTUnwrap(HumStubProtocol.seen.last)
        XCTAssertEqual(r.httpMethod, "POST")
        XCTAssertEqual(r.url?.path, "/music/hum")
        XCTAssertEqual(r.url?.query, "from=capture&mode=melody")
        XCTAssertEqual(e.id, ideaId)
        XCTAssertEqual(e.humMidi?.state, .listening)
    }

    func testUploadRefusalKeepsTheHubsSentence() async throws {
        let wav = FileManager.default.temporaryDirectory.appendingPathComponent("hum-test-\(UUID().uuidString).wav")
        try Data("x".utf8).write(to: wav)
        defer { try? FileManager.default.removeItem(at: wav) }
        HumStubProtocol.reply = .init(status: 422, headers: [:], body: Data(#"{"error":"send the recording as a WAV file"}"#.utf8))
        do { _ = try await HumStubProtocol.client().uploadHum(fileURL: wav, mode: .melody); XCTFail("expected an error") }
        catch { XCTAssertEqual(error as? HubError, .http(status: 422, message: "send the recording as a WAV file")) }
    }

    func testMIDIComesWithTheHubsName() async throws {
        HumStubProtocol.reply = .init(status: 200, headers: ["Content-Type": "audio/midi", "Content-Disposition": #"attachment; filename="Melody in A minor, 120 BPM.mid""#], body: Data([0x4D, 0x54, 0x68, 0x64]))
        let c = HumStubProtocol.client()
        let snapped = try await c.humMIDI(ideaId)
        XCTAssertEqual(snapped.name, "Melody in A minor, 120 BPM.mid")
        XCTAssertEqual(snapped.data, Data([0x4D, 0x54, 0x68, 0x64]))
        XCTAssertEqual(HumStubProtocol.seen.last?.url?.path, "/music/\(ideaId)/midi")
        XCTAssertNil(HumStubProtocol.seen.last?.url?.query)
        _ = try await c.humMIDI(ideaId, grid: false)
        XCTAssertEqual(HumStubProtocol.seen.last?.url?.query, "grid=off")

        HumStubProtocol.reply = .init(status: 409, headers: [:], body: Data(#"{"error":"still listening; try again in a moment"}"#.utf8))
        do { _ = try await c.humMIDI(ideaId); XCTFail("expected an error") }
        catch { XCTAssertEqual(error as? HubError, .http(status: 409, message: "still listening; try again in a moment")) }
    }

    func testFileNameFromHeader() {
        XCTAssertEqual(HubClient.fileName(contentDisposition: #"attachment; filename="Rhythm, 96 BPM.mid""#), "Rhythm, 96 BPM.mid")
        XCTAssertEqual(HubClient.fileName(contentDisposition: #"attachment; filename="a.mid"; filename*=UTF-8''Caf%C3%A9%20groove.mid"#), "Café groove.mid")
        XCTAssertEqual(HubClient.fileName(contentDisposition: #"attachment; filename="../../.hidden/x.mid""#), "hidden x.mid")
        XCTAssertNil(HubClient.fileName(contentDisposition: "attachment"))
        XCTAssertNil(HubClient.fileName(contentDisposition: nil))
    }

    func testRehearAndRecordingPaths() async throws {
        let t = FakeTransport()
        t.responses = [(202, Data(idea(fields: #"{"title":"x","type":"riff","midi":{"mode":"rhythm","state":"listening","notes":[]}}"#).utf8)), (200, Data("RIFF".utf8))]
        let c = HubClient(transport: t)
        let e = try await c.rehearHum(ideaId, mode: .rhythm, bpm: 95.6)
        XCTAssertEqual(t.calls.last?.method, "POST")
        XCTAssertEqual(t.calls.last?.path, "music/\(ideaId)/rehear")
        let sent = try JSONSerialization.jsonObject(with: t.calls.last?.body ?? Data()) as? [String: Any]
        XCTAssertEqual(sent?["mode"] as? String, "rhythm")
        XCTAssertEqual(sent?["bpm"] as? Double, 96)
        XCTAssertEqual(e.humMidi?.state, .listening)

        let wav = try await c.humRecording(ideaId)
        XCTAssertEqual(t.calls.last?.method, "GET")
        XCTAssertEqual(t.calls.last?.path, "music/\(ideaId)/audio")
        XCTAssertEqual(wav, Data("RIFF".utf8))
    }

    func testRehearWithNothingSendsAnEmptyObject() async throws {
        let t = FakeTransport()
        t.responses = [(202, Data(idea(fields: #"{"title":"x","type":"riff"}"#).utf8))]
        _ = try await HubClient(transport: t).rehearHum(ideaId)
        XCTAssertEqual(String(decoding: t.calls.last?.body ?? Data(), as: UTF8.self), "{}")
    }

    // MARK: playing on the device

    func testPlaybackMIDIFile() {
        let m = HumMidi(mode: .melody, state: .done, notes: [.init(p: 60, s: 0, d: 0.5, v: 100), .init(p: 62, s: 0.5, d: 0.5, v: 90)])
        let bytes = [UInt8](m.playbackMIDIFile())
        XCTAssertEqual(Array(bytes[0..<4]), Array("MThd".utf8))
        XCTAssertEqual(Array(bytes[8..<14]), [0, 0, 0, 1, 0x01, 0xE0], "format 0, one track, 480 ticks a quarter")
        XCTAssertEqual(Array(bytes[14..<18]), Array("MTrk".utf8))
        let length = Int(bytes[18]) << 24 | Int(bytes[19]) << 16 | Int(bytes[20]) << 8 | Int(bytes[21])
        XCTAssertEqual(length, bytes.count - 22)
        XCTAssertEqual(Array(bytes.suffix(4)), [0x00, 0xFF, 0x2F, 0x00])
        // Tempo, then C4 on at 0, C4 off and D4 on at 480 ticks (half a second at 120 BPM), D4 off 480 later.
        let track = Array(bytes[22...])
        XCTAssertEqual(Array(track[0..<7]), [0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20])
        XCTAssertEqual(Array(track[7..<11]), [0x00, 0x90, 60, 100])
        XCTAssertEqual(Array(track[11..<16]), [0x83, 0x60, 0x80, 60, 0])
        XCTAssertEqual(Array(track[16..<20]), [0x00, 0x90, 62, 90])
        XCTAssertEqual(Array(track[20..<25]), [0x83, 0x60, 0x80, 62, 0])
        XCTAssertEqual(HumMidi.vlq(0), [0])
        XCTAssertEqual(HumMidi.vlq(127), [0x7F])
        XCTAssertEqual(HumMidi.vlq(128), [0x81, 0x00])
        XCTAssertEqual(HumMidi.vlq(16_383), [0xFF, 0x7F])
    }

    func testPlaybackFileLoadsInTheSequencer() throws {
        // What the device plays a melody with must read back at the timing heard: 120 BPM, one beat each half second.
        let m = HumMidi(mode: .melody, state: .done, notes: [.init(p: 60, s: 0, d: 0.5, v: 100), .init(p: 64, s: 1.5, d: 0.5, v: 90)])
        let seq = AVAudioSequencer()
        try seq.load(from: m.playbackMIDIFile(), options: [])
        XCTAssertEqual(seq.tracks.count, 1)
        XCTAssertEqual(seq.seconds(forBeats: 4), 2, accuracy: 0.001)
        XCTAssertEqual(seq.tracks[0].lengthInSeconds, 2, accuracy: 0.05)
    }

    func testDrumsLandOnTheirHits() {
        let sr = 22_050.0
        let notes: [HumMidi.Note] = [.init(p: 36, s: 0, d: 0.1, v: 127), .init(p: 38, s: 0.5, d: 0.1, v: 127), .init(p: 42, s: 1, d: 0.1, v: 127)]
        let out = HumDrums.render(notes, sampleRate: sr)
        XCTAssertGreaterThanOrEqual(Double(out.count), 1.0 * sr + Double(HumDrums.hit(.hat, sampleRate: sr).count))
        func energy(_ from: Double, _ to: Double) -> Float { out[Int(from * sr)..<Int(to * sr)].reduce(0) { $0 + $1 * $1 } }
        XCTAssertGreaterThan(energy(0, 0.05), 10)
        XCTAssertGreaterThan(energy(0.5, 0.55), 5)
        XCTAssertGreaterThan(energy(1.0, 1.03), 0.5)
        XCTAssertLessThan(energy(0.4, 0.49), 0.5, "the kick has died away before the snare")
        XCTAssertLessThanOrEqual(out.reduce(Float(0)) { max($0, abs($1)) }, 0.951)
        XCTAssertEqual(out, HumDrums.render(notes, sampleRate: sr), "the same notes give the same sound")
        XCTAssertTrue(HumDrums.render([], sampleRate: sr).isEmpty)
    }
}
