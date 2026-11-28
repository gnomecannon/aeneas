import Foundation
import AVFoundation
import Speech
import EventKit
import Contacts
import UserNotifications
import EACore
#if os(iOS)
import Photos
#else
import AppKit
#endif

/// The permission screen's offer: what the modules that are on need and is not allowed on this device yet, with where
/// each stood when the screen opened (a turned down one shows the way to the system's settings).
struct PermissionOffer: Identifiable, Equatable {
    let id = UUID()
    var needs: [PermissionNeed]
    var states: [DevicePermission: PermissionState] = [:]
}

/// Reads and asks for device permissions. Nothing calls `request` at launch (release rule 2): the permission screen
/// asks after Continue, and a feature's own screen asks when the person taps something that needs it.
@MainActor
enum DevicePermissions {
    /// Whether this device asks for `p` at all. iOS 26 and macOS 26 dictate with SpeechAnalyzer, which needs only the
    /// microphone: speech recognition is never asked there.
    static func asksFor(_ p: DevicePermission) -> Bool {
        if p == .speech, #available(iOS 26, macOS 26, *) { return false }
        return true
    }

    /// Where `p` stands on this device, read without asking. One this device never asks for (speech recognition on
    /// iOS 26 and macOS 26, Health and Photos on the Mac) counts as allowed: nothing waits for it.
    static func state(_ p: DevicePermission) async -> PermissionState {
        guard asksFor(p) else { return .allowed }
        switch p {
        case .notifications:
            switch await ReminderScheduler.shared.authorizationStatus() {
            case .notDetermined: return .notAsked
            case .denied: return .denied
            default: return .allowed
            }
        case .microphone:
            #if os(iOS)
            switch AVAudioApplication.shared.recordPermission {
            case .undetermined: return .notAsked
            case .granted: return .allowed
            default: return .denied
            }
            #else
            switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .notDetermined: return .notAsked
            case .authorized: return .allowed
            default: return .denied
            }
            #endif
        case .speech:
            switch SFSpeechRecognizer.authorizationStatus() {
            case .notDetermined: return .notAsked
            case .authorized: return .allowed
            default: return .denied
            }
        case .reminders, .calendar:
            // Write only is not enough: both read too.
            switch EKEventStore.authorizationStatus(for: p == .reminders ? .reminder : .event) {
            case .notDetermined: return .notAsked
            case .fullAccess: return .allowed
            default: return .denied
            }
        case .contacts:
            switch CNContactStore.authorizationStatus(for: .contacts) {
            case .notDetermined: return .notAsked
            case .denied, .restricted: return .denied
            default: return .allowed
            }
        case .health:
            #if os(iOS)
            guard HealthImporter.available else { return .allowed }
            if await HealthImporter.shared.needsAsking() { return .notAsked }
            // Health never says what was answered: syncing counts as allowed, else it was asked and is waiting.
            return SharedConfig.shared.healthImportEnabled ? .allowed : .askedBefore
            #else
            return .allowed
            #endif
        case .photos:
            #if os(iOS)
            switch PHPhotoLibrary.authorizationStatus(for: .addOnly) {
            case .notDetermined: return .notAsked
            case .denied, .restricted: return .denied
            default: return .allowed
            }
            #else
            return .allowed
            #endif
        case .location:
            let place = ApproximateLocation.shared
            return place.undecided ? .notAsked : place.allowed ? .allowed : .denied
        case .music:
            switch MusicTasteReader.currentAccess {
            case .notAsked: return .notAsked
            case .allowed: return .allowed
            default: return .denied
            }
        }
    }

    /// Each permission's state at once, for a screen that lists several.
    static func states(_ list: [DevicePermission]) async -> [DevicePermission: PermissionState] {
        var out: [DevicePermission: PermissionState] = [:]
        for p in list { out[p] = await state(p) }
        return out
    }

    /// A module switched on here, or Continue on the permission screen, with every permission it needs allowed: its
    /// own switch on this device goes on too, so the yes is not left idle behind a second switch. Contacts are
    /// mirrored on one device at a time: this one takes them only when no other device does.
    static func turnOnHere(_ modules: [ModuleInfo], engine: SyncEngine) async {
        guard !engine.config.sampleMode else { return }
        for m in modules {
            switch AppModule(rawValue: m.id) {
            case .contacts?:
                let other = engine.sources?.contacts.device.map { $0 != engine.config.deviceId } ?? false
                guard !other, !ContactsSync.shared.enabled else { continue }
                UserDefaults.standard.set(true, forKey: ContactsSync.enabledKey)
                await ContactsSync.shared.runNow(reason: "turned on")
            case .images?:
                #if os(iOS)
                guard !PhotosOptions.saveGenerated else { continue }
                // Only images made from now on; the gallery keeps the rest.
                UserDefaults.standard.set(ISO.now(), forKey: PhotosOptions.saveSinceKey)
                UserDefaults.standard.set(true, forKey: PhotosOptions.saveKey)
                #endif
            case .health?:
                #if os(iOS)
                guard HealthImporter.available, !engine.config.healthImportEnabled else { continue }
                _ = await HealthImporter.shared.requestFromPermissionScreen(engine: engine)
                AppleHealthSwitch.shared.refresh()
                #endif
            case .appleCalendar?:
                guard !engine.config.appleCalendarHere else { continue }
                engine.config.appleCalendarHere = true
                await CalendarImporter.shared.runIfReady(reason: "turned on")
                await EventMirrorSync.shared.runIfReady(reason: "turned on")
            case .appleReminders?:
                guard !RemindersSync.shared.enabled else { continue }
                await RemindersSync.shared.turnOn()
            default:
                break
            }
        }
    }

    /// The system's settings where `p` is changed: this app's page in iOS Settings, or the matching Privacy and
    /// Security pane on the Mac.
    static func openSettings(for p: DevicePermission) {
        #if os(macOS)
        if p == .notifications {
            if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") { NSWorkspace.shared.open(url) }
            return
        }
        #endif
        openPrivacySettings(macPane(p))
    }

    /// The Privacy and Security pane on the Mac for each permission.
    static func macPane(_ p: DevicePermission) -> String {
        switch p {
        case .notifications: return "Notifications"
        case .microphone: return "Privacy_Microphone"
        case .speech: return "Privacy_SpeechRecognition"
        case .reminders: return "Privacy_Reminders"
        case .calendar: return "Privacy_Calendars"
        case .contacts: return "Privacy_Contacts"
        case .health: return "Privacy"
        case .photos: return "Privacy_Photos"
        case .location: return "Privacy_LocationServices"
        case .music: return "Privacy_Media"
        }
    }

    /// True when the person was never asked on this device. Allowed or turned down is decided: not asked again here.
    static func undecided(_ p: DevicePermission) async -> Bool {
        switch p {
        case .notifications:
            return await ReminderScheduler.shared.authorizationStatus() == .notDetermined
        case .microphone:
            #if os(iOS)
            return AVAudioApplication.shared.recordPermission == .undetermined
            #else
            return AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined
            #endif
        case .speech:
            guard asksFor(.speech) else { return false }
            return SFSpeechRecognizer.authorizationStatus() == .notDetermined
        case .reminders:
            return EKEventStore.authorizationStatus(for: .reminder) == .notDetermined
        case .calendar:
            return EKEventStore.authorizationStatus(for: .event) == .notDetermined
        case .contacts:
            return CNContactStore.authorizationStatus(for: .contacts) == .notDetermined
        case .health:
            #if os(iOS)
            return await HealthImporter.shared.needsAsking()
            #else
            return false
            #endif
        case .photos:
            #if os(iOS)
            return PHPhotoLibrary.authorizationStatus(for: .addOnly) == .notDetermined
            #else
            return false
            #endif
        case .location:
            return ApproximateLocation.shared.undecided
        case .music:
            return MusicTasteReader.currentAccess == .notAsked
        }
    }

    /// Asks the system, then starts what the permission unlocks. True when allowed.
    @discardableResult
    static func request(_ p: DevicePermission, engine: SyncEngine) async -> Bool {
        switch p {
        case .notifications:
            let ok = await ReminderScheduler.shared.requestPermission()
            if ok { await engine.replanNotifications() }
            return ok
        case .microphone:
            return await requestMicrophone()
        case .speech:
            return await requestSpeech()
        case .reminders:
            await RemindersSync.shared.requestAccess()
            return RemindersSync.shared.access == .full
        case .calendar:
            await CalendarImporter.shared.requestAccess(facts: engine.facts)
            if CalendarImporter.shared.access == .full { await EventMirrorSync.shared.runIfReady(reason: "access granted") }
            return CalendarImporter.shared.access == .full
        case .contacts:
            return await ContactsSync.shared.requestAccess()
        case .health:
            #if os(iOS)
            return await HealthImporter.shared.requestFromPermissionScreen(engine: engine)
            #else
            return false
            #endif
        case .photos:
            #if os(iOS)
            return await PhotosOptions.requestAdd()
            #else
            return false
            #endif
        case .location:
            return await ApproximateLocation.shared.requestPermission()
        case .music:
            return await MusicTasteReader.shared.requestAccess(engine: engine)
        }
    }

    static func requestMicrophone() async -> Bool {
        #if os(iOS)
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        default: return await AVAudioApplication.requestRecordPermission()
        }
        #else
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
        #endif
    }

    static func requestSpeech() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .notDetermined: return await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) } }
        default: return false
        }
    }
}
