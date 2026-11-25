# Using Aeneas

How to do the common things, and where each one lives. The assistant reads this page (and the other docs and the
module list) to answer questions about the app, so ask it too: "how do I get my calendar in?"

## The parts

- **The hub** is the computer at home that keeps everything and runs the models. Every app is a window onto it.
- **The apps**: iPhone, iPad and Mac (one Apple app), Apple Watch (through the iPhone app), Windows, Android, and the
  web app in a browser. They show the same data; what differs is what each device can read from itself (only the
  Apple apps can read Apple Calendar, Reminders, Contacts and Apple Health).
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

Today is the day as a status board, the same on every device. From the top, as it comes:

- **The line at the top** (the Next line) says what you are on. A task is on it only when you press Start on it
  ("Doing: Write the report", and the time left while its block runs). Otherwise it is what is on now and how long it
  has left ("Dentist cleaning until 4:00 PM, 46 min left"), else what is next with a time today, an event, a block or
  a reminder, and how long until it ("Next: Call the vet at 1:30 PM, in 40 min"), else "Nothing else today". Under it
  is the free time now or next. The same line is on the widgets, the Watch and the Mac menu bar.
- **Tech** (with Machines on) is one line above Needs you: a green dot and "All good", a yellow dot and "2 things
  need a look" when only readings are out of bounds or silent, or a red dot when a check is down or the hub's backup
  needs a look. It is folded each time you open Today. Press it to see each one with Propose a fix, Acknowledge and
  Open, then the ones you acknowledged, and Open Tech.
- **Needs you** lists only what waits on you, numbered in the order to take it, each with its buttons: reminders
  that have come due, renewals to renew, a medicine not logged today, and captures the assistant could not file. A charge on autopay is not on Today at all: it pays itself, and Renewals lists it.
- **Schedule** names the all-day things first (events, and a plan rule for the whole day), then the day in time
  order with Schedule here on free time, then the people in today's plans with what you have noted about them.
- **To do** lists your open tasks: the circle finishes one, Start makes it the task you are doing. The task you
  started is at the top with its buttons: Done, Skip (back to the end of Next), Start block while no block of it is
  running, and Set aside where your device has it. A task first in Next is a suggestion; it is never taken to be what
  you are doing until you press Start.
- **Today so far** shows today's numbers when Health is on (weight, sleep, steps, caffeine, mood), and the diary's
  lines, finished tasks and logs in the order they happened. To capture something, use Capture, which is on every
  screen.
- **Coming up** shows tomorrow's plans, and birthdays and other dates in the next two weeks.

The cards are in one column on a phone and in up to five across a wide window. On iPhone, iPad and Mac, swiping left
or right shows another day's plan.

**Edit Today**, a small link at the bottom of Today (or Settings, Theme, Today), chooses what Today shows and in what
order, the same on every device:

- Each part has a switch. The line at the top always stays at the top; it can only be shown or hidden.
- Drag a card by its handle to move it. In the Windows and Android apps and the browser there are also Move up and
  Move down buttons for the keyboard; on iPhone, iPad and Mac, VoiceOver has Move up and Move down actions.
- On a wide window the cards fill the columns in your order. Tech is a short line, so it sits at the top of the card
  after it, or under the card before it when it is last. It still shows only when it has something to watch.
- With every card hidden, Today says so, with Edit Today to bring them back. Reset puts every part back, in the order
  above.
- **Lists in To do** chooses which Apple Reminders lists fill the To do card: All lists, or Only these lists with a box
  for each list that is on and one for No list (tasks made in Aeneas that are in no Reminders list). To do then shows
  the task you started and your other open tasks, from those lists only. Reset leaves this choice as it is.

## The Next line everywhere (widgets, Watch, menu bar)

There is no separate Now screen any more: Today covers it, and an old link or a widget that opened Now
opens Today. The line at the top of Today shows in these places too, with the same words:

