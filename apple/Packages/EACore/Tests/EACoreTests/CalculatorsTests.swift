import XCTest
@testable import EACore

/// The same examples as web/src/lib/admin.test.ts and hub/test/admin.test.ts, so the three agree to the cent.
final class CalculatorsTests: XCTestCase {

    // MARK: split

    func testSplitEvenWithMassachusettsTax() throws {
        let r = try Calc.split(subtotal: 84, taxPct: 6.25, tipPct: 20, people: 3)
        XCTAssertEqual(r, Calc.SplitResult(subtotal: 84, tax: 5.25, tip: 16.8, total: 106.05, per_person: [35.35, 35.35, 35.35], remainder_cents: 0))
    }

    func testSplitHubReference() throws {
        let r = try Calc.split(subtotal: 87.4, taxPct: 6.25, tipPct: 20, people: 3)
        XCTAssertEqual(r, Calc.SplitResult(subtotal: 87.4, tax: 5.46, tip: 17.48, total: 110.34, per_person: [36.78, 36.78, 36.78], remainder_cents: 0))
    }

    func testSplitLeftoverCentsToFirstPerson() throws {
        let r = try Calc.split(subtotal: 100, taxPct: 6.25, tipPct: 18, people: 3)
        XCTAssertEqual(r.total, 124.25)
        XCTAssertEqual(r.per_person, [41.43, 41.41, 41.41])
        XCTAssertEqual(r.remainder_cents, 2)
        XCTAssertEqual((r.per_person.reduce(0, +) * 100).rounded(), 12425)

        let plain = try Calc.split(subtotal: 100, people: 3)
        XCTAssertEqual(plain.per_person, [33.34, 33.33, 33.33])
        XCTAssertEqual(plain.total, 100)
        XCTAssertEqual(plain.remainder_cents, 1)
    }

    func testSplitRoundsTaxHalfUp() throws {
        // 19.99 * 6.25% = 1.249375 -> 1.25; 19.99 * 15% = 2.9985 -> 3.00
        let r = try Calc.split(subtotal: 19.99, taxPct: 6.25, tipPct: 15, people: 1)
        XCTAssertEqual(r.subtotal, 19.99)
        XCTAssertEqual(r.tax, 1.25)
        XCTAssertEqual(r.tip, 3)
        XCTAssertEqual(r.total, 24.24)
        XCTAssertEqual(r.per_person, [24.24])
    }

    func testSplitUnevenShares() throws {
        XCTAssertEqual(try Calc.split(subtotal: 100.01, people: 3, shares: [2, 1, 1]).per_person, [50.01, 25, 25])
        let r = try Calc.split(subtotal: 60, taxPct: 6.25, tipPct: 20, people: 3, shares: [30, 20, 10])
        XCTAssertEqual(r.total, 75.75)
        XCTAssertEqual(r.per_person, [37.88, 25.25, 12.62])
        XCTAssertEqual(try Calc.split(subtotal: 10, people: 3, shares: [2, 1, 1]).per_person, [5, 2.5, 2.5])
        XCTAssertEqual(try Calc.split(subtotal: 10, people: 3, shares: [1, 1, 1.5]).per_person, [2.87, 2.85, 4.28])
    }

    func testSplitRejectsBadInput() {
        XCTAssertThrowsError(try Calc.split(subtotal: 10, people: 0))
        XCTAssertThrowsError(try Calc.split(subtotal: 10, people: 2, shares: [1]))
    }

    // MARK: payoff

    func testPayoffHubReference() throws {
        let r = try Calc.payoff(balance: 4200, aprPct: 28.99, payment: 200)
        XCTAssertEqual(r.months, 30)
        XCTAssertEqual(r.total_interest, 1731.57)
        XCTAssertEqual(r.preview[0], Calc.PayoffRow(month: 1, payment: 200, interest: 101.47, principal: 98.53, balance: 4101.47))
        XCTAssertEqual(try Calc.payoff(balance: 4200, aprPct: 28.99, payment: 200, months: 12).months, 30)
    }

    func testPayoffFixedPayment() throws {
        let r = try Calc.payoff(balance: 5000, aprPct: 18, payment: 200)
        XCTAssertEqual(r.months, 32)
        XCTAssertEqual(r.total_interest, 1313.97)
        XCTAssertEqual(r.preview.count, 12)
        XCTAssertEqual(r.preview[0], Calc.PayoffRow(month: 1, payment: 200, interest: 75, principal: 125, balance: 4875))
        XCTAssertEqual(r.preview[1], Calc.PayoffRow(month: 2, payment: 200, interest: 73.13, principal: 126.87, balance: 4748.13))
    }

    func testPayoffForMonths() throws {
        let r = try Calc.payoff(balance: 1000, aprPct: 12, months: 12)
        XCTAssertEqual(r.payment, 88.85)
        XCTAssertEqual(r.months, 12)
        XCTAssertEqual(r.total_interest, 66.19)
        XCTAssertEqual(r.preview[11].payment, 88.84)
        XCTAssertEqual(r.preview[11].balance, 0)
    }

