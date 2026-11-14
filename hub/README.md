# EverythingApp hub

One Node process that owns the data: SQLite with WAL and FTS5, the sync feed, the reminder loop, the Obsidian vault mirror, search, and the AI gateway with structured memory, redaction and the style filter. It implements `packages/shared/CONTRACT.md` sections 3 and 5. Clients talk to it over the tailnet with one bearer token.

## Run

```
# from the repo root, once
npm install

# from hub/
cp .env.example .env        # set EA_TOKEN at minimum
npm run seed                # load deploy/seed/facts.json, rules.json and plan_rules.json (idempotent)
npm run dev                 # tsx watch, restarts on edit
npm start                   # same without watch
npm run backup              # VACUUM INTO a timestamped copy in EA_BACKUP_DIR, encrypted to the backup key, and fill the outbox
npx tsx src/main.ts restore <hub-...sqlite.age> <new path>  # decrypt a backup (key file, or EA_RECOVERY_KEY on a new machine)
npx tsx src/main.ts sweep   # knowledge sweep now (links and tag suggestions), same as the 03:10 nightly run
npx tsx src/main.ts watches # watch maintenance now (linked reminders, TLS probes), same as the 04:00 daily run
npm test                    # node:test suite, no network needed
npm run typecheck           # tsc --noEmit
```

With no `.env` at all the hub still runs: data goes to `hub/data/`, the vault to `hub/data/vault/`, backups to `hub/data/backups/`. Only `EA_TOKEN` is required to serve.

Node 20 with `tsx`; there is no build step. `better-sqlite3` ships a prebuilt binary for Node 20 on macOS and Linux.

## Environment

