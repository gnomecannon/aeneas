import type { Hub } from "./hub.js";
import { StoreError } from "./store.js";
import { GMAIL_SCOPE } from "./imports/gmail.js";

/**
 * Guided setup for the services that need the person's own key or app (release rule 3, Phase 3 of
 * docs/05-public-release.md): Gmail (their own Google app), Confluence (their own Atlassian app) and Steam playtime
 * (their own Steam Web API key). There is no server of the project's in between, so each person makes their own.
 *
 * One guide per service, written here once so the web and Apple apps show the same steps: one step at a time, with
 * the exact values to copy filled in for this hub (its return address, the permissions), a link to the service's own
 * page, and at the end the fields to fill and a check that says in plain words what is wrong. The values typed go
 * to the hub's own routes (`PUT /connections/google/app`, `/connections/atlassian/app`, `/connections/steam/key`),
 * are kept on the hub only and are never shown again.
 */

export type GuideService = "google" | "atlassian" | "steam";
export const GUIDE_SERVICES: GuideService[] = ["google", "atlassian", "steam"];

export interface GuideStep {
  title: string;
  /** What to do, in plain words. */
  text: string;
  /** Values to copy exactly, filled in for this hub. */
  copy?: { label: string; value: string }[];
  /** The service's own page for this step. */
  link?: { label: string; url: string };
  /** The last step: what to paste back, and the route that takes it. */
  fields?: { id: string; label: string; secret: boolean; placeholder?: string }[];
  save?: { method: "PUT"; path: string };
  /** A check the app runs after saving (POST, no body), when the service allows one without signing in. */
  test?: { path: string };
}

export interface Guide {
  service: GuideService;
  title: string;
  minutes: string;
  /** Whether this hub already has the key or app. */
  done: boolean;
  /** What comes after: the sign-in, which is also the final check. */
  after: string;
  /** Anything about this hub's address that stops the service from working. */
  warning: string | null;
  steps: GuideStep[];
}

function hostIsIp(address: string): boolean {
  try { return /^\d{1,3}(\.\d{1,3}){3}$/.test(new URL(address).hostname) || new URL(address).hostname.includes(":"); } catch { return false; }
}

