# Mail screen: behavior spec for a native (SwiftUI) client

How the web client's Mail screen (module `mail_inbox`) behaves, written so an iPhone, iPad or Mac screen can do the
same. The hub does all the reading, storing, cleaning and checking; a client lists, shows and asks. Nothing below needs
a hub change.

**Sources of truth**, if this and the code ever disagree:

- `packages/shared/CONTRACT.md`, section **Mail**: every route, field and limit.
- `web/src/lib/mail.ts`: the screen's rules as plain functions (threads, sections, delivery, snooze choices, trips, keys).
  Each has tests in `web/src/lib/mail.test.ts`, which double as worked examples.
- `web/src/views/Mail.tsx`: the screen itself.

**Versions.** Parts marked **(next PR)** are on `mail-next`, after 1.0.11; everything else is in 1.0.11.

**Where it plugs in.** `AppModule` in `apple/Packages/EACore/Sources/EACore/Modules.swift` has `mail` (the receipts
filer, no screen) but not `mail_inbox`, so today the iPhone app lists Mail only in Settings. A screen needs a case
`mailInbox = "mail_inbox"`. New-mail alerts (`notify`, kind `mail`) already reach Apple devices in 1.0.11.

---

## 1. Data

| What | Route | Notes |
|---|---|---|
| The list | `GET /mail` | `messages` (every kept message, at most 5,000, no text), `logos`, `mailboxes`, `snooze_times`, `bundle_delivery`, `custom_bundles`, `mail_notify`, and `folders` **(next PR)** |
| One message whole | `GET /mail/messages/:id` | `text`, `html` (a cleaned page, or null), `quote_at`, `pictures_pending`, `pictures_ask`, plus the list fields |
| Refresh | `POST /mail/refresh` | The hub also refreshes every 15 minutes on its own |
| Read or unread | `POST /mail/seen` with `{ ids, seen }` | Batched, at most 500 ids a call |
| Pin | `POST /mail/messages/:id/pin` | Pins the whole thread |
| Done, Undo | `POST /mail/done`, `POST /mail/undo` with `{ ids }` | At most 500 a call |
| Delete, Spam, Not spam, Move to **(next PR)** | `POST /mail/move` with `{ ids, to }` | `to`: `inbox`, `trash`, `junk` or an own folder's key |
| Snooze, Unsnooze | `POST /mail/messages/:id/snooze` `{ until }`, `.../unsnooze` | |
| Show pictures | `POST /mail/messages/:id/pictures` | Only on a hub without Tor (`pictures_ask`) |
| Settings | `PUT /mail/settings/snooze`, `/bundles/:id`, `/notify`; `POST`/`PUT`/`DELETE /mail/settings/custom-bundles` | |
| A folder **(next PR)** | `GET /mail/folders/:key` | Read-only |
| A draft **(next PR)** | `POST /mail/drafts` | With `preview: true` it saves nothing |
| Greeting and sign-off **(next PR)** | `POST /mail/messages/:id/greeting` | |

A message in the list: `id`, `at`, `from { name, address }`, `reply_to?`, `subject`, `preview` (first 200 characters,
link addresses removed, quoted history left out), `automated`, `bundle`, `state` (`inbox`, `snoozed`, `done`, `sent`;
`folder` **(next PR)**), `pinned`, `seen`, `thread?`, `mine?`, `snooze_until?`, `logo_domain?`, `back_at?`, and
`cards?` **(next PR)**.

Reload the list after every action, and when the screen comes back to the front.

---

## 2. Layout

- **Side list** (a drawer on a phone): Inbox, Snoozed and Done, then **(next PR)** Drafts, Sent, Spam, Trash and the
  owner's own folders, then Bundles, the module bundles under "From your modules", "Your bundles" with **New bundle**,
  and at the bottom the mailbox state with a keyboard-keys button and an info button.
  - Counts: Inbox shows its unread threads that are showing now; each bundle shows its unread threads; Drafts shows how
    many there are; Spam and the owner's folders show unread; Sent and Trash show none.
