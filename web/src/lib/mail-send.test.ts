import { describe, expect, it } from "vitest";
import { canSend, outboxFace, outboxLine, previewNote, SEND_TEXTS, smtpGuess, writeNote, type MailMailbox, type OutboxItem } from "./mail";

// Sending from the Mail screen (since 2026-11-24): when Send is offered, what the box says, and how a mail in the
// outbox shows. The same cases as EACore's MailSendTests.

const box = (o: Partial<MailMailbox>): MailMailbox => ({ email: "robin@example.com", last_refresh: null, last_error: null, more: false, provider: "Gmail", kind: "gmail", ...o });
const item = (o: Partial<OutboxItem>): OutboxItem => ({ id: "o1", mailbox: "robin@example.com", to: ["alex@example.com"], subject: "Plans", state: "waiting", send_at: "2026-11-24T10:00:10.000Z", ...o });

describe("mail send: when Send is offered", () => {
  it("only for a mailbox with a sending server that is not Read only; an older hub saves drafts only", () => {
    expect(canSend(box({ can_send: true }))).toBe(true);
    expect(canSend(box({ can_send: true, read_only: true }))).toBe(false);
    expect(canSend(box({ can_send: false }))).toBe(false);
    expect(canSend(box({}))).toBe(false);
    expect(canSend(undefined)).toBe(false);
  });
  it("the box says what happens: send or save, and for another mail account without a server how to send", () => {
    expect(writeNote(box({ can_send: true }))).toBe(SEND_TEXTS.write);
    expect(previewNote(box({ can_send: true }))).toBe("This is the whole mail. Send it, or save it as a draft.");
    expect(writeNote(box({ can_send: false, kind: "icloud", provider: "iCloud" }))).toBe("Saved to Drafts in iCloud, to send from Apple Mail.");
    expect(previewNote(box({ kind: "imap", provider: "mail.example.org", can_send: false }))).toBe(`This is the whole mail. Save it to Drafts, then send it from your mail app. ${SEND_TEXTS.noServer}`);
    expect(SEND_TEXTS.noServer).toBe("To send from here, add a sending server on this account's page in Settings, Accounts.");
  });
});

describe("mail send: a mail in the outbox", () => {
  it("is Sending with Undo while it waits, Sending without once on its way, Sent, or Not sent with the hub's words", () => {
    expect(outboxFace(item({}))).toEqual({ face: "sending", undo: true, text: "Sending" });
    expect(outboxFace(item({ state: "sending" }))).toEqual({ face: "sending", undo: false, text: "Sending" });
    expect(outboxFace(item({ state: "sent" }))).toEqual({ face: "sent", undo: false, text: "Sent." });
    const why = "Gmail did not accept the account's password for sending, so the mail was not sent. Check the app password in Settings, Accounts.";
    expect(outboxFace(item({ state: "failed", error: why }))).toEqual({ face: "failed", undo: false, text: why });
    expect(outboxFace(null).face).toBe("gone");
  });
  it("a notice names the mail and who it was for", () => {
    expect(outboxLine(item({}))).toBe("Not sent: Plans, to alex@example.com");
    expect(outboxLine(item({ subject: " ", to: ["a@example.com", "b@example.com", "c@example.com", "d@example.com", "e@example.com"] }))).toBe("Not sent: (no subject), to a@example.com, b@example.com, c@example.com and 2 more");
  });
  it("no text has a dash used as a pause", () => {
    for (const t of Object.values(SEND_TEXTS)) expect(t).not.toMatch(/[–—]/);
  });
});

describe("mail send: another account's sending server", () => {
  it("is only hinted from the IMAP server's name, never filled in", () => {
    expect(smtpGuess("imap.fastmail.com")).toBe("smtp.fastmail.com");
    expect(smtpGuess("mail.example.org")).toBe("mail.example.org");
    expect(smtpGuess("")).toBe("smtp.example.com");
  });
});
