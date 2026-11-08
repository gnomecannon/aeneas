import { test } from "node:test";
import assert from "node:assert/strict";
import { gpuBusy, parseNvidiaProcesses } from "../src/gpu.js";
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
