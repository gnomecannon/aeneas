import SwiftUI
import EACore

/// Everyday calculators. The math is the hub's (ported in EACore `Calc`), worked here so results show as you type, offline too.
struct CalcView: View {
    enum Tool: String, CaseIterable, Identifiable {
        case split, payoff, unit, pay, subs
        var id: String { rawValue }
        var title: String {
            switch self {
            case .split: return "Split"
            case .payoff: return "Payoff"
            case .unit: return "Unit"
            case .pay: return "Pay"
            case .subs: return "Subs"
            }
        }
    }

    @AppStorage("admin.calc.tool") private var tool: Tool = .split

    var body: some View {
        VStack(spacing: 0) {
            Picker("Calculator", selection: $tool) {
                ForEach(Tool.allCases) { t in Text(t.title).tag(t) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal)
            .padding(.vertical, 8)
            switch tool {
            case .split: AdminSplitCalc()
            case .payoff: AdminPayoffCalc()
            case .unit: AdminUnitCalc()
            case .pay: AdminTakeHomeCalc()
            case .subs: AdminSubscriptionsCalc()
            }
        }
        .navigationTitle("Calc")
    }
}

/// A labelled number field with the label on the left and the value on the right.
private struct NumberRow: View {
    var label: String
    @Binding var text: String
    var placeholder = "0"
    var prefix: String? = nil
    var suffix: String? = nil

    var body: some View {
        HStack {
            Text(label)
            Spacer()
            if let p = prefix { Text(p).foregroundStyle(.secondary) }
            TextField(placeholder, text: $text)
                .numericKeyboard()
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 140)
                .accessibilityLabel(label)
            if let s = suffix { Text(s).foregroundStyle(.secondary) }
        }
    }
}

/// The big answer line plus a smaller explanation underneath.
private struct Answer: View {
    var big: String
    var small: String? = nil
    var color: Color = .primary

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(big).font(.largeTitle.weight(.bold).monospacedDigit()).foregroundStyle(color).textSelection(.enabled)
            if let s = small { Text(s).font(.subheadline.monospacedDigit()).foregroundStyle(.secondary).textSelection(.enabled) }
        }
        .padding(.vertical, 4)
    }
}

private let money = Calc.money

// MARK: Split

private struct AdminSplitCalc: View {
    @State private var subtotal = ""
    @EnvironmentObject var engine: SyncEngine
    /// Blank until known: your state's rate when this device may use your location, else what you typed last (kept on
    /// this device). A typed rate always wins over the one from your location.
    @AppStorage("ea.calc.taxPct") private var tax = ""
    @AppStorage("ea.calc.taxFrom") private var taxFrom = ""
    @State private var taxNote = ""
    @State private var locating = false
    @State private var tip: Double = 20
    @State private var people = 2
    @State private var uneven = false
    @State private var shares = ""

    private var result: Result<Calc.SplitResult, Error>? {
        guard let s = Calc.parse(subtotal) else { return nil }
        let sh: [Double]? = uneven && !shares.trimmingCharacters(in: .whitespaces).isEmpty
            ? shares.split(separator: ",").map { Double($0.trimmingCharacters(in: .whitespaces)) ?? .nan } : nil
        return Result { try Calc.split(subtotal: s, taxPct: Calc.parse(tax) ?? 0, tipPct: tip, people: Double(people), shares: sh) }
    }

