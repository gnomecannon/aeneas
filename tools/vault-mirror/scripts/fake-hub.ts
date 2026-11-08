/**
 * Start the test fake hub as a real HTTP server for manual runs.
 *   tsx scripts/fake-hub.ts [--port 8799] [--token test-token] [--seed <dir of .md files>]
 * Prints the env lines to export for the mirror CLI.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { FakeHub } from "../test/fake-hub.ts";

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const port = Number(opt("--port", "8799"));
const token = opt("--token", "test-token");
const seed = opt("--seed", "");

const hub = new FakeHub(token);
if (seed) {
  async function walk(dir: string, base: string): Promise<void> {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs, base);
      else if (e.name.endsWith(".md")) {
        const st = await fs.stat(abs);
        hub.set(path.relative(base, abs).split(path.sep).join("/"), await fs.readFile(abs, "utf8"), st.mtime.toISOString());
      }
    }
  }
  await walk(seed, seed);
}
const url = await hub.listen(port);
console.log(`fake hub listening with ${hub.files.size} files`);
console.log(`export EA_HUB_URL=${url}`);
console.log(`export EA_TOKEN=${token}`);
process.on("SIGINT", () => void hub.close().then(() => process.exit(0)));