- **The Now and next widget** (iPhone, iPad and Mac; on the iPhone also on the Lock Screen) and the **Windows app's
  widget**: the line, with Done while a task you started is on it, a running activity, and Capture. Under a task you
  started, the medium size shows what is on now or next.
- **The Watch**: the Now and next page, one swipe below Ask, Capture and Hum Song, with Done and Skip for the task you
  started and your Next tasks to start with a tap; and the Now and next complication.
- **The Mac menu bar** and the **Quick Capture panel**.
- **The Live Activity** on the iPhone follows a running activity, or the block of the task you started while it runs;
  nothing else starts one.
- **The assistant**, asked what to do next, starts from the task you started, else what is on now or next today, and
  offers your Next tasks as suggestions.

## Week

Week is your calendar, laid out the way Apple's Calendar app does it:

- **Day, Week, Month, Year** at the top choose the view. Week is the plan as it always was: the hours of each day with
  your blocks, events and free time (on a phone, a strip of days and the chosen day's plan). Day is one day of that.
  Month shows each day's events (titles on a wide window or the Mac, dots on a phone); tap a day to open it. Year shows
  twelve small months; tap one to open it. Each device remembers the view you used last.
- **The arrows** move back and forward a day, a week, a month or a year, and **Today** comes back to today.
- **Search** finds events by their title and place, on every date your devices have, grouped by day: today and later
  first, then Earlier. Tap one to open it.
- **Calendars** lists the calendars your events come from, by account, with their colors. Untick one to hide its events
  in Week (every view and search); tick it to bring them back. Show all ticks them all. The choice is the same on every
  device. Today, your free time and the assistant still count those events. Events made in Aeneas on no calendar are
  listed as Made in Aeneas.
- **Invitations** shows beside Calendars when someone has invited you, with how many wait for your answer. Each one has
  **Accept**, **Maybe** and **Decline**, and is answered the way Calendar would, through where it came from:
  - an invitation in an iCloud calendar your hub keeps in step: the hub answers in the calendar and iCloud tells the
    organizer;
  - an invitation that came by mail (Google, Exchange and others) to a mailbox on the Mail screen: Aeneas sends the
    standard answer calendar apps send, from that mailbox, with 10 seconds of **Undo**; Accept and Maybe also put the
    event on your calendar, unless it is there already;
  - an invitation only Apple Calendar has on your iPhone, iPad or Mac: Apple does not let other apps answer those, so
    the row has **Open in Calendar** (on the web, Windows and Android it says to answer it in your calendar app).
  Answered ones stay under Answered for 7 days. A declined event stays on its calendar but is hidden, as Calendar hides
  it. Today's Needs you says "2 invitations" while some wait. The assistant can list them and answer one, but only after
  you say yes to that answer in the chat.

## Tasks

- **Set aside** takes a task out of Next, with a reason, until you bring it back; it waits under Set aside.
- **Start** (on a task, or in its menu) makes it the task you are doing: it is on the Next line until you finish it,
  skip it or start another.
- **Done** offers Undo for a few seconds. A finished task has **Not done** in the Done list, which puts it back at the
  end of Next.
- **Delete** is in a task's edit (on the iPhone also a swipe, on the Mac the right-click menu) and offers Undo. A task
  from Apple Reminders is deleted there too, except one from a work account, which stays in that account.
- **Personal and Work**: Work holds tasks you add under Work, tasks from work Reminders accounts (Exchange, or one
  named after your work email's domain) and captures that start with "work:". Everything else is Personal. Move to
  Work or Move to Personal in a task's edit changes it; a task from a work Reminders account stays in Work.
- **Groups**: beside Personal and Work you can make your own groups, like School. New group, beside the selector at
  the top of Tasks, asks for a name and which Reminders lists are in it (and No list, for tasks made in Aeneas). The
  group then shows the tasks of those lists, from Personal and Work alike. Edit group renames it, changes its lists or
  deletes it. A group only changes what Tasks shows: its tasks stay where they are kept and sync as before. Groups
  are the same on every device.

## Wide windows

On a large window (a Mac, a browser on a computer, the Windows app, a large iPad on its side) the screens use the
width instead of one column in the middle. Collections become grids of cards, and in the Apple apps Tasks is a board
with its statuses side by side. Notes, the Wiki and the Assistant keep their list at the left with what you open
beside it. In the Apple apps a page about one thing (a person, a machine, a project) shows two lists side by side.
Text you read keeps a width that reads. On the Mac a card cannot be swiped: delete, archive, set aside and move are in
its right-click menu. A narrow window, the iPhone and an iPad held upright keep their lists and swipes.

## Accounts

Settings, Accounts is where your mail and calendar accounts are, and what comes in from your devices. It has three
parts.

- **Accounts.** Each address once, with a letter badge, what it brings in (Mail, Receipts and renewals, Calendars)
  and its kind (iCloud, Google, Other mail). Tap one to open its page. Your hub keeps these in step whether or not any
  device is on.
- **From this iPhone** (iPad, Mac), on the Apple apps: Calendars, Reminders, Contacts and, on the iPhone and iPad,
  Apple Health (the red heart). One switch each, and it asks for the permission when you switch it on. Calendars and
  Reminders open their choices: which calendar your events go to, which calendars are work, which Reminders lists
  come in and in which space. Apple Health opens its page: what Aeneas reads from Apple Health and writes to it, Send
  now, and how many readings came from it. The
  web, Windows and Android apps show **From your iPhone, iPad and Mac** instead: the same lists and work calendars,
  which you can change there too, and which device mirrors your contacts. The switches themselves are on each device.
- **Work**: Keep work calendar and tasks. Off erases every work event and task on every device.

**Add account** is one sheet of three steps:

1. Which account? iCloud, Google or Other mail.
2. Sign in: the address and an app password. Google makes one in about 2 minutes (Open Google's page takes you
   there); iCloud's is an app-specific password from account.apple.com (Show me how walks through it); another
   provider needs its server, port, user name and password.
3. What it brings in: Mail and Receipts and renewals start on, an iCloud account's Calendars off.

A switch you turn on here turns its module on for you, so there is no trip to Settings, Modules first and no key to
make. The hub checks the sign-in before it keeps it. The Mail screen with no mailbox linked has Add an account too.

**An account's page** has its switches (Mail, Receipts and renewals, Calendars on iCloud, Read only), each with a line
saying what it does; its calendars and where new events go, while Calendars is on; Sign-in, with when the hub last
used the password and Replace for a new one; and Remove account. Each address is one account: an address already
added as iCloud is not added again as another mail account, and the other way round; the hub says which to remove
first.

## The bottom bar on a phone

On the iPhone, and in the Windows and Android apps or a browser in a narrow window, the screens you use most sit in a
bar along the bottom. Settings, Theme, Bottom bar chooses them, and the choice is the same on every device. iPad, Mac
and wide windows keep the sidebar.

- **Screens across**: 3, 4 or 5. The fewer across, the larger each icon and name. Going down to fewer leaves out the
  last screens of each row.
- **Two rows**: the first row always shows. Press and drag up on the bar to pull the second row out above it; let go
  past half way, or flick, and it stays open. A drag down, a tap outside it, or choosing a screen folds it again. The
  small grabber on the bar's top edge opens and folds it with a tap too, and it is in the accent color while a screen
  of the second row is the one showing. With nothing in the second row there is no grabber.
- **Choosing a screen**: on the Bottom bar page, choose a place in the preview, then the screen for it from the
  screens that are on. A screen that already has a place swaps with the one there. A place of the second row can be
  emptied. Reset puts back Today, Assistant, Capture, Library and Search, with Tasks, Week, Notes, Memory and People
  in the second row.
- **Library always has a place**, since every other screen and Settings are reached from it. A screen without a place
  opens inside Library, and a main screen you left out (Today, Assistant, Capture or Search) is listed at the top of
  Library. A screen whose module is off is left out of the bar until the module is on again; its place waits for it.
- With VoiceOver on the iPhone, the grabber is a button named More screens, and the bar has an action to show or hide
  the second row. In the other apps the grabber is a button you can reach with the keyboard, and Escape folds the row.

## Calendars

There are two directions, and they are set up in different places.

### Your iCloud calendars, on the hub (every device)

The Calendar accounts module keeps your iCloud calendars in step with Aeneas on the hub, both ways, so every device
has them: Windows, Android and the web as well as the Apple apps. In Settings, Accounts:

1. An iCloud account already added for Mail needs no new password: open it and switch Calendars on.
2. Otherwise choose Add account, iCloud, enter the address and an app-specific password from account.apple.com
   (Sign-In and Security, App-Specific Passwords), and switch Calendars on in What it brings in. The hub checks them
   with iCloud.
3. On the account's page, tick the calendars to keep in step and pick where events made in Aeneas go.

Switching Calendars on turns the Calendar accounts module on for you.

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
Exchange and others). On the iPhone, iPad or Mac, switch Calendars on in Settings, Accounts, From this iPhone (it
turns the Apple Calendar module on and asks for calendar access), then open it:

- **Your calendar**: the calendar that events made in Aeneas (by you or the assistant) are copied into. Changes made
  to them in Apple Calendar come back; single events made in that calendar come in both ways, and repeating ones come
  in as read-only occurrences. While the hub syncs iCloud calendars, this part is off: the hub's own choice, on the
  iCloud account's page, applies instead, so where new events go is set in one place.
- **Work calendars**: calendars you mark as work. Only the title and time of each meeting are read, from 7 days back
  to 30 days ahead. They show as Work in Today and Week and count as busy time. This is the way in for an employer's
  Exchange calendar, which often does not allow other apps to sign in. **Work events you make go to** picks where
  work events made in Aeneas are copied, and Import now reads the work calendars at once.

Switching Calendars off on one device stops only that device; the Apple Calendar module in Settings, Modules stops
every device.

The Mac app copies at once; the iPhone after about two minutes.

Which calendars are work is one choice for every device (since 1.0.18): tick or untick a calendar on any iPhone, iPad
or Mac and every device imports the same ones. The first time an updated device runs, the calendars it had ticked
itself join that choice once. A calendar your hub keeps in step from iCloud cannot be a work calendar (its events
would come in twice), and is shown as kept in step by your hub.

### Calendar colors

Events are drawn in their calendar's color in Today and Week on every device: the color the calendar has in Apple
Calendar or iCloud, as the Apple apps or the hub's iCloud sync find it. Settings, Theme, Calendar colors lists every
calendar events came from; choose a color there and every device uses it, or Use its own color to go back. Events
made in Aeneas on no calendar use the theme's accent.

### Your plan out to any calendar app

Settings, Connections, Calendar has **Subscribe in calendar app** and **Copy link**. This goes the other way: it
publishes your scheduled tasks, events, reminders and renewal dates as a calendar feed that Apple Calendar, Google
Calendar or Outlook keeps up to date by itself. It does not bring any calendar into Aeneas. Work items stay out, and
so do events that are in one of your calendars already (your iCloud calendars the hub keeps in step, and events your
iPhone, iPad or Mac copied to or brought in from Apple Calendar): subscribed in the same calendar app, they showed
twice. The link's key reads only this feed; New link ends the old one. On a computer, Subscribe asks which calendar
app to open; Copy link and adding it as a subscribed calendar by URL works in any calendar app.

## Mail

Mail is read on the hub, not on the devices. Accounts are linked in Settings, Accounts, on every device: iCloud,
Google with an app password, or another mail server. Their mail then shows in Mail on every device. Two modules use
them, and each account's switches turn them on.

**Receipts and renewals** (in Settings, Modules under Mail, with a switch of its own). The hub reads only mail that
looks like purchase receipts, renewal notices or vet mail, files them as renewals and pet visits, and does not keep
the mail itself. It works with the Mail screen off.

**Mail** (the Mail screen, in the web, Windows, Android, iPhone, iPad and Mac apps, not on the Apple Watch). Your
Inbox by day, for each mailbox you link: iCloud Mail, Gmail, or another mail server that takes an app password. Kinds
of mail are gathered into colored bundles: Transactions, Trips, Updates and Promotions, and Bills and Pet while those
modules are on. A person's mail stands on its own.

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
  Delete to Trash, Spam to Junk, Move to one of your folders, and back), drafts saved to Drafts, and the copy of a
  mail you send put in Sent. It never erases a mail (emptying Trash is your mail app's), and it sends one only when
  you press Send.
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

These are in every app, the web, Windows and Android apps and the iPhone, iPad and Mac apps alike:

- **Delete, Spam and Move to.** Delete moves a mail to Trash, Spam to Junk, and Move to into one of your own folders.
  Undo puts it back as it was: snoozed again, or done again.
- **Folders.** Drafts, Sent, Spam, Trash and your own folders show under the Inbox, each with its newest 500 mails of
  the last 90 days.
- **Writing and sending.** Reply, Reply all, Forward and New mail show you the whole mail first (Preview), then Send
  sends it, or Save draft puts it in your mailbox's Drafts folder. A mail can carry up to 10 files, 15 MB together;
  an edited draft keeps the files and the Bcc it had.
- **Cc**: a new mail shows a Cc line when it has one (a mail the assistant wrote and you opened with Edit).
- **Send** gives you 10 seconds: the box says Sending, with Undo, which puts the mail back in the box as it was. Then
  your hub sends it through your mailbox's own sending server with the same app password (Gmail's, iCloud's, or the
  one you give for another mail account on its page in Settings, Accounts), and puts its copy in Sent (Gmail does that
  itself). If the hub restarts in those 10 seconds, it sends the mail once when it is back. A Bcc is sent but is not in
  the copy. A refused password, a refused address or a server that does not answer leaves the mail in the box, says
  what went wrong, and offers Try again and Save draft; if any address is refused, nobody gets the mail. A mailbox set
  to Read only, or another mail account with no sending server, saves drafts and does not send. Only you send: the
  assistant cannot, though it can write a mail for you to send with one tap (The assistant, below). What you typed and have not saved stays
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
  has Tor; without Tor it asks first, because the sender then sees your home's internet address. When the mail gives
  only an address to write to, Send the unsubscribe mail shows the whole mail (it says unsubscribe), then sends it
  like any mail you send, with 10 seconds of Undo; a mailbox that cannot send saves it to Drafts. Block sender moves
  a sender's mail to Spam now and whenever more arrives. You can block one address, or a whole domain that is the
  sender's own (not one like gmail.com that many people use).

