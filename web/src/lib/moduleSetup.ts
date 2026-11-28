/**
 * Where a module that needs an account, a link or a download is set up, so switching it on leads there instead of to
 * an empty screen ("Set it up now" under its switch, and the link in its Advanced setup line). Machines has its own
 * first steps (MachinesStart). A module not listed works as soon as it is on.
 */
export interface ModuleSetup { href: string; label: string; what: string }

export const MODULE_SETUP: Record<string, ModuleSetup> = {
  mail_inbox: { href: "/settings/accounts/add", label: "Add a mail account", what: "Mail needs a mail account to show." },
  mail: { href: "/settings/accounts/add", label: "Add a mail account", what: "Receipts and renewals reads a mail account you add." },
  calendars: { href: "/settings/accounts/add?kind=icloud", label: "Add an iCloud account", what: "Calendar accounts needs your iCloud account and an app-specific password." },
  reference: { href: "/settings/reference", label: "Choose what to download", what: "Offline reference needs the guides you want, downloaded to the hub." },
  games: { href: "/settings/connections?show=steam", label: "Link Steam", what: "Games brings in your library once Steam is linked." },
  films: { href: "/settings/connections?show=letterboxd", label: "Link Letterboxd", what: "Films reads your Letterboxd diary once it is linked." },
  wiki: { href: "/settings/connections?show=confluence", label: "Link Confluence", what: "Project wiki needs a Confluence space linked, or a repository's docs." },
};

/** The setup a module leads to, or null for one that needs none here. */
export function moduleSetup(id: string): ModuleSetup | null {
  return MODULE_SETUP[id] ?? null;
}

/** The Connections section a link asks for (`?show=steam`), when it is one this page has. */
export const CONNECTION_SECTIONS = ["steam", "letterboxd", "confluence"] as const;
export function connectionSection(show: string | null): (typeof CONNECTION_SECTIONS)[number] | null {
  return (CONNECTION_SECTIONS as readonly string[]).includes(show ?? "") ? (show as (typeof CONNECTION_SECTIONS)[number]) : null;
}