    var body: some View {
        Form {
            SwiftUI.Section {
                switch result {
                case .none:
                    Text("Type the subtotal from the receipt, before tax and tip.").foregroundStyle(.secondary)
                case .failure(let e):
                    AdminMessage(tone: .error, text: e.localizedDescription)
                case .success(let r):
                    let even = r.per_person.allSatisfy { $0 == r.per_person.first }
                    Answer(big: even ? "\(money(r.per_person.first ?? 0)) each" : "\(money(r.total)) total",
                           small: "\(money(r.subtotal)) + tax \(money(r.tax)) + tip \(money(r.tip)) = \(money(r.total))")
                    if r.remainder_cents > 0 {
                        Text("Person 1 covers the extra \(r.remainder_cents) \(r.remainder_cents == 1 ? "cent" : "cents").").font(.callout).foregroundStyle(.secondary)
                    }
                    if !even {
                        ForEach(Array(r.per_person.enumerated()), id: \.offset) { i, x in
                            LabeledContent("Person \(i + 1)", value: money(x)).monospacedDigit()
                        }
                    }
                }
            }
            SwiftUI.Section {
                NumberRow(label: "Subtotal", text: $subtotal, prefix: "$")
                NumberRow(label: "Tax", text: Binding(get: { tax }, set: { tax = $0; taxFrom = "typed"; taxNote = "" }), suffix: "%")
                Button(locating ? "Finding your state" : "Use my location") { Task { await fromLocation(ask: true) } }
                    .disabled(locating)
                if !taxNote.isEmpty { Text(taxNote).font(.footnote).foregroundStyle(.secondary) }
                Picker("Tip", selection: $tip) {
                    ForEach([15.0, 18, 20, 22], id: \.self) { t in Text("\(Int(t))%").tag(t) }
                }
                .pickerStyle(.segmented)
                Stepper("People: \(people)", value: $people, in: 1...50)
                Toggle("Uneven shares", isOn: $uneven)
                if uneven {
                    TextField("What each ordered, like 30, 20, 10", text: $shares).numericKeyboard()
                }
            } footer: {
                Text(uneven ? "One number per person, in order. Tax and tip are shared in the same proportion." : "Tax and tip are both worked on the subtotal. The tax rate you type is kept on this device.")
            }
        }
        .formStyle(.grouped)
        // Without asking: only when location is already allowed and no rate was typed on this device.
        .task { if !(taxFrom == "typed" && !tax.isEmpty), ApproximateLocation.shared.allowed { await fromLocation(ask: false) } }
    }

    /// Your state's meals tax from an approximate position, looked up by your own hub.
    private func fromLocation(ask: Bool) async {
        locating = true
        defer { locating = false }
        let place = ApproximateLocation.shared
        if place.undecided, ask { _ = await place.requestPermission() }
        guard place.allowed else {
            if ask { taxNote = "Location is off for Aeneas. Type the rate instead, and it is kept on this device." }
            return
        }
        guard let here = await place.current() else {
            if ask { taxNote = "This device could not tell where it is. Type the rate instead." }
            return
        }
        guard let c = engine.client else { if ask { taxNote = "Not connected to your hub. Type the rate instead." }; return }
        do {
            let m = try await withDeadline(20) { try await c.mealsTax(latitude: here.coordinate.latitude, longitude: here.coordinate.longitude) }
            tax = m.pct.formatted(.number.precision(.fractionLength(0...3)))
            taxFrom = "location"
            taxNote = m.note
        } catch {
            guard ask else { return }
            if case .http(status: 404, _)? = error as? HubError { taxNote = "That location is not in a US state. Type the rate instead." }
            else { taxNote = "Your hub could not look up your state. Type the rate instead." }
        }
    }
}

// MARK: Payoff

private struct AdminPayoffCalc: View {
    @State private var balance = ""
    @State private var apr = ""
    @State private var byMonths = false
    @State private var value = ""
    @State private var showTable = false

    private var result: Result<Calc.PayoffResult, Error>? {
        guard let b = Calc.parse(balance), let a = Calc.parse(apr), let v = Calc.parse(value), v > 0 else { return nil }
        if byMonths {
            // Int(v) on 19 or more digits crashed; wholeMonths checks the range before converting.
            return Result { try Calc.payoff(balance: b, aprPct: a, months: try Calc.wholeMonths(v)) }
        }
        return Result { try Calc.payoff(balance: b, aprPct: a, payment: v) }
    }

