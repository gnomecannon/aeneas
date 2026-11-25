/**
 * A made-up but realistic month in the life of "Alex" (people, plans, diary days, tasks, logs, a pet, shopping lists,
 * renewals, projects, notes): the assistant eval's world (eval-assistant.ts) and the demo hub's sample data
 * (demo-hub.ts). Nothing in it is anyone's real data.
 */
import { MUSIC_PROFILE_ID, personFactKey } from "@everythingapp/shared";
import type { Hub } from "../src/hub.js";
import { appendDiary, diaryDay } from "../src/diary.js";
import { registerDevice } from "../src/devices.js";
import { reportComputer } from "../src/hostsensors.js";
import { identifyTick, type Signals } from "../src/identify.js";
import { setMachineOs } from "../src/machineinfo.js";
import { loadHosts, readMachines, writeMachines } from "../src/ai/hosts.js";
import os from "node:os";


/** Local time on day `n` from today at "HH:MM". */
export function at(n: number, hm = "12:00"): Date {
  const [h, m] = hm.split(":").map(Number);
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(h, m, 0, 0);
  return d;
}
export const iso = (n: number, hm?: string) => at(n, hm).toISOString();
/** For logs: day n at a clock time, but never in the future (run after midnight, "today at 7:30" had not happened). */
export const past = (n: number, hm?: string) => new Date(Math.min(at(n, hm).getTime(), Date.now() - 10 * 60_000)).toISOString();
export const ymd = (n: number) => diaryDay(at(n));

