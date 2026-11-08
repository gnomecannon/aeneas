import Foundation

/// Module 7 calculators, ported from web/src/lib/calc.ts (the same math the hub runs behind /calc/*).
/// Money is worked in integer cents held in Doubles, exactly as the JavaScript does, so results match to the cent.
public enum Calc {

    public struct InputError: Error, LocalizedError, Equatable, Sendable {
        public var message: String
        public init(message: String) { self.message = message }
        public var errorDescription: String? { message }
    }

    // MARK: JavaScript number helpers

    /// `Number(x.toFixed(6))`: trims float noise before rounding.
    static func fixed6(_ x: Double) -> Double {
        guard x.isFinite else { return x }
        return Double(String(format: "%.6f", x)) ?? x
    }

    /// `Math.round`: nearest integer, halves toward positive infinity.
    static func jsRound(_ x: Double) -> Double {
        guard x.isFinite else { return x }
        let f = x.rounded(.down)
        return x - f >= 0.5 ? f + 1 : f
    }

    /// Dollars to cents, half away from zero after trimming float noise (the hub's toCents).
    static func cents(_ n: Double) -> Double {
        let v = fixed6(n * 100)
        let s: Double = v > 0 ? 1 : (v < 0 ? -1 : 0)
        return s * jsRound(abs(v))
    }

    /// A non-negative cent amount rounded to a whole cent after trimming float noise (the hub's roundC).
    static func roundC(_ x: Double) -> Double { jsRound(fixed6(x)) }

    /// pct percent of an amount in cents, rounded half up to the cent.
    static func pctOf(_ c: Double, _ pct: Double) -> Double { cents((c * pct) / 10000) }

    /// Digits after the point in the shortest form of a number, as `String(x).split(".")[1].length` reads it.
    static func fractionDigits(_ x: Double) -> Int {
        if x.rounded() == x { return 0 }
        let s = "\(x)"
        guard let dot = s.firstIndex(of: ".") else { return 0 }
        return s[s.index(after: dot)...].count
    }

    // MARK: Split

    public struct SplitResult: Equatable, Sendable {
        public var subtotal: Double
        public var tax: Double
        public var tip: Double
        public var total: Double
        public var per_person: [Double]
        /// Cents the first person carries beyond their exact share.
        public var remainder_cents: Int
    }

    /// Tax and tip are both taken on the pre-tax subtotal. The cents left over after splitting go to the first person.
    public static func split(subtotal: Double, taxPct: Double = 0, tipPct: Double = 0, people peopleIn: Double, shares: [Double]? = nil) throws -> SplitResult {
        let people = peopleIn.rounded(.down)
        guard people >= 1 else { throw InputError(message: "People must be at least 1.") }
        guard people <= 1000 else { throw InputError(message: "People must be 1000 or fewer.") }
        guard subtotal >= 0 else { throw InputError(message: "Subtotal must be 0 or more.") }
        let sub = cents(subtotal)
        let tax = pctOf(sub, taxPct)
        let tip = pctOf(sub, tipPct)
        let total = sub + tax + tip
        let sh = (shares?.isEmpty ?? true) ? nil : shares
        if let s = sh, s.count != Int(people) || s.contains(where: { !($0 >= 0) }) || s.reduce(0, +) <= 0 {
            throw InputError(message: "Shares need one weight per person.")
        }
        let w = sh ?? Array(repeating: 1, count: Int(people))
        // Fractional weights are scaled to integers so the allocation stays exact, as the hub does.
        let scale = pow(10, Double(min(6, max(0, w.map(fractionDigits).max() ?? 0))))
        let iw = w.map { jsRound($0 * scale) }
        let W = iw.reduce(0, +)
        // Weights that all round to 0 at the scale (0.0000001 reads as "1e-07", which has no digits after a point)
        // left nothing to divide by, and the NaN that came out crashed the app at Int(). They are refused now, as are
        // amounts too large to hold in cents.
        guard W > 0, W.isFinite else { throw InputError(message: "Shares are too small to split by. Use weights of 0.000001 or more.") }
        var parts = iw.map { ((total * $0) / W).rounded(.down) }
        let first = parts[0]
        parts[0] += total - parts.reduce(0, +)
        guard total.isFinite, parts.allSatisfy(\.isFinite), abs(parts[0] - first) < 1e15 else {
            throw InputError(message: "The amounts are too large to split.")
        }
        return SplitResult(subtotal: sub / 100, tax: tax / 100, tip: tip / 100, total: total / 100, per_person: parts.map { $0 / 100 }, remainder_cents: Int(parts[0] - first))
    }

    // MARK: Payoff

    public struct PayoffRow: Equatable, Sendable {
        public var month: Int
        public var payment: Double
        public var interest: Double
        public var principal: Double
        public var balance: Double
    }

    public struct PayoffResult: Equatable, Sendable {
        /// nil means never: the payment does not cover the interest.
        public var months: Int?
        public var payment: Double
        public var total_interest: Double?
        public var preview: [PayoffRow]
        public var never: Bool { months == nil }
    }