- **Top bar**, in the current view's color: the title (the view's name). In the middle are Refresh, the search box and
  the **Pinned only** switch (the Inbox and, next PR, each bundle, where it keeps only the bundle's pinned mail; a pin inside its knob); on the right is **New mail** **(next PR)**. While mail
  is selected, the view's name stays and "N selected" follows it, with Done (Move to Inbox in Done), Snooze, Pin/Unpin, Mark read,
  Mark unread and ✕. It keeps one height either way.
- **Search** matches every word, ignoring case, in the sender's name, the address, the subject and the preview. It
  searches the current view. On a phone held upright (up to 560px) it is a magnifier beside Refresh **(next PR)**;
  tapped, the field takes the whole bar with a close button, which clears the search, and it stays open while a search
  is typed. A phone on its side shows the search box.
- **Search everywhere** (next PR): with 3 or more characters typed, below the view's own matches, "In all your mail":
  `GET /mail/search?q=` a moment after typing stops, each hit labelled with where it is (`whereLabel`) and a snippet;
  opened, the mail whole, with Show it in its place (Inbox, Snoozed, Done) and All mail with the sender.
- **People view** (next PR): All with <name> on an open thread (or a hit) shows, in the list's place, all mail with that
  person (`GET /mail/search?with=`), theirs and the owner's to them, with Close.
- **Centering:** Refresh, search and Pinned only stay centered in the bar at every width. The two sides are equal, never
  narrower than what they hold, and the search box shrinks to keep them so. Up to 420px, Pinned only is a round pin
  button and New mail a round pencil (white circles, below).
- **The bar's buttons (next PR)** look like the Pinned only switch's circle: Refresh (and the phone's magnifier) a white
  circle, New mail a white pill, with their icon and words in the bar's color. Pointed at, as Sweep: solid in the bar's
  color deepened, the icon and words white, with a thin white ring; Pinned only's circle does the same. The pin is in
  the bar's color, an outline while off and filled while on. On a phone (up to 420px) New mail and Pinned only are
  white circles too, all four 36px.
- **Everything clickable shows it when pointed at (next PR):** on the bar, deeper and never lighter (the search box's
  shade darkens, the menu and ✕ get one); on the page, the screen's hover shade and a darker border (an open mail's
  header, More, smart replies, Move to, Attach files, picture previews, the bundle colors), or the solid color for Pin,
  Snooze, Done and Sweep. A new control gets one too.

---

## 3. Threads

Messages with the same `thread` show as one row (`threadRows` in `lib/mail.ts`):

- **The members** are every message of the thread, oldest first. The owner's own replies (`mine`, state `sent`) are
  among them, but never make a row on their own.
- **Its state** is Inbox while any received mail in it is in the Inbox, else Snoozed, else Done.
- **It's unread** while any received message is, and **pinned** when any is.
- **Its people line** is "Alex, me (3)": first names in order, the owner as "me", then the count.
- **Its preview** is the newest message's, as "You: …" when the owner wrote it.
- **A person's mail anywhere in it keeps the thread out of the bundles,** so it stands alone.
- **Actions use the right members:** Done and Snooze take the thread's Inbox and snoozed mail; Move to Inbox takes its
  done mail; opening it marks its unread mail read.

---

## 4. The Inbox

`inboxSections` in `lib/mail.ts`:

1. **Due reminders** lead Today: the owner's tasks whose reminder time has come (`dueReminders`). Each has Done, Snooze
   and a link to the task, using the Tasks screen's own actions. Snoozed-mail tasks (`task.mail`) are left out, because
   the mail itself comes back.
2. **The rest goes under day headings:** Today, Yesterday, This week, This month, then the month and year. Each mail is
   placed by when it shows (`inboxAt`): when it came back from a snooze (`back_at`), else when it arrived, but a bundle
   held to a daily or weekly time shows at that time (see 9.3).
3. **A bundle is one row per day,** placed where its newest mail is. It opens in place to list its mail, with **Sweep**.
4. **Pinned mail always stands on its own,** never in a bundle. With **Pinned only**, only pinned mail shows.
5. **Each day heading has Sweep:** it marks every unpinned thread under it done, with one Undo.
6. **The actions' colors (next PR):** a row's Pin, Snooze and Done are round buttons in their places' colors (Pin
   the Inbox's blue, Snooze Snoozed's amber, Done Done's green), the icon in that color on a light wash of it, solid with
   a white icon when pointed at (Pin and Snooze also while on); Sweep is a pill in Done's green the same way.

The time beside a row is the hour today, the weekday this week, else the date (with the year when it's not this year).

---

**Back later today (next PR):** above the day headings, the snoozed threads coming back later today (`backLaterToday`),
soonest first, as rows showing "Until 3 PM"; they open from there.

**Needs you (next PR):** above the day headings, up to 5 Inbox threads the hub's model marked `today` or `needs_reply`
(`needsYou`), today's first, each with its people, Today and Reply marks and the model's summary (else the subject),
opening the thread; with a line saying it was sorted by the hub's model and can be wrong. Rows of mail needing a reply
show a small "Reply?". The info panel's switch turns triage off. The model runs only when the owner asks: while mail
waits unsorted, the same place shows "N new mails are not sorted yet." with **Sort new mail** (`POST /mail/triage`),
then "Sorting new mail: N left." while it runs, and the hub's own sentence when a run stopped early (a game on the
graphics card, a chat). Only a hub set to `EA_BACKGROUND_AI=auto` sorts after each refresh by itself.

---

## 5. A row

From left to right:

- **The unread dot:** an accent-colored 8px dot, centered in its own narrow column.
- **The circle (34px):**
  - the brand's logo when iCloud verified it (`logo_domain` in `logos`, a `data:` SVG; show it only as a picture);
  - else, for automated mail in a bundle, the sender's initials in white on the bundle's color;
  - else (a person, or mail in no bundle) the initials on gray.
  - Initials are Apple Mail's: the first letters of the first and last words of the name ("Alumni Relations Team"
    gives AT), else one letter.
