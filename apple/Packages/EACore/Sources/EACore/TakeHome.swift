import Foundation

/// Take-home pay, ported from web/src/lib/calc.ts `takeHome` (the hub's /calc/takehome in hub/src/takehome.ts, which cites the
/// sources). Tax year 2026: IRS Rev. Proc. 2025-32 brackets and standard deductions, the SSA wage base of $184,500, and the
/// IRS Publication 15 rates. Year figures are worked first in cents; per paycheck is the year spread evenly.
extension Calc {

    public static let taxYear = 2026

    public enum PayFrequency: String, CaseIterable, Identifiable, Sendable {
        case weekly, biweekly, semimonthly, monthly
        public var id: String { rawValue }
        public var periods: Int {
            switch self {
            case .weekly: return 52
            case .biweekly: return 26
            case .semimonthly: return 24
            case .monthly: return 12
            }
        }
        public var title: String {
            switch self {
            case .weekly: return "Weekly"
            case .biweekly: return "Every 2 weeks"
            case .semimonthly: return "Twice a month"
            case .monthly: return "Monthly"
            }
        }
    }

    public enum Filing: String, CaseIterable, Identifiable, Sendable {
        case single, married, head
        public var id: String { rawValue }
        public var title: String {
            switch self {
            case .single: return "Single"
            case .married: return "Married filing jointly"
            case .head: return "Head of household"
            }
        }
        /// Standard deduction in dollars (Rev. Proc. 2025-32 section 4.14).
        var standardDeduction: Double {
            switch self {
            case .single: return 16100
            case .married: return 32200
            case .head: return 24150
            }
        }
        /// Top of each bracket in dollars and its rate (Rev. Proc. 2025-32 section 4.01).
        var brackets: [(Double, Double)] {
            switch self {
            case .married: return [(24800, 0.10), (100800, 0.12), (211400, 0.22), (403550, 0.24), (512450, 0.32), (768700, 0.35), (.infinity, 0.37)]
            case .head: return [(17700, 0.10), (67450, 0.12), (105700, 0.22), (201750, 0.24), (256200, 0.32), (640600, 0.35), (.infinity, 0.37)]
            case .single: return [(12400, 0.10), (50400, 0.12), (105700, 0.22), (201775, 0.24), (256225, 0.32), (640600, 0.35), (.infinity, 0.37)]
            }
        }
    }

    /// How the 401k is given: a percent of each paycheck's gross, or an amount per paycheck.
    public enum K401: Equatable, Sendable {
        case none
        case percent(Double)
        case amount(Double)
    }

    public struct PayLines: Equatable, Sendable {
        public var gross: Double
        public var federal: Double
        public var social_security: Double
        /// Includes `additional_medicare`.
        public var medicare: Double
        public var additional_medicare: Double
        public var state: Double
        public var k401: Double
        public var health: Double
        public var pretax: Double
        public var net: Double
    }

    public struct BonusLines: Equatable, Sendable {
        public var gross: Double
        public var federal: Double
        public var federal_rate: Double
        public var social_security: Double
        public var medicare: Double
        public var additional_medicare: Double
        public var state: Double
        public var net: Double
    }

    public struct TakeHomeResult: Equatable, Sendable {
        public var periods: Int
        public var per_paycheck: PayLines
        public var per_year: PayLines
        public var bonus: BonusLines?
        public var year_net_with_bonus: Double
        public var notes: [String]
    }

    static let ssBase: Double = 184_500_00
    static let addlOver: Double = 200_000_00
    static let suppTop: Double = 1_000_000_00

    /// Tax in cents on taxable income in cents.
    static func bracketTax(_ taxable: Double, _ filing: Filing) -> Double {
        var tax: Double = 0
        var low: Double = 0
        for (top, rate) in filing.brackets {
            if taxable <= low { break }
            tax += (min(taxable, top * 100) - low) * rate
            low = top * 100
        }
        return roundC(tax)
    }