    static let maxMonths = 1200

    /// A months value as typed into Payoff, as a whole number from 1 to 1200. The screen turned the typed number into
    /// an Int before payoff checked it, and 19 or more digits is past what an Int holds, so the app crashed.
    public static func wholeMonths(_ v: Double) throws -> Int {
        guard v.isFinite, v.rounded() == v else { throw InputError(message: "Months must be a whole number.") }
        guard v >= 1, v <= Double(maxMonths) else { throw InputError(message: "Months must be from 1 to \(maxMonths).") }
        return Int(v)
    }

    /// Month by month in cents: interest rounds each month, the last payment is only what is left. Never: 12 rows of a growing balance.
    static func amortize(_ bal0: Double, _ rate: Double, _ pay: Double) -> (rows: [PayoffRow], months: Int?, interest: Double) {
        var rows: [PayoffRow] = []
        var bal = bal0
        var m = 0
        var interest: Double = 0
        while bal > 0 && m < maxMonths {
            m += 1
            let int = roundC(bal * rate)
            if pay <= int {
                var k = m
                while rows.count < 12 {
                    let i = roundC(bal * rate)
                    bal += i - pay
                    rows.append(PayoffRow(month: k, payment: pay / 100, interest: i / 100, principal: (pay - i) / 100, balance: bal / 100))
                    k += 1
                }
                return (rows, nil, interest)
            }
            let p = min(pay, bal + int)
            bal = bal + int - p
            interest += int
            if rows.count < 12 { rows.append(PayoffRow(month: m, payment: p / 100, interest: int / 100, principal: (p - int) / 100, balance: bal / 100)) }
        }
        return (rows, bal > 0 ? nil : m, interest)
    }

    /// Given a payment: months to payoff and total interest, or never when the payment does not cover the interest.
    /// Given months: the payment, rounded up to the cent (and raised a cent at a time until it pays off in time).
    /// Payment wins when both are given. Interest accrues monthly at apr / 12 and rounds to the cent.
    public static func payoff(balance: Double, aprPct: Double, payment: Double? = nil, months: Int? = nil) throws -> PayoffResult {
        guard balance > 0 else { throw InputError(message: "Balance must be more than 0.") }
        guard aprPct >= 0 else { throw InputError(message: "APR must be 0 or more.") }
        let bal0 = cents(balance)
        let rate = aprPct / 100 / 12
        if let p = payment, p > 0 {
            let pay = cents(p)
            let r = amortize(bal0, rate, pay)
            guard let m = r.months else { return PayoffResult(months: nil, payment: pay / 100, total_interest: nil, preview: r.rows) }
            return PayoffResult(months: m, payment: pay / 100, total_interest: r.interest / 100, preview: r.rows)
        }
        guard let n = months, n >= 1, n <= maxMonths else { throw InputError(message: "Give a payment or a whole number of months.") }
        let exact = rate == 0 ? bal0 / Double(n) : (bal0 * rate) / (1 - pow(1 + rate, -Double(n)))
        var pay = fixed6(exact).rounded(.up)
        var r = amortize(bal0, rate, pay)
        while r.months == nil || r.months! > n {
            pay += 1
            r = amortize(bal0, rate, pay)
        }
        return PayoffResult(months: r.months, payment: pay / 100, total_interest: r.interest / 100, preview: r.rows)
    }

    // MARK: Unit price

    public struct UnitItem: Equatable, Sendable {
        public var name: String
        public var price: Double
        public var qty: Double
        public var unit: String
        public init(name: String, price: Double, qty: Double, unit: String) { self.name = name; self.price = price; self.qty = qty; self.unit = unit }
    }

    public struct UnitRow: Equatable, Sendable {
        public var name: String
        public var price: Double
        public var qty: Double
        public var unit: String
        /// Price per base unit (oz for mass, fl oz for volume, each for counts, else the unit as typed).
        public var per_unit: Double
        public var base: String
    }

    static let ozG = 28.349523125
    static let flozMl = 29.5735295625
    static let units: [String: (String, Double)] = [
        "oz": ("oz", 1), "ounce": ("oz", 1), "ounces": ("oz", 1), "lb": ("oz", 16), "lbs": ("oz", 16), "pound": ("oz", 16), "pounds": ("oz", 16),
        "g": ("oz", 1 / ozG), "gram": ("oz", 1 / ozG), "grams": ("oz", 1 / ozG), "kg": ("oz", 1000 / ozG), "mg": ("oz", 0.001 / ozG),
        "fl oz": ("fl oz", 1), "floz": ("fl oz", 1), "fl. oz": ("fl oz", 1), "ml": ("fl oz", 1 / flozMl), "l": ("fl oz", 1000 / flozMl), "liter": ("fl oz", 1000 / flozMl), "litre": ("fl oz", 1000 / flozMl),
        "gal": ("fl oz", 128), "gallon": ("fl oz", 128), "qt": ("fl oz", 32), "quart": ("fl oz", 32), "pt": ("fl oz", 16), "pint": ("fl oz", 16), "cup": ("fl oz", 8),
        "each": ("each", 1), "ea": ("each", 1), "ct": ("each", 1), "count": ("each", 1), "pc": ("each", 1), "pcs": ("each", 1), "piece": ("each", 1), "pieces": ("each", 1),
    ]

