import XCTest
@testable import EACore

/// Makes apple/EverythingApp/Resources/SampleHub.json, the recording sample mode plays back (SampleHub.swift), from a
/// running demo hub. Skipped unless EA_SAMPLE_RECORD_URL is set. To record it again:
///
///   1. Start a demo hub on a new folder (it seeds Alex's month around today, then serves it on 127.0.0.1):
///        cd hub && npx tsx scripts/demo-hub.ts /tmp/aeneas-demo 8790
///      Seed it after about 9 AM: the sample's logs from today are never later than the moment it was seeded.
///   2. In apple/Packages/EACore:
///        EA_SAMPLE_RECORD_URL=http://127.0.0.1:8790 EA_SAMPLE_RECORD_TOKEN_FILE=/tmp/aeneas-demo/demo-token \
///          swift test --filter SampleRecorderTests
///      EA_SAMPLE_RECORD_TOKEN can hold the key instead, and EA_SAMPLE_RECORD_OUT names another file to write.
///   3. Stop the demo hub (Ctrl-C) and delete its folder, then run `swift test`: SampleHubTests checks the new
///      recording on every day of the week.
///
/// It asks every read in SampleScreens through the real HubClient, so the keys are the app's own, as the screens ask
/// them on each day of the week (DayShiftTransport). Then it takes out what belongs to the recording machine rather
/// than to the sample (SampleRecordingCleaner) and writes the file only when every read was answered and nothing of
/// the machine is left.
final class SampleRecorderTests: XCTestCase {
    func testRecordSampleHub() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let address = env["EA_SAMPLE_RECORD_URL"], !address.isEmpty else {
            throw XCTSkip("Set EA_SAMPLE_RECORD_URL and EA_SAMPLE_RECORD_TOKEN_FILE to record SampleHub.json from a demo hub.")
        }
        let token = try Self.token(env)
        let base = try XCTUnwrap(URL(string: address).flatMap { $0.host == nil ? nil : $0 }, "EA_SAMPLE_RECORD_URL is not an address")
        // Only Alex's made-up month goes into the app: a hub of anyone real is refused before anything is read.
        let owner = try await HubClient(transport: HTTPTransport(baseURL: base, token: token)).profile()
        guard owner.name == "Alex" else {
            XCTFail("This hub belongs to someone other than the sample's Alex: record only from a demo hub (hub/scripts/demo-hub.ts).")
            return
        }
        let recorder = RecordingTransport(inner: HTTPTransport(baseURL: base, token: token), file: nil)
        let world = try await SampleScreens.World.load(HubClient(transport: recorder))
        XCTAssertFalse(world.entities.isEmpty, "the demo hub synced nothing")

        let recordedDay = try XCTUnwrap(SampleTransport.dayDate(recorder.recording.day))
        var failed: [String] = []
        for i in 0..<7 {
            let other = try XCTUnwrap(Calendar.current.date(byAdding: .day, value: i, to: recordedDay))
            let client = HubClient(transport: DayShiftTransport(inner: recorder, days: -i, around: LocalPlanner.dateString(other)))
            for read in SampleScreens.reads(world, today: other) {
                do { try await read.call(client) } catch { failed.append("\(read.screen): \(error.localizedDescription)") }
            }
        }
        XCTAssertEqual(failed, [], "the demo hub did not answer these")

        var rec = recorder.recording
        // What a demo hub cannot answer, carried over from the recording the app ships (SampleScreens, Settings).
        if let data = try? Data(contentsOf: SampleScreens.bundledRecording), let shipped = try? JSONDecoder().decode(SampleTransport.Recording.self, from: data) {
            SampleRecordingCleaner.keepHandWritten(&rec, from: shipped)
        }
        let renamed = SampleRecordingCleaner.clean(&rec)
        let left = SampleRecordingCleaner.leftovers(rec, words: renamed.filter { $0.key != $0.value }.map(\.key) + [token])
        XCTAssertEqual(left, [], "the recording still holds these details of the recording machine")
        guard failed.isEmpty, left.isEmpty else { return }

