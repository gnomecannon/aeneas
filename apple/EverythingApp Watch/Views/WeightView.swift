import SwiftUI
import EACore

/// Log weight with the Digital Crown.
struct WeightView: View {
    @EnvironmentObject var engine: SyncEngine
    @State private var value: Double = 240
    @State private var saved: String?

    var body: some View {
        VStack(spacing: 10) {
            Text(String(format: "%.1f", value))
                .font(.system(size: 40, weight: .bold, design: .rounded))
                .focusable()
                .digitalCrownRotation($value, from: 80, through: 500, by: 0.2, sensitivity: .medium, isContinuous: false, isHapticFeedbackEnabled: true)
            Text("lb").font(.caption).foregroundStyle(.secondary)
            Button {
                let v = (value * 10).rounded() / 10
                Task { _ = await engine.log(type: .weight, value: .number(v), unit: "lb", source: .watch); saved = "Logged \(String(format: "%.1f", v))" }
            } label: { Label("Log", systemImage: "scalemass").frame(maxWidth: .infinity, minHeight: 44) }
            .tint(.green)
            if let s = saved { Text(s).font(.caption2).foregroundStyle(.secondary) }
        }
        .navigationTitle("Weight")
        .onAppear {
            // The crown logs lb, so it starts from the last weight in lb: a kg reading used to be taken as lb.
            if let last = engine.logs(type: .weight).last, let lb = LogUnits.weightLb(last) { value = min(500, max(80, (lb * 10).rounded() / 10)) }
        }
    }
}
