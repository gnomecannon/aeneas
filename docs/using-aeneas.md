# Using Aeneas

How to do the common things, and where each one lives. The assistant reads this page (and the other docs and the
module list) to answer questions about the app, so ask it too: "how do I get my calendar in?"

## The parts

- **The hub** is the computer at home that keeps everything and runs the models. Every app is a window onto it.
- **The apps**: iPhone, iPad and Mac (one Apple app), Apple Watch (through the iPhone app), Windows, Android, and the
  web app in a browser. They show the same data; what differs is what each device can read from itself (only the
  Apple apps can read Apple Calendar, Reminders, Contacts and Health).
- **Modules**: everything outside the core (Today, Assistant, Capture, Search, Unsorted Info, Tasks, Week, Notes,
  Memory, People, Lists) is a module you switch on or off in Settings, Modules. The setting is the same on every device.

## Add another device (pair a new phone, tablet or computer)

A Mac, iPad, Windows PC or Android tablet, on a hub that uses Direct link: install Aeneas on it and open it. Set up
shows a code to scan. Point the Camera of a phone that already uses Aeneas at it, and tap Add on the phone. The hub
reaches the new device by itself, from anywhere, and nothing needs typing.

A phone, or a hub on Tailscale or Home Wi-Fi only: on a device that is already paired, open Settings, Connection, Pair
another device. It shows a code (and a QR code) that works once, for 10 minutes. On the new device, install Aeneas,
open it and scan the QR code, or type the code and the hub's address, or paste the pairing link into the address
field. Reinstalling the app on a device means pairing it again the same way.

A web browser cannot use Direct link. It opens the hub at the addresses Settings, How devices reach the hub lists: at
home, or on your tailnet when the hub's computer runs Tailscale and you switch on the Tailscale door there. Then type a
pairing code made on a paired device.

## Today

Today is the day as a status board, the same on every device. From the top:

