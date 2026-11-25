import SMTPConnection from "nodemailer/lib/smtp-connection";
import { StoreError } from "../store.js";

/**
 * Sending mail (since 2026-11-24): one message the owner wrote and pressed Send for on the Mail screen, handed to the
 * account's own sending server with SMTP and its own password (nodemailer's SMTPConnection, nothing else of the
 * library). Gmail is `smtp.gmail.com` port 465 with TLS on connect, iCloud `smtp.mail.me.com` port 587 with STARTTLS,
 * another mail account the server, port and security the owner gave (icloud.ts smtpLogin). What this file holds to:
 * - TLS always: on connect, or STARTTLS that must take (a server that does not offer it is never written to in the
 *   clear); the certificate checked against the server's name, whatever address the hub connects to;
 * - the server's name looked up by the caller and every address checked (none on the owner's own network), each
 *   tried in turn, as for IMAP (icloud.ts publicAddresses); a connection only to a checked address;
 * - hard time limits: on the connection, the greeting, each answer, and the whole job;
 * - all or nothing: when the server refuses any recipient, nothing is sent to the others either (the message is
 *   never handed over), so a mail is never half sent;
 * - the hub names itself `[127.0.0.1]` in its greeting, never its machine's name, and logs nothing of the talk;
 * - the server's own words are never shown or logged: each failure is told in the hub's words (SendFailed).
 */

export type SmtpSecurity = "tls" | "starttls";
/** Who signs in to send, and where. `name`: the provider in the hub's words (Gmail, iCloud Mail, the server's name). */
export interface SmtpLogin { host: string; port: number; security: SmtpSecurity; user: string; pass: string; name: string }
/** One address to connect to: a checked address of the server, its port, and the name its certificate must carry. */
export interface SmtpTarget { address: string; port: number; servername: string }

/** Why a send failed, in kinds the screen and the outbox tell apart; `message` is the hub's own sentence. */
export type SendFailure = "password" | "recipient" | "sender" | "refused" | "later" | "certificate" | "reach";
export class SendFailed extends StoreError {
  constructor(public kind: SendFailure, message: string, public refused: string[] = []) { super(kind === "password" || kind === "recipient" || kind === "sender" ? 422 : 502, message); }
}

/** The time limits (tests shorten them). `job`: the whole of one send, connection included. */
const LIMITS = { connect: 15_000, greeting: 15_000, socket: 60_000, job: 3 * 60_000 };
/** For tests: where a server's name leads (a local fake server), the certificate it is trusted by, and the limits. */
let testRoute: ((host: string, port: number) => SmtpTarget[]) | null = null;
let testCa: string | null = null;
export function setSmtpTest(t: { route?: ((host: string, port: number) => SmtpTarget[]) | null; ca?: string | null; limits?: Partial<typeof LIMITS> } | null) {
  testRoute = t?.route ?? null;
  testCa = t?.ca ?? null;
  Object.assign(LIMITS, { connect: 15_000, greeting: 15_000, socket: 60_000, job: 3 * 60_000 }, t?.limits ?? {});
}

/** The addresses to try for a login: the caller's checked ones, at the login's port, the certificate held to the name. */
async function targetsOf(login: SmtpLogin, addresses: (host: string) => Promise<string[]>): Promise<SmtpTarget[]> {
  if (testRoute) return testRoute(login.host, login.port);
  return (await addresses(login.host)).map((address) => ({ address, port: login.port, servername: login.host }));
}

type Conn = SMTPConnection & { _envelope?: { rejected: string[]; mailError?: Error & { rejected?: string[] } }; _envelopeError?: (str: string) => Error | null };

