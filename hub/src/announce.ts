import dgram from "node:dgram";
import { createRequire } from "node:module";
import { errCode } from "./logsafe.js";

/**
 * Home Wi-Fi only: the hub says on the home network where it is now (Bonjour, `_aeneas._tcp`), so a phone or computer
 * paired with it finds it again after the router hands the hub a new address.
 *
 * What it says: the port, the address it has on the home network, and the SHA-256 of the hub's certificate (`fp`),
 * which every device on the network can already see by connecting. Nothing personal: the service is named "Aeneas hub"
 * and the first characters of that fingerprint, on a host name of its own (not the computer's). The announcement only
 * points the way; a device still accepts the hub only when it presents the certificate pinned from the QR code, so a
 * stand-in announcing the same name gets nowhere.
 *
 * It goes out on the network adapter with the way out (the one the router serves), never on virtual ones (WSL,
 * Hyper-V, Docker) or Tailscale, and names only that adapter's address. That adapter is looked up again every minute,
 * so a new address from the router is announced within a minute.
 *
 * Off for Direct link and Tailscale, which find the hub on their own.
 */
export const SERVICE_TYPE = "_aeneas._tcp.local";

export interface Announcement { name: string; host: string; port: number; fp: string }

export function announcement(port: number, fp: string): Announcement {
  return { name: `Aeneas hub ${fp.slice(0, 8)}`, host: `aeneas-${fp.slice(0, 8)}.local`, port, fp };
}

interface Question { name: string; type: string }
interface DnsRecord { name: string; type: string; ttl?: number; flush?: boolean; data: unknown }
interface Mdns {
  on(ev: "query", f: (q: { questions?: Question[] }) => void): void;
  on(ev: "error" | "warning", f: (e: Error) => void): void;
  respond(r: { answers: DnsRecord[]; additionals?: DnsRecord[] }, cb?: (e?: Error | null) => void): void;
  destroy(cb?: () => void): void;
}
const makeMdns = createRequire(import.meta.url)("multicast-dns") as (opts: object) => Mdns;

/** The records for `a` at `ip`: the service list entry, the service, where it is, its fingerprint, and the address. */
export function records(a: Announcement, ip: string, ttl = 120): { ptr: DnsRecord[]; service: DnsRecord[] } {
  const inst = `${a.name}.${SERVICE_TYPE}`;
  return {
    ptr: [
      { name: "_services._dns-sd._udp.local", type: "PTR", ttl, data: SERVICE_TYPE },
      { name: SERVICE_TYPE, type: "PTR", ttl, data: inst },
    ],
    service: [
      { name: inst, type: "SRV", ttl, flush: true, data: { priority: 0, weight: 0, port: a.port, target: a.host } },
      { name: inst, type: "TXT", ttl, flush: true, data: [`fp=${a.fp}`, "v=1"] },
      { name: a.host, type: "A", ttl, flush: true, data: ip },
    ],
  };
}

/** What to answer for one question, and what to add so the asker needs no second round. */
export function answer(q: Question, a: Announcement, ip: string): { answers: DnsRecord[]; additionals: DnsRecord[] } {
  const r = records(a, ip);
  const name = q.name.toLowerCase();
  const answers = [...r.ptr, ...r.service].filter((x) => x.name.toLowerCase() === name && (q.type === "ANY" || q.type === x.type));
  const additionals = answers.some((x) => x.type === "PTR" && x.name === SERVICE_TYPE) ? r.service : [];
  return { answers, additionals };
}

/** The address of the adapter with the way out: the system's routing table decides (a UDP "connect" sends nothing). */
export function homeAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    const done = (v: string | null) => { try { s.close(); } catch { /* closed */ } resolve(v); };
    s.on("error", () => done(null));
    s.connect(53, "1.1.1.1", () => {
      let v: string | null = null;
      try { v = s.address().address; } catch { v = null; }
      // Tailscale's addresses (100.64.0.0/10) are not the home network.
      done(v && v !== "0.0.0.0" && !isCgnat(v) ? v : null);
    });
  });
}

function isCgnat(v: string): boolean {
  const [a, b] = v.split(".").map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

let wanted: Announcement | null = null;
let ip: string | null = null;
let mdns: Mdns | null = null;
let timer: NodeJS.Timeout | null = null;

/** Starts, changes or stops the announcement; `a` null stops it. Never throws: the hub works without it. */
export function announce(a: Announcement | null): void {
  if (a && wanted && a.name === wanted.name && a.host === wanted.host && a.port === wanted.port && a.fp === wanted.fp) return;
  stopResponder();
  wanted = a;
  ip = null;
  if (timer) { clearInterval(timer); timer = null; }
  if (!a) return;
  void refresh();
  timer = setInterval(() => void refresh(), 60_000);
  timer.unref();
}

/** Looks up the home network's address and, when it changed, announces again from there. */
async function refresh(): Promise<void> {
  const a = wanted;
  if (!a) return;
  const now = await homeAddress();
  if (a !== wanted || (now === ip && mdns)) return;
  stopResponder();
  ip = now;
  if (!now) { console.error("[announce] no home network found: the hub is not announced"); return; }
  try {
    const m = makeMdns({ interface: now, bind: "0.0.0.0", reuseAddr: true });
    m.on("error", (e) => console.error(`[announce] the home network announcement failed (${errCode(e)})`));
    m.on("warning", () => { /* a malformed packet from some other device */ });
    m.on("query", (q) => {
      if (mdns !== m || !wanted || !ip) return;
      const answers: DnsRecord[] = [];
      const additionals: DnsRecord[] = [];
      for (const question of q.questions ?? []) {
        const r = answer(question, wanted, ip);
        for (const x of r.answers) if (!answers.includes(x)) answers.push(x);
        for (const x of r.additionals) if (!additionals.some((y) => y.name === x.name && y.type === x.type)) additionals.push(x);
      }
      if (answers.length) m.respond({ answers, additionals: additionals.filter((x) => !answers.some((y) => y.name === x.name && y.type === x.type)) });
    });
    mdns = m;
    // Said twice, a second apart, so devices that missed the first hear it (RFC 6762, 8.3).
    const r = records(a, now);
    const say = () => { if (mdns === m) m.respond({ answers: [...r.ptr, ...r.service] }); };
    say();
    setTimeout(say, 1000).unref();
    console.log(`[announce] announcing the hub on the home network, port ${a.port}`);
  } catch (e) {
    console.error(`[announce] the home network announcement did not start (${errCode(e)})`);
    stopResponder();
  }
}

function stopResponder(): void {
  const m = mdns;
  mdns = null;
  if (!m) return;
  // A goodbye (TTL 0), so devices forget the old address at once.
  if (wanted && ip) {
    try {
      const r = records(wanted, ip, 0);
      m.respond({ answers: [r.ptr[1], ...r.service] }, () => { try { m.destroy(); } catch { /* closed */ } });
      return;
    } catch { /* closing anyway */ }
  }
  try { m.destroy(); } catch { /* already closed */ }
}