        let out = env["EA_SAMPLE_RECORD_OUT"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) } ?? SampleScreens.bundledRecording
        let enc = JSONEncoder()
        // One answer per line, in key order: a new recording reads as a diff of what changed.
        enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let data = try enc.encode(rec)
        try data.write(to: out, options: .atomic)
        print("[sample] \(rec.entries.count) answers recorded on \(rec.day), \(data.count) bytes, written to \(out.path)")
    }

    private struct NoKey: Error, CustomStringConvertible {
        var description: String { "EA_SAMPLE_RECORD_URL is set, but neither EA_SAMPLE_RECORD_TOKEN nor EA_SAMPLE_RECORD_TOKEN_FILE gives the demo hub's key" }
    }

    /// The demo hub's key, never printed.
    private static func token(_ env: [String: String]) throws -> String {
        if let t = env["EA_SAMPLE_RECORD_TOKEN"]?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { return t }
        if let f = env["EA_SAMPLE_RECORD_TOKEN_FILE"], !f.isEmpty {
            let t = try String(contentsOfFile: f, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { return t }
        }
        throw NoKey()
    }
}

/// What a demo hub tells about the machine it runs on, rather than about Alex's month, taken out of a recording before
/// it ships in a public app: the machine's name, the hub's folders, its git working copy and its feed keys.
enum SampleRecordingCleaner {
    /// The name the recording gives the hub's own machine (the sample journal's "server").
    static let machine = "server"

    /// Cleans `rec` in place; answers the machine names it replaced, each with its new name.
    @discardableResult
    static func clean(_ rec: inout SampleTransport.Recording) -> [String: String] {
        var renamed: [String: String] = [:]
        // The machines the hub runs commands on: the hub's own one is named for the machine it was recorded on.
        edit(&rec, "GET ai/hosts") { o in
            guard var hosts = o["hosts"] as? [[String: Any]] else { return }
            for i in hosts.indices where hosts[i]["local"] as? Bool == true {
                for k in ["name", "target"] { if let n = hosts[i][k] as? String { renamed[n] = machine } }
                for a in hosts[i]["aliases"] as? [String] ?? [] { renamed[a] = machine }
                hosts[i]["name"] = machine
                hosts[i]["target"] = machine
                hosts[i]["aliases"] = [machine]
            }
            o["hosts"] = hosts
        }
        // Add machine (GET machines) lists the machines the demo hub may reach, named for the recording machine, and the
        // names in that machine's SSH config: only the hub's own one stays, renamed, beside two sample names to add.
        edit(&rec, "GET machines") { o in
            let local = (o["machines"] as? [[String: Any]] ?? []).filter { $0["local"] as? Bool == true }.map { m -> [String: Any] in
                var m = m
                for k in ["name", "ssh"] { if let n = m[k] as? String { renamed[n] = machine; m[k] = machine } }
                m["aliases"] = [machine]
                return m
            }
            o["machines"] = local
            o["ssh_config"] = ["nas01", "desk-pc"]
        }
        // The Tech Overview's cards (GET ops `things`) name the hub's own machine too.
        edit(&rec, "GET ops") { o in
            guard var things = o["things"] as? [[String: Any]] else { return }
            for i in things.indices {
                for k in ["name", "label"] { if let n = things[i][k] as? String, renamed[n] != nil { things[i][k] = machine } }
            }
            o["things"] = things
        }
        edit(&rec, "GET connections") { o in
            guard var pm = o["password_manager"] as? [String: Any] else { return }
            if let h = pm["host"] as? String, let n = renamed[h] { pm["host"] = n }
            o["password_manager"] = pm
        }
        // The working copy the demo hub runs from (its folder, edits not yet committed) is not the sample hub's.
        edit(&rec, "GET hub-update") { o in
            o["reason"] = NSNull()
            o["local_changes"] = false
            o["can_update"] = false
            o["last_run"] = NSNull()
            o["running"] = false
        }
        // Add machine reads only whether a password manager is linked; the rest is the demo hub's model setup.
        edit(&rec, "GET setup") { o in o = ["password_manager": o["password_manager"] ?? false] }
        // The Quiz reads only the creative counts; the rest is the hub's folders, uptime and model setup.
        edit(&rec, "GET status") { o in o = ["creative": o["creative"] ?? NSNull()] }
        // Keys that open the demo hub's calendar and sensor feeds (in the door's path too); screens show them in
        // example links.
        edit(&rec, "GET feeds") { o in
            for door in ["calendar", "sensors"] {
                guard var d = o[door] as? [String: Any] else { continue }
                let sample = "sample-\(door)-key"
                if let old = d["key"] as? String, !old.isEmpty, let path = d["path"] as? String {
                    d["path"] = path.replacingOccurrences(of: old, with: sample)
                }
                d["key"] = sample
                o[door] = d
            }
        }
        return renamed
    }

