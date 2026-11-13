# Gmail setup

The Mail receipts module reads Gmail messages that look like receipts, renewal notices or vet mail, and your own
model files them as renewals and pet visits. It only reads: it never sends, changes or deletes mail, and the mail
itself is not kept.

This page is for reading ahead. In the app, Settings, Connections, "Your own Google app, for Gmail" shows the same
steps one at a time, with your hub's own addresses filled in, and checks the result at the end.

## Why you make your own Google app

Google counts reading mail as a restricted permission. An app that many people sign in to with that permission has
to pass Google's verification and a security assessment by an outside lab every year, so Aeneas does not ship one
shared Google app. Instead each person makes their own. You are its only user, so Google does not need to review it,
and nothing passes through a server of the project's: the hub talks to Google directly.

## Before you start

- **About 10 to 15 minutes**, signed in to the Google account whose mail Aeneas should read.
- **Your hub reached through Tailscale.** Google sends people back only to an https address, and it does not accept an
  IP address, so Gmail needs the hub's Tailscale name (an https `ts.net` address), and the device you sign in on must
  reach the hub through it. A hub reached only over home Wi-Fi or Direct link cannot use Gmail.
- **The Mail receipts module on**, with Renewals or Pet on as well: mail is filed only into modules that are on.
- **Your hub's address** as the app shows it in Settings, Connection, for example `https://hub.example.ts.net:8787`.
  Steps 3 and 6 use it. Below, `<hub>` stands for it.

## Steps

1. **Make a Google Cloud project.** Open [Create a project](https://console.cloud.google.com/projectcreate), sign in
   with the Google account whose mail Aeneas should read, and create a project. Any name works; `Aeneas` is fine.
2. **Turn on the Gmail API.** Open the [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
   page and, with the new project selected at the top of the page, press Enable.
3. **Set up the sign-in screen.** Open [Google Auth Platform](https://console.cloud.google.com/auth/overview) and press
   Get started. App name: `Aeneas`. Support email and contact email: your own. Audience: External. Agree and press
   Create. A privacy policy is optional; if you add one, use `<hub>/privacy`.
4. **Let it keep working.** In [Audience](https://console.cloud.google.com/auth/audience), press Publish app and
   confirm, so the status says In production. Left in Testing, Google ends the sign-in every 7 days. You are its only
   user, so Google does not need to review it.
5. **Allow reading mail, nothing else.** In [Data Access](https://console.cloud.google.com/auth/scopes), press Add or
   remove scopes, paste the scope below into Manually add scopes, press Add to table, then Update and Save.

   ```
   https://www.googleapis.com/auth/gmail.readonly
   ```

6. **Make the client.** In [Clients](https://console.cloud.google.com/auth/clients), press Create client. Application
   type: Web application. Name: `Aeneas`. Under Authorized redirect URIs press Add URI and paste your hub's return
   address exactly, then press Create and copy the Client ID and the Client secret.

   ```
   <hub>/connections/google/return
   ```

7. **Paste them into the app.** In Settings, Connections, open the Gmail guide's last step and paste the Client ID
   and the Client secret. They are kept on your hub only and never shown again.
8. **Sign in with Google.** Google shows a screen saying it has not verified the app. It is your own app, so choose
   Advanced, then Go to Aeneas, and allow reading mail.

## If it does not work

- **Google says `redirect_uri_mismatch`.** The address in step 6 must match the hub's exactly, port included. Copy
  it from the app's guide, which fills it in.
- **The sign-in stops after a week.** The app is still in Testing: do step 4.
- **The app says Google needs an https address, or does not accept an IP address.** Reach the hub through its
  Tailscale name, then open the guide again.
- **After moving the hub or restoring it from a backup.** Link Gmail again (`docs/running-your-hub.md`, Linked
  accounts).