- **The line at the top** says what is on now and how long it has left ("Dentist cleaning until 4:00 PM, 46 min
  left"), else what is next and how long until it, else that nothing else is scheduled. Under it is the free time
  now or next. With Machines on, Tech's light sits beside it: green when all is good, and a press opens the Tech
  Overview.
- **Needs you** lists only what waits on you, numbered in the order to take it, each with its buttons: reminders
  that have come due, machines and checks that need a look, renewals to renew, job follow-ups, a medicine not logged
  today, and captures the assistant could not file. A charge on autopay is not on Today at all: it pays itself, and
  Renewals lists it.
- **Schedule** names the all-day things first (events, and a plan rule for the whole day), then the day in time
  order with Schedule here on free time, then the people in today's plans with what you have noted about them.
- **To do** shows the task you are doing, or the first one in Next, with its buttons, then your other open tasks:
  the circle finishes one, Start makes it the task you are doing.
- **Today so far** shows today's numbers when Health is on (weight, sleep, steps, caffeine, mood), and the diary's
  lines, finished tasks and logs in the order they happened. To capture something, use Capture, which is on every
  screen.
- **Coming up** shows tomorrow's plans, and birthdays and other dates in the next two weeks.

The cards are in one column on a phone and in up to five across a wide window. On iPhone, iPad and Mac, swiping left
or right shows another day's plan.

## Now

Now shows the one task you are doing, or the first one in Next, with Done, Set aside, Skip and Start block. When
nothing is being done it lists your open tasks, each with Start. On a wide window, what is due today and what is up
next sit beside the task.

## Tasks

- **Set aside** takes a task out of Next and Now, with a reason, until you bring it back; it waits under Set aside.
- **Done** offers Undo for a few seconds. A finished task has **Not done** in the Done list, which puts it back at the
  end of Next.
- **Delete** is in a task's edit (on the iPhone also a swipe, on the Mac the right-click menu) and offers Undo. A task
  from Apple Reminders is deleted there too, except one from a work account, which stays in that account.
- **Personal and Work**: Work holds tasks you add under Work, tasks from work Reminders accounts (Exchange, or one
  named after your work email's domain) and captures that start with "work:". Everything else is Personal. Move to
  Work or Move to Personal in a task's edit changes it; a task from a work Reminders account stays in Work.

## Wide windows

On a large window (a Mac, a browser on a computer, the Windows app, a large iPad on its side) the screens use the
width instead of one column in the middle. Collections become grids of cards, and in the Apple apps Tasks is a board
with its statuses side by side. Notes, the Wiki and the Assistant keep their list at the left with what you open
beside it. In the Apple apps a page about one thing (a person, a machine, a project) shows two lists side by side.
Text you read keeps a width that reads. On the Mac a card cannot be swiped: delete, archive, set aside and move are in
its right-click menu. A narrow window, the iPhone and an iPad held upright keep their lists and swipes.

## Calendars

There are two directions, and they are set up in different places.

### Your iCloud calendars, on the hub (every device)

The Calendar accounts module keeps your iCloud calendars in step with Aeneas on the hub, both ways, so every device
has them: Windows, Android and the web as well as the Apple apps. Switch it on in Settings, Modules, then open
Settings, Connections, Internet Accounts:

1. Make an app-specific password at account.apple.com (Sign-In and Security, App-Specific Passwords). An iCloud account
   already added for Mail needs no new one: switch its Calendars on.
2. Otherwise choose Add Account, iCloud, and enter the address and the password. The hub checks them with iCloud.
3. Switch Calendars on for the account, tick the calendars to keep in step, and pick where events made in Aeneas go.

Single events in those calendars, from 30 days back to a year ahead, come in as your events; edits and deletions
made either in Aeneas or in iCloud reach the other side within about 5 minutes (10 seconds after a change in the
app). When both sides changed the same event, the newer change wins. Repeating events come in as their occurrences,
7 days back to 90 days ahead, and are changed in iCloud. Only the title, times and place are synced; notes, alerts and
invitees stay as they are in iCloud. Work events never leave the hub. A read-only calendar (a subscribed holiday
calendar) only comes in. Sync now syncs at once; Stop syncing keeps the events in Aeneas and deletes the password
from the hub unless iCloud Mail still uses it.

While the hub keeps a calendar in step, the iPhone, iPad and Mac leave personal events to it, so nothing is copied
twice. Google and Exchange calendars are not synced by the hub yet: for those, use the Apple apps below.

### Calendars through the Apple apps

The Apple apps can also read Apple Calendar on the device (so any account Apple Calendar has: iCloud, Google,
Exchange and others). Switch on the Apple Calendar module in Settings, Modules, then on the iPhone, iPad or Mac open
Settings, Calendar and work:

- **Where app events go**: the calendars that events made in Aeneas (by you or the assistant) are copied into.
  Changes made to them in Apple Calendar come back; single events made in those calendars come in both ways, and
  repeating ones come in as read-only occurrences. While the hub syncs iCloud calendars, this part is off.
- **Work meetings to import**: calendars you mark as work. Only the title and time of each meeting are read, from
  7 days back to 30 days ahead. They show as Work in Today and Week and count as busy time. This is the way in for an
  employer's Exchange calendar, which often does not allow other apps to sign in.

The Mac app copies at once; the iPhone after about two minutes.

### Calendar colors

Events are drawn in their calendar's color in Today and Week on every device: the color the calendar has in Apple
Calendar or iCloud, as the Apple apps or the hub's iCloud sync find it. Settings, Theme, Calendar colors lists every
calendar events came from; choose a color there and every device uses it, or Use its own color to go back. Events
made in Aeneas on no calendar use the theme's accent.

### Your plan out to any calendar app

Settings, Connections, Calendar has **Subscribe in calendar app** and **Copy link**. This goes the other way: it
publishes your scheduled tasks, events, reminders and renewal dates as a calendar feed that Apple Calendar, Google
Calendar or Outlook keeps up to date by itself. It does not bring any calendar into Aeneas. Work items stay out. The
link's key reads only this feed; New link ends the old one. On a computer, Subscribe asks which calendar app to open;
Copy link and adding it as a subscribed calendar by URL works in any calendar app.

## Mail

Mail is read on the hub, not on the devices. Accounts are linked in Settings, Connections, Internet Accounts, on every
device: iCloud, Google with an app password, or another mail server. Their mail then shows in Mail on every device.
Two modules use them.

**Mail receipts.** The hub reads only mail that looks like receipts, renewal notices or vet mail, files them as
renewals and pet visits, and does not keep the mail itself.

**Mail** (the Mail screen, in the web, Windows, Android, iPhone, iPad and Mac apps, not on the Apple Watch). Your
Inbox by day, for each mailbox you link: iCloud Mail, Gmail, or another mail server that takes an app password. Kinds
of mail are gathered into colored bundles: Transactions, Trips, Updates and Promotions, and Bills, Pet and Jobs while
those modules are on. A person's mail stands on its own.

- **Pin** keeps a mail out of its bundle and out of a Sweep. A pin is your mailbox's own flag: flag a mail in your
  mail app and it is pinned here, and the other way round.
- **Done** moves a mail to Archive in your mailbox (All Mail in Gmail), with Undo. **Sweep** marks every unpinned mail
  of a day or a bundle done.
- **Snooze** hides a mail until a time you pick and makes a task called "Snoozed mail", which holds none of the mail's
  words (tasks are open to the assistant; mail is not). The Snoozed list on the Mail screen says which mail it is. The
  mail comes back to the top of the Inbox at that time, or as soon as you finish or delete the task.
- **Read and unread** are the same here and in your mailbox, both ways: mail you read in your mail app shows as read
  here, and opening a mail here (or Mark unread) changes it there.
- **What the hub changes in your mailbox**, and nothing else: read marks, flags (pins), moves (Done to Archive,
  Delete to Trash, Spam to Junk, Move to one of your folders, and back) and drafts saved to Drafts. It never erases a
  mail (emptying Trash is your mail app's) and it never sends one.
- **Threads.** A back-and-forth is one row that opens with its messages stacked, your own replies among them (the hub
  reads your Sent folder, read-only). Earlier messages quoted inside a reply are folded behind "•••". Pin and Snooze
  act on the whole thread.
- **Bundles your way.** Each bundle can show in the Inbox as mail arrives, once a day, once a week or never, and you
  can make bundles of your own from senders, domains, words in the subject or the text, and the address a mail was
  sent to.
- **New-mail alerts** are for mail from people to start with; a bundle's alerts are switched on in that bundle. They
  say the sender and subject, the sender only, or a count, as you choose on the Mail screen. Like every alert, they
  are switched off altogether in Settings, Notifications.
- **Keys.** Arrow keys and single letters work on the Mail screen; the Keyboard keys button lists them. They act on
  the mail you see, and not while you are writing.

These are in the web, Windows and Android apps (the Apple apps have the Inbox, the bundles, Pin, Done, Snooze and
read marks):

- **Delete, Spam and Move to.** Delete moves a mail to Trash, Spam to Junk, and Move to into one of your own folders.
  Undo puts it back as it was: snoozed again, or done again.
- **Folders.** Drafts, Sent, Spam, Trash and your own folders show under the Inbox, each with its newest 500 mails of
  the last 90 days.
- **Writing.** Reply, Reply all, Forward and New mail save a draft in your mailbox's Drafts folder, and you send it
  from your mail app: Aeneas sends no mail. You see the whole mail before it is saved. A draft can carry up to 10
  files, 15 MB together; an edited draft keeps the files and the Bcc it had. What you typed and have not saved stays
  while the page is open, and in a browser the page asks before you reload or close it. When you start a reply, the
  model on your hub (never a cloud one) may suggest a greeting, a sign-off and up to three short replies, which you
  edit or drop.
- **Attachments.** A paperclip marks mail that has them. Small pictures show when you open the mail; Download saves a
  file, and the screen asks first for a kind of file that can run programs. Files are read from your mailbox when you
  ask and are never kept on the hub.
- **Search** looks through every kept mail, the folders too, by its whole text. A person's name opens all mail with
  that person.
- **Sort new mail.** The model on your hub marks which new mails need you today or need a reply, with one line on
  each, shown as Needs you. It reads them only when you press Sort new mail (a hub set to do its model work on its
  own also does it after each refresh). Its lines are kept a week. The switch under the Mail screen's "i" turns it
  off and erases them. It can be wrong.
- **Unsubscribe and Block sender.** Unsubscribe uses the mail's own unsubscribe address, through Tor when your hub
  has Tor; without Tor it asks first, because the sender then sees your home's internet address. Block sender moves
  a sender's mail to Spam now and whenever more arrives. You can block one address, or a whole domain that is the
  sender's own (not one like gmail.com that many people use).

On every device:

- **On the iPhone, iPad and Mac** the title is the menu of places (Inbox, Snoozed, Done, each bundle). Swipe a mail
  for Done, Snooze, Pin and Mark read, or touch and hold it for the rest; Select (in the menu at the top right) picks
  several. Pull the list down to refresh. A mail's page shows in a view where nothing in it runs or loads, and a
  link in it opens in your browser. On the Mac the open mail shows beside the list, and an iPad or Mac keyboard has
  the same letters as the web (Mailboxes and settings lists them).
- The mail is kept on the hub only: the Inbox's while it is there (done mail for 30 days) and the other folders'
  newest mail, never in a backup, and the assistant cannot read it. Unlinking a mailbox or switching the module off
  deletes it from the hub at once.
- **Pictures in mail.** The hub fetches them through Tor when a mail arrives, so opening a mail loads nothing, and a
  sender sees neither your device nor your home's internet address, nor whether you opened it. A hub without Tor
  fetches no picture until you press Show pictures on a mail; that mail's sender then sees your home's internet
  address. Pictures a mail hides in order to track you are never fetched.
- **Colors.** The bar across the top is the color of where you are (Inbox, Snoozed, Done or a bundle), and those
  colors are the same in every theme, so a color always means the same bundle. The list itself follows your theme
  (Settings, Theme): the page and each mail take the theme's own page and card colors.

Linking a mailbox:

- **iCloud Mail** needs an app-specific password you make at account.apple.com; the guide in Settings, Connections
  takes you through it. The password is kept only on the hub. Apple's app-specific passwords also open iCloud
  Contacts and Calendars; Aeneas uses it for mail, and for calendars only when Calendar accounts is on.
- **Gmail on the Mail screen** needs an app password you make in your Google Account (16 letters; Google offers it
  once 2-Step Verification is on). Add the account under Internet Accounts as Google, with an app password. The same
  password feeds Mail receipts, and nothing needs setting up at Google.
- **Gmail for receipts only** can use Sign in with Google instead: your own Google app, allowed only to read mail,
  and the hub reached through Tailscale (Google returns only to an https name). The steps are in
  [gmail-setup.md](gmail-setup.md) and in the guide under Settings, Connections, Keys. Signed in this way, the hub may
  only read, so that account does not show on the Mail screen.
- **Another mail server** needs its IMAP server's name, your username and an app password from your provider. The
  hub links only servers on the internet, over an encrypted connection (port 993 as a rule).
- Each account has switches for what it brings in (Mail, Calendars, and on your iCloud account Reminders, which your
  iPhone and Mac sync), then the Aeneas modules that read it (Receipts, with Read now), and Remove account, which takes
  its password and its mail off the hub. A password stays on the hub only while Mail, Receipts or Calendars uses it:
  switching off the last one removes the account, and the app asks first.
- **Read only**, on each account, keeps Aeneas from changing anything in it: no drafts saved, no mail moved, flagged
  or marked read there, and no calendar event written. The hub itself refuses those changes, and Mail offers no Done,
  Delete, Pin or replies for that account's mail. Reminders are not covered: your iPhone and Mac write them through
  Apple's own Reminders.

## Reminders, Contacts and Health

These are read on the Apple devices: Apple Reminders (the Reminders switch on your iCloud account in Settings,
Connections, or on its own line there before you add one), the Contacts module (Settings, Modules), and Apple Health,
turned on in the iPhone app under Settings, Connections. Health works both ways: readings come in, and what you log
in Aeneas goes to Health.

## Alerts

Aeneas alerts you about reminders, the morning summary, a long activity, new mail, machines and services, sensor
readings, the hub's disk and the recall quiz. Each kind is switched on or off by itself in Settings, Notifications,
once for every device: the hub holds back a kind you switched off, so no phone, computer or Watch shows it. Off
stops the alert only; the feature it belongs to goes on working (Mail still shows your mail, a sensor still records).
A kind is listed while the module it belongs to is on.

## Capture

Capture takes a thought, task or note by voice or text, from the Capture screen, the Watch, or the Mac menu bar.
Each capture goes into the day's diary and the assistant files it where it belongs (a plan on the calendar, a to-do,
a fact in memory, a tagged note, a song idea, a film to watch), or nowhere when it is only a passing thought (the
diary has it). One it could not file after three tries waits in Unsorted Info.

## Music

Music module. The Music screen starts with one row: a line to type and Hum Song. The line picks out chords, time
signature, tempo and tuning (`Am F C G 6/8 112bpm drop D`); the rest is the title. Your ideas are under it by type,
with a filter by status. Projects (at the top of the screen; on the Apple apps, the Projects row) holds your releases
in the making: an album, an EP or a single. New project is there. Each project is a card that opens to its ideas and
hummed takes, and the line and Hum Song inside a card add to that project. A project's status, tasks and plan are on
its page in Projects. Cheat sheets and checklists are notes, in Notes under Music, Reference.

## Hum Song

Music module. Press Hum Song (in Capture, Music, or on the Watch) and hum, sing, tap or beatbox for up to 2 minutes.
The hub hears every recording both as a melody and as a rhythm. Afterwards, on the idea in Music, choose Melody,
Rhythm or Both; playback and the MIDI download follow that choice. Until you choose, a hummed tune keeps only its
melody (every hummed note also starts with a jump in level, which the rhythm hearing would add as a drum hit), and a
recording with hits of its own between the notes keeps both. Each idea in Music shows when it was recorded.

## Apple Watch

The Watch reaches the hub through the Aeneas app on the paired iPhone (over Bluetooth or Wi-Fi), not on its own.
Its first page has Ask, Capture and Hum Song, all by voice. Capture records what you say on the Watch (up to 5
minutes; press Done when you finish) and the iPhone turns it into text on the phone itself, so a long thought is kept
whole and the recording never goes to Apple. On a Series 9, Ultra 2 or newer Watch, the Watch also writes it down
itself: while you speak, the words so far show under the timer (the ones still settling dimmer, and the latest part of
a long capture), while the Watch's screen is on, and "Heard: ..." shows a second or two after you stop; its speech model (about 150 MB) comes over by itself
once: the hub fetches it from Hugging Face and the iPhone copies it from the hub on Wi-Fi. The Watch loads the model when you open the app, and until your words
show, the recording screen says where it stands: still arriving (with how much has come), getting ready (the first time on a Watch takes longer, while the Watch
prepares the model for its chip), or ready. What the iPhone heard is what is saved, and once the hub has filed
it the Watch shows where it went ("Filed: Logs: weight 192.2 lb") until your next capture. Ask uses Apple's dictation, which shows the words as you speak and suits a
short question (it keeps only about the last 30 seconds of a long one). Complications (add them by editing a watch face):
Ask, Capture, Hum Song, Now and Next up. When the Watch shows Offline, tap Offline, then Try now; opening the iPhone
app helps it reconnect.

## The assistant

The assistant runs on your hub's own model. It reads and changes your data with tools (adding tasks, reminders,
notes, events), and it says what it changed. Switch modules off and their tools go with them. Ask it about the app
itself too: it answers from these docs.

## Tech: your machines, checks and sensors

Tech, Overview is one screen for everything you watch: what needs a look at the top, then a card for each machine (with
its CPU, memory and fullest disk), each service on the internet you check, and each place with sensor boards. Switch on
Machines (and Sensors, for the readings) in Settings, Modules; add the computers the hub may reach with Add machine, and
a ping, port, web address, certificate, name lookup or backup check with Add check.

- **Propose a fix** sits on anything red: a check that is down or a reading out of bounds. The assistant looks into it
  with read-only commands and proposes one change, which runs only when you approve it in that chat.
- **A machine's page** (tap its card) has its checks, its readings with graphs and alert limits, its History, its fix
  notes and its snippets. At the top it says what kind of device it is (Computer, Network device, Printer, Camera or
  Device) and what it runs or its model when the device says. The hub works this out from what each device reports
  about itself and answers when asked, and names a kind only when it is fairly sure; otherwise it says Not identified.
- **Add machine** needs the computer's address, a user name and its password once: the hub signs in with it, adds
  its own key there, checks that signing in with the key works, and forgets the password. The computer needs SSH on:
  on a Mac, System Settings, General, Sharing, Remote Login; on Windows, Settings, System, Optional features, OpenSSH
  Server; on Linux, the openssh-server package. The assistant can add one too when the password is in your password
  manager ("add the NAS at 192.168.1.20 as admin, the password is the NAS item"); it waits for your Run.
- **A computer with the Aeneas app** can show up by itself: on Windows, Settings, This computer, Show this computer
  in Tech sends its CPU, memory and disks every 10 minutes while the app runs, and Let the hub sign in turns on
  Windows' SSH server (one administrator prompt) and adds the hub's key, so the assistant can run commands there too.
- **Purpose** on a machine's page is what it is for, in your words. The assistant reads it whenever that machine comes
  up, and saves to it when you tell it about the machine.
- **Virtual machines** on a Proxmox host the hub signs in to get their own cards with CPU and memory, without adding
  them. Their disks need the QEMU guest agent turned on in the VM's Options and installed inside it.
- **History** is what happened on that machine, newest first: changes the assistant made with your approval (with
  the command and how to undo it), checks that went down and came back, readings that went out of bounds and back, and
  changes you note in one line ("What did you change?"), tell the assistant or say in a Capture ("I replaced the fan on
  the NAS"). A
  step you planned waits at the top with Done and Didn't do it. Lookups that needed approval but changed nothing stay out.
- Renewals and bills are not in Tech: they are in Plan, Renewals.

## Family: a hub for someone else, and helping with their devices

On a Linux or Windows hub, Settings, People on this machine gives someone their own hub on your machine. Invite them
with the large QR code when they are with you, or copy a message (or print a page) for someone who lives elsewhere: they
install Aeneas, copy the message and tap I have an invitation. Help with devices beside their name asks them once,
in large type; after their yes, your assistant can check and fix their computer (the Aeneas app on it), the devices
their app found at home, and devices that take SSH, with the passwords they chose to save for you. They see everything
you did in Settings, People who help you, and can stop it there. The whole story: [helpers.md](helpers.md).

## Updates, backups and the hub

- **Updates**: Settings, About shows the hub's version and updates it. The Windows and Android apps update from
  the hub: when the hub runs a newer release, a banner and Settings, About have **Update app**, which installs the new
  app from the hub (Windows closes and opens the new app by itself; Android shows its own install prompt, and the first
  time asks whether Aeneas may install apps). Apps older than 1.0.5 have no Update app: install the new one once from
  the release page, and it updates itself after that. Apple apps update from the App Store or TestFlight.
- **Updating another device's app**: Settings, Connection, Devices shows which app and version each device runs, with
  Update for a Windows or Android app that is behind; or ask the assistant ("update my Windows app"). That app installs
  the update the next time it reaches the hub, after 15 seconds with Not now (Android waits until the app is open and
  shows its prompt there). The hub cannot install the Apple apps.
- **Backups, restore, moving to a new machine, other people on the same computer**: see
  [running-your-hub.md](running-your-hub.md) and [multi-person.md](multi-person.md).
- **How devices reach the hub** (Direct link, Tailscale or home Wi-Fi only): [connections.md](connections.md).
- **What goes where on the network**: [privacy-network.md](privacy-network.md).