    /// Price per base unit, cheapest first, converting lb, g, kg, ml, l, gal and the like. Mixed dimensions are an error.
    public static func unitPrices(_ items: [UnitItem]) throws -> [UnitRow] {
        let rows: [(row: UnitRow, raw: Double)] = items.filter { $0.qty > 0 && $0.price >= 0 }.map { x in
            let typed = x.unit.isEmpty ? "each" : x.unit
            let unit = typed.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            let singular = unit.hasSuffix("s") ? String(unit.dropLast()) : unit
            let (base, factor) = units[unit] ?? units[singular] ?? (unit, 1)
            let raw = x.price / (x.qty * factor)
            return (UnitRow(name: x.name, price: x.price, qty: x.qty, unit: unit, per_unit: jsRound(fixed6(raw * 10000)) / 10000, base: base), raw)
        }
        if Set(rows.map(\.row.base)).count > 1 { throw InputError(message: "These units cannot be compared. Use all weights, all volumes or all counts.") }
        return rows.sorted { a, b in
            if a.raw != b.raw { return a.raw < b.raw }
            return a.row.name.localizedCompare(b.row.name) == .orderedAscending
        }.map(\.row)
    }

    // MARK: Subscriptions

    /// Periods per year for "every N days|weeks|months|years"; nil otherwise.
    static func perYear(_ repeatRule: String?) -> Double? {
        guard let r = repeatRule, let m = r.firstMatch(of: #/^every (\d+) (days|weeks|months|years)/#), let n = Double(m.1), n > 0 else { return nil }
        switch m.2 {
        case "days": return 365.25 / n
        case "weeks": return 365.25 / 7 / n
        case "months": return 12 / n
        default: return 1 / n
        }
    }

    /// Monthly equivalent of a cost repeating like "every 1 years"; nil when the repeat is missing or not understood.
    public static func monthlyOf(_ cost: Double, repeat repeatRule: String?) -> Double? {
        guard let per = perYear(repeatRule) else { return nil }
        return cents((cost * per) / 12) / 100
    }

    public struct SubRow: Equatable, Sendable, Identifiable {
        public var id: String
        public var title: String
        public var cost: Double
        public var `repeat`: String
        public var monthly: Double
        public var yearly: Double
    }

    public struct Skipped: Equatable, Sendable, Identifiable {
        public var id: String
        public var title: String
        public var reason: String
    }

    public struct SubsResult: Equatable, Sendable {
        public var items: [SubRow]
        public var monthly_total: Double
        public var yearly_total: Double
        public var skipped: [Skipped]
    }

    /// Watches of category subscription with a cost and a repeat, most expensive per month first, with totals.
    public static func subscriptions(_ watches: [Entity]) -> SubsResult {
        var items: [SubRow] = []
        var skipped: [Skipped] = []
        for w in watches where w.str("category") == "subscription" {
            let title = w.str("title")
            guard case .number(let cost)? = w.fields["cost"] else {
                skipped.append(Skipped(id: w.id, title: title, reason: "no cost"))
                continue
            }
            let rep = w.string("repeat") ?? ""
            guard let per = perYear(rep) else {
                skipped.append(Skipped(id: w.id, title: title, reason: rep.isEmpty ? "no repeat" : "repeat \(rep) is not in days, weeks, months or years"))
                continue
            }
            let yearly = cost * per
            items.append(SubRow(id: w.id, title: title, cost: cost, repeat: rep, monthly: cents(yearly / 12) / 100, yearly: cents(yearly) / 100))
        }
        items.sort { a, b in
            if a.monthly != b.monthly { return a.monthly > b.monthly }
            return a.title.localizedCompare(b.title) == .orderedAscending
        }
        let mt = items.map { cents($0.monthly) }.reduce(0, +) / 100
        let yt = items.map { cents($0.yearly) }.reduce(0, +) / 100
        return SubsResult(items: items, monthly_total: mt, yearly_total: yt, skipped: skipped)
    }

    // MARK: Display

    /// US dollars, like `toLocaleString("en-US", { style: "currency", currency: "USD" })`.
    public static func money(_ n: Double) -> String {
        n.formatted(.currency(code: "USD").locale(Locale(identifier: "en_US")))
    }

    /// A number typed by hand: "$1,200.50" reads as 1200.5. Nil when empty or not a number.
    public static func parse(_ s: String) -> Double? {
        let t = s.replacingOccurrences(of: "$", with: "").replacingOccurrences(of: ",", with: "").replacingOccurrences(of: "%", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, let v = Double(t), v.isFinite else { return nil }
        return v
    }
}
