# Several people on one hub machine

Aeneas keeps one person per hub. When several people (a household, say) want to use one machine, each gets a hub of their own on it. Nothing is shared between their hubs but the model server, and that is shared fairly.

This works on a Linux hub with Tailscale. Each person's hub needs its own address on your tailnet.

## Who can see what

- **The other people on the machine cannot see your hub.** Each hub runs in its own Linux account, and its files (database, notes, chats, keys, backups) can be read only by that account. One person's hub cannot open another's, and neither can the hubs' assistants.
- **The machine's admin can.** Anyone with admin (root or sudo) rights on the machine can read every account's files, and that usually means the machine's owner. The app says so on the People on this machine screen, before and after someone is added. Tell the people you add before they start, and share a machine only with people who trust whoever runs it.

## Adding someone

**Once, on the hub's machine.** In a terminal, run this command. It asks for your password and takes a minute.

```bash
sudo bash ~/everythingapp/deploy/people.sh setup --name "Your name"
```

It sets up three things:

- the model gate, which shares the model;
- your own hub, sent through the gate and given a color;
- a small service that lets your hub add people from the app.

Until it has run, the app's People on this machine screen shows this command.

**Each person, in the app.**

1. Open Settings, People on this machine. Type their first name and press Add. It takes a minute or two, and the screen shows each step.
2. When it's ready, the screen shows their hub's address and color, and a QR code.
3. Share the machine with them on Tailscale. In the [admin console](https://login.tailscale.com/admin/machines), open Machines, pick the hub machine, and choose Share. They accept with their own Tailscale account, which is free.
4. On their phone, they install Aeneas and Tailscale, then scan the QR code with the camera.

The code works once, for 10 minutes. If it runs out, press New pairing code beside their name.

The same steps from a terminal on the hub's machine:

```bash
sudo bash ~/everythingapp/deploy/people.sh add Jamie
```

## What each person gets

- **Their own Linux account**, named `aeneas-<name>`. It has no password and no login. Its home folder is mode 700.
- **Their own hub** on its own port, with its own Tailscale address. For example, `https://core.example.ts.net:8788`.
- **Their own everything else**: database, notes folder, work space key, chats, linked accounts, nightly backups and devices.
- **A name and a color.** Their devices show these:
  - the web app (Windows, Android, browser) shows a dot in the hub's color and "Jamie's hub" in the sidebar and the top bar, and puts the name in the window title;
  - the iPhone, iPad and Mac app shows it under Settings, Connection.

  A hub on a machine with only one person has no color and looks as it always did.

## What they share

- **The model server.** It is shared through the **model gate** (`hub/src/gate.ts`), a small service run by the owner's account. Every hub on the machine talks to the gate instead of to Ollama directly.
  - **A reply comes first.** Someone waiting on a reply goes before a capture being filed, which goes before background reading (mail, note tags).
  - **Two people asking at once take turns.** They alternate call by call, so one person's long assistant answer, with several tool steps, cannot shut the other out.
  - **A chat can stop background work.** If one person's background reading holds the model when another person starts a chat, the reading stops and is tried again later.
  - **Warm-ups give way.** A warm-up (when someone opens the assistant) only runs on an idle model that nobody else used in the last two minutes, so it never pushes someone's conversation out of the model's memory.
  - **Only the owner manages models.** Only the owner can add or remove models. Everyone else runs the owner's model, so no second large model pushes the shared one out of GPU memory.
  - **"Waiting for the shared model."** A person whose chat is waiting sees that status. They are never told whose question is ahead of theirs.
- **The owner's settings for how the model runs.** These are the model, its context size, how long it stays loaded, web search, and the time zone.
- **CPU and memory.** systemd gives every account an equal share of the processor by default, so one person humming a long melody does not slow the other's hub.

## What other people's hubs cannot do

- Reach the owner's machines. Their accounts have no SSH keys, and Homelab and Sensors start switched off.
- Read this machine's disks or temperatures.
- Use the image service. That is the owner's only.
- Add people. Only the owner's hub offers that.

## Looking after them

All of these run on the hub's machine, with sudo, from the owner's account:

```bash
# everyone's hubs, addresses, colors, and whether each is up
sudo bash ~/everythingapp/deploy/people.sh list

# after updating your own hub: everyone else's to the same code and model settings
sudo bash ~/everythingapp/deploy/people.sh update

# stop a hub and turn off its address (also in the app, the Stop button beside their name); their data stays
sudo bash ~/everythingapp/deploy/people.sh remove Jamie

# delete a stopped person's account and data for good (only from the terminal, never from the app)
sudo bash ~/everythingapp/deploy/people.sh remove-account aeneas-jamie --erase aeneas-jamie
```

`unsetup` turns all of this off again, once the other people's hubs are removed. It puts your own hub back on the model server directly.

## How the app adds someone without root

Your hub runs without any special rights and never runs anything as root. Here is what happens instead:

1. When you press Add, your hub writes a small request into `/var/lib/aeneas/requests`. Only your account can write there.
2. A system service, `aeneas-people.path`, notices the request. It runs the root-owned copy of this script, `/usr/local/sbin/aeneas-people`, that `setup` installed.
3. That copy accepts only three requests: add, a new pairing code, or stop. Each one names a person and nothing else, and every field is checked before anything runs.
4. Progress and the result (the address and a one-time pairing code) go to `/var/lib/aeneas/results`. Only your account can read that folder.
5. While a hub is being set up, the hub's code is read as you and written as the new account, so root itself never runs your code.

## Limits

- **The machine's admin can read every hub** (see Who can see what).
- **One answer is written at a time.** With one place on the gate (the default), replies don't overlap. If Ollama runs with `OLLAMA_NUM_PARALLEL` above 1 and the GPU has room for it, set `EA_GATE_SLOTS` to match in `~/.config/systemd/user/aeneas-gate.service`.
- **Linux with Tailscale only.** A hub on a Mac, or one on a home network without Tailscale, has one person.
