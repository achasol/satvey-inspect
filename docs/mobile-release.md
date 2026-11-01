# Native release and public store preparation

The app is packaged with Capacitor as `nl.satvey.inspect` / **Satvey Inspect**. Confirm ownership of that identifier before reserving either public store entry. This repository does not upload or publish to either store.

## Build

Run `npm ci` at repository root. Set `VITE_API_URL` to the actual HTTPS origin (for example `https://inspect.customer.nl`, with no trailing slash), then run `node scripts/build-mobile.mjs`. It typechecks, builds and synchronizes both native projects. A normal browser build needs no API origin. Never add a remote `server.url` to the release Capacitor configuration.

Android requires Java 21 and Android SDK 36. From `apps/web/android`, run `./gradlew assembleDebug` for device acceptance or `./gradlew bundleRelease` for an unsigned release bundle. On Windows use `gradlew.bat`. Configure release keystore/signing through the developer's secure CI secret store or Android Studio, outside version control. Verify the signed bundle and increment `versionCode` on every store upload.

iOS requires a Mac/Xcode supporting the pinned Capacitor SDK. Open `apps/web/ios/App/App.xcodeproj`, select the owner's development team, register bundle identifier/capabilities, set signing and increment marketing/build versions. Archive the **App** scheme for a physical iOS device. Export/upload through Xcode Organizer or the owner's authenticated release pipeline. The checked-in package uses Swift Package Manager.

[Native build verification](../.github/workflows/mobile.yml) builds Android debug/unsigned release and an unsigned iOS simulator app. Pull requests use an explicitly invalid API origin solely for compilation; those artifacts cannot serve customer visits. Dispatch with the real origin for device acceptance. This workflow does not sign, submit or prove store acceptance. Windows execution of `cap sync` does not compile Swift or Android.

### Android verification in Docker

The [Docker build](../infra/android-build.Dockerfile) installs Java 21 and Android SDK 36 inside the image; no host Java or Android SDK installation is needed. Run these commands from the repository root with Docker Desktop using Linux containers:

```powershell
docker build -f infra/android-build.Dockerfile -t satvey-android-verify .
docker run --name satvey-android-verification --cpus=2 --memory=3g --memory-swap=3g --pids-limit=512 --mount type=volume,source=satvey-android-gradle-cache,target=/gradle-cache satvey-android-verify
New-Item -ItemType Directory -Force .cache/android-build
docker cp satvey-android-verification:/work/apps/web/android/app/build/outputs/apk/debug/app-debug.apk .cache/android-build/app-debug.apk
docker cp satvey-android-verification:/work/apps/web/android/app/build/outputs/bundle/release/app-release.aab .cache/android-build/app-release.aab
```

The default origin is `https://inspect.invalid`, explicitly for compilation. To create a build for device acceptance, supply `--build-arg API_ORIGIN=https://your-actual-origin.example` to `docker build`. Use a fresh container name for subsequent runs, or remove the previous stopped verification container after copying its artifacts. The Gradle cache volume can be reused.

Initial readiness build, before visual changes, verified on 2026-11-01: `assembleDebug bundleRelease` completed successfully, 679 tasks, with release vital lint included. APK and AAB ZIP integrity checks passed. The final artifacts are in `.cache/android-build`; the build log is `.cache/android-gradle-build-final.log`.

| Artifact          |    Bytes | SHA-256                                                            |
| ----------------- | -------: | ------------------------------------------------------------------ |
| `app-debug.apk`   | 18168389 | `82319b88ef8cc555df11d20cc1576785769217c06e37e54e8e54bc24e621d8f6` |
| `app-release.aab` | 11507199 | `9be754d30cec8ec67ce849f9ff62fdaa6ccfcadd29e9f2062f99da0b7d3df5cf` |

The APK uses debug signing; the release AAB is unsigned. Neither was installed on a physical device during this verification. iOS compilation, signed device acceptance and store submission remain outstanding.

### Final visual/workflow Android verification

The final visual implementation passed `assembleDebug bundleRelease` in Docker on 2026-11-01: 679 tasks, container exit 0, APK/AAB archive integrity checks passed. This includes continuous capture/audio, scoring, branding, Analytics and the corrected mobile header spacing. The build uses `https://inspect.invalid` for compilation; it is not a customer device build. The APK uses debug signing and the AAB is unsigned.

Artifacts: `.cache/android-build/visual-review`. Build log: `.cache/visual-implementation/android-verified.log`. The machine-readable manifest is `.cache/android-build/visual-review/manifest.json`.

| Artifact          |    Bytes | SHA-256                                                            |
| ----------------- | -------: | ------------------------------------------------------------------ |
| `app-debug.apk`   | 18177860 | `5dec9e65ab5a0104d81228072e4c040e9f4ab2b5f657ef5a582527ae69bc3325` |
| `app-release.aab` | 11516127 | `8029eec06f9f2054f42f387b70c6bbb8397c3a20d6eadec275e18bb04f179ed8` |

## Storage and permissions

