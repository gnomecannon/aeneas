/**
 * Connections that broke after setup (since 2026-11-27, hub `connection-problems.ts`): a mailbox whose password was
 * revoked, an ended sign-in, a Steam key Steam stopped taking. They were said only on their own Settings page, so mail
 * and films simply stopped coming in; Today's Needs you, the Settings rows, Mail and Week now say so, each with the one
 * button that opens the fix. No DOM, so the rules are tested here (connectionProblems.test.ts); EACore's
 * `ConnectionProblem` follows the same ones.
 */
export interface ConnectionProblem {
  id: string;
  service: string;
  title: string;
  detail: string;
  fix: "account" | "connections";
  account?: string;
  button: string;
  affects: string[];
  since: string | null;
}

/**
 * The page with the fix: an account's page with Replace already open, or Settings, Connections. An account the hub
 * did not name (an older hub) opens the list of accounts.
 */
export function fixPath(p: Pick<ConnectionProblem, "fix" | "account"> & { id?: string }): string {
  if (p.fix === "account") return p.account ? `/settings/accounts/${encodeURIComponent(p.account)}?replace=1` : "/settings/accounts";
  // Opened at the service's own section (`?show=`), as a module's Set it up now does: at the page's top its button was
  // below the fold.
  const section = p.id === "atlassian" ? "confluence" : p.id;
  return section === "steam" || section === "letterboxd" || section === "confluence" ? `/settings/connections?show=${section}` : "/settings/connections";
}

/** The problems a screen says besides Today and Settings: `mail` on Mail, `calendar` on Week. */
export function problemsFor(list: ConnectionProblem[] | undefined, area: string): ConnectionProblem[] {
  return (list ?? []).filter((p) => p.affects.includes(area));
}

/**
 * A Settings row's summary while some of its connections are broken (Accounts: `fix` account, Connections: the
 * rest): the one problem's title, or how many need you. Null while none does, and the row keeps its usual summary.
 */
export function rowWarning(list: ConnectionProblem[] | undefined, fix: ConnectionProblem["fix"]): string | null {
  const mine = (list ?? []).filter((p) => p.fix === fix);
  if (!mine.length) return null;
  return mine.length === 1 ? mine[0].title : `${mine.length} ${fix === "account" ? "accounts" : "connections"} need you`;
}

/** The key of a Mail screen mailbox in Settings, Accounts: `icloud:<address>` for iCloud, `imap:<address>` for the rest. */
export const mailboxKey = (m: { email: string; kind?: string }) => `${m.kind === "icloud" ? "icloud" : "imap"}:${m.email}`;
