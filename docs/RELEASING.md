# Releasing and auto-updates

OpenTable ships updates through **GitHub Releases**. Installed apps check that
feed on launch and every six hours, download in the background, and install on
next quit. Users can also check manually in **Settings**.

---

## Cutting a release

```bash
npm version patch     # or minor / major — this creates the git tag
git push --follow-tags
```

Pushing the tag triggers `.github/workflows/release.yml`, which builds macOS,
Windows and Linux in parallel and publishes them to a GitHub Release, along
with the `latest*.yml` metadata files that `electron-updater` reads.

Nothing else is required. Existing installs pick the update up within hours.

---

## The one hard requirement: code signing

**An unsigned macOS build can never auto-update.** Squirrel.Mac refuses to
replace an app whose signature it cannot verify. The app will see that a newer
version exists and will never be able to install it.

This is not a limitation you can configure around — it is enforced by macOS.

| Platform | Unsigned | Signed |
| --- | --- | --- |
| macOS | Will not launch on other machines; **cannot auto-update** | Full auto-update |
| Windows | Installs with a SmartScreen warning; auto-update works | No warning |
| Linux (AppImage) | Works | Works |

### Setting up macOS signing

1. Join the [Apple Developer Program](https://developer.apple.com/programs/) ($99/year).
2. Create a **Developer ID Application** certificate and export it as `.p12`.
3. Create an [app-specific password](https://appleid.apple.com) for notarisation.
4. Add these repository secrets in GitHub → Settings → Secrets → Actions:

   | Secret | Value |
   | --- | --- |
   | `MAC_CERT_P12` | base64 of your `.p12` — `base64 -i cert.p12 \| pbcopy` |
   | `MAC_CERT_PASSWORD` | the password you set when exporting |
   | `APPLE_ID` | your Apple ID email |
   | `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password from step 3 |
   | `APPLE_TEAM_ID` | ten-character Team ID from your developer account |

### Windows signing (optional)

Add `WIN_CERT_PFX` (base64 of your `.pfx`) and `WIN_CERT_PASSWORD`. Without
them installers still work, but users see a SmartScreen prompt on first run.

---

## Building locally

```bash
npm run dist:mac      # or dist:win / dist:linux
```

Local builds do **not** publish. To produce an unsigned build for testing:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac -c.mac.notarize=false
```

Output lands in `release/`.

---

## How the client side works

`src/main/updater.ts` owns this. It:

- refuses to check in development, or when the macOS app is running outside
  `/Applications` (Squirrel cannot update in place from elsewhere), and reports
  that state rather than failing silently
- checks 8 seconds after launch, then every 6 hours
- downloads automatically and installs on quit
- pushes every state change to the renderer over the `update:state` channel, so
  Settings and the status bar stay in sync

Version comparison is semver, driven entirely by `version` in `package.json`.
Never publish a tag whose version is not greater than the last one — clients
will not offer it.