    /// The hub's /calc/takehome, to the cent. `health` is health and HSA per paycheck (a cafeteria plan, so it comes off Social
    /// Security and Medicare too); the 401k comes off income tax and state wages only. State tax is a flat percent.
    public static func takeHome(salary salaryIn: Double, bonus bonusIn: Double = 0, frequency: PayFrequency, filing: Filing,
                                k401 k401In: K401 = .none, health healthIn: Double = 0, statePct: Double = 0) throws -> TakeHomeResult {
        guard salaryIn > 0 else { throw InputError(message: "Salary must be above 0.") }
        guard statePct >= 0 && statePct <= 20 else { throw InputError(message: "State tax must be 0 to 20 percent.") }
        let P = Double(frequency.periods)
        let salary = cents(salaryIn)
        let bonus = bonusIn > 0 ? cents(bonusIn) : 0
        let health = healthIn > 0 ? cents(healthIn) * P : 0
        var k401: Double = 0
        switch k401In {
        case .none: break
        case .percent(let p):
            guard p >= 0 && p <= 100 else { throw InputError(message: "401k percent must be 0 to 100.") }
            k401 = roundC(salary * p / 100)
        case .amount(let a):
            if a > 0 { k401 = cents(a) * P }
        }
        guard k401 + health <= salary else { throw InputError(message: "Pre-tax deductions are more than the pay.") }

        let incomeWages = salary - k401 - health
        let ficaWages = salary - health
        let federal = bracketTax(max(0, incomeWages - filing.standardDeduction * 100), filing)
        let ss = roundC(min(ficaWages, ssBase) * 0.062)
        let addl = roundC(max(0, ficaWages - addlOver) * 0.009)
        let medicare = roundC(ficaWages * 0.0145) + addl
        let state = roundC(incomeWages * statePct / 100)
        let yearNet = salary - federal - ss - medicare - state - k401 - health

        func each(_ c: Double) -> Double { roundC(c / P) }
        let pg = each(salary), pf = each(federal), pss = each(ss), pm = each(medicare), pa = each(addl), pst = each(state), pk = each(k401), ph = each(health)
        let perNet = pg - pf - pss - pm - pst - pk - ph

        var b: BonusLines?
        var bonusNet: Double = 0
        if bonus > 0 {
            // The salary uses up the wage base and the Additional Medicare threshold first; the bonus pays on what is left.
            let bFed = roundC(min(bonus, suppTop) * 0.22 + max(0, bonus - suppTop) * 0.37)
            let bSs = roundC(min(bonus, max(0, ssBase - ficaWages)) * 0.062)
            func over(_ w: Double) -> Double { max(0, w - addlOver) }
            let bAddl = roundC((over(ficaWages + bonus) - over(ficaWages)) * 0.009)
            let bMed = roundC(bonus * 0.0145) + bAddl
            let bState = roundC(bonus * statePct / 100)
            bonusNet = bonus - bFed - bSs - bMed - bState
            b = BonusLines(gross: bonus / 100, federal: bFed / 100, federal_rate: bonus > suppTop ? 37 : 22, social_security: bSs / 100,
                           medicare: bMed / 100, additional_medicare: bAddl / 100, state: bState / 100, net: bonusNet / 100)
        }

        var notes: [String] = []
        if ficaWages > ssBase {
            let n = Int((ssBase / (ficaWages / P)).rounded(.up))
            notes.append("Social Security stops after paycheck \(n) of \(frequency.periods), when the year's wages pass $184,500. The paychecks after that are larger than shown.")
        }
        if addl > 0 { notes.append("Additional Medicare of 0.9% is withheld on wages over $200,000 in the year.") }
        if filing == .married && (addl > 0 || (b?.additional_medicare ?? 0) > 0) {
            notes.append("Married filing jointly owes Additional Medicare only over $250,000 together, so some of it can come back on the return.")
        }

        return TakeHomeResult(
            periods: frequency.periods,
            per_paycheck: PayLines(gross: pg / 100, federal: pf / 100, social_security: pss / 100, medicare: pm / 100, additional_medicare: pa / 100,
                                   state: pst / 100, k401: pk / 100, health: ph / 100, pretax: (pk + ph) / 100, net: perNet / 100),
            per_year: PayLines(gross: salary / 100, federal: federal / 100, social_security: ss / 100, medicare: medicare / 100, additional_medicare: addl / 100,
                               state: state / 100, k401: k401 / 100, health: health / 100, pretax: (k401 + health) / 100, net: yearNet / 100),
            bonus: b,
            year_net_with_bonus: (yearNet + bonusNet) / 100,
            notes: notes
        )
    }
}
