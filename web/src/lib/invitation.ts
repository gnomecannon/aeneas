import { RELEASES_URL } from "./appUpdate";

/**
 * The invitation someone who lives elsewhere is sent (Settings, People on this machine; docs/helpers.md): three plain
 * steps, then the link their app finds in the pasted message (Setup, I was sent an invitation).
 */
export const APP_STORE = "https://apps.apple.com/app/id6832161802";

/** "Saturday, November 22 at 3:14 PM": when an invitation ends. */
export function until(iso?: string): string {
  if (!iso) return "3 days from now";
  const d = new Date(iso);
  return `${d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })} at ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

/** The message to send someone who lives elsewhere: plain steps, then the invitation their app finds in it. */
export function invitationMessage(name: string, from: string, link: string, expires?: string): string {
  return [
    `Hi ${name}, ${from ? `it's ${from}. ` : ""}I set up Aeneas for you.`,
    "",
    `1. Install the Aeneas app. On an iPhone or iPad: ${APP_STORE} . On an Android phone: ${RELEASES_URL} .`,
    "2. Copy this whole message: press and hold it, then tap Copy.",
    "3. Open Aeneas and tap Paste the invitation. It finds the invitation in this message and connects you.",
    "",
    `The invitation works once, until ${until(expires)}.`,
    link,
  ].join("\n");
}

