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

The recipe has not been run on F-Droid's build server yet. The parts most likely to need changes there are the Node
install line and the NDK version.

## Checks F-Droid makes

- No proprietary libraries: no Google Play Services or Firebase. The app uses AndroidX, Material Components and the
  WebView, all open source.
- No trackers or analytics.
- Anti-features: none expected. The app only talks to the owner's own hub, which is free software.
