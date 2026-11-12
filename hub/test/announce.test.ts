import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { announce, announcement, answer, homeAddress, SERVICE_TYPE } from "../src/announce.js";

const fp = "ab".repeat(32);
const a = announcement(48731, fp);

test("the Home Wi-Fi announcement names nothing personal", () => {
  assert.equal(a.name, "Aeneas hub abababab");
  assert.equal(a.host, "aeneas-abababab.local");
});

test("a browse gets the service, where it is, its fingerprint and one address, in one answer", () => {
  const r = answer({ name: SERVICE_TYPE, type: "PTR" }, a, "192.168.1.20");
  assert.deepEqual(r.answers.map((x) => x.data), [`${a.name}.${SERVICE_TYPE}`]);
  assert.deepEqual(r.additionals.map((x) => x.type), ["SRV", "TXT", "A"]);
  assert.deepEqual((r.additionals[0].data as { port: number }).port, 48731);
  assert.deepEqual(r.additionals[1].data, [`fp=${fp}`, "v=1"]);
  assert.equal(r.additionals[2].data, "192.168.1.20");
  // Other names and types get nothing.
  assert.equal(answer({ name: "_ssh._tcp.local", type: "PTR" }, a, "192.168.1.20").answers.length, 0);
  assert.deepEqual(answer({ name: a.host, type: "A" }, a, "192.168.1.20").answers.map((x) => x.data), ["192.168.1.20"]);
  assert.equal(answer({ name: a.host, type: "AAAA" }, a, "192.168.1.20").answers.length, 0);
});

test("the hub answers a browse on the home network with its home address only", async (t) => {
  const ip = await homeAddress();
  if (!ip) { t.skip("no home network here"); return; }
  assert.ok(!/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip), "not a Tailscale address");
  announce(a);
  const mdns = createRequire(import.meta.url)("multicast-dns")({ interface: ip, bind: "0.0.0.0" });
  try {
    const got = await new Promise<{ port: number; txt: string[]; addrs: string[] }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no answer within 5 s")), 5000);
      mdns.on("response", (res: { answers: { name: string; type: string; data: unknown }[]; additionals: { name: string; type: string; data: unknown }[] }) => {
        const all = [...res.answers, ...res.additionals];
        const srv = all.find((x) => x.type === "SRV" && x.name === `${a.name}.${SERVICE_TYPE}`);
        if (!srv) return;
        clearTimeout(timer);
        resolve({
          port: (srv.data as { port: number }).port,
          txt: ((all.find((x) => x.type === "TXT")?.data as Buffer[]) ?? []).map(String),
          addrs: all.filter((x) => x.type === "A").map((x) => String(x.data)),
        });
      });
      const ask = () => mdns.query({ questions: [{ name: SERVICE_TYPE, type: "PTR" }] });
      setTimeout(ask, 300);
      setTimeout(ask, 1500);
    });
    assert.equal(got.port, 48731);
    assert.deepEqual(got.txt, [`fp=${fp}`, "v=1"]);
    assert.deepEqual(got.addrs, [ip]);
  } finally {
    announce(null);
    mdns.destroy();
  }
});
