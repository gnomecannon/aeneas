/**
 * A mail the assistant wrote for the owner to send with one tap (since 2026-11-24, CONTRACT.md Mail, Mail from the
 * assistant): its card in the chat, the same on every device (EACore MailProposals.swift). The assistant sends
 * nothing: only the owner's Send on the card does, through the hub's outbox with its 10 seconds of Undo.
 */

/** A proposal as its card shows it (`GET /mail/proposals/:id`). */
export interface MailProposal {
  id: string;
  from: { name: string; address: string };
  to: string[];
  cc: string[];
  subject: string;
  text: string;
  files: { name: string; size: number }[];
  /** proposed, waiting (Sending, with Undo), sending, sent, failed (`error`: the hub's words), cancelled, edited. */
  state: "proposed" | "waiting" | "sending" | "sent" | "failed" | "cancelled" | "edited";
  error?: string;
  expires_at: string;
}
/** What Edit hands the Mail screen's writing box (`POST /mail/proposals/:id/edit`): the mail, its pictures as files. */
export interface MailProposalEdit { from: string; to: string[]; cc: string[]; subject: string; text: string; files: { name: string; type: string; data: string }[] }
/** What the chat keeps on the reply that proposed a mail: its id, and how it ended once it did. */
export interface ChatMailProposal { id: string; state?: "sent" | "cancelled" | "edited" }

export const PROPOSAL_TEXTS = {
  title: "A mail for you to send",
  notSent: "Nothing is sent until you tap Send.",
  sending: "Sending",
  sent: "Sent.",
  failed: "Not sent",
  cancelled: "Cancelled. Nothing was sent.",
  edited: "Opened on the Mail screen to edit. Send it from there.",
  expired: "This mail expired after 24 hours. Nothing was sent.",
  /** On the Watch, which has no writing box. */
  watchEdit: "To change it, open this chat on your iPhone.",
} as const;

export type ProposalButton = "send" | "edit" | "cancel" | "undo" | "retry";
export const PROPOSAL_BUTTONS: Record<ProposalButton, string> = { send: "Send", edit: "Edit", cancel: "Cancel", undo: "Undo", retry: "Try again" };

/**
 * What a proposal's card shows: its line, whether the mail itself shows, and its buttons. `view` null: the hub no
 * longer keeps it (24 hours went by), and the chat's `stored` end says how it ended, else that it expired.
 */
export function proposalFace(view: MailProposal | null, stored?: ChatMailProposal["state"]): { line: string; error?: string; showMail: boolean; buttons: ProposalButton[] } {
  if (!view) {
    const line = stored === "sent" ? PROPOSAL_TEXTS.sent : stored === "cancelled" ? PROPOSAL_TEXTS.cancelled : stored === "edited" ? PROPOSAL_TEXTS.edited : PROPOSAL_TEXTS.expired;
    return { line, showMail: false, buttons: [] };
  }
  switch (view.state) {
    case "proposed": return { line: PROPOSAL_TEXTS.notSent, showMail: true, buttons: ["send", "edit", "cancel"] };
    case "waiting": return { line: PROPOSAL_TEXTS.sending, showMail: true, buttons: ["undo"] };
    case "sending": return { line: PROPOSAL_TEXTS.sending, showMail: true, buttons: [] };
    case "sent": return { line: PROPOSAL_TEXTS.sent, showMail: true, buttons: [] };
    case "failed": return { line: PROPOSAL_TEXTS.failed, error: view.error ?? "The mail was not sent.", showMail: true, buttons: ["retry", "edit", "cancel"] };
    case "cancelled": return { line: PROPOSAL_TEXTS.cancelled, showMail: true, buttons: [] };
    default: return { line: PROPOSAL_TEXTS.edited, showMail: true, buttons: [] };
  }
}

/** Whether the card asks the hub again in a moment: while the mail waits or is on its way. */
export const proposalMoving = (v: MailProposal | null) => v?.state === "waiting" || v?.state === "sending";