    var body: some View {
        Form {
            SwiftUI.Section {
                switch result {
                case .none:
                    Text(byMonths ? "Type the balance, the APR and how many months you want it done in." : "Type the balance, the APR and what you pay each month.").foregroundStyle(.secondary)
                case .failure(let e):
                    AdminMessage(tone: .error, text: e.localizedDescription)
                case .success(let r):
                    if r.never {
                        Label("Never. The payment does not cover the interest.", systemImage: "exclamationmark.triangle.fill")
                            .font(.title3.weight(.semibold)).foregroundStyle(.orange)
                        if let first = r.preview.first { Text("Interest in month 1 is \(money(first.interest)).").foregroundStyle(.secondary) }
                    } else {
                        Answer(big: byMonths ? "\(money(r.payment)) a month" : "\(r.months ?? 0) months",
                               small: r.total_interest.map { "\(money($0)) total interest" })
                    }
                    if !r.preview.isEmpty {
                        DisclosureGroup("First \(r.preview.count) months", isExpanded: $showTable) { table(r.preview) }
                    }
                }
            }
            SwiftUI.Section {
                NumberRow(label: "Balance", text: $balance, prefix: "$")
                NumberRow(label: "APR", text: $apr, suffix: "%")
                Picker("Solve for", selection: $byMonths) {
                    Text("I pay this much").tag(false)
                    Text("Done in months").tag(true)
                }
                .pickerStyle(.segmented)
                if byMonths { NumberRow(label: "Months", text: $value, placeholder: "12") }
                else { NumberRow(label: "Payment", text: $value, prefix: "$") }
            } footer: {
                Text("Interest is charged monthly at APR divided by 12 and rounds to the cent.")
            }
        }
        .formStyle(.grouped)
        .onChange(of: byMonths) { _, _ in value = "" }
    }

