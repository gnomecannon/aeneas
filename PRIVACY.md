# Privacy policy

Aeneas (the iPhone, iPad, Apple Watch, Mac, Windows and web apps, and the hub) is made by gnomecannon. This
policy covers all of them. Last changed 2026-11-06.

## The short version

We collect nothing. There is no server of ours, no account with us, no analytics, no advertising, no tracking and no
crash reports sent to us. Your data goes only between your own devices and the hub you run on your own computer.

## Where your data is

- **On your hub.** Everything you make in the app (captures, tasks, notes, reminders, logs, chats with the assistant)
  is kept on the hub, a program you install on a computer you own. Backups are encrypted with a key only you hold.
- **On your devices.** Each app keeps a copy so it works offline. Removing a device from the hub wipes that copy the
  next time it connects. The Apple apps keep their copy out of iCloud Backup, Spotlight and the lock screen unless you
  turn those on in Settings, Privacy.
- **Between them.** Devices reach the hub over your own Tailscale network (WireGuard, end to end) or over HTTPS on
  your home network with a certificate the app checks. Each device has its own key, and any device can be removed.

We, the makers, cannot see any of it: we have no copy, no access and no way to get one.

## When something leaves your devices

Only when you turn on a feature that needs it, and the app says which company and what goes before it starts:

- **The assistant** runs on a model on your own computer. Choosing a cloud model instead (with your own key from that
  company) sends your chats to that company; work items never go to it.
- **Web lookups** (off until you turn them on) send search words to search engines and fetch pages, only through Tor,
  so they see a Tor address, not yours.
- **Linked accounts** you choose to connect (for example Gmail, read only; Confluence; Steam) are read by your hub
  with your permission, which you can withdraw at any time.
- **Voice input** uses your device's own speech recognition; where the device would send audio to its maker (Apple,
  Google or Microsoft) for that, the app says so first.
- **Location** (only if you allow it, for the meals tax in the calculator) is used once, approximately, on your device
  and hub to find your state; it is not kept or sent anywhere else.

The full list of every outside address the hub and apps can contact, and what turns each on, is in
`docs/privacy-network.md` in the source code.

## Children

The apps are not directed at children and collect nothing from anyone.

## Changes and contact

Changes to this policy are made in the public source code, where every change is dated. Questions: open an issue at
https://github.com/gnomecannon/aeneas/issues.