/** One connection, signed in, for one job: closed at the end whatever happens, and given up at the job's limit. */
type Step = <R>(go: (ok: (v: R) => void, fail: (e: unknown) => void) => void) => Promise<R>;
async function withSmtp<T>(login: SmtpLogin, addresses: (host: string) => Promise<string[]>, job: (c: Conn, step: Step) => Promise<T>): Promise<T> {
  let c: Conn | undefined;
  let over = false;
  let timer: NodeJS.Timeout | undefined;
  const close = () => { try { c?.close(); } catch { /* closed already */ } };
  let onError: (e: Error) => void = () => {};
  /** One step with the server: done when its call answers, failed when it fails or the connection does. */
  const step = <R>(go: (ok: (v: R) => void, fail: (e: unknown) => void) => void) => new Promise<R>((ok, fail) => {
    // The call's own answer wins: the library closes the connection (an event) just before it answers with the reason.
    onError = (e) => { setTimeout(() => fail(e), 50).unref?.(); };
    go(ok, fail);
  }).finally(() => { onError = () => {}; });
  const run = (async () => {
    const targets = await targetsOf(login, addresses);
    if (!targets.length) throw new SendFailed("reach", `The hub could not find ${login.name}'s sending server, so the mail was not sent.`);
    for (const [i, t] of targets.entries()) {
      if (over) throw new SendFailed("reach", reachText(login));
      c = new SMTPConnection({
        host: t.address, port: t.port, servername: t.servername,
        secure: login.security === "tls", requireTLS: login.security === "starttls", ignoreTLS: false, opportunisticTLS: false,
        name: "[127.0.0.1]", logger: false, debug: false, transactionLog: false,
        connectionTimeout: LIMITS.connect, greetingTimeout: LIMITS.greeting, socketTimeout: LIMITS.socket,
        tls: { servername: t.servername, rejectUnauthorized: true, minVersion: "TLSv1.2", ...(testCa ? { ca: testCa } : {}) },
      }) as Conn;
      // The library emits what goes wrong with the connection (refused, closed, a bad certificate) as an event, not
      // through the call that waits: each step below ends on either. One emitted after the end must not stop the hub.
      const conn = c;
      conn.on("error", (e: Error) => onError(e));
      conn.on("end", () => onError(Object.assign(new Error("the connection closed"), { code: "ECONNECTION" })));
      try {
        await step<void>((ok, fail) => conn.connect((e) => (e ? fail(e) : ok())));
        break;
      } catch (e) {
        close();
        // Only an address that takes no connection gives way to the next one; a certificate or a refusal is the server's answer.
        if (i === targets.length - 1 || !unreachable(e)) throw e;
      }
    }
    const conn = c!;
    await step<void>((ok, fail) => conn.login({ user: login.user, pass: login.pass }, (e) => (e ? fail(e) : ok())));
    return job(conn, step);
  })();
  run.catch(() => {}); // after the limit it ends on its own, as the connection is closed under it
  try {
    return await Promise.race([run, new Promise<never>((_, fail) => {
      timer = setTimeout(() => { over = true; close(); fail(new SendFailed("reach", reachText(login))); }, LIMITS.job);
      timer.unref?.();
    })]);
  } catch (e) {
    throw failure(e, login);
  } finally {
    clearTimeout(timer);
    try { c?.quit(); } catch { /* closed already */ }
    setTimeout(close, 2000).unref?.();
  }
}

/** A connection that never came up (refused, timed out, no route): the next address may still answer. */
const unreachable = (e: unknown) => ["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS"].includes(String((e as { code?: string })?.code)) && !tlsProblem(e);
const tlsProblem = (e: unknown) => {
  const x = e as { code?: string; originalCode?: string; message?: string } | null;
  return x?.code === "ETLS" || /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|HOSTNAME|TLS/i.test(`${x?.originalCode ?? ""} ${x?.message ?? ""}`);
};
const reachText = (login: SmtpLogin) => `${login.name} could not be reached from the hub, or stopped answering, so the mail was not sent. Check the hub's internet connection and try again.`;

/** The hub's own words for a failure: never the server's, which can repeat an address or say anything at all. */
function failure(e: unknown, login: SmtpLogin): StoreError {
  // The hub's own refusals (the sending server's name not found, or on the owner's own network) say what they are.
  if (e instanceof StoreError) return e;
  const x = e as { code?: string; command?: string; responseCode?: number; rejected?: string[] } | null;
  const temporary = typeof x?.responseCode === "number" && x.responseCode >= 400 && x.responseCode < 500;
  if (x?.code === "EAUTH") return new SendFailed("password", `${login.name} did not accept the account's password for sending, so the mail was not sent. Check the app password in Settings, Accounts.`);
  if (x?.code === "EENVELOPE" && x.rejected?.length) {
    const who = x.rejected.slice(0, 5).join(", ");
    return temporary
      ? new SendFailed("later", `${login.name} asked to try ${who} again later, so the mail was not sent. Try again in a few minutes.`, x.rejected)
      : new SendFailed("recipient", `${login.name} refused ${who}, so the mail was not sent to anyone. Check the address and try again.`, x.rejected);
  }
  if (x?.code === "EENVELOPE" && x.command === "MAIL FROM") return new SendFailed("sender", `${login.name} would not send from this address, so the mail was not sent.`);
  if (temporary) return new SendFailed("later", `${login.name} asked to try again later, so the mail was not sent. Try again in a few minutes.`);
  if (x?.code === "EMESSAGE" || x?.code === "EENVELOPE") return new SendFailed("refused", `${login.name} did not take the mail, so it was not sent. It may be too big for the server.`);
  // STARTTLS that the server does not offer: nothing is said in the clear.
  if (/STARTTLS/i.test(String((e as { message?: string })?.message ?? ""))) return new SendFailed("certificate", `${login.name} did not offer STARTTLS, so the hub sent nothing to it. Check the sending server's security.`);
  if (tlsProblem(e)) return new SendFailed("certificate", `${login.name} did not show a valid certificate for its name, so the hub sent nothing to it.`);
  return new SendFailed("reach", reachText(login));
}

