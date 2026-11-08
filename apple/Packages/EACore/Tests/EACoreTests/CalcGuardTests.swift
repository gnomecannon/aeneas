import XCTest
@testable import EACore

/// Inputs that crashed the Calculators screens (reproduced by probes in the screens review, 2026-11-05).
final class CalcGuardTests: XCTestCase {

    /// 0.0000001 reads as "1e-07", which has no digits after a point, so the scale stayed 1, the weight rounded to 0
    /// and Int(NaN) trapped. It is refused now with a message.
    func testSplitTinyShareIsRefusedNotACrash() {
        XCTAssertEqual(Calc.fractionDigits(0.0000001), 0, "the hub reads String(w) the same way")
        XCTAssertThrowsError(try Calc.split(subtotal: 10, people: 1, shares: [0.0000001])) { e in
            XCTAssertEqual((e as? Calc.InputError)?.message, "Shares are too small to split by. Use weights of 0.000001 or more.")
        }
        XCTAssertThrowsError(try Calc.split(subtotal: 10, people: 2, shares: [0.0000001, 0.0000002]))
    }

    /// A share that is tiny next to a normal one still splits: only weights that all vanish are refused.
    func testSplitTinyShareNextToANormalOneStillSplits() throws {
        let r = try Calc.split(subtotal: 10, people: 2, shares: [1, 0.0000001])
        XCTAssertEqual(r.per_person, [10, 0])
        XCTAssertEqual(r.total, 10)
    }

    /// A tip so large the total is not a finite number is refused instead of trapping at Int().
    func testSplitInfiniteTotalIsRefused() {
        XCTAssertThrowsError(try Calc.split(subtotal: 1e300, tipPct: 1e300, people: 3)) { e in
            XCTAssertEqual((e as? Calc.InputError)?.message, "The amounts are too large to split.")
        }
    }

    /// 19 digits of months is past Int; the screen converted it before payoff checked it and crashed.
    func testWholeMonthsChecksRangeBeforeConverting() throws {
        let huge = try XCTUnwrap(Calc.parse("9999999999999999999"))
        XCTAssertThrowsError(try Calc.wholeMonths(huge)) { e in
            XCTAssertEqual((e as? Calc.InputError)?.message, "Months must be from 1 to 1200.")
        }
        XCTAssertThrowsError(try Calc.wholeMonths(1e300))
        XCTAssertThrowsError(try Calc.wholeMonths(.infinity))
        XCTAssertThrowsError(try Calc.wholeMonths(.nan))
        XCTAssertThrowsError(try Calc.wholeMonths(12.5)) { e in
            XCTAssertEqual((e as? Calc.InputError)?.message, "Months must be a whole number.")
        }
        XCTAssertThrowsError(try Calc.wholeMonths(0))
        XCTAssertEqual(try Calc.wholeMonths(36), 36)
        XCTAssertEqual(try Calc.wholeMonths(1200), 1200)
        let r = try Calc.payoff(balance: 1000, aprPct: 20, months: try Calc.wholeMonths(12))
        XCTAssertEqual(r.months, 12)
    }
}