On every device:

- **On the iPhone and iPad** the title is the menu of places (Inbox, Snoozed, Done, each bundle). Swipe a mail for
  Done, Snooze, Pin and Mark read, or touch and hold it for the rest; Select (in the menu at the top right) picks
  several. Pull the list down to refresh. An iPad keyboard has the same letters as the web (Keyboard keys, in the
  menu at the top right, lists them).
- **On the Mac** the Mail screen is the web's: the places are in the side list, and a mail opens in place in the
  list, in one column; click its heading, or press Esc, to close it. New mail opens its box at the top of the list.
  Point at a mail for Pin, Snooze and Done, or Control-click it for the rest; Command-click or Shift-click selects
  several. The keyboard has the web's keys (Keyboard keys, in the side list, lists them).
- A mail's page shows in a view where nothing in it runs or loads, and a link in it opens in your browser.
- The mail is kept on the hub only: the Inbox's while it is there (done mail for 30 days) and the other folders'
  newest mail, never in a backup, and the assistant cannot read it. Unlinking a mailbox or switching the module off
  deletes it from the hub at once.
- **Pictures in mail.** The hub fetches them through Tor when a mail arrives, so opening a mail loads nothing, and a
  sender sees neither your device nor your home's internet address, nor whether you opened it. A hub without Tor
  fetches no picture until you press Show pictures on a mail; that mail's sender then sees your home's internet
  address. Pictures a mail hides in order to track you are never fetched.
