import XCTest
@testable import EACore

final class ClassifierTests: XCTestCase {
    func testReminder() {
        let r = Classifier.classify("remind me to order filament")
        XCTAssertEqual(r.kind, .reminder)
        XCTAssertEqual(r.fields["title"], "order filament")
        XCTAssertEqual(r.fields["friction"], "none")
    }

    func testWeight() {
        let r = Classifier.classify("weight 162")
        XCTAssertEqual(r.kind, .log)
        XCTAssertEqual(r.fields["type"], "weight")
        XCTAssertEqual(r.fields["value"], 162)
        XCTAssertEqual(r.fields["unit"], "lb")
        XCTAssertNotNil(r.fields["at"]?.stringValue)
    }

    func testMed() {
        let r = Classifier.classify("took claritin")
        XCTAssertEqual(r.kind, .log)
        XCTAssertEqual(r.fields["type"], "med")
        XCTAssertEqual(r.fields["value"], "claritin")
    }

    func testTaskVerb() {
        let r = Classifier.classify("call the vet")
        XCTAssertEqual(r.kind, .task)
        XCTAssertEqual(r.fields["title"], "call the vet")
        XCTAssertEqual(r.fields["status"], "inbox")
    }

    func testOthers() {
        XCTAssertEqual(Classifier.classify("bp 120/80").fields["value"], "120/80")
        XCTAssertEqual(Classifier.classify("mood -1").fields["value"], -1)
        XCTAssertEqual(Classifier.classify("todo: wash the car").fields["title"], "wash the car")
        XCTAssertEqual(Classifier.classify("note: a thought\nmore").fields["title"], "a thought")
        XCTAssertEqual(Classifier.classify("remember that the dog is named Ace").kind, .fact)
        XCTAssertEqual(Classifier.classify("just some rambling about nothing in particular").kind, .none)
    }

    func testStyleGuard() {
        let r = StyleGuard.apply("Great question! Use the cable \u{2014} the short one.\nLet me know if that helps.")
        XCTAssertFalse(r.text.contains("\u{2014}"))
        XCTAssertFalse(r.text.lowercased().contains("great question"))
        XCTAssertFalse(r.text.lowercased().contains("let me know"))
        XCTAssertTrue(r.applied.contains("em-dash"))
        XCTAssertEqual(StyleGuard.apply("the final fix is here").text, "the this change is here")
        XCTAssertEqual(StyleGuard.apply("Dentist 3:00\u{2013}4:00 PM, then home \u{2014} rest.").text, "Dentist 3:00 to 4:00 PM, then home, rest.")
        XCTAssertEqual(StyleGuard.dashes("Oct 26\u{2013}31"), "Oct 26 to 31")
        XCTAssertEqual(StyleGuard.dashes("Mon\u{2013}Fri: Work 9:00 AM\u{2013}5:00 PM"), "Mon to Fri: Work 9:00 AM to 5:00 PM")
        XCTAssertEqual(StyleGuard.dashes("It is free \u{2014} Monday works"), "It is free, Monday works")
        XCTAssertEqual(StyleGuard.apply("Mon - Fri, 9:00 AM - 5:00 PM - busy").text, "Mon to Fri, 9:00 AM to 5:00 PM, busy")
        let h = StyleGuard.apply("1. **Pick up HDMI cable** - it is at Micro Center\n- Eggs\nRun `a - b` or:\n```sh\nexpr 5 - 3\n```\nwell-known 5-3")
        XCTAssertEqual(h.text, "1. **Pick up HDMI cable**, it is at Micro Center\n- Eggs\nRun `a - b` or:\n```sh\nexpr 5 - 3\n```\nwell-known 5-3")
        XCTAssertTrue(h.applied.contains("spaced-hyphen"))
        XCTAssertEqual(StyleGuard.apply("Two left: eggs and bread. Want me to add anything else?").text, "Two left: eggs and bread.")
        XCTAssertEqual(StyleGuard.apply("Moved to 7 PM. Say the word if you want it longer.").text, "Moved to 7 PM.")
        XCTAssertEqual(StyleGuard.apply("Call at 3 \u{2013} Janet will pick up.").text, "Call at 3, Janet will pick up.")
        XCTAssertEqual(StyleGuard.apply("I'll be there at 5 - Marcus is driving.").text, "I'll be there at 5, Marcus is driving.")
        XCTAssertEqual(StyleGuard.apply("The team - 3 people - is set.").text, "The team, 3 people, is set.")
        XCTAssertEqual(StyleGuard.apply("Open 5pm - 9pm, Mon - Fri, and 5 - 6 on Sat.").text, "Open 5pm to 9pm, Mon to Fri, and 5 to 6 on Sat.")
        let start = Date()
        _ = StyleGuard.apply(String(repeating: " ", count: 20000) + "x")
        XCTAssertLessThan(Date().timeIntervalSince(start), 1.0)
    }

    func testRecordsInPlainWords() {
        XCTAssertEqual(Classifier.classify("Today I weigh 116.4").fields["value"], .number(116.4))
        XCTAssertEqual(Classifier.classify("I weighed in at 72 kg this morning").fields["unit"], "kg")
        XCTAssertEqual(Classifier.classify("Blood pressure 130 over 85").fields["value"], "130/85")
        XCTAssertEqual(Classifier.classify("slept 7 and a half hours").fields["value"], .number(450))
        XCTAssertEqual(Classifier.classify("walked 10,432 steps today").fields["value"], .number(10432))
        XCTAssertEqual(Classifier.classify("took my claritin").fields["value"], "claritin")
        XCTAssertEqual(Classifier.classify("feeling 3/5").fields["type"], "mood")
        XCTAssertNotEqual(Classifier.classify("I weigh more than I want to").kind, .log)
        XCTAssertNotEqual(Classifier.classify("take out the trash").kind, .log)
    }
}
