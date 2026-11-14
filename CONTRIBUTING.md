# Contributing to EverythingApp

Changes are welcome: bug fixes, new modules, translations, docs. Read `packages/shared/CONTRACT.md` first; it is the
rulebook every part of the app follows (privacy, permissions, the shape of every route).

## What you agree to when you contribute

EverythingApp is licensed under the GNU Affero General Public License, version 3 only (`LICENSE`). The project's
maintainer (gnomecannon) also publishes the Apple apps on the App Store, whose terms add restrictions the AGPL does
not allow. So every contribution comes with one extra permission. By sending a pull request, a patch or any other
contribution, you agree that:

1. **You may contribute it.** You wrote it, or you have the right to send it under these terms, and it holds no code
   under a license the project cannot use (the license check in `tools/license-check/` lists the allowed ones).
2. **Everyone gets it under the AGPL.** Your contribution is licensed to everyone under AGPL-3.0-only, the same as
   the rest of the code.
3. **The maintainer may use it in any way.** You also give the maintainer a permanent, worldwide, royalty-free,
   irrevocable permission to use, copy, change, publish, sell and sublicense your contribution under any terms,
   including in the paid App Store apps.
4. **You keep your copyright.** Nothing here transfers it; you can use your own work however you like.

Pull requests have a checkbox for this. A contribution without it ticked is not merged.

## How to work

- One change per pull request, with a sentence on why.
- Tests with the change: `cd hub && npm test`, `cd web && npx vitest run`, and for the Apple apps
  `cd apple/Packages/EACore && swift test`.
- New dependencies must pass `npm run license-check`.
- Every new module is a module people can switch off, and asks only for the permissions it needs.
- Nothing leaves the user's own devices unless they turned it on or chose it at setup (how devices reach the hub), and logs never hold personal text or secrets.
