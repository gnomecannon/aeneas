# Several people on one hub machine

Aeneas keeps one person per hub. When several people (a household, say) want to use one machine, each gets a hub of their own on it. Nothing is shared between their hubs but the model server, and that is shared fairly.

## What each person gets

- **Their own Linux account**, named `aeneas-<name>`. It has no password and no login. Its home folder is mode 700, so the other hubs cannot read it.
- **Their own hub** on its own port, with its own Tailscale address. For example, `https://core.example.ts.net:8788`.
- **Their own everything else**: database, notes folder, work space key, chats, linked accounts and nightly backups.
- **A name and a color.** Their devices show these, so everyone can see whose hub a device is paired with:
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
- **The owner's settings for how the model runs.** These are the model, its context size, how long it stays loaded, web search, and the time zone. `people.sh update` copies them again after the owner changes them.
- **CPU and memory.** systemd gives every account an equal share of the processor by default, so one person humming a long melody does not slow the other's hub.

## What other people's hubs cannot do

- Reach the owner's machines. Their accounts have no SSH keys, and Homelab and Sensors start switched off.
- Read this machine's disks or temperatures (`EA_HOST_SENSORS=false`).
- Use the image service. That is the owner's only.

## Commands

Run these on the hub machine, from the owner's account, with sudo:

```bash
# once: the gate, and the owner's own hub sent through it
sudo bash ~/everythingapp/deploy/people.sh setup --name Sam

# a hub for someone else; prints its address and a pairing link for their first device
sudo bash ~/everythingapp/deploy/people.sh add Jamie

# everyone's hubs, addresses, colors, and whether each is up
sudo bash ~/everythingapp/deploy/people.sh list

# a new pairing link (the first one lasts 10 minutes)
sudo bash ~/everythingapp/deploy/people.sh pair Jamie

# after updating the owner's hub (deploy/update-hub-user.sh): everyone else's hubs to the same code
sudo bash ~/everythingapp/deploy/people.sh update

# stop a hub and turn off its address; their data stays in their account
sudo bash ~/everythingapp/deploy/people.sh remove Jamie
```

`remove Jamie --erase Jamie` also deletes the account and everything in it, for good.

**Letting them in.** The person needs to reach the machine on your tailnet. In the Tailscale admin console, open Machines, pick the hub machine, and choose Share. They accept with their own Tailscale account, and they use only their own hub's address.

## Limits

- Anyone with admin rights on the machine can read every account's files. Each person's data is separate from the other people's, not hidden from the machine's admin.
- With one place on the gate (the default), one reply is written at a time. If Ollama runs with `OLLAMA_NUM_PARALLEL` above 1 and the GPU has room for it, set `EA_GATE_SLOTS` to match in the gate's service file.
