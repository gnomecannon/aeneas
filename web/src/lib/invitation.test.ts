import { describe, expect, it } from "vitest";
import { invitationMessage } from "./invitation";
import { pastedLink } from "../views/Setup";

describe("an invitation for someone far away", () => {
  const link = `everythingapp://setup?code=ABCD-EFGH&name=Mom%27s%20phone&link=direct&node=${"ab".repeat(32)}&relay=${encodeURIComponent("https://relay.example")}&hid=${"cd".repeat(16)}`;
  const msg = invitationMessage("Mom", "Robin", link, "2026-11-22T17:00:00Z");

  it("says what to do in plain steps and carries the link", () => {
    expect(msg).toMatch(/^Hi Mom, it's Robin\. I set up Aeneas for you\./);
    expect(msg).toContain("apps.apple.com/app/id6832161802");
    expect(msg).toContain("tap Paste the invitation");
    expect(msg.split("\n").at(-1)).toBe(link);
  });

  it("is found by the app in the whole pasted message", () => {
    const p = pastedLink(msg);
    expect(p?.get("code")).toBe("ABCD-EFGH");
    expect(p?.get("hub")).toMatch(/^iroh:\/\//);
    expect(pastedLink("Hi Mom, nothing in here")).toBeNull();
  });
});