    private func table(_ rows: [Calc.PayoffRow]) -> some View {
        Grid(alignment: .trailing, horizontalSpacing: 12, verticalSpacing: 6) {
            GridRow {
                Text("Month"); Text("Paid"); Text("Interest"); Text("Left")
            }
            .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(rows, id: \.month) { r in
                GridRow {
                    Text("\(r.month)"); Text(money(r.payment)); Text(money(r.interest)); Text(money(r.balance))
                }
                .font(.caption.monospacedDigit())
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: Unit price

private struct AdminUnitCalc: View {
    struct Row: Identifiable { var id = UUID(); var name = ""; var price = ""; var qty = ""; var unit = "oz" }
    @State private var rows: [Row] = [Row(), Row()]

    private var items: [Calc.UnitItem] {
        rows.enumerated().compactMap { i, r in
            guard let p = Calc.parse(r.price), let q = Calc.parse(r.qty), q > 0 else { return nil }
            let n = r.name.trimmingCharacters(in: .whitespaces)
            return Calc.UnitItem(name: n.isEmpty ? "Item \(i + 1)" : n, price: p, qty: q, unit: r.unit.trimmingCharacters(in: .whitespaces))
        }
    }

    var body: some View {
        Form {
            SwiftUI.Section {
                let its = items
                if its.isEmpty {
                    Text("Type a price and an amount for 2 or more items to see which is cheaper.").foregroundStyle(.secondary)
                } else {
                    switch Result(catching: { try Calc.unitPrices(its) }) {
                    case .failure(let e):
                        AdminMessage(tone: .error, text: e.localizedDescription)
                    case .success(let out):
                        ForEach(Array(out.enumerated()), id: \.offset) { i, x in
                            HStack {
                                if i == 0 && out.count > 1 { AdminPill(text: "Cheapest", symbol: "star.fill", color: .green) }
                                Text(x.name)
                                Spacer()
                                Text("$\(String(format: x.per_unit < 1 ? "%.4f" : "%.2f", x.per_unit)) / \(x.base)").monospacedDigit()
                            }
                            .fontWeight(i == 0 ? .semibold : .regular)
                        }
                    }
                }
            }
            ForEach($rows) { $r in
                SwiftUI.Section {
                    TextField("Name (optional)", text: $r.name)
                    NumberRow(label: "Price", text: $r.price, prefix: "$")
                    NumberRow(label: "Amount", text: $r.qty)
                    HStack {
                        Text("Unit")
                        Spacer()
                        TextField("oz", text: $r.unit).multilineTextAlignment(.trailing).frame(maxWidth: 100).autocorrectionDisabled()
                            #if os(iOS)
                            .textInputAutocapitalization(.never)
                            #endif
                        Menu {
                            ForEach(["oz", "lb", "g", "kg", "fl oz", "ml", "l", "gal", "each"], id: \.self) { u in Button(u) { r.unit = u } }
                        } label: { Image(systemName: "chevron.up.chevron.down") }
                        .menuIndicator(.hidden)
                        .fixedSize()
                        .accessibilityLabel("Choose unit")
                    }
                } header: {
                    Text("Item \((rows.firstIndex { $0.id == r.id } ?? 0) + 1)")
                }
            }
            SwiftUI.Section {
                Button { rows.append(Row()) } label: { Label("Add item", systemImage: "plus") }
                if rows.count > 2 {
                    Button(role: .destructive) { rows.removeLast() } label: { Label("Remove last item", systemImage: "minus") }
                }
            } footer: {
                Text("Weights compare per oz, volumes per fl oz, counts per each. lb, g, kg, ml, l and gal convert on their own.")
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: Take-home pay

private struct AdminTakeHomeCalc: View {
    @State private var salary = ""
    @State private var bonus = ""
    @State private var frequency: Calc.PayFrequency = .biweekly
    @State private var filing: Calc.Filing = .single
    @State private var k401IsPercent = true
    @State private var k401 = ""
    @State private var health = ""
    /// Remembered on this device only.
    @AppStorage("admin.calc.takehome.statePct") private var statePct = ""
    @State private var showYear = false

    private var result: Result<Calc.TakeHomeResult, Error>? {
        guard let s = Calc.parse(salary), s > 0 else { return nil }
        let k: Calc.K401 = Calc.parse(k401).map { k401IsPercent ? .percent($0) : .amount($0) } ?? .none
        return Result {
            try Calc.takeHome(salary: s, bonus: Calc.parse(bonus) ?? 0, frequency: frequency, filing: filing,
                              k401: k, health: Calc.parse(health) ?? 0, statePct: Calc.parse(statePct) ?? 0)
        }
    }

    var body: some View {
        Form {
            SwiftUI.Section {
                switch result {
                case .none:
                    Text("Type the yearly salary to see each paycheck after tax and deductions.").foregroundStyle(.secondary)
                case .failure(let e):
                    AdminMessage(tone: .error, text: e.localizedDescription)
                case .success(let r):
                    Answer(big: "\(money(r.per_paycheck.net)) a paycheck", small: "\(money(r.per_year.net)) a year, \(r.periods) paychecks")
                    Picker("Show", selection: $showYear) {
                        Text("Paycheck").tag(false)
                        Text("Year").tag(true)
                    }
                    .pickerStyle(.segmented)
                    lines(showYear ? r.per_year : r.per_paycheck)
                }
            }
            if case .success(let r) = result, let b = r.bonus {
                SwiftUI.Section {
                    LabeledContent("Bonus", value: money(b.gross)).monospacedDigit()
                    LabeledContent("Federal at \(Int(b.federal_rate))%", value: "-\(money(b.federal))").monospacedDigit()
                    LabeledContent("Social Security", value: "-\(money(b.social_security))").monospacedDigit()
                    LabeledContent("Medicare", value: "-\(money(b.medicare))").monospacedDigit()
                    if b.state > 0 { LabeledContent("State", value: "-\(money(b.state))").monospacedDigit() }
                    LabeledContent("Bonus after tax", value: money(b.net)).monospacedDigit().fontWeight(.semibold)
                } header: {
                    Text("Bonus, paid separately")
                } footer: {
                    Text("Salary and bonus together: \(money(r.year_net_with_bonus)) a year. Bonuses are withheld at the flat 22% federal supplemental rate.")
                }
            }
            if case .success(let r) = result, !r.notes.isEmpty {
                SwiftUI.Section {
                    ForEach(r.notes, id: \.self) { n in Text(StyleGuard.dashes(n)).font(.callout).foregroundStyle(.secondary) }
                }
            }
            SwiftUI.Section {
                NumberRow(label: "Salary a year", text: $salary, prefix: "$")
                NumberRow(label: "Bonus a year", text: $bonus, placeholder: "none", prefix: "$")
                Picker("Paid", selection: $frequency) {
                    ForEach(Calc.PayFrequency.allCases) { f in Text(f.title).tag(f) }
                }
                Picker("Filing", selection: $filing) {
                    ForEach(Calc.Filing.allCases) { f in Text(f.title).tag(f) }
                }
            }
            SwiftUI.Section {
                Picker("401k as", selection: $k401IsPercent) {
                    Text("Percent").tag(true)
                    Text("Amount").tag(false)
                }
                .pickerStyle(.segmented)
                if k401IsPercent { NumberRow(label: "401k", text: $k401, suffix: "%") }
                else { NumberRow(label: "401k each paycheck", text: $k401, prefix: "$") }
                NumberRow(label: "Health and HSA each paycheck", text: $health, prefix: "$")
                NumberRow(label: "State income tax", text: $statePct, suffix: "%")
            } header: {
                Text("Before tax")
            } footer: {
                Text("\(String(Calc.taxYear)) federal brackets and standard deduction, spread evenly over the year. The 401k lowers income tax but not Social Security or Medicare; health and HSA lower both. State tax is a flat percent and is remembered on this device. An estimate of withholding, not the return.")
            }
        }
        .formStyle(.grouped)
        .onChange(of: k401IsPercent) { _, _ in k401 = "" }
    }

    @ViewBuilder private func lines(_ l: Calc.PayLines) -> some View {
        LabeledContent("Gross", value: money(l.gross)).monospacedDigit()
        LabeledContent("Federal income tax", value: "-\(money(l.federal))").monospacedDigit()
        LabeledContent("Social Security", value: "-\(money(l.social_security))").monospacedDigit()
        LabeledContent(l.additional_medicare > 0 ? "Medicare, with 0.9% extra" : "Medicare", value: "-\(money(l.medicare))").monospacedDigit()
        if l.state > 0 { LabeledContent("State", value: "-\(money(l.state))").monospacedDigit() }
        if l.k401 > 0 { LabeledContent("401k", value: "-\(money(l.k401))").monospacedDigit() }
        if l.health > 0 { LabeledContent("Health and HSA", value: "-\(money(l.health))").monospacedDigit() }
        LabeledContent("Take home", value: money(l.net)).monospacedDigit().fontWeight(.semibold)
    }
}

// MARK: Subscriptions

private struct AdminSubscriptionsCalc: View {
    @EnvironmentObject var engine: SyncEngine

    var body: some View {
        let r = Calc.subscriptions(engine.list(.watch))
        Form {
            SwiftUI.Section {
                Answer(big: "\(money(r.monthly_total)) a month", small: "\(money(r.yearly_total)) a year, \(r.items.count) subscription\(r.items.count == 1 ? "" : "s")")
            }
            SwiftUI.Section {
                if r.items.isEmpty {
                    Text("No subscriptions with a cost and a repeat. Add them in Renewals with the category Subscription.").foregroundStyle(.secondary)
                }
                ForEach(r.items) { s in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text(StyleGuard.dashes(s.title))
                            Spacer()
                            Text("\(money(s.monthly)) a month").monospacedDigit()
                        }
                        Text("\(money(s.cost)) \(repeatLabel(s.repeat))").font(.caption).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            } header: {
                Text("Most expensive first")
            }
            if !r.skipped.isEmpty {
                SwiftUI.Section {
                    ForEach(r.skipped) { s in
                        LabeledContent(StyleGuard.dashes(s.title), value: s.reason)
                    }
                } header: {
                    Text("Left out, \(r.skipped.count)")
                } footer: {
                    Text("Give these a cost and a repeat in Renewals to count them.")
                }
            }
            SwiftUI.Section {
                NavigationLink(value: Section.renewals) { Label("Edit in Renewals", systemImage: Section.renewals.symbol) }
            }
        }
        .formStyle(.grouped)
    }

    /// "every 1 years" reads as "a year"; anything else stays as written.
    private func repeatLabel(_ r: String) -> String {
        if let m = r.firstMatch(of: #/^every 1 (\w+)s$/#) { return "a \(m.1)" }
        return r
    }
}