    /// Anything of a recording machine left in a recording: absolute folders, tailnet names and addresses, home network
    /// addresses, mail addresses, and `words` (the machine's names, the key it was recorded with).
    static func leftovers(_ rec: SampleTransport.Recording, words: [String] = []) -> [String] {
        var patterns = [
            #"/Users/"#, #"/home/"#, #"/private/"#, #"/var/folders/"#, #"[A-Za-z0-9-]+\.ts\.net"#,
            #"\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b"#, #"\b192\.168\.[0-9]{1,3}\.[0-9]{1,3}\b"#,
            #"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"#,
        ]
        patterns += words.filter { $0.count >= 3 }.map { #"(?i)\b"# + NSRegularExpression.escapedPattern(for: $0) + #"\b"# }
        var found: [String] = []
        for (key, e) in rec.entries.sorted(by: { $0.key < $1.key }) {
            for p in patterns {
                guard let re = try? NSRegularExpression(pattern: p) else { continue }
                let ns = e.body as NSString
                let hits = re.matches(in: e.body, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range) }
                if let first = hits.first(where: { !madeUp($0) }) { found.append("\(key): \(first)") }
            }
        }
        return found
    }

    /// An address nobody has: one at the domains kept for examples (example.com, .org and .net, RFC 2606), as Settings,
    /// Accounts' made-up accounts are, or the hub's own placeholder in its iCloud guide (hub/src/guides.ts).
    static func madeUp(_ s: String) -> Bool {
        s == "you@icloud.com" || s.range(of: #"^[A-Za-z0-9._%+-]+@example\.(com|org|net)$"#, options: .regularExpression) != nil
    }

    /// Answers a demo hub cannot give, written into the recording the app ships by hand: it links no mail or calendar
    /// account (it would sign in with a made-up password), so Settings, Accounts' made-up addresses (in `connections`),
    /// the iCloud account's calendars and From this iPhone's lists and calendars come from there, their dates moved to
    /// the new recording's day.
    static let handWritten = ["GET calendars", "GET prefs/sources"]
    static let handWrittenConnections = ["icloud", "imap", "internet", "health"]

    static func keepHandWritten(_ rec: inout SampleTransport.Recording, from old: SampleTransport.Recording) {
        guard let from = SampleTransport.dayDate(old.day), let to = SampleTransport.dayDate(rec.day) else { return }
        let days = Calendar.current.dateComponents([.day], from: from, to: to).day ?? 0
        let moved = { (body: String) in SampleTransport.shift(body, days: days, around: old.day) }
        for k in handWritten { if let e = old.entries[k] { rec.entries[k] = .init(status: e.status, body: moved(e.body)) } }
        guard let e = old.entries["GET connections"], let was = (try? JSONSerialization.jsonObject(with: Data(moved(e.body).utf8))) as? [String: Any] else { return }
        edit(&rec, "GET connections") { o in for k in handWrittenConnections { o[k] = was[k] } }
    }

    /// Changes one recorded JSON object, keeping it compact with its keys in order.
    private static func edit(_ rec: inout SampleTransport.Recording, _ key: String, _ change: (inout [String: Any]) -> Void) {
        guard let e = rec.entries[key], var o = (try? JSONSerialization.jsonObject(with: Data(e.body.utf8))) as? [String: Any] else { return }
        change(&o)
        guard let d = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys, .withoutEscapingSlashes]) else { return }
        rec.entries[key] = .init(status: e.status, body: String(decoding: d, as: UTF8.self))
    }
}
