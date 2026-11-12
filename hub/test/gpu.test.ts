import { test } from "node:test";
import assert from "node:assert/strict";
import { gpuBusy, gpuBusyNow, gpuBusyWindows, gpuProbe, parseNvidiaProcesses, parseWindowsGpu } from "../src/gpu.js";
import { makeHub } from "./helpers.js";
import { mailTimeReached } from "../src/mail-filer.js";

const table = (rows: string) => `+-----------------------------------------------------------------------------------------+
| Processes:                                                                              |
|  GPU   GI   CI              PID   Type   Process name                        GPU Memory |
|        ID   ID                                                               Usage      |
|=========================================================================================|
${rows}+-----------------------------------------------------------------------------------------+`;

const desktop = `|    0   N/A  N/A         1593754      G   /usr/bin/gnome-shell                    745MiB |
|    0   N/A  N/A         1594686      G   /usr/bin/Xwayland                         6MiB |
|    0   N/A  N/A         1597604      G   ...nstallation/ubuntu12_32/steam          8MiB |
|    0   N/A  N/A         1597864      G   ...on/ubuntu12_64/steamwebhelper        162MiB |
`;

test("gpu: the desktop and Steam's client are not a game; a game or a busy card is", () => {
  const idle = parseNvidiaProcesses(table(desktop));
  assert.equal(idle.length, 4);
  assert.equal(gpuBusy(idle, 0, false), null);
  const model = parseNvidiaProcesses(table(desktop + "|    0   N/A  N/A         2000001      C   /usr/bin/ollama                       17800MiB |\n"));
  assert.equal(gpuBusy(model, 95, true), null, "the model itself is not a game");
  const game = parseNvidiaProcesses(table(desktop + "|    0   N/A  N/A         2000002      G   ...common/Valheim/valheim.x86_64       4200MiB |\n"));
  assert.match(String(gpuBusy(game, 80, false)), /valheim\.x86_64 is using the GPU/);
  assert.match(String(gpuBusy(idle, 65, false)), /65% busy/, "load with nothing named, while the model is idle, counts as busy");
  assert.equal(gpuBusy(idle, 65, true), null, "while the model runs, its own load does not count");
});

test("mail: a set read time is reached once, when the clock passes it", () => {
  const at = (h: number, m: number) => { const d = new Date(2026, 10, 3, h, m); return d; };
  assert.equal(mailTimeReached(["07:00", "12:00"], at(11, 59), at(12, 0)), true);
  assert.equal(mailTimeReached(["07:00", "12:00"], at(12, 0), at(12, 1)), false);
  assert.equal(mailTimeReached(["07:00"], at(6, 30), at(8, 0)), true, "a hub that was busy past the minute still reads");
});

// Measured on a Windows gaming PC at its desktop, 2026-11-10 (pid, name, dedicated MiB, 3D load %).
const winDesktop = ["9844\tdwm\t35530\t1.7", "35964\twallpaper64\t3616\t4.8", "23372\tNVIDIA Overlay\t2595\t0", "33940\tremoting_desktop\t124\t5.2", "13212\tclaude\t118\t0.6"].join("\r\n");

test("gpu on Windows: the desktop, its wallpaper, overlays and browsers are not a game; a program drawing hard is", async () => {
  const idle = parseWindowsGpu(winDesktop);
  assert.equal(idle.length, 5);
  assert.deepEqual(idle[0], { pid: 9844, name: "dwm", mib: 35530, pct3d: 1.7 });
  assert.equal(gpuBusyWindows(idle), null, "a busy desktop with gigabytes held is still not a game");
  assert.equal(gpuBusyWindows(parseWindowsGpu(`${winDesktop}\r\n1\tchrome\t900\t45\r\n2\twallpaper64\t3600\t60\r\n3\tollama\t17800\t0`)), null, "a video in a browser, a busy wallpaper and the model server are not games");
  assert.equal(gpuBusyWindows(parseWindowsGpu(`${winDesktop}\r\n4\teldenring\t9800\t86.5\r\n5\tdiscord\t300\t30`)), "eldenring is using the GPU", "the program drawing most is named");
  assert.equal(gpuBusyWindows(parseWindowsGpu(`${winDesktop}\r\n6\tsomegame\t2000\t12`)), null, "a game paused in the background, drawing little, lets work run");
  // gpuBusyNow asks PowerShell on Windows; no answer (no counters) counts as free.
  const orig = { ...gpuProbe };
  const asked: string[] = [];
  try {
    gpuProbe.platform = "win32";
    gpuProbe.run = async (file) => { asked.push(file); return `${winDesktop}\r\n4\teldenring\t9800\t86.5`; };
    assert.equal(await gpuBusyNow(false), "eldenring is using the GPU");
    assert.deepEqual(asked, ["powershell.exe"]);
    gpuProbe.run = async () => null;
    assert.equal(await gpuBusyNow(false), null);
  } finally { Object.assign(gpuProbe, orig); }
});

test("background model work waits while a game runs on this machine's card, without calling the model, and runs again after", async () => {
  const t = makeHub();
  const orig = { ...gpuProbe };
  let game = true;
  try {
    t.hub.cfg.ollamaUrl = "http://127.0.0.1:11434";
    gpuProbe.platform = "win32";
    gpuProbe.run = async () => (game ? "4\teldenring\t9800\t86.5" : "9844\tdwm\t35530\t1.7");
    const r = await t.hub.ai.backgroundJson("notes:x", "system", "user");
    assert.deepEqual(r, { text: null, stopped: true });
    assert.equal(await t.hub.ai.gameRunning(), "eldenring is using the GPU");
    // Asked again only after 30 seconds.
    game = false;
    assert.equal(await t.hub.ai.gameRunning(), "eldenring is using the GPU");
    assert.equal(await t.hub.ai.gameRunning(Date.now() + 31_000), null);
    // A model server on another computer has its own card: this one's games do not count.
    game = true;
    t.hub.cfg.ollamaUrl = "http://gamingpc:11434";
    assert.equal(await t.hub.ai.gameRunning(Date.now() + 62_000), null);
  } finally { Object.assign(gpuProbe, orig); t.cleanup(); }
});
