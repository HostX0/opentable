#!/usr/bin/env bash
# Reports whether this machine can produce a distributable, auto-updatable
# macOS build. Run: npm run check:signing
set -uo pipefail

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }

echo
echo "macOS release readiness"
echo

ready=0

# 1. Developer ID Application certificate — the one Gatekeeper accepts
if security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
  ok "Developer ID Application certificate"
  security find-identity -v -p codesigning | grep "Developer ID Application" \
    | sed 's/.*"\(.*\)"/    \1/'
else
  bad "No Developer ID Application certificate"
  info "You may have an 'Apple Development' cert — that one cannot be"
  info "distributed and cannot auto-update. Create the right one at:"
  info "https://developer.apple.com/account/resources/certificates/add"
  info "choosing 'Developer ID Application'."
  ready=1
fi

# 2. Notarisation credentials — either an API key or an Apple ID password
if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_ID:-}" && -n "${APPLE_API_ISSUER:-}" ]]; then
  ok "Notarisation via App Store Connect API key"
elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
  ok "Notarisation via Apple ID + app-specific password"
else
  bad "No notarisation credentials in the environment"
  info "Either set APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER,"
  info "or APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID."
  info "See docs/RELEASING.md."
  ready=1
fi

# 3. notarytool
if xcrun --find notarytool >/dev/null 2>&1; then
  ok "notarytool available"
else
  bad "notarytool missing — install Xcode or Command Line Tools 13+"
  ready=1
fi

echo
if [[ $ready -eq 0 ]]; then
  echo "  Ready. 'npm run dist:mac' will produce a signed, notarised build."
else
  echo "  Not ready yet — a build will still run, but unsigned, and unsigned"
  echo "  macOS builds cannot auto-update."
fi
echo
exit 0
