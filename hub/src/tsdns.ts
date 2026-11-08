import dns from "node:dns";

/**
 * Tailscale name fallback.
 *
 * Hosts without MagicDNS (core uses systemd-resolved, not 100.100.100.100) cannot
 * resolve `*.ts.net` names. This wraps `dns.lookup`, which `net`, `tls` and `fetch`
 * all use, so a failed lookup of a Tailscale name is retried against the Tailscale
 * resolver. Every other name and every successful lookup is untouched.
 */

type LookupCb = (err: NodeJS.ErrnoException | null, address?: string | dns.LookupAddress[], family?: number) => void;

let installed = false;

export function installTailscaleLookup(server = process.env.EA_TS_RESOLVER || "100.100.100.100", suffix = ".ts.net"): void {
  if (installed) return;
  installed = true;
  const original = dns.lookup;
  const resolver = new dns.promises.Resolver();
  resolver.setServers([server]);

  const patched = function (hostname: string, options: unknown, callback?: unknown): void {
    const cb = (typeof options === "function" ? options : callback) as LookupCb;
    const opts = (typeof options === "function" ? {} : typeof options === "number" ? { family: options } : (options ?? {})) as dns.LookupOptions;
    (original as unknown as (h: string, o: dns.LookupOptions, c: LookupCb) => void)(hostname, opts, (err, address, family) => {
      if (!err || typeof hostname !== "string" || !hostname.toLowerCase().endsWith(suffix)) return cb(err, address, family);
      if (err.code !== "ENOTFOUND" && err.code !== "EAI_AGAIN") return cb(err, address, family);
      resolver.resolve4(hostname).then(
        (addrs) => {
          if (!addrs.length) return cb(err, address, family);
          if (opts.all) return cb(null, addrs.map((a) => ({ address: a, family: 4 })));
          return cb(null, addrs[0], 4);
        },
        () => cb(err, address, family),
      );
    });
  };
  (dns as unknown as { lookup: unknown }).lookup = patched;
}