- **Colors.** The bar across the top (on the iPhone and iPad the title, on the Mac the side list) is the color of
  where you are (Inbox, Snoozed, Done or a bundle), and those colors are the same in every theme, so a color always
  means the same bundle. The list itself follows your theme (Settings, Theme): the page and each mail take the
  theme's own page and card colors.

Linking a mailbox:

- **iCloud Mail** needs an app-specific password you make at account.apple.com; Add account, iCloud, Show me how
  takes you through it. The password is kept only on the hub. Apple's app-specific passwords also open iCloud
  Contacts and Calendars; Aeneas uses it for mail, and for calendars only when Calendar accounts is on.
- **Gmail** needs an app password you make in your Google Account (16 letters; Google offers it once 2-Step
  Verification is on). Add the account in Settings, Accounts as Google. The same password feeds Mail and Receipts
  and renewals, and nothing needs setting up at Google. Sign in with Google is no longer offered.
- **An address signed in with Google before** (it says it uses the older Google sign-in) keeps reading its receipts,
  and nothing else. Its Add an app password opens Add account with the address filled in. Once the app password is
  added, the hub moves the address's receipts to it, reads on from where the sign-in stopped, so no mail is read
  twice, and removes the older sign-in; the account then shows in Mail too. An address that had both is made one
  account the same way by the hub itself. With the last such sign-in, the hub's Google app under App keys goes too.