/** A made-up month in Alex's life. Ids of the things cases refer to are in `ids`. */
export function seedWorld(hub: Hub): Record<string, string> {
  const s = hub.store;
  const ids: Record<string, string> = {};
  ids.jamie = s.create("person", { name: "Jamie", relationship: "partner", birthday: `1991-${ymd(9).slice(5)}` }).id;
  ids.devon = s.create("person", { name: "Devon Hale", given_name: "Devon", family_name: "Hale", phones: [{ label: "mobile", value: "+1 312 555 0142" }] }).id;
  ids.rafael = s.create("person", { name: "Rafael Reyes", given_name: "Rafael", family_name: "Reyes" }).id;
  ids.priya = s.create("person", { name: "Priya" }).id;
  s.create("fact", { category: "relationship", key: "jamie:likes", value: "Jamie loves dark chocolate and has been wanting to try a pottery class", person_id: ids.jamie, person: "Jamie", source: "user" });
  // A person's page in sections (since 2026-11-25): likes, a dislike, gift ideas with one already given.
  for (const [category, value, extra] of [
    ["like", "Dark chocolate", {}], ["like", "Board games", {}], ["dislike", "Cilantro", {}],
    ["gift_idea", "Pottery class", { occasion: "birthday" }], ["gift_idea", "Wingspan board game", { given_at: ymd(-40) }],
  ] as const) {
    s.create("fact", { category, key: personFactKey(category, value), value, person_id: ids.jamie, person: "Jamie", source: "user", ...extra });
  }

  ids.dentist = s.create("event", { title: "Dentist cleaning", start: iso(0, "15:00"), end: iso(0, "16:00"), all_day: false, location: "Maple Street Dental" }).id;
  ids.games = s.create("event", { title: "Board games at Devon's", start: iso(2, "19:00"), end: iso(2, "22:00"), all_day: false }).id;
  s.create("event", { title: "Apple picking with Jamie and Priya", start: new Date(`${ymd(-3)}T00:00:00`).toISOString(), end: new Date(`${ymd(-2)}T00:00:00`).toISOString(), all_day: true });

  appendDiary(s, "Walked Pepper around Riverside Park, about 40 minutes", at(-1, "08:10"));
  appendDiary(s, "Lunch at Chipotle with Priya, she's starting a new job at Northwind", at(-2, "12:40"));
  appendDiary(s, "Replaced the noisy fan in the NAS, it's quiet now", at(-4, "21:15"));
  appendDiary(s, "Bouldering with Devon at Summit Climbing, finally sent the green V3", at(-5, "19:30"));
  appendDiary(s, "Ordered 2 Seagate IronWolf 12TB drives for the NAS from B&H", at(-6, "10:05"));

  ids.hdmi = s.create("task", { title: "Pick up HDMI cable at Micro Center", status: "next", order: 1 }).id;
  ids.registration = s.create("task", { title: "Renew car registration", status: "next", order: 2, due: ymd(10) }).id;
  s.create("task", { title: "Clean the gutters", status: "parked", order: 3, parked_reason: "waiting for a dry weekend" });
  s.create("task", { title: "Return library books", status: "done", order: 4, done_at: iso(-1, "17:00") });

  const weights = [163.2, 162.4, 161.8, 161.0, 160.1, 159.6, 158.4];
  weights.forEach((v, i) => s.create("log", { type: "weight", value: v, unit: "lb", at: past(-30 + i * 5, "07:30"), source: "web" }));
  // Before 4 AM this morning's sleep has not happened: the newest is yesterday's 7.2.
  for (let i = 1; i <= 7; i++) if (i > 1 || new Date().getHours() >= 4) s.create("log", { type: "sleep", value: [6.5, 7.2, 5.8, 7.9, 6.9, 7.4, 6.1][i - 1], unit: "h", at: past(-i + 1, "07:00"), source: "iphone" });
  s.create("log", { type: "med", value: "Claritin", at: past(0, "08:05"), source: "web" });
  s.create("log", { type: "caffeine", value: 1, unit: "cups", at: past(0, "08:30"), source: "web" });

  s.create("pet_event", { pet: "Pepper", type: "vet", at: iso(-20, "10:00"), note: "Annual checkup, all good", next_due: iso(25, "10:00") });
  s.create("pet_event", { pet: "Pepper", type: "med", at: iso(-3, "09:00"), note: "Heartworm chew", next_due: iso(27, "09:00") });
  s.create("pet_event", { pet: "Pepper", type: "custody", with: "me", at: iso(-3, "18:00"), cycle_days: 7 });

  // Apple Reminders lists as an iPhone syncs them: Alex's and Jamie's shopping lists.
  s.create("task", { title: "Dish soap", status: "next", order: 10, apple: { id: "R1", list: "L1", list_title: "Alex Shopping" } });
  s.create("task", { title: "Beeswax candles", status: "next", order: 11, apple: { id: "R2", list: "L2", list_title: "Jamie Shopping" } });
  s.create("task", { title: "Hair ties", status: "next", order: 12, apple: { id: "R3", list: "L2", list_title: "Jamie Shopping" } });
  ids.hardware = s.create("checklist", { title: "Hardware store run", kind: "generic", items: [{ text: "Drywall anchors" }, { text: "Wood glue" }, { text: "Sandpaper", done_at: iso(-1) }] }).id;
  ids.domain = s.create("watch", { title: "alex-example.net domain", category: "domain", due: ymd(20), lead_days: 14, cost: 18 }).id;
  s.create("monitor", { name: "nas01 SMB", host: "nas01", type: "tcp", target: "10.255.255.1:445", interval_s: 86400, state: "down", last_error: "connect timeout after 5000 ms", consecutive_fails: 7, last_check: new Date().toISOString() });
  // The seeded monitors were all checked a moment ago and are up, as on a hub that runs them every minute.
  for (const m of s.list({ kind: "monitor" })) if (!m.fields.state || m.fields.state === "unknown") s.patch(m.id, { state: "up", last_check: new Date().toISOString(), last_ok: new Date().toISOString(), consecutive_fails: 0 });
  ids.starfall = s.create("project", { name: "Starfall", status: "active", definition_of_done: "A playable demo: one level and a working map editor", resume_card: "Next: hook the save button to the level file. Blocked on the tile set export." }).id;
  s.create("project", { name: "Kitchen timer display", status: "parked", definition_of_done: "A small screen on the fridge counts down the cooking timers" });
  s.create("film", { title: "Dune: Part Three", year: 2026, watched_on: [ymd(-1)], last_watched: ymd(-1), rating: 4.5, liked: true, source: "letterboxd" });
  s.create("film", { title: "The Thing", year: 1982, watched_on: [ymd(-12)], last_watched: ymd(-12), rating: 5, source: "letterboxd" });
  s.create("film", { title: "Weapons", year: 2025, watched_on: [ymd(-45)], last_watched: ymd(-45), rating: 3, source: "letterboxd" });
  s.create("game", { name: "Deep Rock Galactic", min_players: 1, max_players: 4, coop: true, genres: ["shooter"], owned_by: ["Alex", "Devon", "Rafael"], session_hours: 2, last_played: iso(-20), source: "manual" });
  s.create("game", { name: "Valheim", min_players: 1, max_players: 10, coop: true, genres: ["survival"], owned_by: ["Alex", "Devon"], session_hours: 3, last_played: iso(-3), source: "manual" });
  s.create("game", { name: "Hades", min_players: 1, max_players: 1, coop: false, genres: ["roguelike"], owned_by: ["Alex"], session_hours: 1, source: "manual" });
  // Alex's Apple Music taste as an iPhone reads it (Music, in Media). Every artist and song here is made up.
  s.create("music_profile", {
    source: "apple_music", read_at: past(0, "09:15"), device: "Alex's iPhone", subscription: true,
    library: { songs: 1184, albums: 97, artists: 126, playlists: 9 },
    top_artists: [
      { name: "The Lantern Moths", plays: 412 }, { name: "Copper Tide Collective", plays: 338 }, { name: "Juniper Static", plays: 291 },
      { name: "Harbor Kites", plays: 240 }, { name: "Northbound Owls", plays: 187 }, { name: "Glass Orchard", plays: 151 },
      { name: "Saltwater Radio", plays: 122 }, { name: "Velvet Ferns", plays: 96 }, { name: "Dusk Bicycle Club", plays: 71 },
    ],
    top_songs: [
      { title: "Paper Moons", artist: "The Lantern Moths", plays: 88 }, { title: "Tidewater", artist: "Copper Tide Collective", plays: 74 },
      { title: "Driftwood Static", artist: "Juniper Static", plays: 69 }, { title: "Kite Season", artist: "Harbor Kites", plays: 61 },
      { title: "Northern Porch Light", artist: "Northbound Owls", plays: 55 }, { title: "Orchard in Glass", artist: "Glass Orchard", plays: 47 },
      { title: "AM Dial", artist: "Saltwater Radio", plays: 40 }, { title: "Moth Hour", artist: "The Lantern Moths", plays: 38 },
    ],
    playlists: [
      { name: "Focus, no words", songs: 64, own: true }, { name: "Long drive", songs: 112, own: true }, { name: "Sunday kitchen", songs: 37, own: true },
      { name: "Bouldering", songs: 45, own: true }, { name: "Acoustic Mornings", songs: 50, own: false },
    ],
    recent: [
      { title: "Kite Season", artist: "Harbor Kites" }, { title: "Paper Moons", artist: "The Lantern Moths" },
      { title: "Low Tide Waltz", artist: "Copper Tide Collective" }, { title: "Static Garden", artist: "Juniper Static" },
    ],
    genres: [
      { name: "Indie Rock", songs: 318 }, { name: "Folk", songs: 204 }, { name: "Electronic", songs: 161 }, { name: "Ambient", songs: 92 },
      { name: "Jazz", songs: 58 }, { name: "Pop", songs: 41 },
    ],
  }, "personal", MUSIC_PROFILE_ID);
  s.create("inventory", { name: "DS18B20 temperature sensor", category: "component", qty: 5, location: "parts drawer 3" });
  s.create("inventory", { name: "ESP32 DevKit", category: "component", qty: 2, location: "parts drawer 1" });
  s.create("journal", { host: "nas01", at: iso(-4, "21:10"), what: "Replaced the rear case fan", command: "", risk: "low", outcome: "done" });
  s.create("journal", { host: "server", at: iso(-2, "22:30"), what: "Raised Ollama context to 24576", command: "systemctl --user restart ollama", risk: "medium", rollback: "set OLLAMA_CONTEXT_LENGTH back to 16384", outcome: "done" });
  ids.vet = s.create("task", { title: "Call the vet about Pepper's chew", status: "scheduled", order: 20, remind_at: new Date(Date.now() - 5 * 60_000).toISOString(), friction: "none" }).id;
  s.create("watch", { title: "Plex Pass", category: "subscription", due: ymd(12), repeat: "every 1 months", cost: 6.99 });
  s.create("watch", { title: "Spotify", category: "subscription", due: ymd(3), repeat: "every 1 months", cost: 11.99, autopay: true });
  // Ideas as the filer and the note linker leave them: notes tagged idea and their form, in Alex's folders.
  s.create("note", { title: "Robot choir", path: "Writing/Sketches/Robot choir.md", body: "A skit where a church choir is slowly replaced by vacuum cleaners and nobody notices.", tags: ["comedy", "sketch", "idea"] });
  s.create("note", { title: "Silent auction", path: "Writing/Sketches/Silent auction.md", body: "Everyone at the silent auction takes the name far too literally.", tags: ["comedy", "sketch", "idea"] });
  s.create("note", { title: "Lighthouse keeper", path: "Writing/Lighthouse keeper.md", body: "A story about a lighthouse keeper whose light only works when nobody is watching.", tags: ["story", "idea"] });
  ids.songs = s.create("project", { name: "Songs", status: "active", definition_of_done: "One song finished end to end", area: "music" }).id;
  ids.nas = s.create("note", { title: "NAS upgrade plan", path: "Homelab/NAS upgrade plan.md", body: "# NAS upgrade plan\n\nSwap the four 4TB drives in the NAS for 12TB IronWolfs and rebuild as RAIDZ2.\n\n- Budget: $900\n- Copy everything to the 8TB USB drive first\n- Resilver one disk at a time, check SMART after each\n" }).id;
  return ids;
}