All variables are read from `hub/.env` (a small built-in loader; existing process env wins) and are documented in `.env.example`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `EA_PORT` | `8787` | Listen port, bound on `0.0.0.0` |
| `EA_TOKEN` | none | Bearer token. Required to serve. Compared in constant time |
| `EA_DATA_DIR` | `./data` | Holds `hub.sqlite` (plus WAL files) |
| `EA_VAULT_DIR` | `<data>/vault` | Markdown vault, the file source of truth for notes |
| `EA_BACKUP_DIR` | `<data>/backups` | Nightly 03:00 `VACUUM INTO` copies, encrypted (`.sqlite.age`), 30 day retention |
| `EA_BACKUP_KEY_FILE` | next to `EA_WORK_KEY_FILE` (`backup.key`) | The age key every copy that leaves `hub.sqlite` is encrypted to. Made on first start, mode 600, in no backup. Its recovery key belongs in the password manager |
| `EA_OLLAMA_URL` | empty | Local model server. Empty disables the local backend. On a host without MagicDNS this must be the tailnet IP, not the hostname |
| `EA_OLLAMA_MODEL` | `qwen3-coder:30b` | Model name for Ollama |
| `EA_OLLAMA_NUM_CTX` | automatic | Context window asked of Ollama. Empty: the smallest that holds the system prompt, every tool, a reply and some history (32768 with today's tools; `GET /status` shows it under `ai.context`). A smaller value is raised to that, since Ollama silently drops the start of a longer request; a larger one is kept |
| `EA_OLLAMA_KEEP_ALIVE` | `2h` | `keep_alive` sent with every Ollama (and adapter) chat so the model stays loaded. Ollama unloads after 5 minutes by default, which made the first call after idle take about 30 s |
| `EA_ANTHROPIC_API_KEY` | empty | Cloud key. Used only when a request allows cloud |
| `EA_ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Cloud model |
| `EA_ALLOW_CLOUD_DEFAULT` | `false` | Default for `allow_cloud` when a request omits it |
| `EA_TZ` | `America/New_York` | Process timezone; drives reminder repeats, the dashboard day window and every planner calculation |
| `EA_DAY_START` | `09:00` | Planner day window start, HH:MM local. Free slots and blocks live inside the window |
| `EA_DAY_END` | `23:00` | Planner day window end, HH:MM local (`24:00` allowed) |
| `EA_DIGEST_TIME` | `09:00` | Local time the daily `digest` notify is emitted, once per day |
| `EA_FOCUS_CHECK_HOURS` | `3` | Hours an open activity may run before the activity check-in asks whether it is still on purpose |
| `EA_READING_KEEP_DAYS` | `365` | Days of sensor readings kept; older rows are purged at 03:20 every night |
| `EA_QUIZ_TIME` | `21:00` | Local time the recall quiz is built from the day's assistant sessions |
| `EA_ADAPTER_URL` | empty | Voice adapter with the Ollama `/api/chat` shape; first choice for `draft` |
| `EA_ADAPTER_MODEL` | empty | Model name for the adapter, falls back to `EA_OLLAMA_MODEL` |
| `EA_SEED_DIR` | `../deploy/seed` | Where `seed` reads `facts.json`, `rules.json`, `plan_rules.json`, `food_options.json`, `music_notes.json` and `monitors.json` |
| `EA_AI_TIMEOUT_MS` | `120000` | Per backend call timeout |
| `EA_CLASSIFY_TIMEOUT_MS` | `4000` | Upper bound the model classifier may add to `POST /capture` |
| `EA_REMINDER_INTERVAL_MS` | `30000` | Reminder loop period |
| `EA_AI_FAKE` | `0` | Canned AI backend for tests |
| `EA_LOG_REQUESTS` | `1` | One line per request: method, path, status, ms, and `device=<id>` when the request carried one. Never the query string, headers, tokens or bodies |

## Routes

Every route except `GET /health` requires `Authorization: Bearer <EA_TOKEN>`. Errors are `{ error, detail? }` with 400, 401, 404, 409, 413, 422 or 500. Invalid JSON, or a JSON body that is not an object, is always a 400. Request bodies are limited to 2 MB (413), vault files to 1 MB (413), one push to 500 patches (422), and `GET /entities` to `limit=1000`.

| Route | What it does |
| --- | --- |
| `GET /health` | `{ ok, version, time, db_seq }` |
| `GET /sync/changes?since=&kinds=&space=&device_id=` | Change feed, 500 per page, `more` flag, current entity state per change row. `device_id` is optional and feeds liveness |
| `POST /sync/push` | `{ device_id, patches[] }`. Per-field LWW: a key is written when its `ts` is newer than `field_ts[key]`. `create: true` creates unknown ids. One change row per applied patch. `deleted_at` is a normal field. `null` clears a field |
| `GET /live?device_id=` | SSE: `change` `{seq,id,kind}`, `notify` (`{id,kind:"reminder",title,at,friction}`, `{id,kind:"digest",title,at}` once a day, `{id,kind:"activity",title,at,log_id}` for the check-in, `{id,kind:"quiz",title,at,date}` when the recall quiz is ready, `{id,kind:"monitor",title,at,name,state,error?}` when a monitor goes down or up, and every 6 h for an unacknowledged incident), `ping` every 25 s. Bus listeners are removed when the client disconnects |
| `GET /entities?kind=&space=&limit=&<field>=` | List, newest first. Any other query key filters on a field value |
| `GET /entities/:id`, `POST /entities`, `PATCH /entities/:id`, `DELETE /entities/:id` | CRUD on the same storage as sync. DELETE sets `deleted_at` |
| `POST /capture` | `{ text, source, attachments?, auto? }`. With `auto`, the shared rule classifier runs first, then the local model (only when configured, reachable and inside the classify timeout), and a non-`none` kind is converted immediately. When nobody could classify it and the text is at least 80 characters or has a line break, it becomes an `Inbox/` note (see below) |
| `POST /capture/:id/convert` | `{ kind, fields? }`. Fills required fields, creates the entity, marks the capture processed |
| `POST /reminders/:id/snooze` | `{ until, reason? }`. 422 when friction is `reason` and no reason is given |
| `POST /reminders/:id/ack` | One-shot: sets `acknowledged_at`. Repeating: moves `at` to the next occurrence and clears `acknowledged_at` and `snoozed_until` |
| `GET /reminders/due?within=` | `{ reminders, now, until }`: unacknowledged reminders whose effective time is at or before now plus `within` minutes (default 60, max 10080), overdue included, sorted by effective time |
| `GET /search?q=&kinds=&limit=` | FTS5 with snippets and a bm25 score |
| `GET /vault/index` | `[{ path, hash (sha256), mtime (ISO), size }]` |
| `GET /vault/file?path=` | Raw markdown |
| `PUT /vault/file?path=&mtime=` | Body is raw markdown. Upserts the note entity; injects `id:` into the frontmatter when missing and returns the hash of what is on disk |
| `DELETE /vault/file?path=` | Removes the file and marks the note deleted |
| `GET /notes/graph` | Nodes and resolved edges for the map view, built from derived `links` |
| `GET /notes/:id/related` | `{ links, backlinks, similar }`; similar comes from FTS on the title words |
| `POST /notes/:id/suggest?ai=` | Recomputes `links` (wikilinks plus title mentions) and `suggested_tags` (vocabulary and folder; a model is added with `ai=true`) |
| `POST /notes/:id/accept` | `{ tags? }` moves suggested tags onto the note, default all |
| `POST /log` | `{ type, value, unit?, at?, note? }` one-tap log |
| `GET /dashboard` | `now` (first `doing` task, else lowest-order `next`), `next`, `reminders_today`, `logs_7d`, `captures_unprocessed`, `projects_active` |
| `POST /ai/chat` | Full pipeline (below). A `troubleshoot` or `plan` reply with three or more numbered steps also carries `procedure_id` (see Creative and builds) |
| `POST /ai/chat/stream` | SSE `token` events, then `done` with the same object as `/ai/chat`; `error` on failure |
| `POST /ai/classify` | `{ text }` to `{ kind, fields, via }` where `via` is `rules`, `model` or `unavailable` |
| `POST /ai/resume-card` | `{ project_id, session_id }` writes `project.resume_card` |
| `GET /ai/memory?allow_cloud=&allow_work=` | The facts and rules that would be injected under that policy |
| `GET /ai/sessions/:id` | Stored session transcript (extra, for debugging) |
| `POST /devices/register` | `{ name, platform, push_token? }` to `{ device_id }` |
| `GET /status` | Version, start time and uptime; database path, size (with WAL), seq and non-deleted entity counts by kind; devices with `last_seen`; backup dir, latest file and count; AI backends configured, calls, last call and average latency over 24 h; next due reminder and reminders fired in 24 h; `planner` with `blocks_this_week`, `free_hours_this_week` and `watches_due_30d`; `memory` with `runbooks`, `journal_entries`, `snippets` and `open_ledgers`; `home`; `creative` with `projects_active`, `procedures_open`, `music_ideas` and `quiz_streak_days`; `ops` with `monitors`, `down` and `incidents_open`; unprocessed captures |
| `GET /metrics/proof?days=` | One row per local day (default 14, max 90): captures created and auto-sorted, tasks done, reminders fired, acked and snoozed, logs created, notes edited, AI calls, `blocks_scheduled` (task blocks starting that day) and `blocks_completed` (tasks done that day that held a block that day), `incidents_opened` (homelab incidents opened that day), whether a task was provably in `next` or `doing` at 09:00 (`null` when the field timestamps cannot show it, with the end-of-day `next`/`doing` count as the fallback). Plus totals and friction signals: captures unprocessed for more than 24 h, reminders snoozed 3 or more times, tasks parked for more than 7 days |
| `GET /planner/week?start=&min_hours=` | Seven days from `start` (YYYY-MM-DD, default this week's Monday). Per day: `blocks` (tasks with a `block`, not done), `events`, `commitments` (blackouts and commitments from `plan_rule`, with `type`), `preferences`, `reminders` due that day, `watches_due` that day, and `free_slots` of at least `min_hours` (default 3) with `preferred: true` when a preference overlaps. See Planner below |
| `POST /planner/schedule` | `{ task_id, start, hours? (3), force? }`. Sets `block` and `status: scheduled` (`doing` stays `doing`). 409 `{ error: "conflict", conflict: { type: blackout, commitment, block or event, title, start, end, ... } }` unless `force` |
| `POST /planner/unschedule` | `{ task_id }`. Clears `block`; status goes back to `next` unless the task is `done` or `doing` |
| `GET /planner/today?min_hours=` | `date`, `now`, `next`, today's `blocks`, `commitments`, `reminders_due` (unacknowledged, effective by end of day, overdue included), `watches_due_soon` (inside their own `lead_days`), `captures_unprocessed`, `free_slots` still ahead of now, and `digest`: two to four plain lines |
| `POST /watches/:id/renewed` | With `repeat`: `due` rolls one step forward from the old due (a date-only due stays date-only) and the linked reminder is re-planned. Without: the linked reminder is acknowledged. `renewed_at` is set either way. Returns the watch |
| `GET /watches/:id/reminder` | The watch's linked reminder (extra, for clients and the curl check) |
| `GET /runbooks?host=` | Runbooks newest first, optionally for one host (case-insensitive) |
| `GET /hosts` | `[{ host, runbooks, journal_entries, last_change, snippets }]` derived from runbook, journal and snippet entities plus facts keyed `host:<name>`, sorted by host |
| `POST /snippets/:id/render` | `{ params: { name: value } }` to `{ text }` with every `{{name}}` replaced; declared defaults fill what the body does not give; 422 `{ error: "missing params", detail: { missing: [...] } }` when a name is still unfilled. Sets `last_used` on success |
| `POST /ai/sessions/:id/close` | `{ outcome: fixed, abandoned or parked, note?, host?, project_id?, allow_cloud? }` to `{ runbook_id?, journal_id?, journal_ids, snippet_ids, resume_card_written, plan_note_id?, summary, host, via }`. See Memory and runbooks below |
| `GET /ledgers?open=` | Ledgers newest first; `open=true` only open ones, `open=false` only closed ones. `PATCH /entities/:id` edits `confirmed` and `ruled_out` by hand |
| `GET /health/summary?days=30` | `{ days, weight: { latest, at, delta_7d, delta_30d, series }, bp: { latest, at }, caffeine_today, meds_today, meds_expected, mood: { series_7d }, sleep: { series_7d }, activity_hours_7d, next_injection }` from `log` rows and the `health:medications` fact. See Body, home and animals below |
| `POST /health/injection-day` | `{ name, weekday: mon..sun, time: HH:MM }` creates (201) or moves (200) the weekly reminder `Injection: <name>`, friction `reason`, matched by title |
| `GET /pets/:pet/summary` | `{ pet, events_30d, next_due, custody: { with_me_now, next_handoff } }`; pet name matched case-insensitively |
| `POST /sensors/:name/readings` | `{ value, at?, unit? }` stores a `reading` (201) and moves the `sensor` row, creating it on first contact. Accepts the token as `?token=` so a microcontroller needs no headers |
| `GET /sensors` | Every sensor entity plus `series_24h: [{ at, value }]`, at most 288 points, sorted by name |
| `GET /sensors/:name/csv?days=30` | `text/csv` with `at,value,unit`, oldest first; 404 for an unknown sensor |
| `POST /food/pick` | `{ meal: lunch, dinner or snack, mode?, budget?, exclude?: [ids] }` to `{ pick, why, runner_up, constraints_used }`. Never writes |
| `POST /food/picked` | `{ id }` sets `last_picked` now and adds one to `times_picked` |
| `GET /projects/:id/summary` | `{ project, tasks: { next, doing, done_7d }, notes, plan_note, procedures, music, parts: [{ name, qty, have, missing }], last_session_close }`. Notes are the ones under `Projects/<name>/` (the plan excluded); `last_session_close` is when the resume card was last written |
| `POST /projects/:id/plan` | `{ sections?: { goal?, current?, next?, parts?, log_line? } }` upserts `Projects/<name>/Plan.md` with the headings Goal, Definition of done, Current state, Next, Parts, Log and returns the note. `log_line` is dated and appended; the rest replace their section; Parts is rendered from the project unless given |
| `POST /procedures/from-text` | `{ text, title?, host?, project_id?, allow_cloud? }` to a `procedure` (201) plus `via: model or rules` |
| `POST /procedures/:id/advance` | `{ done: true }` stamps the step on screen, moves `current` on and sets `done_at` after the last step; `{ back: true }` steps back without clearing; past the end is a no-op; 422 with neither |
| `POST /procedures/:id/reset` | Every step undone, `current` 0, `started_at` and `done_at` cleared |
| `GET /music?type=&status=` | Music ideas newest first, filtered by `type` and `status` when given |
| `POST /music/quick` | `{ text, project_id?, tags? }` parses one line into a `music_idea` (201) |
| `GET /ops` | The ops board: `monitors` (each with `incident_open` or null), `incidents_open`, `incidents_7d`, `uptime_24h: [{ name, pct }]` (`pct` null without checks), `watches_due_30d`, `journal_recent` (last 10) and `hosts` as in `GET /hosts` |
| `POST /monitors/:id/check` | Runs the check now, logs it and moves the state like a scheduled run; returns the updated monitor |
| `GET /monitors/:id/history?hours=24` | `[{ at, ok, latency_ms, error? }]` from the `checks` table, oldest first; `hours` above 0 and at most 168 |
| `POST /incidents/:id/ack` | `{ note? }`, body optional. Sets `acknowledged_at`; a note also writes a low-risk `journal` row on the monitor's host (`Incident acknowledged: <name>: <note>`) and sets `ack_note` and `journal_id` |
| `GET /quiz/today` | Today's `quiz` or `null` |
| `POST /quiz/:id/answer` | `{ index, result: right, wrong or revealed }` stamps `result` and `asked_at` on one item; `completed_at` is set when every item has a result |
| `POST /checklists/:id/instantiate` | `{ title? }`, body optional. Copies a template (201): every `done_at` cleared, notes and tags kept, `template: false`, `from_template` set, title defaults to `<title> YYYY-MM-DD`. 422 when the source is not a template |
| `POST /checklists/:id/toggle` | `{ index }` flips `done_at` on one item; 409 on a template (templates are copied, never ticked), 422 on a bad index |
| `GET /applications/board` | `{ stages: [{ stage, count, applications }] (all eight stages in pipeline order, soonest next_at first), total, active, follow_ups: [{ id, company, role, stage, next_step, next_at, overdue }] }` (active stages only, soonest first) |
| `POST /applications/:id/cover-letter` | `{ job_text?, tone?, allow_cloud? }`, body optional. Drafts through the `draft` route (adapter, then Ollama), then the general route; saves `Career/Cover letters/<company> - <role>.md`, sets `letter_note_id`, returns `{ note, backend }`. 422 `{ detail: { invented: [...] } }` when the draft names an employer that is in neither the facts nor the job text; 503 `{ error: "no model" }` without a backend |
| `POST /games/pick` | `{ players: string[], hours?, coop?, exclude?: [ids] }` to `{ pick, why, runner_up, considered }` (considered is the eligible count) |
| `POST /games/:id/played` | `{ at? }`, body optional. Sets `last_played` (now by default) |
| `POST /calc/split` | `{ subtotal, tax_pct?, tip_pct?, people, shares? }` to `{ subtotal, tax, tip, total, people, per_person, remainder_cents }` |
| `POST /calc/payoff` | `{ balance, apr_pct, payment? , months? }` to months and `total_interest` (or `months: "never"` with a `why`), or the payment for `months`; both carry a 12-row `schedule` of `{ month, payment, interest, principal, balance }` |
| `POST /calc/unit` | `{ items: [{ name, price, qty, unit }] }` to `{ unit, items (cheapest first, with base_qty and per_unit), cheapest, savings_vs_priciest_pct }`; 422 when units cannot be compared |
| `GET /finance/subscriptions` | `{ items: [{ id, title, cost, repeat, monthly, yearly, due, url }], monthly_total, yearly_total, skipped: [{ id, title, reason }] }` from `subscription` watches |

The vault folder is the source of truth for notes. Writing a note entity (sync, POST, PATCH, capture) writes `<vault>/<path>` as frontmatter (`id`, `title`, `tags`) followed by the body. Writing a file through `PUT /vault/file` parses frontmatter, takes the title from frontmatter, else the first `# ` heading, else the filename, collects `[[wikilinks]]` into `links` and `#tags` plus frontmatter tags into `tags`. Path changes move the file; deletions remove it. At startup the hub reconciles: files changed on disk since the last index update their entities, notes without a file get one written. Paths with `..`, a leading slash, a drive letter or a non `.md` suffix are rejected with 400.

Work space entities are limited to `task` and `event`; a note pushed with `space: work` is rejected. Work notes never reach the vault.

## AI pipeline, in order

1. Route by `task_type`: `draft` tries the adapter then Ollama; `classify` is always Ollama; `general`, `troubleshoot` and `plan` use Ollama unless the request (or `EA_ALLOW_CLOUD_DEFAULT`) allows cloud and a key is set, in which case Anthropic is tried first with Ollama as fallback. The first backend that answers wins; failures are recorded in `ai_calls` and the next one is tried.
2. For `troubleshoot`, open (or create) the session ledger. If the newest user message contains "didn't work", "no change", "same", "nope" or "still", the last pending ledger entry gets that result and its text is added to `ruled_out`.
3. Load memory: active rules; facts (minus `private` ones when the backend is Anthropic, minus work-space ones unless `allow_work`); the open ledger for the session; a project's resume card when the conversation mentions that project's id; for every known host (facts keyed `host:<name>` and runbook hosts) the conversation names, the first 1500 characters of its runbook and its last three journal entries, with runbooks trimmed first so the host memory stays under 6000 characters.
4. Build the system prompt: rules with `enforce` in `prompt` or `both`, the fact list, the ledger (tried, ruled out, confirmed), the project card, the host memory (`troubleshoot` only), and a task-type instruction. Client-supplied `system` messages are appended after it.
5. Redact every user and assistant message with the shared `redact`: keys, tokens, password assignments, bearer headers, every private fact value as a literal, and email addresses when `space` is `work`. The count is returned as `redactions`.
6. Call the backend (streaming for `/ai/chat/stream`).
7. Apply the shared `applyStyle` (dashes, platitudes, closing filler, "final fix", emoji in code) and then every active rule that has a `pattern` with `enforce` in `filter` or `both`, compiled as `new RegExp(pattern, flags ?? "g")`. Names of the patterns that changed the text come back as `rules_applied`.
8. Pre-flight (every task type): when the reply contains a destructive command from the table below, a `Pre-flight for \`<command>\` (<rule>):` block with three lines (back up or snapshot, verify the target, rollback) is placed immediately before the first code block or line that holds it, `preflight:<rule>` is added to `rules_applied`, and a `journal` entry `{ outcome: planned, risk: high, host, what (first 120 characters of the command), command, rollback, session_id }` is written. `host` is the first known host named on the command's own line, else in the reply, else in the request, else `unknown`. A reply that already carries a block is left alone, and the same command in the same session updates its journal row instead of adding another.
9. For `troubleshoot`, append `{ what, result: "pending" }` to the ledger, where `what` is the first two numbered or bulleted lines of the reply, else its first two sentences.
10. Persist the session (request messages plus the reply) and write an `ai_calls` row: backend, model, redaction count, prompt and completion tokens when reported, latency, ok flag and error.

`POST /capture` with `auto` never blocks on the model: the capture row is stored first, the shared rule classifier decides most cases, and the model is consulted only when the rules return `none`, Ollama is configured, and it answers inside `EA_CLASSIFY_TIMEOUT_MS`. When the model is off, unreachable or late and the text is at least 80 characters or contains a line break, the hub parks it as a note instead of losing it: `Inbox/<first 60 characters of the first line, filesystem-safe>.md` (numbered when taken), title from the first line, body the full text, capture marked processed with `suggested_kind: note` and `sorted_by: auto`. Shorter text, and text the model deliberately called `none`, keeps `suggested_kind: none` and stays unprocessed. Every processed capture records `sorted_by` as `auto` or `manual` so `/metrics/proof` can tell them apart.

Device liveness: `/sync/push`, `/sync/changes` and `/live` take the device id (body or `device_id` query) and move the device entity's `last_seen` at most once per 60 s per device. The write goes straight to the row (`store.patchSilent`): no change row, no bus event, no file hook, so a polling client never wakes the others.

## Planner (Module 1: days and tasks)

All planner arithmetic is local wall-clock time in `EA_TZ`. The day window runs from `EA_DAY_START` to `EA_DAY_END`. Active `plan_rule` entities add fixed intervals on the days they name: `blackout` and `commitment` remove time, `preference` only marks it. A rule with `alternating_anchor` applies on weeks that are an even number of weeks from the anchor's Monday (custody weeks). Task blocks (tasks with `block`, not deleted, not done) and `event` entities remove time too. What is left inside the window is cut into free slots; a slot that overlaps a preference is split at the preference's edges so the preferred stretch stands on its own, pieces shorter than `min_hours` are merged back into a neighbour, and anything still shorter than `min_hours` is dropped.

`digest` is the first lines of `/planner/today`: `Now: <task>` or `Nothing queued`; `Blocks: 18:00 to 21:00 <title>` or `No blocks today`; a `Due:` line with reminders due today and watches inside their lead window when there are any; `N captures to sort` when there are any. At `EA_DIGEST_TIME` the hub emits one `notify` `{ id: "digest:<date>", kind: "digest", title: <first line>, at }` per day.

Watches: every `watch` write (hook) and the 04:00 daily job make sure the watch owns exactly one reminder, `Renew: <title>`, at `due - lead_days` at 09:00 local, friction `reason`, `linked_id` the watch, `reminder_id` on the watch. When `due` or `lead_days` move, the reminder moves with them and any acknowledgement or snooze is cleared. Deleting the watch deletes the reminder. Watches with `probe_url` are probed in the daily job: a TLS handshake to the URL's host and port (443 by default), 5 s timeout, chain not validated so an expired certificate still answers; `due` becomes the certificate's `valid_to`, `last_probe` is set and `last_probe_error` is cleared, or set to the error with `due` untouched. The prober is `hub.tlsProbe`, replaced in tests. `npx tsx src/main.ts watches` runs the job once.

Activity check-in: every 60 s the hub finds the newest `activity` log that no later `activity` log with the same value and `note: "end"` has closed. Once `EA_FOCUS_CHECK_HOURS` have passed since its start or its last check-in it emits `notify` `{ id, kind: "activity", title: "On <value> for <h> h", at, log_id }` and appends the time to the log's `checkins` (a normal patch, so clients see it). Clients show a banner with "Still on it" (do nothing) and "Stop" (create the `end` log).

Seed: `deploy/seed/plan_rules.json` holds a `Work` blackout (Monday to Friday 09:00 to 17:00) and an `Evening block` preference (18:00 to 22:00). Plan rules are matched by title and only created when missing, so the hours the user edits in place survive every redeploy. Watches are never seeded.

## Memory and runbooks (Module 2)

Hosts are the names in facts keyed `host:<name>` plus the `host` of every runbook, matched as whole words, case-insensitive. A runbook per host holds dated sections; the journal holds one row per change with its risk, rollback and outcome; snippets keep commands with `{{name}}` parameters. `GET /hosts` is the index over all three. Logic lives in `src/memory.ts`, the detector in `src/preflight.ts`, the routes in `src/routes/memory.ts`.

Seed: `npm run seed` (and `runSeed`) creates `Runbook: <name>` for every host fact that has no runbook yet, with the fact value as the first paragraph under `## Facts`. Runbooks are matched by host and created only when missing, so hand edits survive every redeploy and a runbook the user deleted stays deleted.

Pre-flight: the detector table in `src/preflight.ts` (`DESTRUCTIVE`, one row per `{ name, pattern, backup, verify, rollback }`; add a row to extend it). `fdisk -l` and `parted -l` are read-only and do not match.

| Rule | Pattern |
| --- | --- |
| rm -rf | `\brm\s+(?:[^\n;&|]*\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b` (every recursive rm) |
| zpool destroy | `\bzpool\s+destroy\b` |
| zfs destroy | `\bzfs\s+destroy\b` |
| mkfs | `\bmkfs(?:\.[a-z0-9]+)?\b` |
| dd if= | `\bdd\s+(?:\S+\s+)*if=` |
| fdisk | `\bfdisk\b(?!\s+-l\b)` |
| parted | `\bparted\b(?!\s+-l\b)` |
| wipefs | `\bwipefs\b` |
| DROP TABLE or DATABASE | `\bDROP\s+(?:TABLE|DATABASE)\b` (i) |
| reg delete | `\breg\s+delete\b` (i) |
| format | `(?<=^|[\s;&|(])format\s+[a-zA-Z]:` (im) |
| diskpart | `\bdiskpart\b` (i) |
| rendom | `\brendom\b` (i) |
| rsync --delete | `\brsync\b[^\n]*--delete` |
| git push --force | `\bgit\s+push\b[^\n]*(?:--force\b|\s-f\b)` |
| terraform destroy | `\bterraform\s+destroy\b` |
| blkdiscard | `\bblkdiscard\b` |
| docker compose down -v | `\bdocker(?:\s+|-)compose\b[^\n]*\bdown\b[^\n]*(?:\s-v\b|\s--volumes\b)` |
| zfs rollback | `\bzfs\s+rollback\b` |
| Remove-Item -Recurse | `\bRemove-Item\b[^\n]*\s-r[a-z]*\b|\b(?:rd|rmdir|del|erase)\s+(?:\/[a-z]+\s+)*\/s\b` (i) |
| git clean | `\bgit\b[^\n]*\bclean\b[^\n]*(?:\s-[a-zA-Z]*f|\s--force\b)` |
| sgdisk | `\bsgdisk\b` with an option other than `-p`, `-v`, `-b` (print, verify, back up the table) |
| sfdisk | `\bsfdisk\b` without `-d`, `-l`, `-J`, `-V`, `-s`, `-g`, `-F` or their long forms |
| lvremove | `\b(?:lvremove|vgremove|pvremove)\b` |

A reply about a command that already ran in its turn (an approved change it reports on) gets no block and no planned entry.

Close flow, `POST /ai/sessions/:id/close`:

1. The session must exist (404). `outcome` must be `fixed`, `abandoned` or `parked` (422).
2. Host: `host` from the body, else the first known host named anywhere in the session, else none. Project: `project_id` from the body (404 when unknown), else the first project id mentioned in the session.
3. With a backend available, one chat call with a strict JSON instruction asks for `{ runbook_section, journal: [{ what, command?, risk, rollback? }], snippets: [{ title, os, language, body, params }] }` from the outcome, note, host, ledger and the last 12000 characters of the transcript. The answer is parsed defensively: code fences stripped, unknown `risk` becomes `medium`, unknown `os` becomes `any`, malformed rows dropped, at most two snippets. When no backend answers or the JSON has no section, the rule-based summary is used instead: `## <date>: <ledger topic or first user line>`, the outcome and note, the first symptom line, the ledger's tried, ruled out and confirmed lists, and the last three user messages. `via` in the response says which path ran.
4. Runbook: when a host is known, `Runbook: <host>` is found or created and the section is appended wrapped in `<!-- session:<id> -->` and `<!-- /session:<id> -->`; a section that does not start with `## ` gets a `## <date>: <topic>` heading; `last_verified` is set. A second close of the same session replaces the section between its markers.
5. Journal: rows a previous close of this session wrote (`source: close`, or a `runbook_id` from before that mark) are deleted, then one row per entry is created with `host` (`unknown` without a host), `session_id`, `runbook_id`, `source: close` and outcome `done` (`failed` for the rule-based row of an abandoned session). An entry for a change already in the session's journal (same host, same command ignoring spacing, `sudo` and case) is not created. Pre-flight rows (`outcome: planned`), the hub's rows for commands it ran and rows from `journal_entry` or the owner are never touched.
6. Snippets: created with `source_session`, `host` and the host as a tag; on a second close they are matched by title and updated, and leftovers from the earlier close are deleted.
7. The session's ledger is closed (`open: false`).
8. With a project, `POST /ai/resume-card` logic writes `project.resume_card` through the model; without a model a three-heading card (Where I left off, What to do next, Open questions) is written from the section and the note. `resume_card_written` reports it.
9. `summary` is the section heading without its `## `.

## Body, home and animals (Module 4)

Logic lives in `src/health.ts`, `src/pets.ts`, `src/sensors.ts` and `src/food.ts`; the routes in `src/routes/home.ts`.

Health: the summary is read from `log` rows. Weight deltas compare the latest weight with the newest weight at or before 7 and 30 days ago (null without a baseline); `caffeine_today` sums today's caffeine values (a log without a number counts as one); `meds_today` lists the `med` values logged today; `meds_expected` splits the `health:medications` fact on commas and keeps the parenthesised brand or else the first word of each part, deduped; `activity_hours_7d` adds up every activity log until its `end` log (an open one until now), clipped to the last 7 days; `next_injection` is the earliest pending reminder titled `Injection: ...`. `POST /health/injection-day` plans the next `weekday` at `time` local and sets `repeat: every 1 weeks on <weekday>`; a second call with the same name moves the one reminder and clears its acknowledgement and snooze when the time changed.

Pets: a `pet_event` with `next_due` owns one reminder, `<pet>: <type> due`, one day before `next_due` at 09:00 local, friction `none`, `linked_id` the event, `reminder_id` on the event. The after-write hook moves it with `next_due` and `type`, deletes it when `next_due` is cleared or the event is deleted. Custody comes from an active `info` plan rule titled `<pet> week`: with an `alternating_anchor` the pet is here on anchor-even weeks and `next_handoff` is next Monday 00:00 local; a rule without an anchor means always here; no rule means both null. `info` rules never block the planner.

Sensors: one `sensor` row per name. Each reading updates `last_at` and `last_value` and recomputes `state` against `min` and `max` (`low`, `high`, else `ok`); a reading older than `last_at` is stored but moves nothing. Every state change after the first reading emits one `notify` `{ id, kind: "sensor", title, at, name, value, unit, state }`: into `low` or `high`, back to `ok`, and `stale`. The minute loop (the same one that runs the activity check-in) marks a sensor `stale` when `stale_minutes` (default 180) pass without a reading, once. `alert: false` keeps the state but sends nothing. Readings are entities like everything else but are read by SQL per sensor and time window, left out of `GET /sync/changes` unless `kinds=reading` is asked for, and hard-deleted (no tombstones) at 03:20 every night once older than `EA_READING_KEEP_DAYS`. `series_24h` averages equal-count buckets down to 288 points (one per 5 minutes over a day) and keeps each bucket's last timestamp.

A microcontroller posts with MicroPython and `urequests`, no headers:

```python
import urequests, json
HUB = "http://hub.your-tailnet.ts.net:8787"
TOKEN = "<EA_TOKEN>"

def post_reading(name, value, unit):
    url = "%s/sensors/%s/readings?token=%s" % (HUB, name, TOKEN)
    r = urequests.post(url, data=json.dumps({"value": value, "unit": unit}), headers={"Content-Type": "application/json"})
    r.close()

post_reading("cabinet_temp", 27.5, "C")
```

The hub fills `at` with its own clock, so the board needs no NTP. Set `min`, `max`, `location` and `stale_minutes` on the sensor entity afterwards with `PATCH /entities/:id`.

Food: `POST /food/pick` is rule-based and deterministic. Eligible options are not `avoid`, not in `exclude`, of the requested `mode` (without a mode any kind but `home`, as long as the `diet:no_cook` fact exists), never mention a texture the `diet:textures` fact names (any of a dozen common ones such as mushroom, olive or tomato, matched against tags, items and name), and cost at most `budget` when one is given. Score: `protein` +2; `plant` +1, or +3 when the `health:doctor_rules` fact exists; never picked +2, picked inside the last 3 days -4, otherwise +0.1 per day since the last pick up to 30; with the doctor's rules `sweet-sauce` -3, `fried` -2, `tomato` -1; rating divided by 10 as the tie-breaker, then name order. `why` is one line of the terms that scored, for example `protein, not picked in 9 days, no sweet sauce`. With nothing eligible `pick` is null and `why` says what kind of option to add. Only `POST /food/picked` writes `last_picked` and `times_picked`.

Seed: `deploy/seed/food_options.json` starts empty, so a new hub's food list is the owner's own; the tests seed eleven sample options (sushi, Thai, grilled chicken bowl, steak, eggs, Mediterranean, poke, burrito bowl, lentil soup, a General Tso's entry tagged `sweet-sauce` and `fried`, and a tikka masala entry tagged `tomato` with `avoid: true`). Seeded options are matched by name and created only when missing, so ratings, pick history and deletions survive a redeploy.

`/status` carries `home: { sensors, sensors_alerting, readings_24h, pet_events_30d, food_options }` (`sensors_alerting` counts `low`, `high` and `stale`). `/metrics/proof` rows carry `health_logs`, the weight, med, bp, caffeine, mood and sleep logs dated that day.

## Creative and builds (Module 5)

Logic lives in `src/projects.ts`, `src/procedures.ts`, `src/music.ts` and `src/quiz.ts`; the routes in `src/routes/creative.ts`.

Parts: an after-write hook on `project` fills each part's `have` (the summed `qty` of inventory rows with the same name, case-insensitive) and `inventory_id` (the first match), and runs again over every project whenever an `inventory` row is written. The patch is skipped when nothing changed, so the hook never loops.

Plan note: `POST /projects/:id/plan` renders the six headings in order from the existing body and the given sections, keeps any other heading after them, and appends `- YYYY-MM-DD: <log_line>` under Log. Goal falls back to the previous Goal, then the project's `definition_of_done`; Definition of done always mirrors the project. Writing the same plan twice yields the same body. The note is written through the vault (file plus entity, id kept) and `project.plan_doc_path` points at it. A session close with a project (given or mentioned) appends `Session <outcome>: <summary>` to Log and sets Current state to `<outcome>: <summary>` and Next to the close note (or `Nothing open from the last session.` when fixed), creating the plan when the project has none; `plan_note_id` reports it.

Procedures: the rule-based splitter takes numbered lines (`1.`, `2)`, `Step 3:`) and bullets as steps, joins continuation lines to the step before them, attaches a fenced block as the previous step's `command` (a block with no step before it becomes a step of its own), uses a lone inline code span as the command when there is no fence, and pulls `on <host> as <user>:` off the front of a step. The title is the given one, else the first heading or plain line before the first step. With a model, `POST /procedures/from-text` asks for `{ title, steps: [{ text, command?, host?, user? }] }` in strict JSON once and falls back to the rules when the answer has no usable step; `host` in the body fills steps that name none. In the chat pipeline a `troubleshoot` or `plan` reply with three or more numbered steps (fenced blocks do not count) becomes a procedure through the rules only, never a second model call, titled after the first user line with `source_session` set; the response carries `procedure_id` so a client can offer "Run as procedure".

Music: `POST /music/quick` recognizes chord tokens (`Am`, `F#m7`, `Bb`, `C/G`, `Cadd9`), one time signature (`6/8`, `4/4`), a tempo (`112bpm`, `bpm 112`, `112 bpm`) and a tuning (`drop D`, `drop C`, `DADGAD`, `standard`, `E standard`, `B standard`, `open G`, `half step down`); the remaining words are the title, else the chords are. Chords make a `progression` with `body` the chord line and `key` from the first chord; no chords make a `riff`. Seed: `deploy/seed/music_notes.json` holds two `reference` entries (a gain staging cheat sheet, a DAW session checklist), matched by title and created only when missing, so edits and deletions survive a reseed.

Recall quiz: at `EA_QUIZ_TIME` the hub takes every session touched today (local day, user and assistant messages, the `:close` and `:resume` helper sessions skipped), asks the model once for up to five `{ q, a, hint, topic }` items about what was learned and never about the user, stores the `quiz` for the date with `source_sessions`, and emits `notify { id: "quiz:<date>", kind: "quiz", title: "Recall quiz: <n> questions", at, date }`. No sessions today, no model, or no usable item means no quiz that day; a day that already has one is left alone. `quiz_streak_days` counts consecutive days with a completed quiz ending today or, when today's is not done yet, yesterday.

## Homelab ops (Module 6)

Logic lives in `src/monitors.ts`; the routes in `src/routes/ops.ts`.

Checks run from the hub's own host, each bounded by `timeout_s` (default 5):

- `ping`: the system `ping` binary, one packet (`ping -c 1 -W <s>` on Linux, `-t <s>` on macOS, where `-W` means milliseconds). No raw sockets, so it runs as a rootless user. `target` is a hostname or IP.
- `tcp`: a socket connect to `host:port` (`[v6]:port` allowed); the connection is closed at once.
- `http`: a GET with an abort timeout. Without `expect`, ok on 2xx or 3xx. A three-digit `expect` must equal the status. Any other `expect` must appear in the body (first 256 KB), whatever the status.
- `tls`: the watch prober reads the certificate (chain not validated); ok when it expires 14 or more days from now, else `last_error` says `certificate expires in N days` or `certificate expired N days ago`.
- `dns`: `dns.promises.lookup` with every address; ok when any address comes back, or when one equals `expect`.

State: every check writes `last_check`, `last_latency_ms`, `consecutive_fails` and `last_error` (cleared on success; `last_ok` on success). `fails_before_down` (default 3) consecutive failures from `up` or `unknown` set `down`, open one `incident` (`opened_at`, `last_error`, `checks_failed`) and emit `notify { id, kind: "monitor", title, at, name, state: "down", error }`. Further failures update the open incident's `last_error` and `checks_failed`. The first success while `down` sets `up`, closes the incident (`closed_at`) and emits `state: "up"`. An open incident with no `acknowledged_at` re-notifies `down` every 6 hours from its open (the clock lives in memory, so a restart counts 6 hours from the open again).

Jobs: a 15 s loop runs every enabled monitor whose `last_check` is missing or older than `interval_s`, at most 8 at a time, skips a pass while the previous one is still running, then runs the re-notify sweep. Every check is a row in the `checks` table (`monitor_id, at, ok, latency_ms, error`), not an entity, so the change feed stays quiet; rows older than 7 days are deleted at 03:30 every night. `uptime_24h` is the share of ok rows per monitor over the last 24 h, two decimals.

Seed: `deploy/seed/monitors.json` holds ten monitors, matched by name (deleted ones included) and created only when missing, so edits and deletions survive a reseed: LAN and Tailscale pings for the owner's other machines (every 120 s), `hub health` (`http://127.0.0.1:8787/health`, expect `ok`, every 60 s), `Ollama` (`<model host>:11434/api/tags`, every 60 s). Core is not pinged (the hub runs on it) and its own Tailscale certificate is not probed (core cannot reach its own Serve endpoint).

`/status` carries `ops: { monitors, down, incidents_open }`; `/metrics/proof` rows carry `incidents_opened`.

## Life admin (Module 7)

Logic lives in `src/admin.ts`; the routes in `src/routes/admin.ts`.

Checklists: templates are copied, never ticked. `instantiate` and `toggle` as in the route table.

Applications: an after-write hook keeps exactly one reminder per application, `Follow up: <company> <role>` at `next_at` with friction `none` and `linked_id` the application. Moving `next_at` moves it and clears any acknowledgement or snooze. Removing `next_at`, deleting the application, or a stage of `rejected`, `withdrawn` or `accepted` deletes the reminder and clears `reminder_id`.

Cover letters: the system prompt carries only `identity` and `history` facts (private ones dropped before a cloud call), the user's style rules (`enforce` of `both` or `filter`), and the hard rule never to invent employers, titles, dates, degrees, certifications or skills; the user message carries the company, the role and the job text. The style filter runs on the draft. The employer check is deliberately narrow: it looks only at capitalized phrases after a lowercase `at ` or `with ` and flags one only when none of its words (three letters or more, minus pronouns, months, weekdays and a few fillers) appears in the company, the role, the job text or the facts. A flagged draft is never saved.

Games: only games every listed player owns (names case-insensitive), with the player count inside `min_players` and `max_players`, `coop` matching when given (true keeps coop games, false keeps competitive ones), and `session_hours` within `hours` when both are known. Ranking: never played first, then least recently played, then higher `rating`, then name. `why` lists ownership, fit, mode, length, recency and rating.

Calculators work in whole cents, half away from zero after trimming float noise. Split: tax and tip are percentages of the subtotal (tip before tax); `shares` are weights, one per person; leftover cents go to the first person. Payoff: monthly rate is `apr_pct / 12`, interest is rounded to the cent each month, the last payment is only what is left; `payment` wins when both `payment` and `months` are sent; "never" when the payment does not exceed the first month's interest; the months mode rounds the payment up to the cent and steps up until the balance clears in time. Unit: mass converts to ounces, volume to fluid ounces, counts to each; any other unit compares only with itself. Subscriptions: per-year factors are `365.25 / n` for days, `365.25 / 7 / n` for weeks, `12 / n` for months and `1 / n` for years; `monthly` and `yearly` are rounded per item and the totals add the rounded values. Watches without `cost`, or with no repeat or a minutes or hours repeat, land in `skipped`.

Seed: `deploy/seed/checklists.json` holds four packing templates (`Camping weekend`, `Overnight bag`, `Work trip`, `Day hike`) and the non-template `US states visited` with all 50 states, matched by title (deleted ones included) and created only when missing. When the states list is created, a note titled like `States visited` or `US states I've visited` (straight or curly apostrophe, matched on title or file name) marks every state it lists as `- [x] <State>`, as a plain list line (`- `, `* `, `1. `) or as a bare line that is exactly a state name; unchecked boxes and states mentioned mid-sentence do not count.

`/status` carries `admin: { checklists_open, applications_active, games }`: `checklists_open` counts non-template, non-archived lists with an unticked item.

## Storage

`hub.sqlite` in WAL mode with tables `entities` (id, kind, space, created_at, updated_at, deleted_at, fields JSON, field_ts JSON), `changes` (seq, entity_id, kind, ts), `devices`, `sessions` (session_id, task_type, created_at, last_at, messages JSON), `ai_calls`, `checks` (id, monitor_id, at, ok, latency_ms, error), `vault_files` (path, hash, mtime, size, entity_id) and the FTS5 table `entities_fts` (id, kind, title, text), which is rewritten on every entity write. Indexed text per kind: note title, body and tags; task title and notes; runbook host, title, body and commands; capture text; fact key and value; project name, definition of done and resume card; reminder and event titles.

Backups: `npm run backup` or the 03:00 timer inside the server run `VACUUM INTO` a temp file, encrypt it with age to the backup key as `<EA_BACKUP_DIR>/hub-YYYYMMDD-HHMMSS.sqlite.age`, remove the plain copy and delete copies older than 30 days. Plain backups an older hub left are sealed and encrypted once, keeping their times. `npm run backup` also fills `<data>/outbox` (the settings in one encrypted zip, each gallery picture and recording encrypted once) for `deploy/user-backup`. `restore` decrypts a backup to a new path; the standard `age -d -i <key file>` opens any of them too. `GET /setup/backup` reports the key, whether its recovery key was saved, the backups and whether the disk is encrypted (CONTRACT.md, Backups and encryption at rest). Litestream is a deploy concern and is not wired here.

Nightly knowledge sweep at 03:10 (`sweep` command for an immediate run): every personal note gets its `links` recomputed through the knowledge map, and notes with no tags get rule-based `suggested_tags`. Writes go through `vault.patchQuiet` and only when the value changed, so files are never rewritten and the change feed sees only real differences. One summary line is logged. The 03:00 backup, the 03:10 sweep, the 03:20 reading purge, the 03:30 check prune, the 04:00 watch job, the digest at `EA_DIGEST_TIME`, the 30 s reminder loop, the 15 s monitor loop and the 60 s minute loop (activity check-in and sensor staleness) all catch their own errors and keep their schedule.

## Tests

`npm test` runs `node --import tsx --test test/*.test.ts` against temp directories with the canned AI backend. Nothing touches the network.

Two evaluations run the real assistant and model instead, each case on a throwaway hub (nothing touches the live data). Run them on the hub machine after any prompt, tool or model change:

```
cd ~/everythingapp/hub && export PATH=$HOME/.local/node/bin:$PATH && set -a && . ~/.config/everythingapp/hub.env && set +a && npx tsx scripts/eval-assistant.ts
cd ~/everythingapp/hub && export PATH=$HOME/.local/node/bin:$PATH && set -a && . ~/.config/everythingapp/hub.env && set +a && npx tsx scripts/eval-filing.ts
```

The PATH line picks the hub's own Node: a non-interactive SSH shell finds a newer one first, and better-sqlite3 is built for the hub's. Case ids after the script name run only those cases.

- `scripts/eval-assistant.ts`: everyday requests against a made-up month.
  - Topics: the day, the weekend, the diary, people, Reminders lists and checklists, tasks, plans, health, Pepper, homelab, renewals.
  - Troubleshooting must not repeat what was tried or ruled out.
  - Tone: no dashes, no vague closing offers.
  - Give case ids to run only those.
- `scripts/eval-filing.ts`: quick captures through the filer, checked for where they went.
  - Calendar days, tasks and due dates, logs, people, memory, the food list, shopping lists.
  - Nothing unrelated may change.

- `sync.test.ts`: auth on every route but `/health`; create via push; per-field LWW with an out-of-order older patch, a newer patch, `deleted_at` through LWW; one change row per applied patch and reading the echo back through `/sync/changes`; rejections for unknown ids, invalid fields and notes in the work space.
- `reminders.test.ts`: `ack` on a weekly repeat computes the next `at` with `nextOccurrence` and clears the acknowledgement; the loop tick fires a due instance exactly once, fires again after a snooze, and never fires acknowledged reminders; snooze friction returns 422 without a reason.
- `capture.test.ts`: `auto` classification of "remind me to order filament", "weight 162", "took claritin" and "call the vet"; manual convert; the small time parser for "tomorrow" and "in 20 minutes".
- `vault.test.ts`: `PUT /vault/file` creates the note with title, tags, links and an injected id; `PATCH` on the note rewrites the file and re-derives links; index hash matches disk; delete; four traversal cases rejected.
- `search.test.ts`: FTS hits across task, runbook and note with a snippet, kind filter, and deleted rows dropping out.
- `ai.test.ts`: the full pipeline with the fake backend, which replies with an em dash, "Great question", "let me know if", a disclaimer line, and echoes a user message containing `password=hunter2` and a private fact value: proves the redaction count, the default style filter and a seeded rule pattern; work-space email redaction; the `ai_calls` audit row; session persistence; `/ai/memory` dropping private facts for cloud; the troubleshoot ledger (pending entry, failure marking, ruled_out); streaming `token` then `done`; resume card written to the project.
- `dashboard.test.ts`: `now` selection, `next` ordering, 7 day log grouping, counts; backup file creation and pruning.
- `hardening.test.ts`: 413 over 2 MB; 400 on invalid JSON and non-object bodies across the JSON routes; 422 on 501 patches with nothing applied; `limit` capped at 1000; 413 on a vault file over 1 MB; `/live` removes its bus listeners after the client cancels; the reminder loop logs a store failure and fires on the next tick; a daily job that throws still runs the next day (mock timers); the three LWW edge cases (equal ts ignored, `create: true` on a known id is a patch, `deleted_at: null` undeletes).
- `status.test.ts`: liveness through `/sync/changes`, `/sync/push` and `/live` with the 60 s throttle and no change rows; `/status` fields; `/metrics/proof` rows for yesterday, totals and the three friction lists; `/reminders/due` window, ordering, overdue and acknowledged handling.
- `planner.test.ts`: week free slots with the seeded blackout and preference, a commitment, an event and a live block (done tasks ignored, short gaps dropped, `min_hours`); an alternating rule on and off weeks, anchored on a non-Monday, and inactive; `/planner/week` validation and the Monday default; schedule 409 on a blackout, a block and an event with the conflict body, `force`, re-scheduling over the task's own block, unschedule, 404 and 422 cases; the today view and digest text, the clipped free slots, the `digest` notify; plan rule seeding created once by title with the user's edits and deletions left alone.
- `watches.test.ts`: a watch creates one linked reminder at `due - lead_days` 09:00 local (date-only and datetime dues), re-plans it on `due`, `lead_days` and `title` changes with acknowledgement and snooze cleared, writes nothing when nothing relevant changed, deletes it with the watch; `renewed` with a repeat rolls one step from the old due and re-plans, without a repeat acknowledges; the daily job with an injected TLS reader writes `due`, `last_probe`, `last_probe_error`, replaces a missing reminder, and the real prober rejects non-https without a socket.
- `focus.test.ts`: the check-in fires once at the threshold, again only after the next interval, stops after the `end` log, honours the configured hours and prints fractional hours; future-dated logs never fire.
- `memory.test.ts`: the pre-flight table against every listed command and seven harmless lines; block placement before a fence and before a plain line, never twice; the pipeline inserting the block with one planned journal row per command and `unknown` without a host; snippet render with defaults, `last_used`, the 422 with `missing`, 404; `/hosts` and `/runbooks?host=`; the close with the fake backend's JSON (runbook created from the host fact, tagged section, journal with `runbook_id`, rendered snippet, closed ledger, `/ledgers?open=`, resume card, 404 and 422 cases); a second close replacing the section, journal and snippet; the rule-based fallback with a dead backend (ledger lists, last messages, note, rule-based card) and the no-host case; defensive JSON parsing and section upsert; seeded runbooks created once, hand edits and deletions left alone, the `memory` status block; troubleshoot prompt injection with the runbook head, the last three journal rows, host selection, no injection for `general`, and the 6000 character budget.
- `status.test.ts` also covers the `planner` block of `/status` and the `blocks_scheduled` and `blocks_completed` proof counters.
- `sweep.test.ts`: the sweep repairs damaged links, suggests tags only for untagged notes, leaves file mtimes alone, writes one change row per changed note, and is idempotent.
- `health.test.ts`: the summary with seeded logs (weight deltas against 7 and 30 day baselines, bp, caffeine and meds today, mood and sleep series, activity hours with `end` logs), `meds_expected` parsing, the `health_logs` proof counter; injection-day creating one weekly reminder, idempotent by title, moving it with the acknowledgement cleared, the 422 cases and the next-weekday arithmetic.
- `pets.test.ts`: a `pet_event` with `next_due` owning one reminder a day before at 09:00 with friction `none`, following `next_due` and `type`, removed when `next_due` is cleared or the event deleted; custody with an anchor on this week and last week, without an anchor, with an inactive rule, and `info` rules never blocking the planner.
- `monitors.test.ts` (every check type replaced by a scripted fake, so nothing touches the network): `fails_before_down` opening one incident with one `down` notify and counting failures while open; recovery closing it with an `up` notify and a new outage opening a second; history rows, `hours` validation, 404s, `uptime_24h` math and the 7 day prune; ack with a note writing and linking the journal row, ack with no body, 400 and 422 cases; the 6 hour re-notify with an injected clock, silent after ack; http `expect` as status and as body text; tls days, ping flags for Linux and macOS, tcp target parsing; the scheduler honouring `interval_s` and `enabled`; at most 8 concurrent checks; `POST /monitors/:id/check`, `/status.ops` and `incidents_opened` in proof rows; the seed created once by name with edits and deletions left alone.
- `admin.test.ts`: instantiate copying and clearing, toggle with the template 409 and index 422; states parsed from checked boxes, list lines and bare lines; the checklist seed created once with states marked from the note; the application reminder created, moved with its acknowledgement cleared, and removed on a closing stage and on a cleared `next_at`; the board's stage order, counts, follow-ups and `/status.admin`; the cover letter through the adapter (note path, link, prompt contents, overwrite), the invented-employer 422, the narrow employer check and the 503; the game picker on ownership, player count, coop, hours, recency, rating and exclude plus `played`; split rounding with the remainder and weighted shares; payoff by payment, by months and never; change and unit order; subscription monthly and yearly totals with skips.
- `sensors.test.ts`: the first reading creating the config through `?token=`, one notify per crossing into `high` and `low` and one back to `ok`, older readings stored without moving the state, `alert: false`, the 422 cases; stale after `stale_minutes` with one notify and `ok` on the next reading, the `home` status block; the 24 h series downsampled to 288 points, csv output, readings excluded from `/sync/changes` unless asked for, the nightly purge; the minute loop running the sensor tick beside a throwing one.
- `food.test.ts`: the pick skipping `avoid`, textures and `home`, scoring protein and plant with a deterministic tie-break and a one-line `why`; `/food/picked` recency, 9 days versus 2 days, budget, exclude, the sweet-sauce entry winning only when nothing else fits, the nothing-eligible reply, and the doctor's penalties off without the fact; seeding the eleven options once by name with edits and deletions left alone.
- `creative.test.ts`: parts filled on project write and refilled on inventory create and edit, the summary rows; the plan note under `Projects/<name>/Plan.md` with six headings, a second write keeping the headings and appending the log, extra headings kept and a no-op rewrite; a session close appending to the plan and refreshing Current state and Next; the splitter with numbered, bulleted and continuation lines, fenced and inline commands and host prefixes; from-text through the fake backend's fallback, advance to completion, back, reset and the 422s, the model path and a bad model answer; a troubleshoot reply with three steps carrying `procedure_id` with one model call, two steps and general sessions not; quick parse for three lines and the `/music` filters; the quiz built from today's sessions with the notify, answers, completion and the streak, the streak ending yesterday and broken by an incomplete day, no quiz without a model; the `creative` status block; the two music notes seeded once by title with edits and deletions left alone.
- `capture.test.ts` also covers the Inbox note fallback: no model, model timeout, numbered paths for duplicate first lines, reserved characters stripped, short text left unprocessed, and a model that answers `none` respected.
