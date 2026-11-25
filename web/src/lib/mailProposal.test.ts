import { describe, expect, it } from "vitest";
import { PROPOSAL_BUTTONS, PROPOSAL_TEXTS, proposalFace, proposalMoving, type MailProposal } from "./mailProposal";

// A mail the assistant wrote for the owner to send with one tap: the card's words and buttons. The same cases as
// EACore's MailProposalTests.

const view = (state: MailProposal["state"], error?: string): MailProposal => ({ id: "p1", from: { name: "Robin", address: "robin@example.com" }, to: ["alex@example.com"], cc: [], subject: "Saturday", text: "Saturday works.", files: [], state, ...(error ? { error } : {}), expires_at: "2026-11-25T10:00:00.000Z" });

describe("mail proposals: the card", () => {
  it("says nothing is sent until Send, and offers Send, Edit and Cancel", () => {
    expect(proposalFace(view("proposed"))).toEqual({ line: "Nothing is sent until you tap Send.", showMail: true, buttons: ["send", "edit", "cancel"] });
    expect(proposalFace(view("waiting")).buttons).toEqual(["undo"]);
    expect(proposalFace(view("waiting")).line).toBe("Sending");
    expect(proposalFace(view("sending")).buttons).toEqual([]);
    expect(proposalFace(view("sent"))).toEqual({ line: "Sent.", showMail: true, buttons: [] });
    const why = "iCloud Mail did not accept the account's password for sending, so the mail was not sent. Check the app password in Settings, Accounts.";
    expect(proposalFace(view("failed", why))).toEqual({ line: "Not sent", error: why, showMail: true, buttons: ["retry", "edit", "cancel"] });
    expect(proposalFace(view("cancelled")).line).toBe("Cancelled. Nothing was sent.");
    expect(proposalFace(view("edited")).line).toBe("Opened on the Mail screen to edit. Send it from there.");
    expect(PROPOSAL_BUTTONS).toEqual({ send: "Send", edit: "Edit", cancel: "Cancel", undo: "Undo", retry: "Try again" });
  });
  it("one the hub no longer keeps says how it ended, else that it expired", () => {
    expect(proposalFace(null)).toEqual({ line: "This mail expired after 24 hours. Nothing was sent.", showMail: false, buttons: [] });
    expect(proposalFace(null, "sent").line).toBe("Sent.");
    expect(proposalFace(null, "cancelled").line).toBe("Cancelled. Nothing was sent.");
    expect(proposalFace(null, "edited").line).toBe(PROPOSAL_TEXTS.edited);
  });
  it("asks again only while the mail waits or is on its way, and no text pauses with a dash", () => {
    expect([proposalMoving(view("waiting")), proposalMoving(view("sending")), proposalMoving(view("proposed")), proposalMoving(null)]).toEqual([true, true, false, false]);
    for (const t of Object.values(PROPOSAL_TEXTS)) expect(t).not.toMatch(/[–—]/);
  });
});
