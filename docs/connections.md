# How your devices reach your hub

Your hub is a computer in your home. Your phone and other computers need a private way to reach it, and the installer (and later Settings, How devices reach this hub) asks which of three you want. The choice doesn't change what the hub stores or where your data lives: that always stays on your hub.

The same comparison is in the app, under Settings, How devices reach this hub, ⓘ, Learn more.

| | Direct link (iroh) | Tailscale | Home Wi-Fi only |
|---|---|---|---|
| **Setting up a phone or computer** | Scan the QR code (Aeneas 1.0.3 or newer). | Sign in to Tailscale with the same account as the hub (in the Tailscale app, or inside Aeneas on iPhone, iPad and Mac), then scan the QR code. | Scan the QR code while on your home network. |
| **Works away from home** | Yes. | Yes. | No. |
| **Account needed** | None. | A Tailscale account (Google, Apple, Microsoft or GitHub sign-in). | None. |
| **Can anyone read your data on the way?** | No. Encrypted end to end between your device and the hub. | No. Encrypted end to end between your devices (WireGuard). | No. Encrypted with the hub's own certificate. |
| **Outside companies involved** | n0, the makers of iroh, run the relay used when a direct path is blocked. It passes encrypted data and sees IP addresses and timing, not content. n0 offers its relays free but promises no uptime; if they stop, Direct link stops until the app moves to another relay (Tailscale and Home Wi-Fi only are not affected). | Tailscale runs the coordination server and relays. It keeps your account, a list of your devices, their names and when they're online. | None. |
| **Who decides which devices are trusted** | Only you: your devices trust the hub key in the QR code you scanned. A relay can't add a device or pretend to be your hub. | Tailscale's server tells your devices which keys belong to your network. Tailnet Lock moves that decision back to you, but it's off by default. | Only you, through the certificate in the QR code. |
| **If a company is forced to cooperate** | The relay operator could be made to log IP addresses and timing. There's no account or device list to hand over. | Tailscale could be made to hand over your account and device records, and in principle to add a device to your network (unless Tailnet Lock is on). | Nothing outside your home is involved. |
| **Upkeep** | None. | Devices sign in again every 180 days unless you turn key expiry off in Tailscale's admin page. | None. |
| **Cost** | Free for you. | Free for personal use. | Free. |
| **Best for** | Most people. | People who already use Tailscale, or want the hub to reach their other machines. | Keeping everything inside your home. |

## What none of these can protect against

Every choice trusts the Aeneas app itself, your phone or computer's operating system, and any cloud backups of your devices. Aeneas is open source, so anyone can check what the app does.

## How each one works

- **Direct link** uses [iroh](https://iroh.computer), open source networking software from the company n0. The hub has its own key; the pairing QR code carries that key and the relay the hub uses, and the app accepts only that key. Requests that arrive this way are treated as a remote device and need that device's own key. The hub keeps the relay it was first given and uses no lookup service. Code: `hub/src/link.ts`.
- **Tailscale** uses Tailscale Serve on the hub's computer, with a certificate for its tailnet name. See [What is Tailscale](https://tailscale.com/kb/1151/what-is-tailscale) and [Tailnet Lock](https://tailscale.com/kb/1226/tailnet-lock).
- **Home Wi-Fi only** has the hub listen on the home network with its own certificate; the QR code carries the certificate's fingerprint, so the app accepts that certificate and no other. On Windows, a firewall rule lets only the hub's own program take connections, on private networks only.

What each one sends where is listed in [privacy-network.md](privacy-network.md).
