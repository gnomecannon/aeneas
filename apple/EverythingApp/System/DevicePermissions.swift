import Foundation
import AVFoundation
import Speech
import EventKit
import Contacts
import UserNotifications
import EACore
#if os(iOS)
import Photos
#endif

/// The permission screen's offer: what the modules that are on need and were never asked on this device.
struct PermissionOffer: Identifiable, Equatable {
    let id = UUID()
    var needs: [PermissionNeed]
}

/// Reads and asks for device permissions. Nothing calls `request` at launch (release rule 2): the permission screen
/// asks after Continue, and a feature's own screen asks when the person taps something that needs it.
@MainActor
enum DevicePermissions {
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