- **Another mail server** needs its IMAP server's name, your username and an app password from your provider. The
  hub links only servers on the internet, over an encrypted connection (port 993 as a rule).
- Each account has switches for what it brings in (Mail, Receipts and renewals with Read now, and Calendars on
  iCloud), and Remove account, which takes its password and its mail off the hub. A password stays on the hub only
  while something uses it (Mail, Receipts and renewals or Calendars): switching off the last one removes the account,
  and the app asks first.
- **Read only**, on each account, keeps Aeneas from changing anything in it: no drafts saved, no mail moved, flagged
  or marked read there, and no calendar event written. The hub itself refuses those changes, and Mail offers no Done,
  Delete, Pin or replies for that account's mail. Reminders are not covered: your iPhone and Mac write them through
  Apple's own Reminders.

## Reminders, Contacts and Apple Health

These are read on the Apple devices, each switched on for that device in Settings, Accounts, From this iPhone:
Reminders (it turns the Apple Reminders module on, which Settings, Modules can switch off for every device), Contacts,
and Apple Health, on the iPhone and iPad. Each asks for its permission when you switch it on.

**Apple Health** works both ways. Switch on Sync with Apple Health in Settings, Accounts, From this iPhone, Apple
Health (the row with the red heart). Aeneas reads weight, blood pressure, sleep, steps, workouts, caffeine and mood
(State of Mind) from Apple Health, only the types you allow, and writes what you log in Aeneas (weight, blood
pressure, caffeine, mood and timed activities, as workouts) to Apple Health. The page also has Send now, how many
readings came from Apple Health and when it last synced. The Health screen (Library, Body and home, Health) opens with
Apple Health: whether this iPhone syncs with it, and Apple Health settings, which opens that page. Readings from Apple
Health are marked with a heart. In sample mode the switch stays off, so no sample data goes into your own Health; it
works once your hub is set up. The switch is for each device, and the Mac has no Apple Health.

