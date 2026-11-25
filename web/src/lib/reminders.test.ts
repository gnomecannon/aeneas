import { describe, expect, it } from "vitest";
import { repeatWords } from "./reminders";

// A repeat rule in words, as Renewals shows it. The same cases as EACore's RepeatTests.

describe("a repeat rule in words", () => {
  it("says one of a unit plainly and keeps a count above one", () => {
    expect(repeatWords("every 1 months")).toBe("every month");
    expect(repeatWords("every 1 years")).toBe("every year");
    expect(repeatWords("every 1 days")).toBe("every day");
    expect(repeatWords("every 2 weeks")).toBe("every 2 weeks");
    expect(repeatWords("every 3 months")).toBe("every 3 months");
  });
  it("names the days of a week and the day of a month", () => {
    expect(repeatWords("every 1 weeks on mon,tue,wed,thu,fri")).toBe("every weekday");
    expect(repeatWords("every 2 weeks on mon,thu")).toBe("every 2 weeks on Mon and Thu");
    expect(repeatWords("every 1 weeks on mon,wed,fri")).toBe("every week on Mon, Wed and Fri");
    expect(repeatWords("every 1 weeks on sat")).toBe("every week on Sat");
    expect(repeatWords("every 1 months on day15")).toBe("every month on day 15");
  });
  it("leaves what it cannot read as it is", () => {
    expect(repeatWords("every fortnight")).toBe("every fortnight");
    expect(repeatWords("every 1 weeks on someday")).toBe("every 1 weeks on someday");
    expect(repeatWords(undefined)).toBe("");
  });
});
