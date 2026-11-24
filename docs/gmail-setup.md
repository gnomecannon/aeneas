# Gmail setup

Sign in with Google is no longer offered (since 2026-11-24). Add a Google account with an app password instead. One
app password works for Mail and for Receipts and renewals, takes about 5 minutes, and needs no Google Cloud project and
no Tailscale.

1. Turn on 2-Step Verification for your Google Account.
2. Make an app password named Aeneas at
   [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords). Google shows it once, as 16 letters.
3. In Aeneas, open Settings, Accounts, Add account, choose Google, and enter your address and the app password.

[using-aeneas.md](using-aeneas.md), Mail, has the rest.

An address that was signed in with Google before keeps reading its receipts. Its account in Settings, Accounts
says it uses the older Google sign-in and offers Add an app password. Once you add one, the hub moves the address's
receipts to it, reads on from where the sign-in stopped (no mail is read twice), and removes the older sign-in. With
the last such sign-in, the hub deletes its Google app under App keys too.
