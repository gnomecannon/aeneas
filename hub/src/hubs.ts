import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StoreError } from "./store.js";

/**
 * Other people's hubs on this machine (deploy/people.sh, docs/multi-person.md), as the owner's hub sees them.
 *
 * The owner adds a person from the app: the hub writes a request into a folder only the owner's account can write to,
 * and a small root service (aeneas-people.path) runs `aeneas-people add` for it, the same as the command line would,
 * writing progress and the result (the new hub's address and a pairing code for the person's first device) where only
 * the owner's account can read it. The hub itself never runs anything as root: it names a person, nothing else.
 *
 * Only the owner's hub (the account in /etc/aeneas/owner) offers this; everyone else's says `not_owner`.
 */

export interface PersonHub {
  name: string;
  account: string;
  port: number;
  color: string;
  owner: boolean;
  address: string | null;
  up: boolean;
}

export type HubsReason = "linux_only" | "not_set_up" | "not_owner";

/** Every fixed path is under this root (`EA_PEOPLE_ROOT`, tests only), normally "/". */
function root(): string { return process.env.EA_PEOPLE_ROOT || "/"; }
const at = (...p: string[]) => path.join(root(), ...p);
const REGISTRY = () => at("etc/aeneas/people.json");
const OWNER_FILE = () => at("etc/aeneas/owner");
const REQUESTS = () => at("var/lib/aeneas/requests");
const RESULTS = () => at("var/lib/aeneas/results");

/** The command that turns this on, shown where the app would offer Add a person. */
export const SETUP_COMMAND = "sudo bash ~/everythingapp/deploy/people.sh setup --name <your name>";

/** What everyone who is added should hear first, shown before and after adding someone. */
export const ADMIN_NOTE =
  "Each person's notes, chats and everything else are kept in their own account on this machine, apart from yours and from everyone else's. Anyone with admin (root or sudo) rights on this machine, you included, can still open them. Tell the people you add before they start.";

export const NAME_RE = /^[A-Za-z][A-Za-z '.-]{0,29}$/;
const ACCOUNT_RE = /^aeneas-[a-z0-9]{1,20}$/;
const ID_RE = /^[a-z0-9-]{8,40}$/;

function me(): string { try { return os.userInfo().username; } catch { return ""; } }

export function hubsState(): { available: boolean; reason?: HubsReason } {
  if (process.platform !== "linux" && !process.env.EA_PEOPLE_ROOT) return { available: false, reason: "linux_only" };
  let owner = "";
  try { owner = fs.readFileSync(OWNER_FILE(), "utf8").trim(); } catch { return { available: false, reason: "not_set_up" }; }
  if (owner !== me()) return { available: false, reason: "not_owner" };
  try { fs.accessSync(REQUESTS(), fs.constants.W_OK); } catch { return { available: false, reason: "not_set_up" }; }
  return { available: true };
}

function registry(): { name: string; user: string; port: number; color?: string; owner?: boolean; address?: string }[] {
  try {
    const list = JSON.parse(fs.readFileSync(REGISTRY(), "utf8"));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

async function up(port: number): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 2000);
  try { return (await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal })).ok; } catch { return false; } finally { clearTimeout(t); }
}

export async function listHubs(): Promise<PersonHub[]> {
  const list = registry();
  return Promise.all(list.map(async (p) => ({
    name: String(p.name), account: String(p.user), port: Number(p.port), color: String(p.color ?? ""), owner: !!p.owner,
    address: p.address ? String(p.address) : null, up: await up(Number(p.port)),
  })));
}

function request(op: "add" | "pair" | "stop", name: string, color = ""): { request_id: string } {
  const state = hubsState();
  if (!state.available) throw new StoreError(409, state.reason === "not_owner" ? "only the machine owner's hub adds people" : `this machine is not set up for several people yet: run ${SETUP_COMMAND}`, { reason: state.reason });
  const id = crypto.randomUUID();
  const body = JSON.stringify({ id, op, name, color });
  // Written under another name first, so the root service never reads half a request.
  const tmp = path.join(REQUESTS(), `.${id}.part`);
  fs.writeFileSync(tmp, body, { mode: 0o660 });
  fs.renameSync(tmp, path.join(REQUESTS(), `${id}.json`));
  return { request_id: id };
}

export function addPerson(body: Record<string, unknown>): { request_id: string } {
  const name = String(body.name ?? "").trim().replace(/\s+/g, " ");
  if (!NAME_RE.test(name)) throw new StoreError(422, "a name is letters, spaces, apostrophes, dots or dashes, up to 30, starting with a letter");
  const color = String(body.color ?? "").trim();
  if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new StoreError(422, "a color is #rrggbb");
  const taken = registry().find((p) => String(p.name).toLowerCase() === name.toLowerCase());
  if (taken) throw new StoreError(409, `${name} already has a hub here`);
  return request("add", name, color);
}

/** By account (aeneas-...), the one stable handle: names are for people to read. */
function personByAccount(account: string) {
  if (!ACCOUNT_RE.test(account)) throw new StoreError(404, "no such hub");
  const p = registry().find((x) => x.user === account && !x.owner);
  if (!p) throw new StoreError(404, "no such hub");
  return p;
}

export function pairPerson(account: string): { request_id: string } { return request("pair", String(personByAccount(account).name)); }
export function stopPerson(account: string): { request_id: string } { return request("stop", String(personByAccount(account).name)); }

/** Progress or the result of a request: `queued` until the root service picks it up. */
export function requestResult(id: string): Record<string, unknown> {
  if (!ID_RE.test(id)) throw new StoreError(404, "no such request");
  if (fs.existsSync(path.join(REQUESTS(), `${id}.json`))) return { state: "queued" };
  try {
    const r = JSON.parse(fs.readFileSync(path.join(RESULTS(), `${id}.json`), "utf8")) as Record<string, unknown>;
    return r;
  } catch {
    throw new StoreError(404, "no such request");
  }
}