**Which Reminders lists come in** (since 1.0.18) is one choice for every device, made on the iPhone, iPad or Mac
(Settings, Accounts, From this iPhone, Reminders). Each list has a switch and Personal or Work. A list that is off
stays out of Tasks, Today, Week, search, alerts and the assistant, on every device, and stays as it is in Apple
Reminders: nothing there is changed or deleted. Switch it on again and its tasks are back, with no doubles. Lists in
iCloud or on the device itself start on, and so does any list that already had tasks; lists of other accounts
(Exchange, Google, a school or work account) start off until you switch them on. Personal or Work moves a list's
tasks to that space once every iPhone, iPad and Mac runs 1.0.18 or later; until then the page names the devices to
update. **New tasks go to** picks the list that tasks you or the assistant make in Aeneas are added to.

**Contacts** are kept in step by one device at a time: switching Contacts on on a device makes it the one (it says
first which device had them), and a device that had it on turns its own switch off. People shows which device that
is.

## Alerts

Aeneas alerts you about reminders, the morning summary, a long activity, new mail, machines and services, sensor
readings, the hub's disk and the recall quiz. Each kind is switched on or off by itself in Settings, Notifications,
once for every device: the hub holds back a kind you switched off, so no phone, computer or Watch shows it. Off
stops the alert only; the feature it belongs to goes on working (Mail still shows your mail, a sensor still records).
A kind is listed while the module it belongs to is on.

