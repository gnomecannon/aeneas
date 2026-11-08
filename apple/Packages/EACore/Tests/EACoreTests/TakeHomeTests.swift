import XCTest
@testable import EACore

/// The same hand-worked examples as hub/test/takehome.test.ts and web/src/lib/takehome.test.ts, so the three agree to the cent.
final class TakeHomeTests: XCTestCase {

    func testBracketTableConstants() {
        // The "plus" amounts printed in Rev. Proc. 2025-32 at the top of a bracket, in cents.
        XCTAssertEqual(Calc.bracketTax(50400_00, .single), 5800_00)
        XCTAssertEqual(Calc.bracketTax(640600_00, .single), 192979_25)
        XCTAssertEqual(Calc.bracketTax(768700_00, .married), 206583_50)
        XCTAssertEqual(Calc.bracketTax(640600_00, .head), 191171_00)
    }

    func testSingleBiweekly() throws {
        let r = try Calc.takeHome(salary: 85000, frequency: .biweekly, filing: .single, k401: .percent(5), health: 100, statePct: 5)
        XCTAssertEqual(r.per_year, Calc.PayLines(gross: 85000, federal: 8363, social_security: 5108.8, medicare: 1194.8, additional_medicare: 0,
                                                 state: 3907.5, k401: 4250, health: 2600, pretax: 6850, net: 59575.9))
        XCTAssertEqual(r.per_paycheck, Calc.PayLines(gross: 3269.23, federal: 321.65, social_security: 196.49, medicare: 45.95, additional_medicare: 0,
                                                     state: 150.29, k401: 163.46, health: 100, pretax: 263.46, net: 2291.39))
        XCTAssertNil(r.bonus)
        XCTAssertEqual(r.notes, [])
    }

    func testMarriedMonthlyWithBonus() throws {
        let r = try Calc.takeHome(salary: 260000, bonus: 50000, frequency: .monthly, filing: .married, k401: .amount(2000))
        XCTAssertEqual(r.per_year, Calc.PayLines(gross: 260000, federal: 34260, social_security: 11439, medicare: 4310, additional_medicare: 540,
                                                 state: 0, k401: 24000, health: 0, pretax: 24000, net: 185991))
        XCTAssertEqual(r.per_paycheck.net, 15499.25)
        XCTAssertEqual(r.bonus, Calc.BonusLines(gross: 50000, federal: 11000, federal_rate: 22, social_security: 0, medicare: 1175, additional_medicare: 450, state: 0, net: 37825))
        XCTAssertEqual(r.year_net_with_bonus, 223816)
        XCTAssertTrue(r.notes.first?.contains("stops after paycheck 9 of 12") ?? false)
    }

    func testHeadOfHouseholdAndBonusAcrossWageBase() throws {
        let r = try Calc.takeHome(salary: 50000, frequency: .weekly, filing: .head)
        XCTAssertEqual(r.per_year.federal, 2748)
        XCTAssertEqual(r.per_year.net, 43427)
        XCTAssertEqual(r.per_paycheck.gross, 961.54)
        XCTAssertEqual(r.per_paycheck.net, 835.13)
        let b = try Calc.takeHome(salary: 180000, bonus: 10000, frequency: .semimonthly, filing: .single, statePct: 5).bonus
        XCTAssertEqual(b, Calc.BonusLines(gross: 10000, federal: 2200, federal_rate: 22, social_security: 279, medicare: 145, additional_medicare: 0, state: 500, net: 6876))
    }

    func testRejectsDeductionsOverPay() {
        XCTAssertThrowsError(try Calc.takeHome(salary: 26000, frequency: .biweekly, filing: .single, k401: .amount(900), health: 200))
        XCTAssertThrowsError(try Calc.takeHome(salary: 0, frequency: .biweekly, filing: .single))
    }
}
