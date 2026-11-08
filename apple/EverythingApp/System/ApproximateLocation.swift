import Foundation
import CoreLocation

/// One approximate position, for the meals tax in the bill splitter. It asks for reduced accuracy (a few kilometres),
/// never tracks, and stops after one answer. The position goes only to this device's own hub, rounded again there.
@MainActor
final class ApproximateLocation: NSObject, CLLocationManagerDelegate {
    static let shared = ApproximateLocation()

    private let manager = CLLocationManager()
    private var asking: [CheckedContinuation<Bool, Never>] = []
    private var locating: [CheckedContinuation<CLLocation?, Never>] = []

    override private init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyReduced
    }

    var status: CLAuthorizationStatus { manager.authorizationStatus }
    var allowed: Bool {
        #if os(iOS)
        return status == .authorizedWhenInUse || status == .authorizedAlways
        #else
        return status == .authorized || status == .authorizedAlways
        #endif
    }
    var undecided: Bool { status == .notDetermined }

    /// Asks the system once. True when allowed.
    func requestPermission() async -> Bool {
        guard undecided else { return allowed }
        return await withCheckedContinuation { c in
            asking.append(c)
            manager.requestWhenInUseAuthorization()
        }
    }

    /// The device's approximate position, or nil when location is off or the device cannot tell within 15 seconds.
    func current() async -> CLLocation? {
        guard allowed else { return nil }
        let deadline = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            self?.finishLocating(nil)
        }
        defer { deadline.cancel() }
        return await withCheckedContinuation { c in
            locating.append(c)
            manager.requestLocation()
        }
    }

    private func finishLocating(_ location: CLLocation?) {
        let waiting = locating
        locating = []
        for c in waiting { c.resume(returning: location) }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            guard !self.undecided else { return }
            let waiting = self.asking
            self.asking = []
            for c in waiting { c.resume(returning: self.allowed) }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        let last = locations.last
        Task { @MainActor in self.finishLocating(last) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.finishLocating(nil) }
    }
}