**Reminders also in Apple Reminders** (since 1.0.19) can alert twice: from Aeneas, and from Apple's Reminders app,
which alerts with the alarm your iPhone and Mac put on the item. While the Apple Reminders sync is on, Settings,
Notifications has a switch for each, once for every device:

- **Alert from Aeneas**: off, no phone, computer or Watch alerts from Aeneas for a task that is in Apple Reminders.
  Other tasks alert as before, and Done and Snooze still work on the task.
- **Alert from Apple Reminders**: off, your iPhone and Mac take the alarm off those items and add none. Each item keeps
  its date and time, so it still shows when it is due, and the reminder time stays in Aeneas. An alarm you set in
  Apple's Reminders app comes off at the next sync, and its new time goes to the task. It waits until every iPhone,
  iPad and Mac runs 1.0.19 or later, and the switch says which ones are still to update. Switch it on again and each
  item gets its alarm back at the task's reminder time.

Apple's own switch for all of Apple Reminders' notifications is in iOS Settings, Notifications, Reminders (System
Settings on a Mac).

## Capture

Capture takes a thought, task or note by voice or text, from the Capture screen, the Watch, or the Mac menu bar.
Each capture goes into the day's diary and the assistant files it where it belongs (a plan on the calendar, a to-do,
a fact in memory, a tagged note, a song idea, a film to watch, a gift idea on that person's page), or nowhere when it
is only a passing thought (the diary has it). One it could not file after three tries waits in Unsorted Info.

## People

A person's page (Library, Notes, People) shows what you have told Aeneas about them in sections that open and close:
Likes, Dislikes, Gift ideas, then Health and food, History and Other when they hold something. Likes, Dislikes and
Gift ideas are always there, each with a field to add one. A section with something in it starts open; your device
remembers the ones you open or close. Mark a gift idea Given once you gave it: it stays on the list, dimmed, with the
day, so you do not give it twice. Tap Not given to undo that.

A capture like "gift idea for Jamie: a pottery class" goes to Jamie's Gift ideas. It becomes a task as well only when
it names a day ("by Friday", or "for her birthday" when her birthday is on her card). Ask the assistant "what should I
get Jamie?" and it reads Jamie's gift ideas and likes.

## Song ideas

Song ideas module (Library, Making, Song ideas; it was called Music until 2026-11-25). The Song ideas screen starts
with one row: a line to type and Hum Song. The line picks out chords, time signature, tempo and tuning
(`Am F C G 6/8 112bpm drop D`); the rest is the title. Your ideas are under it by type, with a filter by status.
Projects (at the top of the screen; on the Apple apps, the Projects row) holds your releases in the making: an album,
an EP or a single. New project is there. Each project is a card that opens to its ideas and hummed takes, and the line
and Hum Song inside a card add to that project. A project's status, tasks and plan are on its page in Projects. Cheat
sheets and checklists are notes, in Notes in the folder Music, Reference.

## Hum Song

