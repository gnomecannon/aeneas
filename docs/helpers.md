# Family: a hub for someone else, and helping them with their devices

For someone who is not technical (a parent, say) and has a family member with a capable computer. They get Aeneas on
their phone with one invitation, their own hub runs on the family member's machine, and that family member can help
them with their computer and phone through the assistant.

The person who runs the machine is called the helper here. The person helped is called them.

## Give them a hub of their own

On the helper's machine, Settings, People on this machine, Add a person (the machine needs a one-time setup first:
the page shows the command). Their hub has its own account, data and devices, apart from the helper's, and shares the
machine's model. See [multi-person.md](multi-person.md) for what is shared and who can see what.

## Invite them

Each person's hub can be reached with a QR code from anywhere, with nothing else on their phone (the Direct link,
[connections.md](connections.md)). After Add a person, or with New invitation beside their name:

- **They are here with you.** Show them the large QR code. They install Aeneas, open the phone's Camera, point it at
  the square and tap the Aeneas link.
- **They live somewhere else.** Copy a message for them (a text or an email): it says, in three steps, to install
  Aeneas, copy the whole message, and open Aeneas and tap Paste the invitation. The app finds the invitation in the
  message and connects. Or print the page: they scan the square on paper with the phone's camera.

An invitation works once, for 3 days. Someone who uses Tailscale can use the hub's Tailscale address instead, once the
helper shares the machine with them on Tailscale.

## Help them with their devices

Beside their name, Help with devices. Their app then asks them once, in large type:

> Robin offered to help with your computer and phone. If you say yes, Robin can check your computer and fix problems
> on it, without asking you each time. Robin can also use the passwords you choose to save for Robin. This does not
> open your notes, chats or diary.

After **Yes, let Robin help** they are never asked again. Someone who is not technical cannot judge a command, and
they chose to trust their helper. What the helper can then do:

- **Their computer.** The Aeneas app on their Windows computer or Mac runs the commands the helper's assistant sends,
  while the app is open, unless they switch it off on that computer (Settings, People who help you, This computer). On
  a Windows computer the app turns on Start on login by itself the first time it finds someone helping (once they said
  yes, on any of their devices), so it is open after a restart without them doing anything, and People who help you,
  This computer says so in one line. It does this only for a helped person, never for other users of the Windows app,
  and only once: turned off in Settings, Windows, Start on login, it stays off. Stop leaves it as it is (Aeneas keeps
  starting when they sign in until they turn that off). On a Mac, turn on Start on login there by hand. Ask the assistant, for example "why is Mom's computer slow?": their computer is a
  machine like the helper's own (Machines). Commands that only look run at once; a change waits for the helper's own
  yes in the chat, as on the helper's own machines.
- **The devices in their home.** In their app, Find the devices in my home lists the computers, printers, phones,
  cameras and other devices on their home Wi-Fi, and what each one answers on (remote desktop, SSH, a web page). The
  helper's assistant sees the list.
- **Devices that already take SSH** (a storage box, a Raspberry Pi, a Mac with Remote Login): each one the scan found
  answering SSH is a machine for the helper's assistant too ("Mom's attic (192.168.1.6)"). Their Windows app signs in to
  it on their home network with the user name and password they saved for that device (Passwords for Robin, Is it for
  one of the devices in your home?). The key a device answers with the first time is kept, and a device that later
  answers with another key is refused before any password goes (the helper can forget a reset device's key).
- **Devices that take no SSH.** The easier way: install Aeneas on it (a Windows computer or a Mac) and pair it with
  their hub, and it is one of their computers. Otherwise someone at the device turns SSH on (Windows: Settings, System,
  Optional features, OpenSSH Server; a Mac: System Settings, General, Sharing, Remote Login), or the helper uses it in
  person or over screen sharing.
- **Passwords they choose to give.** In their app, Passwords for Robin: what it is for, a user name and the password.
  They are kept on their own hub, in a vault of their own apart from anything else, and the helper's assistant uses one
  by name (`{{secret:My computer}}`). The value goes into the command only on their hub, and it is cut out of what comes
  back, so it is never shown in a chat.
- **Everything is written down for them.** Settings, People who help you, What happened: each check and change in a
  plain sentence ("Robin: looked at why your computer is slow"), with the exact command one tap away.
- **They can stop it at once.** Stop Robin's help ends it: the helper's key stops working that moment. The helper can
  stop too, beside their name.

What the helper cannot do through this: read their notes, chats, diary or anything else on their hub. The key the
helper's hub holds opens the helping routes only (`/warden/*`, CONTRACT, Helpers). As the machine's admin the helper can
still open their files directly, as [multi-person.md](multi-person.md) says; helping changes nothing about that.

## Limits now

- Helping works between hubs on the same machine (People on this machine): the helper is the machine's owner.
- Commands run on a computer with the Aeneas app (Windows or Mac), as the person signed in there, without
  administrator rights: a fix that needs them is listed for the helper to do in person or over screen sharing.
- Only the Windows app signs in to other devices over SSH; the Mac app runs commands on the Mac itself.
- A printer, a router or a camera usually has only a web page: it is listed, and the helper's assistant can say what it
  found, but changing its settings is done in its web page by hand.
- The app on a phone looks for devices and saves passwords; it runs nothing.
- On a Windows hub, the model gate cannot tell the hubs apart, so they take turns in the order they ask instead of a
  chat going first ([multi-person.md](multi-person.md)).