    func testPayoffNever() throws {
        let r = try Calc.payoff(balance: 5000, aprPct: 24, payment: 100)
        XCTAssertNil(r.months)
        XCTAssertTrue(r.never)
        XCTAssertNil(r.total_interest)
        XCTAssertEqual(r.preview[0].balance, 5000)
        let worse = try Calc.payoff(balance: 5000, aprPct: 24, payment: 50)
        XCTAssertNil(worse.months)
        XCTAssertGreaterThan(worse.preview[11].balance, 5000)
        let hub = try Calc.payoff(balance: 4200, aprPct: 28.99, payment: 100)
        XCTAssertNil(hub.months)
        XCTAssertEqual(hub.preview.count, 12)
        XCTAssertGreaterThan(hub.preview[11].balance, 4200)
    }

    func testPayoffZeroAPR() throws {
        let r = try Calc.payoff(balance: 1000, aprPct: 0, payment: 300)
        XCTAssertEqual(r.months, 4)
        XCTAssertEqual(r.total_interest, 0)
        XCTAssertEqual(try Calc.payoff(balance: 1000, aprPct: 0, months: 3).payment, 333.34)
        let hub = try Calc.payoff(balance: 1200, aprPct: 0, months: 12)
        XCTAssertEqual(hub.payment, 100)
        XCTAssertEqual(hub.total_interest, 0)
        XCTAssertThrowsError(try Calc.payoff(balance: 100, aprPct: 10))
    }

    // MARK: unit price

    func testUnitPricesCheapestFirst() throws {
        let r = try Calc.unitPrices([
            .init(name: "big", price: 7.99, qty: 2, unit: "lb"),
            .init(name: "small", price: 2.49, qty: 8, unit: "oz"),
            .init(name: "none", price: 1, qty: 0, unit: "oz"),
        ])
        XCTAssertEqual(r.map(\.name), ["big", "small"])
        XCTAssertEqual(r[0].base, "oz")
        XCTAssertEqual(r[0].per_unit, 0.2497)
        XCTAssertEqual(r[1].per_unit, 0.3113)
        XCTAssertThrowsError(try Calc.unitPrices([.init(name: "a", price: 1, qty: 1, unit: "oz"), .init(name: "b", price: 1, qty: 1, unit: "each")]))
        XCTAssertThrowsError(try Calc.unitPrices([.init(name: "a", price: 1, qty: 1, unit: "oz"), .init(name: "b", price: 1, qty: 1, unit: "ml")]))
    }

    func testUnitPricesHubReference() throws {
        let r = try Calc.unitPrices([
            .init(name: "Store brand", price: 3.99, qty: 16, unit: "oz"),
            .init(name: "Bulk bag", price: 3.0, qty: 500, unit: "g"),
            .init(name: "Name brand", price: 3.49, qty: 1, unit: "lb"),
        ])
        XCTAssertEqual(r.map(\.name), ["Bulk bag", "Name brand", "Store brand"])
        XCTAssertEqual(r[1].per_unit, 0.2181)
        XCTAssertEqual(Set(r.map(\.base)), ["oz"])
        XCTAssertEqual(try Calc.unitPrices([.init(name: "x", price: 4, qty: 2, unit: "Pounds")])[0].base, "oz")
    }

    // MARK: subscriptions

    func testSubscriptions() {
        XCTAssertEqual(Calc.monthlyOf(110, repeat: "every 1 years"), 9.17)
        XCTAssertEqual(Calc.monthlyOf(9, repeat: "every 1 months"), 9)
        XCTAssertNil(Calc.monthlyOf(9, repeat: nil))
        let r = Calc.subscriptions([
            Entity(kind: .watch, fields: ["title": "Music streaming", "category": "subscription", "cost": 110, "repeat": "every 1 years"]),
            Entity(kind: .watch, fields: ["title": "Cloud backup", "category": "subscription", "cost": 9, "repeat": "every 1 months"]),
            Entity(kind: .watch, fields: ["title": "Car insurance", "category": "insurance", "cost": 640, "repeat": "every 1 years"]),
        ])
        XCTAssertEqual(r.items.map(\.title), ["Music streaming", "Cloud backup"])
        XCTAssertEqual(r.monthly_total, 18.17)
        XCTAssertEqual(r.yearly_total, 218)
        let skipped = Calc.subscriptions([Entity(kind: .watch, fields: ["title": "No cost", "category": "subscription", "repeat": "every 1 months"])]).skipped
        XCTAssertEqual(skipped.map(\.title), ["No cost"])
        XCTAssertEqual(skipped.map(\.reason), ["no cost"])
    }

    // MARK: helpers

    func testHelpers() {
        XCTAssertEqual(Calc.jsRound(2.5), 3)
        XCTAssertEqual(Calc.jsRound(-2.5), -2)
        XCTAssertEqual(Calc.cents(-0.005), -1)
        XCTAssertEqual(Calc.money(1234.5), "$1,234.50")
        XCTAssertEqual(Calc.parse("$1,200.50"), 1200.5)
        XCTAssertNil(Calc.parse(" "))
    }
}