Song ideas module. Press Hum Song (in Capture, Song ideas, or on the Watch) and hum, sing, tap or beatbox for up to 2
minutes. The hub hears every recording both as a melody and as a rhythm. Afterwards, on the idea in Song ideas, choose
Melody, Rhythm or Both; playback and the MIDI download follow that choice. Until you choose, a hummed tune keeps only
its melody (every hummed note also starts with a jump in level, which the rhythm hearing would add as a drum hit), and
a recording with hits of its own between the notes keeps both. Each idea in Song ideas shows when it was recorded.

## Music (Apple Music)

Music module (Library, Media, Music; off until you switch it on in Settings, Modules). It brings your Apple Music taste
into Aeneas so the assistant knows what you like: ask it what you listen to most, for a playlist idea for a long drive,
or for a gift idea for a friend who likes the same bands. There is no key or password to make: your iPhone, iPad or Mac
asks once for Apple Music, then reads your library with Apple's own MusicKit. It reads your songs with their play
counts, artists, albums, genres and playlists, and with an Apple Music subscription the songs you played recently. It
plays, adds and changes nothing in Apple Music.

What it keeps is a short summary: your 30 most played artists and songs, up to 50 playlists (your own first), the 25
songs you played last and your top genres, with when and on which device it was read. It goes to your hub, which
shares it with your own devices and the assistant. A device reads again by itself when you open the app and the summary
is more than 12 hours old, and Read Apple Music now on the Music screen reads it at once. An iPad with nothing in Apple
Music never replaces the summary your iPhone read.

The Music screen on the iPhone, iPad and Mac shows the summary, Read on (device), (when), and the button. If Apple
Music is not allowed for Aeneas, it says so with Allow Apple Music, or the way to the system's privacy settings. With
no subscription, the summary has no Recently played, and the screen says so. The web, Windows and Android apps show the
same summary from Apple Music on (device), and until one has been read: Turn on Music on your iPhone, iPad or Mac to
bring your Apple Music taste here. Spotify is not supported.

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
Ask, Capture, Hum Song, Now and next (the line at the top of Today) and Next up. When the Watch shows Offline, tap Offline, then Try now; opening the iPhone
app helps it reconnect.

## The assistant

The assistant runs on your hub's own model. It reads and changes your data with tools (adding tasks, reminders,
notes, events), and it says what it changed. Switch modules off and their tools go with them. Ask it about the app
itself too: it answers from these docs.

- **It writes mail; you send it.** Ask it to email someone ("email Alex that Saturday works, and copy Sam") and it
  writes the mail and shows it under its reply as a card: From, To and Cc, Subject and the whole text, then Send,
  Edit and Cancel. Nothing is sent until you tap Send: the assistant cannot send mail itself, and it says so. Send
  gives you the same 10 seconds of Undo as the Mail screen. Edit opens New mail on the Mail screen filled with it, to
  change it and send it or save it as a draft from there. Cancel drops it. A card you leave alone is gone after 24
  hours, and says so. On the Watch the card has Send and Cancel; change a mail on the iPhone.
- **Who it writes to.** Only addresses you give it in that chat, or that are in People. It never writes to an
  address it read on a web page, in a mail or in a document, unless you typed it yourself. It can attach the pictures
  you attached in the chat. It needs Mail on and a mailbox that can send (not Read only, and with a sending server);
  otherwise it says which is missing.

## Tech: your machines, checks and sensors

Tech, Overview is one screen for everything you watch: what needs a look at the top, then a card for each machine (with
its CPU, memory and fullest disk), each service on the internet you check, and each place with sensor boards. Switch on
Machines (and Sensors, for the readings) in Settings, Modules; add the computers the hub may reach with Add machine, and
a ping, port, web address, certificate, name lookup or backup check with Add check.

The light at the top, the same as Today's Tech line, is red while a check is down or the hub's backup needs a look,
yellow while only readings are out of bounds or silent, gray once you have acknowledged each one, and green when all is
good.

- **Propose a fix** sits on a check that is down and on a reading out of bounds or silent. The assistant looks into it
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
- Renewals and bills are not in Tech: they are in Life admin, Renewals.

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