- SQLCipher encrypts the durable native database. A generated passphrase is stored by the native plugin's secure secret facility. IndexedDB is a rebuildable UI projection; a save is acknowledged after native persistence. Private evidence files are hash checked before use. They rely on device filesystem protection; enforce device passcode and organisation management policy.
- Android disables backup/device transfer and cleartext traffic. iOS excludes data/database directories from backup and applies complete file protection. Camera, microphone and selected-photo reasons are configured. There is no broad Android photo-library/storage permission.
- System-browser login uses a short-lived PKCE code, state binding and the fixed `nl.satvey.inspect://auth/callback` callback. Native bearer sessions are stored privately and expire after 30 days. Logout clears local authentication; offline logout cannot revoke a server session until its expiry.
- Offline access is prepared while authenticated and checked on cold start, resume and periodically. Expiry locks access without deleting unsynced work. Moving the device clock backwards requires online renewal. AI, finalization, email and VERA remain online operations.
- `PrivacyInfo.xcprivacy` declares file timestamp/user-default access. Validate the merged archive privacy report and SQLCipher export-compliance answers before submission. Platform configuration references: [Filesystem](https://capacitorjs.com/docs/apis/filesystem), [Camera](https://capacitorjs.com/docs/apis/camera), [SQLite encryption](https://github.com/capacitor-community/sqlite/blob/master/docs/DatabaseEncryption.md).

## Physical-device acceptance record

Record device/OS version, app build, API release, tester, date and resulting issue/receipt for each item. Exercise both iOS and Android, not just emulation.

| Scenario                                                         | Required result                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Browser password and customer SSO login                          | Correct account/organisation in the app; callback replay and cancelled login fail safely                                        |
| Prepare realistic large visit, airplane mode, kill app, restart  | Prepared evidence/framework and manual review remain usable; unprepared resources explain what is unavailable                   |
| Camera/gallery, rotation, Android activity destruction           | Evidence is recovered exactly once into the correct room; no phantom “saved” state                                              |
| Default-on audio, room split, mute/unmute, interruption          | Mute closes and unmute starts a recording; room changes split automatically and preserve mute; durable recovery; validate codec |
| Low disk or failed native write                                  | Save failure is visible; existing evidence survives; no completion acknowledgement before durable commit                        |
| Uninstall/backup/device-transfer drill using disposable data     | Sensitive evidence is excluded from backups; reinstall is explicitly destructive, never a recovery step                         |
| TTL expiry, backward clock, device resume and logout             | Access locks; unsynced work remains; reconnect requires valid identity                                                          |
| Reconnect after concurrent edit/revoked membership               | Conflict or authorization error; no overwrite or cross-account upload                                                           |
| Resident signs/each exception, reviewer feedback, report reissue | Fresh signatures on reissue; QA never blocks; old PDF/version remains preserved                                                 |
| PDF sharing and attachment email                                 | Correct file/name, exact finalized PDF, no internal audio/transcripts, receipt history labels accurate                          |

## Public store metadata draft

**Name:** Satvey Inspect. **Short description:** Woninginspecties met bronbewijs, beoordeling en rapportage. **Audience:** authorised professional inspectors working for participating housing organisations. There is no public registration or consumer purchase.

**Description:** Leg woninginspecties vast per ruimte met foto's en spraaknotities. Controleer bevindingen en bewijseisen aan de hand van het sjabloon van je organisatie. Registreer afspraken, laat het rapport ondertekenen en volg overdracht op. Bereid toegewezen bezoeken vooraf voor om tijdelijk zonder verbinding te werken. Voor gebruik is een account bij een aangesloten organisatie nodig. Automatische voorstellen worden door de inspecteur gecontroleerd; verwerking en rapportverzending vereisen verbinding.

Provide live HTTPS `/support`, `/privacy` and `/account-deletion` pages with the operator's actual legal entity/contact, and the approved full privacy policy URL. Supply an isolated, realistic review account with working sample visits and reviewer instructions. Never give reviewers production resident data or internal credentials.

Capture store screenshots from the signed binary on representative phone/tablet sizes: visit list, capture, compact review, resident signing/report and delivery history. App icon/splash follow the existing house brand. Store screenshots and final copy must describe only device-tested functionality.

Complete Apple App Privacy / Google Data safety from actual production data flows: account name/email/ID, user-provided property/evidence/photos/audio, signatures and report content, plus automatic active-time intervals and operational diagnostics where collected. Describe encrypted transport, service providers used for inference/transcription/email/hosting, data retention/deletion and corporate controller responsibilities. No tracking/advertising is introduced here. These are draft submission inputs, not a legal certification or a completed store declaration.

Before public release: sign and scan artifacts, verify privacy manifest and export compliance, review dependency findings, attach completed device acceptance, customer sandbox receipt and restore evidence, obtain customer/operator sign-off, then submit through the owned Apple/Google accounts. Store approval must be recorded as an external result.

Dependency review at implementation: npm audit reported 15 moderate findings in developer tooling (glob/minimatch and dependents), with no high or critical findings. Do not force a Capacitor major downgrade to silence transitive tooling findings; reassess pinned updates before a signed release. Android release builds prevent screenshots; capture public store images with a debug acceptance build of the same UI and fictional data.