export function guideFor(hub: Hub, service: GuideService, address: string): Guide {
  const view = hub.connections.view();
  const https = address.startsWith("https:");
  if (service === "google") {
    // docs/gmail-setup.md has these steps for reading before an install: change both (test/gmail-setup-doc.test.ts).
    const ret = `${address}/connections/google/return`;
    return {
      service, title: "Your own Google app, for Gmail", minutes: "10 to 15", done: view.google.app,
      after: "Sign in with Google below. Google shows a screen saying it has not verified the app: it is your own app, so choose Advanced, then Go to Aeneas, and allow reading mail.",
      warning: !https ? "Google sends people back only to an https address, and this hub is reached over plain http. Reach it through Tailscale (an https ts.net address) to use Gmail."
        : hostIsIp(address) ? "Google does not accept an IP address as a return address. Reach the hub through its Tailscale name (ts.net) to use Gmail." : null,
      steps: [
        { title: "Make a Google Cloud project", text: "Sign in with the Google account whose mail Aeneas should read, and create a project. Any name works.", copy: [{ label: "Project name", value: "Aeneas" }], link: { label: "Create a project", url: "https://console.cloud.google.com/projectcreate" } },
        { title: "Turn on the Gmail API", text: "With the new project selected at the top of the page, press Enable.", link: { label: "Gmail API", url: "https://console.cloud.google.com/apis/library/gmail.googleapis.com" } },
        { title: "Set up the sign-in screen", text: "Press Get started. App name: Aeneas. Support email and contact email: your own. Audience: External. Agree and press Create.", copy: [{ label: "App name", value: "Aeneas" }, { label: "Privacy policy (optional)", value: `${address}/privacy` }], link: { label: "Google Auth Platform", url: "https://console.cloud.google.com/auth/overview" } },
        { title: "Let it keep working", text: "In Audience, press Publish app and confirm, so the status says In production. Left in Testing, Google ends the sign-in every 7 days. You are its only user, so Google does not need to review it.", link: { label: "Audience", url: "https://console.cloud.google.com/auth/audience" } },
        { title: "Allow reading mail, nothing else", text: "In Data Access, press Add or remove scopes, paste the scope below into Manually add scopes, press Add to table, then Update and Save. Aeneas only reads; it never sends, changes or deletes mail.", copy: [{ label: "Scope", value: GMAIL_SCOPE }], link: { label: "Data Access", url: "https://console.cloud.google.com/auth/scopes" } },
        { title: "Make the client", text: "In Clients, press Create client. Application type: Web application. Name: Aeneas. Under Authorized redirect URIs press Add URI and paste the address below exactly. Press Create, then copy the Client ID and the Client secret.", copy: [{ label: "Authorized redirect URI", value: ret }], link: { label: "Clients", url: "https://console.cloud.google.com/auth/clients" } },
        { title: "Paste them here", text: "They are kept on your hub only and never shown again.", fields: [{ id: "client_id", label: "Client ID", secret: false, placeholder: "1234...apps.googleusercontent.com" }, { id: "client_secret", label: "Client secret", secret: true, placeholder: "GOCSPX-..." }], save: { method: "PUT", path: "/connections/google/app" }, test: { path: "/connections/google/app/test" } },
      ],
    };
  }
  if (service === "atlassian") {
    const ret = `${address}/connections/atlassian/return`;
    return {
      service, title: "Your own Atlassian app, for Confluence", minutes: "10", done: view.atlassian.app,
      after: "Sign in with Atlassian below and choose the site. That sign-in is the check: Atlassian says there what is wrong. A company site may need its admin to allow apps it has not seen before.",
      warning: !https ? "Atlassian sends people back only to an https address, and this hub is reached over plain http. Reach it through Tailscale (an https ts.net address) to use Confluence." : null,
      steps: [
        { title: "Make the app", text: "Sign in with your Atlassian account. Press Create, choose OAuth 2.0 integration, name it, agree to the terms and press Create.", copy: [{ label: "Name", value: "Aeneas" }], link: { label: "Atlassian developer console", url: "https://developer.atlassian.com/console/myapps/" } },
        { title: "Allow reading Confluence, nothing else", text: "In Permissions, press Add next to Confluence API, then Configure. Open Granular scopes, press Edit Scopes, tick the three below and press Save. Aeneas only reads the spaces you pick.", copy: [{ label: "Scopes", value: "read:space:confluence read:page:confluence read:attachment:confluence" }] },
        { title: "Set the return address", text: "In Authorization, press Add next to OAuth 2.0 (3LO), paste the address below as the Callback URL, and press Save changes.", copy: [{ label: "Callback URL", value: ret }] },
        { title: "Copy the client", text: "In Settings, copy the Client ID and the Secret. Distribution can stay as it is: the app is only for your own account." },
        { title: "Paste them here", text: "They are kept on your hub only and never shown again.", fields: [{ id: "client_id", label: "Client ID", secret: false }, { id: "client_secret", label: "Secret", secret: true }], save: { method: "PUT", path: "/connections/atlassian/app" } },
      ],
    };
  }
  let host = "localhost";
  try { host = new URL(address).hostname; } catch { /* keep localhost */ }
  return {
    service, title: "Your own Steam key, for playtime", minutes: "2", done: view.steam.hub_key,
    after: "Sign in with Steam below. In Steam, Edit Profile, Privacy Settings, set Game details to Public, or Steam sends no games.",
    warning: null,
    steps: [
      { title: "Before you start", text: "Steam gives keys only to accounts that have spent at least $5 in the Steam store and have Steam Guard on in the Steam app on a phone. Changing your Steam password can cancel the key; make a new one here if that happens." },
      { title: "Register a key", text: "Sign in, type the domain name below (any name works; Steam does not check it), agree to the terms, press Register and confirm in the Steam app if it asks. Copy the Key.", copy: [{ label: "Domain name", value: host }], link: { label: "Steam Web API key", url: "https://steamcommunity.com/dev/apikey" } },
      { title: "Paste it here", text: "It is kept on your hub only, never shown again, and checked with Steam now.", fields: [{ id: "api_key", label: "Key", secret: true, placeholder: "32 letters and digits" }], save: { method: "PUT", path: "/connections/steam/key" } },
    ],
  };
}

export function parseGuideService(s: string): GuideService {
  if (!(GUIDE_SERVICES as string[]).includes(s)) throw new StoreError(404, "no guide for that: google, atlassian or steam");
  return s as GuideService;
}
