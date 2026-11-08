#!/usr/bin/env node
// License check (release rule 5: open-source code only, nothing we have no license to use).
//
//   node tools/license-check/check.mjs            npm packages, Rust crates (when cargo is here), Apple packages
//   node tools/license-check/check.mjs --no-rust  npm and Apple only
//
// Every third-party package's license, as an SPDX expression, must be satisfiable from ALLOWED: for "A OR B" one
// allowed side is enough, for "A AND B" both must be. A package with no license, or one outside the list, fails the
// check and is listed, so a new dependency is looked at by a person before it ships. This project's own packages are
// skipped (their license is the project's). Nothing is fetched for npm (the lock file has every license); Rust uses
// `cargo metadata`, which reads the crates' manifests.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Open-source licenses whose terms suit an open-source app of any license: permissive ones and MPL-2.0 (file-level). */
export const ALLOWED = new Set([
  "MIT", "MIT-0", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "BlueOak-1.0.0", "CC0-1.0", "Unlicense",
  "Zlib", "BSL-1.0", "Python-2.0", "MPL-2.0", "Unicode-3.0", "Unicode-DFS-2016", "Apache-2.0 WITH LLVM-exception",
  // Data, not code: the browser support tables (caniuse-lite) the web build reads.
  "CC-BY-4.0",
]);

/** Whether an SPDX expression is satisfiable from ALLOWED. Handles OR, AND, WITH, parentheses and the old "/" form. */
export function allowed(expr) {
  if (!expr || typeof expr !== "string") return false;
  const tokens = expr.replace(/\//g, " OR ").replace(/\(/g, " ( ").replace(/\)/g, " ) ").split(/\s+/).filter(Boolean);
  let i = 0;
  const atom = () => {
    const t = tokens[i++];
    if (t === "(") { const v = or(); if (tokens[i++] !== ")") throw new Error("no closing bracket"); return v; }
    if (tokens[i] === "WITH") { const exc = tokens[i + 1]; i += 2; return ALLOWED.has(`${t} WITH ${exc}`) || ALLOWED.has(t); }
    return ALLOWED.has(t);
  };
  const and = () => { let v = atom(); while (tokens[i] === "AND") { i++; const w = atom(); v = v && w; } return v; };
  const or = () => { let v = and(); while (tokens[i] === "OR") { i++; const w = and(); v = v || w; } return v; };
  try { const v = or(); return i >= tokens.length && v; } catch { return false; }
}

function npmPackages() {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const out = [];
  for (const [key, v] of Object.entries(lock.packages ?? {})) {
    if (!key || !key.includes("node_modules/") || v.link) continue; // the root and this project's own workspaces
    out.push({ name: key.slice(key.lastIndexOf("node_modules/") + 13), version: v.version ?? "", license: v.license ?? "" });
  }
  return out;
}

function rustCrates() {
  const manifest = path.join(ROOT, "web/src-tauri/Cargo.toml");
  const raw = execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--manifest-path", manifest], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const meta = JSON.parse(raw);
  const own = new Set(meta.workspace_members);
  return meta.packages.filter((p) => !own.has(p.id)).map((p) => ({ name: p.name, version: p.version, license: p.license ?? (p.license_file ? `file:${p.license_file}` : "") }));
}

/** The Apple apps use no third-party Swift packages: any remote package in the project or a Package.resolved fails. */
function applePackages() {
  const problems = [];
  const yml = fs.readFileSync(path.join(ROOT, "apple/project.yml"), "utf8");
  if (/^\s*url:\s*https?:/m.test(yml)) problems.push("apple/project.yml names a remote Swift package");
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".build" || e.name === "build" || e.name.startsWith(".")) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name === "Package.resolved" && /"location"\s*:\s*"https?:/.test(fs.readFileSync(f, "utf8"))) problems.push(`${path.relative(ROOT, f)} pins a remote Swift package`);
    }
  };
  walk(path.join(ROOT, "apple"));
  return problems;
}

function report(label, pkgs) {
  const bad = pkgs.filter((p) => !allowed(p.license));
  const counts = {};
  for (const p of pkgs) counts[p.license || "(none)"] = (counts[p.license || "(none)"] ?? 0) + 1;
  console.log(`${label}: ${pkgs.length} packages, ${bad.length} not on the allow list`);
  for (const [l, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${l}`);
  for (const p of bad) console.log(`  NOT ALLOWED: ${p.name} ${p.version} (${p.license || "no license"})`);
  return bad.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failures = report("npm", npmPackages());
  if (!process.argv.includes("--no-rust")) {
    let crates = null;
    try { crates = rustCrates(); } catch (e) { console.log(`rust: not checked (${String(e.message ?? e).split("\n")[0]})`); if (process.env.CI) failures++; }
    if (crates) failures += report("rust", crates);
  }
  const apple = applePackages();
  console.log(`apple: ${apple.length ? apple.join("; ") : "no third-party Swift packages"}`);
  failures += apple.length;
  if (failures) { console.log(`\n${failures} problem(s): a person looks at each before it ships (release rule 5).`); process.exit(1); }
  console.log("\nevery third-party package is under an allowed open-source license");
}