- **Two lines:** the people line (bold while unread, with a small pin when pinned), then the subject and the preview
  ("Subject · preview…", the subject bold while unread).
- **The first card** **(next PR)**, as a third line in its bundle's color, for example "UPS · 1Z999… · Arrives Tue,
  Nov 24 · In transit". It's text only on the row; Track is on the open mail.
- **The time,** or "Until <time>" for snoozed mail.

Pointing at a row (desktop) shows Pin, Snooze and Done over the time. On touch, they're on the open mail. Selection: the
circle turns into a checkbox when it is pointed at, or for every row while anything is selected.

**Swipes (touch, next PR, on hold):** right for Done (Move to Inbox in Done), left for Snooze, which opens the mail with
its snooze choices. A swipe counts only once it moves 10px and clearly sideways (1.5 times more across than down). It
acts past 35% of the row's width, at most 120px; short of that, the row slides back. There are no swipes while anything
is selected. On iOS, the system's swipe actions fit better than copying this.

---

## 6. An open thread

- **The header:** the circle, the subject, and the sender's **real address, always**: "**Alex** <alex@example.com> ·
  Tue, Nov 24, 9:12 AM". A thread shows "Alex, me (3)" instead, and each message shows its own address.
- **The thread's actions** (top): Done, Snooze, Pin, Mark unread, and **(next PR)** Delete, Spam, Move to, Unsubscribe or
  block, and All with <name>.
- **Each message's actions** (under it; in a thread, under each open message) **(next PR)**: Reply, Reply all and
  Forward; the owner's own replies have Forward only. The writing box opens right under that message (section 10).
- **Opening a thread** marks its unread mail read, on the hub and in iCloud (only the read flag). Mark unread must
  not be undone by the thread closing.
- **A thread's messages are stacked oldest first.** The newest one is open, plus the newest 3 unread ones
  (`OPEN_UNREAD_MAX`). Each other message is one line (who, when, first words) that opens it.
- **A snoozed thread** says when it comes back, and that its task is called "Snoozed mail".

---

## 7. Showing a message safely

This part matters most. Mail is hostile input.

- **The page:** `html` is the mail as sent, rebuilt by the hub from an allowlist. Show it in a web view with
  **JavaScript off, nothing loaded from the network, and no navigation inside it.** The web client uses an iframe with
  `sandbox="allow-same-origin"` only and `referrerPolicy="no-referrer"`. A `WKWebView` with JavaScript disabled and a
  navigation delegate that cancels every navigation and opens checked links outside is the equivalent.
- **Links:** a tap opens the link outside the app (Safari) only when it is `http`, `https` or `mailto` (`frameLink`).
  Anything else does nothing. Show each link's real address, as the web client does with a tooltip.
