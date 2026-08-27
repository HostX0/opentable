#!/usr/bin/env bash
#
# Download and active-install statistics from the GitHub Releases API.
#
# GitHub reports cumulative counts only, with no history, so each run appends a
# dated snapshot to .stats-history.json (gitignored) and reports the delta
# since the previous run. Run it daily to build a real time series.
#
# Usage: npm run stats
set -euo pipefail
REPO=${REPO:-mohammedkmo/OpenTable}
HIST=${HIST:-.stats-history.json}

command -v gh >/dev/null || { echo "needs the gh CLI: brew install gh && gh auth login"; exit 1; }

gh api "repos/$REPO/releases" --paginate > /tmp/ot-releases.json

python3 - "$HIST" << 'PY'
import json, sys, os, datetime

hist_path = sys.argv[1]
releases = json.load(open('/tmp/ot-releases.json'))

INSTALLER = ('.dmg', '.exe', '.AppImage', '.deb')
def platform(name):
    if name.endswith('.dmg'): return 'macOS'
    if name.endswith('.exe'): return 'Windows'
    if name.endswith(('.AppImage', '.deb')): return 'Linux'
    return None

totals, per_platform, checks = 0, {}, 0
print(f"{'release':<12} {'installers':>11} {'update checks':>14}")
print('-' * 39)
for r in sorted(releases, key=lambda x: x['tag_name']):
    if r['draft']:
        continue
    inst = sum(a['download_count'] for a in r['assets'] if a['name'].endswith(INSTALLER))
    yml  = sum(a['download_count'] for a in r['assets'] if a['name'].endswith('.yml'))
    for a in r['assets']:
        p = platform(a['name'])
        if p:
            per_platform[p] = per_platform.get(p, 0) + a['download_count']
    totals += inst
    checks += yml
    print(f"{r['tag_name']:<12} {inst:>11} {yml:>14}")

print('-' * 39)
print(f"{'total':<12} {totals:>11} {checks:>14}")
print()
for p, n in sorted(per_platform.items(), key=lambda kv: -kv[1]):
    share = (n / totals * 100) if totals else 0
    print(f"  {p:<9} {n:>6}  {share:5.1f}%")

# delta since the last snapshot
today = datetime.date.today().isoformat()
hist = json.load(open(hist_path)) if os.path.exists(hist_path) else []
if hist:
    prev = hist[-1]
    days = (datetime.date.fromisoformat(today) - datetime.date.fromisoformat(prev['date'])).days or 1
    d_inst = totals - prev['installers']
    d_chk  = checks - prev['checks']
    print()
    print(f"  since {prev['date']} ({days}d): +{d_inst} installs, +{d_chk} update checks")
    # each running install checks on launch and every 6h, so ~5 checks/day
    if d_chk > 0:
        print(f"  rough active installs: ~{round(d_chk / days / 5)}")
        print("  (update checks / 5 per day — indicative only, not a real metric)")
else:
    print("\n  first run — no baseline yet. Run again tomorrow for deltas.")

hist.append({'date': today, 'installers': totals, 'checks': checks})
json.dump(hist, open(hist_path, 'w'), indent=2)
PY