/**
 * Send one message as it is (`raw`, built by mail-compose.ts, the same bytes a draft would be) to the envelope's
 * recipients, signed in as the login. Resolves once the server has taken it; throws SendFailed otherwise. `taken` runs
 * the moment the server answers that it has the message, before the connection is closed (the outbox marks the mail
 * sent there, so a hub that stops right after never sends it again).
 */
export async function smtpSend(login: SmtpLogin, envelope: { from: string; to: string[] }, raw: Buffer, addresses: (host: string) => Promise<string[]>, taken: () => void = () => {}): Promise<void> {
  await withSmtp(login, addresses, (c, step) => step<void>((ok, fail) => {
    // All or nothing: a recipient the server refuses ends the message before it is handed over, as if all were. (The
    // library goes on with the ones it took; its envelope check is asked here first, so the refusal ends the
    // transaction, pipelined or not, and a server that took DATA anyway gets no message: the connection is dropped.)
    const decide = c._envelopeError?.bind(c);
    if (decide) {
      c._envelopeError = (str: string) => {
        const env = c._envelope;
        if (env && !env.mailError && env.rejected.length) {
          const err = Object.assign(new Error("a recipient was refused"), { code: "EENVELOPE", command: "RCPT TO", rejected: [...env.rejected], responseCode: (/^\d+/.exec(str) ? Number(/^\d+/.exec(str)![0]) : undefined) });
          // The refusal's own code (a 4xx says later, a 5xx says no), not DATA's.
          const first = (env as { rejectedErrors?: { responseCode?: number }[] }).rejectedErrors?.[0]?.responseCode;
          if (first) err.responseCode = first;
          env.mailError = err;
        }
        return decide(str);
      };
    }
    c.send(envelope, raw, (e) => {
      if (e) { fail(e); return; }
      try { taken(); } catch { /* the caller logs its own */ }
      ok();
    });
  }));
}

/** Sign in once and leave (a sending server the owner gave is checked before it is kept). */
export async function smtpCheck(login: SmtpLogin, addresses: (host: string) => Promise<string[]>): Promise<void> {
  await withSmtp(login, addresses, async () => {});
}

/** Gmail and iCloud's sending servers: fixed, as their IMAP servers are. */
export const SMTP_PRESETS = {
  gmail: { host: "smtp.gmail.com", port: 465, security: "tls" as SmtpSecurity, name: "Gmail" },
  icloud: { host: "smtp.mail.me.com", port: 587, security: "starttls" as SmtpSecurity, name: "iCloud Mail" },
} as const;

/**
 * The sending server of a linked account, as its page shows it (never the password): iCloud's for an iCloud account
 * (no IMAP host), Gmail's for Gmail (linked as Google, or a server whose name is Gmail's), else the one the owner gave;
 * null when there is none (the account saves drafts and does not send).
 */
export function sendingServer(a: { email: string; host?: string; preset?: string; smtp?: { host: string; port: number; security: SmtpSecurity } }): { host: string; port: number; security: SmtpSecurity } | null {
  const preset = !a.host ? SMTP_PRESETS.icloud : a.preset === "gmail" || /(^|\.)(gmail|googlemail)\.com$/.test(a.host) ? SMTP_PRESETS.gmail : null;
  if (preset) return { host: preset.host, port: preset.port, security: preset.security };
  return a.smtp ? { host: a.smtp.host, port: a.smtp.port, security: a.smtp.security } : null;
}

/**
 * A sending server the owner gives for another mail account: `{ host, port?, security? }`. A name, never an address
 * (at most 253); TLS on connect (`tls`, port 465 when none is given) or STARTTLS (`starttls`, port 587), never neither.
 * Null for null (no sending server: the account saves drafts and does not send).
 */
export function checkedSmtp(v: unknown): { host: string; port: number; security: SmtpSecurity } | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new StoreError(422, "smtp is the sending server: { host, port, security }");
  const o = v as Record<string, unknown>;
  const host = typeof o.host === "string" ? o.host.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!host) return null;
  if (host.length > 253 || !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) throw new StoreError(422, "The sending server is a name, like smtp.fastmail.com.");
  const security = o.security === undefined || o.security === null || o.security === "" ? (Number(o.port) === 465 ? "tls" : "starttls") : o.security;
  if (security !== "tls" && security !== "starttls") throw new StoreError(422, "The sending server's security is TLS (most often port 465) or STARTTLS (most often port 587).");
  const port = o.port === undefined || o.port === null || o.port === "" ? (security === "tls" ? 465 : 587) : Number(o.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new StoreError(422, "The sending server's port is a number, most often 465 or 587.");
  return { host, port, security };
}
