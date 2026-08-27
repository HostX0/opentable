# Releasing and auto-updates

OpenTable ships updates through **GitHub Releases**. Installed apps check that
feed 8 seconds after launch and every six hours, download in the background,
and install on next quit. Users can also check manually in **Settings**.

Check whether this machine can produce a distributable build at any time:

```bash
npm run check:signing
```

---

## First-time setup

A one-off checklist. Steps 2–4 need your Apple Developer account; everything
else is already in the repository.

### 1. Push to GitHub

Create a repository named `opentable` under your account, then:

```bash
git remote add origin https://github.com/mohammedkmo/opentable.git
git push -u origin main
```

The repository name must match `publish.repo` in `electron-builder.yml`.

### 2. Create a Developer ID Application certificate

See [One-time macOS setup](#one-time-macos-setup) below. This is the step that
makes macOS auto-update possible at all.

### 3. Create an App Store Connect API key

Also below. Export the three variables in your shell profile so local builds
can notarise.

### 4. Add the CI secrets

Under **Settings → Secrets and variables → Actions**, add the five macOS
secrets listed in [CI secrets](#ci-secrets).

### 5. Cut the first release

```bash
npm run check:signing        # should be all green
git tag v0.1.0
git push origin main --tags
```

Watch it build under the **Actions** tab. When it finishes, a GitHub Release
appears with installers for all three platforms plus the `latest*.yml` files
that make auto-update work.

> **Tip:** you can push a tag *before* sorting out certificates to prove the
> pipeline works end to end. Windows and Linux will build and auto-update
> normally; the macOS build will simply be unsigned, and CI will say so.

---

## Why macOS signing is not optional

**An unsigned macOS build can never auto-update.** Squirrel refuses to replace
an app whose signature it cannot verify. The app will see that a newer version
exists and will never be able to install it. This is enforced by macOS.

| Platform | Unsigned | Signed |
| --- | --- | --- |
| macOS | Won't open on other machines; **cannot auto-update** | Full auto-update |
| Windows | Installs with a SmartScreen warning; auto-update works | No warning |
| Linux (AppImage / deb) | Works | Works |

---

## One-time macOS setup

### 1. Create a Developer ID Application certificate

This is **not** the same as the "Apple Development" certificate Xcode creates
for you. Development certificates only run on your own registered devices and
are rejected by Gatekeeper everywhere else.

1. Go to [Certificates](https://developer.apple.com/account/resources/certificates/add).
2. Choose **Developer ID Application** (under *Software*), not *Apple Development*.
3. Follow the prompts to upload a Certificate Signing Request. To create one:
   *Keychain Access → Certificate Assistant → Request a Certificate From a
   Certificate Authority*, choose **Saved to disk**.
4. Download the resulting `.cer` and double-click to install it.

Only the Account Holder or an Admin on the team can create this. Verify:

```bash
npm run check:signing
```

### 2. Create an App Store Connect API key for notarisation

An API key is preferable to an Apple ID password: it is scoped, revocable, and
works identically on your machine and in CI.

1. Go to [Users and Access → Integrations → App Store Connect API](https://appstoreconnect.apple.com/access/integrations/api).
2. Create a key with the **Developer** role.
3. Download the `.p8` — **Apple lets you download it once.** Store it somewhere
   safe and outside the repository (`~/.appstoreconnect/private_keys/` is the
   conventional location).
4. Note the **Key ID** and the **Issuer ID** shown on that page.

Then set three variables in your shell profile:

```bash
export APPLE_API_KEY="$HOME/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

<details>
<summary>Alternative: Apple ID and an app-specific password</summary>

If you would rather not use an API key, create an
[app-specific password](https://appleid.apple.com) and set:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
```

This works, but the password is a full-account credential rather than a scoped
one — prefer the API key where you can.
</details>

Never commit any of this. `.gitignore` already excludes `*.p8`, `*.p12`,
`*.pfx` and `*.cer`, but the variables belong in your shell profile, not the
repository.

---

## Cutting a release

```bash
npm version patch     # or minor / major — creates the git tag
git push --follow-tags
```

Pushing the tag triggers `.github/workflows/release.yml`, which builds macOS,
Windows and Linux in parallel and publishes them to a GitHub Release together
with the `latest*.yml` metadata that `electron-updater` reads. Existing installs
pick it up within hours.

### CI secrets

Add these under **Settings → Secrets and variables → Actions**:

| Secret | How to produce it |
| --- | --- |
| `MAC_CERT_P12` | Export the Developer ID cert from Keychain Access as `.p12`, then `base64 -i cert.p12 \| pbcopy` |
| `MAC_CERT_PASSWORD` | The password you set during that export |
| `APPLE_API_KEY_P8` | `base64 -i AuthKey_XXXX.p8 \| pbcopy` |
| `APPLE_API_KEY_ID` | Key ID from App Store Connect |
| `APPLE_API_ISSUER` | Issuer ID from App Store Connect |
| `WIN_CERT_PFX` | *(optional)* base64 of a Windows `.pfx` |
| `WIN_CERT_PASSWORD` | *(optional)* its password |

`GITHUB_TOKEN` is provided automatically — you do not need to add it.

---

## Building locally

```bash
npm run check:signing      # confirm the machine is ready
npm run dist:mac           # signed + notarised, if credentials are present
npm run dist:mac:unsigned  # deliberately unsigned, for quick local testing
```

Notarisation adds a few minutes — Apple has to scan the build. Verify the
result before shipping:

```bash
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/OpenTable.app"
spctl --assess --type execute --verbose "release/mac-arm64/OpenTable.app"
xcrun stapler validate "release/mac-arm64/OpenTable.app"
```

`spctl` should say **accepted** with `source=Notarized Developer ID`.

---

## How the client side works

`src/main/updater.ts` owns this. It:

- refuses to check in development, or when the macOS app runs outside
  `/Applications` (Squirrel cannot update in place from elsewhere), and reports
  that as an `unsupported` state rather than failing silently
- checks 8 seconds after launch, then every 6 hours
- downloads automatically and installs on quit
- pushes every state change to the renderer over the `update:state` channel, so
  Settings stays in sync

Version comparison is semver, driven entirely by `version` in `package.json`.
Never publish a tag whose version is not greater than the last — clients will
not offer it.