- **Height:** fit the page to its content, measured with the view at zero height first, and capped at 30,000px (a
  longer mail scrolls inside). Measuring at the view's current height let a crafted mail grow without end.
- **Quoted history:** folded behind "•••" when the page has something besides it. The page marks it with
  `QUOTE_SELECTOR` while its body has the class `aeneas-fold`; the client removes that class to unfold. A mail that is
  all quote (a forward) is never folded.
- **Folded too much? (next PR):** beside "•••", a panel listing the first 8 lines the fold hides (`foldedLines`) to
  mark, and Don't fold this mail (on by default); saved with `POST /mail/messages/:id/folding`. A mail with `no_fold`
  opens unfolded, its page too. The info panel lists the notes (`GET /mail/folding-notes`) with Clear the notes.
- **Pictures:** `pictures_pending` means the hub is still fetching them (say so). `pictures_ask` means the hub has no
  Tor, so show **Show pictures** with the reason ("your hub would fetch them from the sender, who then sees your home's
  internet address"); it calls the pictures route and shows the mail it returns.
- **Show as text:** the mail as plain text instead of the page. Write web addresses as links whose text is the address
  itself (`textParts`), https only. Show the real host beside a host written in another alphabet (`xn--…`).
- **Warnings:**
  - When the sender's name contains a different address than the real one (`nameHidesAddress`): "The sender's name
    shows a different address than the one it came from."
  - **Cards (next PR):** a box above the body, one line per card (`cardLine`), with Track (a package) or Open when it
    has an https link (`cardLink`, checked again). A card read from the text says "Read from the mail's text: check it
    against the mail."
- **Never put anything from a mail into markup or into a URL the app builds.** Everything it carries is plain text.

---

## 8. Actions

- **Done** moves the thread's mail to Archive in iCloud, with an **Undo** bar for 10 seconds ("Marked done", or
  "3 marked done"). In Done, it's **Move to Inbox**. Ids go 500 a call.
- **Snooze** offers four choices (`snoozeChoices`) and a date and time of the owner's own:
  - Later today: 3 hours on, rounded to the hour, only before 9 PM.
  - Tomorrow at 8 AM.
  - This weekend: Saturday at 9 AM, or **Next weekend** when it is the weekend.
  - Next week: Monday at 8 AM.
  - The owner's snooze times change all of these. A snoozed thread offers **Change snooze** and **Unsnooze**. Snoozing
    shows Undo.
- **Undo for more (next PR):** Pin and Unpin, Mark read and Mark unread (one or a selection) and Block show the Undo
  bar too: it puts each thread back as it was, marks the same mail back, or unblocks (mail already in Spam stays).
- **Pin** applies to the whole thread. Pinned mail stays where it is, shows a pin, and Sweep passes it by. **(next PR)**
  A pin is also Apple Mail's flag, both ways: pinning flags the thread's mail in iCloud, and a mail flagged in Apple
  Mail shows pinned after the next refresh.
- **Read and unread:** the read flag syncs both ways with iCloud.
- **Delete, Spam and Move to (next PR):** `POST /mail/move`, IMAP `MOVE` only, so nothing is erased from Aeneas.
  - On an open thread: **Delete** (to Trash), **Spam** (to Junk) and a **Move to…** menu of the owner's folders. They
    take the thread's received mail (`ids.open` and `ids.done`), never the owner's replies.
  - In a folder: Spam has **Not spam** and Delete; Trash has **Move to Inbox** (and says mail is erased only from
    Apple Mail); the owner's folders have Move to Inbox, Delete and Move to; Sent and Drafts have Delete only.
  - **Undo** sends the mail back, using the new ids in the answer's `to`. There is none when the mail can't go back
    (Sent, Drafts) or the hub doesn't know its new id. Deleted Done mail comes back to the Inbox.
