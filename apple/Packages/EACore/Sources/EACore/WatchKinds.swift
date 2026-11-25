import Foundation

extension SyncEngine {
    /// The kinds the Watch keeps and asks the hub for (`kinds` on `/sync/changes`), what its screens, complications
    /// and alerts read: Now and Up next, the Today agenda, reminders and their alerts, Done, Snooze and Skip (task); the
    /// agenda's events (event); recent meds and activities, the last weight and the activity complication (log); Tech's
    /// glance on Now (monitor, incident). Ask and Hum run on the hub through the iPhone, and Capture hands its words to
    /// the iPhone: none of them reads items here. What the Watch makes of another kind (a capture saved offline, a pet
    /// event) stays until the hub has it, and goes at the next start. A Watch screen that starts reading another kind
    /// adds it here; the next start then reads everything again (`copyPlan`).
    public static let watchKinds: [Kind] = [.task, .event, .log, .monitor, .incident]
}
