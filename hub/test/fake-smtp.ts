import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { SMTPServer, type SMTPServerSession } from "smtp-server";
import { setSmtpTest } from "../src/imports/smtp.js";

// A sending server on this machine for the Mail screen's send tests (mail-send, mail-proposals). Not a test file itself.

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "tls");
const CERT = fs.readFileSync(path.join(FIX, "hub-test.crt"), "utf8");
const KEY = fs.readFileSync(path.join(FIX, "hub-test.key"), "utf8");

export interface Got { from: string; to: string[]; raw: string; secure: boolean; user?: string }
export type Fake = { got: Got[]; port: number; closes: (() => void)[]; close: () => Promise<void> };

/**
 * A sending server on this machine: TLS on connect (`secure`) or STARTTLS, PLAIN and LOGIN sign-in only after TLS, the
 * recipients in `refuse` refused (550, or 450 for `later`), PIPELINING offered unless `pipelining` is false.
 */
export async function smtp(opts: { secure: boolean; user: string; pass: string; refuse?: string[]; later?: string[]; pipelining?: boolean; onClose?: (s: SMTPServerSession) => void; servername?: string; noStartTls?: boolean }): Promise<Fake> {
  const got: Got[] = [];
  const closes: (() => void)[] = [];
  const server = new SMTPServer({
    secure: opts.secure, key: KEY, cert: CERT, logger: false, disableReverseLookup: true, hidePIPELINING: opts.pipelining === false, authMethods: ["PLAIN", "LOGIN"],
    ...(opts.noStartTls ? { disabledCommands: ["STARTTLS"], allowInsecureAuth: true } : {}),
    onAuth(auth, _s, cb) {
      if (auth.username === opts.user && auth.password === opts.pass) cb(null, { user: auth.username });
      else cb(Object.assign(new Error("Invalid login"), { responseCode: 535 }));
    },
    onRcptTo(a, _s, cb) {
      if (opts.refuse?.includes(a.address)) { cb(Object.assign(new Error("No such user"), { responseCode: 550 })); return; }
      if (opts.later?.includes(a.address)) { cb(Object.assign(new Error("Try later"), { responseCode: 450 })); return; }
      cb();
    },
    onData(stream, s, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        got.push({ from: (s.envelope.mailFrom as { address: string }).address, to: s.envelope.rcptTo.map((r) => r.address), raw: Buffer.concat(chunks).toString(), secure: s.secure, user: s.user as string | undefined });
        cb();
      });
    },
    onClose(s) { opts.onClose?.(s); for (const f of closes) f(); },
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const port = (server.server.address() as AddressInfo).port;
  setSmtpTest({ route: () => [{ address: "127.0.0.1", port, servername: opts.servername ?? "localhost" }], ca: CERT, limits: { connect: 3000, greeting: 3000, socket: 5000, job: 10_000 } });
  return { got, port, closes, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