- **Unsubscribe or block (next PR):** on an open thread, a panel from `GET .../unsubscribe`: one click (through Tor; on a
  hub without Tor, a second press after saying the sender will see the home's address), the sender's page (opened in the
  browser, its host shown), or a draft to their unsubscribe address; and Block the address or everyone at its domain
  (`POST /mail/settings/blocked`), their mail then going to Spam. The info panel lists blocked senders with Unblock.
- **Selection:** click or Space on the circle; Shift extends it. **(next PR)** The selection bar starts with a select-all box
  (`selectAll`): a dash while some are selected, a check when all shown are; pressed, it selects every thread in sight
  (never one in a closed bundle) or, when all are, none. With the side list shown, it sits right above the rows' select
  circles (the title keeps the side list's width), level with the bar's icons. The bar acts on everything selected: Done, Snooze
  (one picker for all), Pin (Unpin when all are pinned), Mark read, Mark unread, Delete and Spam **(next PR)**.
- **Keys (desktop):** ↑ ↓ to move, Shift + ↑ ↓ to select while moving, Enter to open (or open and close a bundle), Esc to
  close and then clear the selection, Space to select, D Done, S Snooze, P Pin, U unread, R read, Delete or Backspace
  Delete and ! Spam **(next PR)**, / search, ? the key list (`MAIL_KEYS`). Never with Ctrl, Cmd or Alt, and never
  while typing (only Esc).

---

## 9. The other views

### 9.1 Snoozed and Done

- **Snoozed** is a flat list, soonest to come back first.
- **Done** is newest first. The hub keeps done mail 30 days; it stays in Archive in iCloud.

### 9.2 A bundle

- **The built-in bundles (renamed in the next PR):** Transactions, Updates, Promotions and Trips are always there,
  in that order (ids `purchases`, `other`, `promos`, `trips`: an id stays when its bundle is renamed, because apps that
  shipped before know only those ids; before: Purchases, Social, Promos and Other. Social is gone: its mail is in Updates,
  as is every notice nothing else claims, and a reply in a mailing list's discussion stands alone). Bills (Renewals and bills),
  Pet and Jobs (Job search) show only while their module is on, each with "Sorted using your … records. Open … ›".
- **The owner's own bundles** come after them, in one of 8 colors (next PR: teal, blue, magenta, orange, violet, red,
  green, gold, `OWN_COLORS` in `web/src/lib/mail.ts`); they may repeat a built-in bundle's color.
- **Colors:** Inbox, Snoozed, Done and each bundle have a color that carries white words at 4.5:1, held by
  `web/src/lib/contrast.test.ts`. **(next PR)** The places keep their meaning (Inbox blue, Snoozed
  amber, Done green), and no bundle shares their families: Transactions teal, Updates violet, Promotions pink, Trips
  red, Bills brown, Pet orange, Jobs slate (values in `web/src/styles.css`, `--b-*` and `--bt-*`). Folders keep Other's
  old gray.
- **In a bundle:** the mail newest first, Sweep, **Show in Inbox** (9.3), **Notify me** (9.4), and **Edit bundle** for
  the owner's own.
- **Trips (next PR):** in the Trips bundle, mail whose flight and stay cards follow each other within a day is one box
  (`tripsOf`), named "Trip to JFK · Dec 3 to 6". Inside is a timeline of its pieces, each opening its own mail. Rentals,
  tables and events join a trip they are within a day of, but never make one, and a trip needs two mails. A date
  without a time counts at check-in 3 PM, check-out 11 AM, or noon. The Inbox's Trips row names the next trip that
  isn't over.

### 9.3 When a bundle shows in the Inbox

The choices are as mail arrives, once a day at a time, once a week on a day at a time, or never (only in the bundle).
`inboxAt` is the rule:

- **Held mail** shows at the next delivery time after it arrived.
- **Never** keeps it out of the Inbox.
- **Pinned mail and a person's mail always show** as they arrive.

### 9.4 Notifications

The hub sends new-mail alerts to devices. The client only offers the settings:

- mail from people (on by default);
- each bundle's **Notify me** (off by default);
- what an alert says: the sender and subject, the sender only, or a count.

### 9.5 The owner's bundles

- **The fields:** a name (1 to 40 characters), a color (0 to 7), and at least one rule: addresses, domains (a domain
  takes its subdomains), or subject words (whole words).
- **More rules (next PR):** words in the mail's text (`body_words`, its first 3,000 characters, whole words) and who
  it was sent to (`to`, an alias in To or Cc; known for mail arriving from 2026-11-22 on).
- **They're checked before the built-in rules,** so they can take a person's mail too ("Family").
- **At most 20.** Deleting one clears its Show in Inbox and Notify settings first.

### 9.7 Attachments (next PR)

- **Rows** show a paperclip when `attachments` is a number. A thread's is its messages' together.
- **On an open mail** with `attachments` present (a number, or null for "not known yet"), ask
  `GET /mail/messages/:id/attachments` and show the pictures' previews (`preview`, checked with `previewSrc`: a `data:`
  JPEG, PNG, GIF or WebP only) and a list of the files with their sizes and **Download**.
- **Download** saves the file (`GET .../attachments/:part`, which answers `application/octet-stream`). Never open it
  inside the app. Before a kind of file that can run programs (`riskyFile`: programs, scripts, shortcuts, disk images,
  macro-enabled Office files), ask: "… can run programs on your computer. Download it only if you expected it from
  <the sender's address>."

### 9.6 Folders (next PR)

- **What shows:** Drafts, Sent, Spam (iCloud's Junk), Trash and the owner's own folders, kept by the hub like the
  Inbox and read-only. There's no Archive entry, because Done shows it.
- **Rows:** Sent and Drafts name who it went to ("To: Alex"), the others the sender. Past 100 mails there's
  **Show more**, and search works inside a folder.
- **Opening one** works as in 7, but folder mail never has web pictures.
- **Notes:**
  - Spam says its pictures are never loaded and its links may not be safe.
  - An open spam mail warns: never sign in or pay through its links.
  - Drafts says to send or change them in Apple Mail.
- **Folder mail is not marked read** when opened. Its actions are in section 8.

---

## 10. Writing mail (next PR)

Drafts only. Nothing is sent from Aeneas: a draft goes to iCloud's Drafts, and the owner sends it from Apple Mail.

- **Which mail a reply answers** **(next PR)**: Reply, Reply all and Forward sit under each message, and the writing box
  opens right under the one chosen, headed "Replying to Alex · Tue, Nov 24, 9:12 AM" (or "Forwarding …") with that
  message's first lines quoted (its `preview`, two lines). In a thread there is never a doubt which message it is.
- **Reply** answers that message, never the owner's own reply. The hub sets
  the recipient (the sender's From address, never its Reply-To), the "Re:" subject and the thread headers. **The
  client sends only `reply_to` and the text.** If the mail's Reply-To differs, say so: "This mail asks for replies to
  go to X. Your reply goes to the address it came from, Y."
- **New mail** (top bar): To (plain addresses only), Subject and the text.
- **Reply all** and **Forward** (next PR), beside Reply under each message (Forward on a folder's mail too): Reply all
  sends `reply_all: true`, and the hub adds everyone else on the mail as Cc (the preview shows it). Forward has To and an
  optional note, with the mail quoted below it; its attachments come along when "Include its attachments" is on.
- **Greeting and sign-off** (replies): when the reply opens, ask for them (`POST /mail/messages/:id/greeting`) and show
  each as an editable field above and below the text, with **Remove**. Never replace what the owner already typed in
  one. The hub checks both again: at most 2 lines of 60 characters, no links, addresses, long numbers or markup.
- **Files** (next PR): Attach in the writing box (at most 10, 15 MB in all), read in the browser and sent as base64 in
  `files`; each listed with Remove; the preview names them. A forward of a mail with attachments has "Include its
  attachments" (on by default), which the hub adds from iCloud when it is saved.
- **Editing a draft** (next PR): Edit on a mail in Drafts opens the writing box with its recipients, subject and whole
  text (from `GET /mail/messages/:id`); saving sends `replaces` and the mailbox's address as `from`, and says the old
  version goes to Trash.
- **Smart replies** (next PR): the greeting call's `replies`, shown as buttons above the text; one tapped goes into the
  text box (after what is typed), to edit like anything typed.
- **Preview** (`preview: true`) shows the whole mail the hub would save: From, To, Subject, and the full text
  (greeting, the owner's text exactly as typed, sign-off). Show the text as plain text. Then **Save to Drafts**,
  **Edit** or **Discard**.
- **After saving:** "Saved to Drafts in iCloud. Open Drafts in Apple Mail to send it."

---

## 11. Security checklist for a native client

1. **Turn off JavaScript in the mail view,** load nothing from the network in it, and block navigation inside it.
2. **Open links outside the app,** and only `http`, `https` and `mailto`. Never follow a link from a card or a page
   without checking it.
3. **Always show the sender's real address** next to the name, and the warnings in 7.
4. **Never build markup or URLs from mail fields,** and show a logo only when it is a `data:image/svg+xml;base64` value
   from `logos`.
5. **Recipients come from the hub,** never from anything the mail says. Send only `reply_to` for a reply.
6. **Keep nothing of the mail on the device** beyond what the screen needs while open. The hub keeps it out of backups
   and sync on purpose.
7. **The assistant can't reach `/mail`.** Don't hand mail to it from the app.

---

**Other mail accounts (since 1.0.15):** besides iCloud, Gmail and any IMAP server with an app password (Settings, Connections, Internet Accounts: Gmail fills in the server; another provider takes the server, port and username; on every device, the Apple apps since gnomecannon/aeneas#23). Their Inbox joins the same Inbox and bundles, with every feature here; Done moves to their Archive (Gmail's All Mail). The screen's words say "your mailbox" and "your mail app" where they said iCloud and Apple Mail. Brand logos stay iCloud's only. They are added and switched in Settings, Connections, **Internet Accounts**: each account's Mail switch decides whether its Inbox shows here.

## 12. Platform guidelines: iPhone, iPad and the Mac app

The web screen switches layouts by width; a native client should switch by **size class** and follow each platform's
own patterns (Apple Mail's are the model), keeping every behavior and every rule above. What the web does at each
width, and what to use instead:

| Web (by width) | Native |
|---|---|
| Below 768px: the phone layout (side list as a drawer behind a menu button) | Compact horizontal size class |
| 768px and up: the side list always shown | Regular horizontal size class |
| Up to 560px: search is a magnifier that opens a field across the bar | `.searchable`, which iOS places itself |
| Up to 420px: Pinned only is a round pin button, New mail a round pencil | Toolbar items with SF Symbols (`pin`, `square.and.pencil`) |
| A row's actions on hover; touch swipes (on hold on the web) | `.swipeActions` on iOS, hover and a context menu on the Mac |

### 12.1 iPhone (compact width, upright or on its side)

- **Navigation:** a `NavigationStack` whose root is the Inbox. The side list (Inbox, Snoozed, Done, Drafts, Sent, Spam,
  Trash, the owner's folders, the bundles) is a list pushed from a back button or a sheet, as Apple Mail's Mailboxes.
- **Toolbar:** the view's title; Pinned only as a toggle; New mail (`square.and.pencil`) at the bottom trailing edge, as
  in Apple Mail. Refresh is **pull to refresh** (`.refreshable`), not a button.
- **Search:** `.searchable` on the list: the view's own matches as the owner types, and "In all your mail" (section 2)
  below them from 3 characters on. iOS keeps the field above the list, so no magnifier is needed.
- **Rows:** the same contents as section 5, one line each for the people and the subject, at least 44pt tall.
  Swipe actions with `.swipeActions`: leading Done (Move to Inbox in Done); trailing Snooze, and Delete with
  `role: .destructive`. A long press offers the rest (Pin, Mark unread, Spam, Move to) as a context menu.
- **Selection:** the list's Edit mode with checkmarks, and the selection's actions in a bottom toolbar (Done, Snooze,
  Pin, Mark read or unread, Delete, Spam), instead of the web's circle that turns into a checkbox.
- **An open thread:** pushed full screen. The thread's actions in the toolbar (Done, Snooze, Pin, and a "More" menu
  for Mark unread, Delete, Spam, Move to, Unsubscribe or block, All with). Reply, Reply all and Forward under each
  message, as on the web.
- **Writing:** a sheet, with "Replying to …" and the quoted lines at the top, the greeting, the text, the sign-off,
  the smart replies as a row of capsule buttons above the text, and Attach (`PhotosPicker` and `fileImporter`).
  Preview is the sheet's next step; Save to Drafts is its confirm button.
- **Attachments:** previews as a horizontal strip of thumbnails. Download is **Save to Files**
  (`fileExporter` or a share sheet with only "Save to Files"): never Quick Look inside the app, and the risky-file
  warning (`riskyFile`) as an alert first.
- **On its side:** most iPhones stay compact, so the same layout with wider rows. The largest iPhones are regular
  width on their side; there, use the iPad's two columns (12.2).

### 12.2 iPad (regular width)

- **Navigation:** `NavigationSplitView` with three columns: the side list, the list, and the open thread. In portrait
  or Split View, the side list collapses as the system does it.
- **Toolbar:** Refresh, the search field, Pinned only, and New mail. Search, Snooze and Move to menus show as popovers.
- **Keyboard:** with a hardware keyboard, the web's keys (`MAIL_KEYS`) as `.keyboardShortcut`s on the list: arrows,
  Return to open, Space to select, D, S, P, U, R, Delete, !, / and ?. Show them in the system's shortcut overlay
  (holding ⌘).
- **Pointer:** hover shows a row's actions, as on the web desktop.
- **Writing:** a sheet, or a window of its own when the owner drags it out (`openWindow`).

### 12.3 Mac app (the desktop version)

- **Window:** `NavigationSplitView` with three columns, as Apple Mail on the Mac: the side list, the list, the open
  thread. A minimum window size that fits all three (about 900 × 600pt); below it, the side list collapses.
- **Toolbar:** Refresh, Pinned only and New mail as toolbar buttons; `.searchable(placement: .toolbar)` for search,
  with "In all your mail" in the list below the view's matches. The thread's actions in the toolbar when a thread is
  open (Done, Snooze, Pin, Delete, Spam, Move to), as Apple Mail places Archive and Move.
- **Menu bar:** a **Message** menu with the actions and Apple Mail's shortcuts, so the Mac keys feel familiar:
  Reply ⌘R, Reply All ⇧⌘R, Forward ⇧⌘F, Done (Archive) ⌃⌘A, Delete ⌫, Mark as Unread ⇧⌘U, Move to Spam ⇧⌘J, Pin ⇧⌘L,
  Refresh ⇧⌘N, New Mail ⌘N. The web's single letters (D, S, P, U, R, !) still work while the list has focus and
  never while typing, as `MAIL_KEYS` says.
- **Rows:** hovering a row shows its actions over its time (section 5). **Right-click** gives a context menu with
  every action, Move to as a submenu of the owner's folders. Native list selection replaces the web's circle:
  ⌘-click and ⇧-click to select several, then the toolbar and the Message menu act on all of them.
- **An open thread:** in the third column, the messages stacked as on the web, with Reply, Reply all and Forward under
  each. A double-click opens the thread in a window of its own.
- **Writing:** a **window of its own** (`openWindow` with the reply's target), as Apple Mail's compose window, with
  the "Replying to …" header and quote at the top, and Attach with an open panel or drag and drop onto the window
  (at most 10 files, 15 MB, the same as the web).
- **Attachments:** Download opens an **`NSSavePanel`** with the hub's file name; never open the file from the app
  (no Quick Look, no `NSWorkspace.open` on it). Ask first for a file that can run programs (`riskyFile`). A
  dragged-out attachment is the same as a download.
- **Links:** open in the default browser with `NSWorkspace.shared.open`, after the same check as everywhere
  (`frameLink`: `http`, `https`, `mailto` only).
- **The mail view:** a `WKWebView` with `allowsContentJavaScript = false`, a content rule list that blocks every
  network load, and a navigation delegate that cancels every navigation and hands checked links to the browser.
  Measure the page's height as section 7 says.
- **Notifications:** the hub's new-mail alerts through `UNUserNotificationCenter` (they already reach Apple devices).
  A click opens the Mail window at that thread.

### 12.4 Everywhere

- **Dark mode, Dynamic Type and Increase Contrast:** the bundle colors carry white words at 4.5:1 in both modes (as
  `web/src/lib/contrast.test.ts` holds the web's); text sizes follow the system.
- **VoiceOver:** every icon button has the web's label (its `aria-label` or `title`); a row reads as
  "Alex, Gutters, unread, pinned, 2 attachments, Tuesday".
- **Reduce Motion:** no slide for swipes or the side list, as the web's `prefers-reduced-motion` rules.
- **Nothing kept on the device** beyond what is on screen (section 11): no offline mail cache, no attachment cache, no
  Spotlight indexing of mail.