/**
 * The hub's own machine is the sample journal's "server", whatever the computer the demo runs on is called (its name
 * stays in the demo's own machines file). Before the starter seed, so the hub's own check is put on it.
 */
export function nameHubMachine(cfg: Hub["cfg"]): void {
  const self = loadHosts(cfg).find((h) => h.local);
  const name = os.hostname().toLowerCase().split(".")[0];
  writeMachines(cfg, [...(readMachines(cfg) ?? []).filter((e) => e.name !== "server"), { name: "server", local: true, os: self?.os ?? "linux", aliases: [name] }]);
}

/**
 * Alex's machines as a real hub comes to know them (Tech): the hub's own machine ("server", nameHubMachine) says what
 * it runs as its readings would, the laptop's Aeneas app reports it with its readings and the macOS it runs, and the
 * hub's pass that works out what kind of device each one is (identify.ts) asks nas01 at its check's address. Without
 * these every sample machine sat under Not identified, and the journal's "server" was a machine of its own beside the
 * hub's. The answer to that ask is made up here: the demo asks nothing on the network and reads nothing of the
 * machine it runs on.
 */
export async function seedMachines(hub: Hub, now = new Date()): Promise<void> {
  nameHubMachine(hub.cfg);
  const self = loadHosts(hub.cfg).find((h) => h.local);
  setMachineOs(hub, "server", self?.os === "windows" ? "Windows 11 Pro" : self?.os === "linux" ? "Ubuntu 24.04 LTS" : "macOS 26.1", now.toISOString());
  const mac = registerDevice(hub.store, { name: "Alex's Mac", platform: "mac" });
  reportComputer(hub, mac.device_id, { name: "laptop", output: "os macOS 26.1\ncpu 18.4\nmem 57\ndisk / 46.2\n" }, now);
  const answers: Record<string, Signals> = {
    // nas01: SSH and its web page answer; file sharing (its SMB check) is what is down.
    "10.255.255.1": { open: [22, 5000, 5001], ssh: "SSH-2.0-OpenSSH_8.2p1 Debian", http: "nas01 - Synology DiskStation" },
  };
  await identifyTick(hub, now, async (host) => answers[host] ?? { open: [] });
}
