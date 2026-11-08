# F-Droid

`com.gnomecannon.everythingapp.yml` is the build recipe for F-Droid's own repository (fdroiddata). F-Droid builds the
app from this repository's source on its servers and signs it with its own key, so the F-Droid copy and the GitHub
APK cannot update each other: pick one source per phone.

The store text, icon and screenshots F-Droid shows come from `fastlane/metadata/android/en-US/` in this repository.

## Submitting (needs a GitLab account, the owner's)

1. Fork https://gitlab.com/fdroid/fdroiddata and add this file as `metadata/com.gnomecannon.everythingapp.yml`.
2. Open a merge request. F-Droid's pipeline builds it; its reviewers often ask for changes to the build steps.
3. Later versions: push a `vX.Y.Z` tag on the public repository with the version in `web/src-tauri/tauri.conf.json`.
   F-Droid finds new tags on its own (`UpdateCheckMode: Tags`).

The recipe follows the other Tauri apps in fdroiddata (rustup, nodejs and npm from Debian trixie, then `npm ci` and
`tauri android build`). Its build steps were run from a clean clone of the public tag on 2026-11-08 and gave a 10 MB
unsigned APK (arm64 and armv7) at the `output` path. It passes `fdroid lint` and `fdroid rewritemeta`.

Submitted 2026-11-08 as https://gitlab.com/fdroid/fdroiddata/-/merge_requests/56391 from https://gitlab.com/gnomecannon/fdroiddata,
branch `com.gnomecannon.everythingapp`. The fork's own
pipeline does not run until GitLab verifies the account (phone or card); F-Droid's template says not to verify and to
ask their team to run the CI instead, which costs nothing.

Valid categories are listed in fdroiddata's `config/categories.yml`.

## Checks F-Droid makes

- No proprietary libraries: no Google Play Services or Firebase. The app uses AndroidX, Material Components and the
  WebView, all open source.
- No trackers or analytics.
- Anti-features: none expected. The app only talks to the owner's own hub, which is free software.
