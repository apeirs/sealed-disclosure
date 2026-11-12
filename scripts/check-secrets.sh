#!/usr/bin/env bash
# Refuse to ship if a key, mnemonic or seal key could be in the tracked files or the build output.
#   scripts/check-secrets.sh [dist-dir] [--allow-demo-seal-key]
# Exit 1 on any hit; prints file names, never contents. The only seal key a build may carry is the
# throwaway testnet demo project's (dist/demo-project.sealkey.json), and only with --allow-demo-seal-key.
set -euo pipefail
cd "$(dirname "$0")/.."
dist="dist"
allow_demo=0
for a in "$@"; do
  case "$a" in
    --allow-demo-seal-key) allow_demo=1 ;;
    *) dist="$a" ;;
  esac
done
DEMO_PROJECT="qor1knxej2kffzpx9hcfjd54argxj72vs962nw60fg"
fail=0
bad() { echo "check-secrets: $*" >&2; fail=1; }

# 1. Nothing secret-looking is tracked by git.
if git rev-parse --git-dir >/dev/null 2>&1; then
  hits=$(git ls-files | grep -i -E '(^|/)(keys?/|\.env$|[^/]*\.mnemonic$|[^/]*\.sealkey|[^/]*\.key$|[^/]*\.pem$|secrets?(/|\.)|id_(rsa|ed25519))' | grep -v -x '\.env\.example' || true)
  [ -z "$hits" ] || bad "tracked secret-looking files: $hits"
  # A 12/24-word lowercase phrase or a seal-key seed in any tracked text file.
  phrase=$(git ls-files -z | xargs -0 grep -l -I -E '"seed"[[:space:]]*:[[:space:]]*"[0-9a-f]{64}"|^([a-z]{3,8} ){23}[a-z]{3,8}$' -- 2>/dev/null || true)
  [ -z "$phrase" ] || bad "tracked file holds a seed or a 24-word phrase: $phrase"
fi

# 2. The build output holds no key material, except the demo project's seal key when allowed.
if [ -d "$dist" ]; then
  for f in $(grep -r -l -E '"seed"[[:space:]]*:[[:space:]]*"[0-9a-f]{64}"' "$dist" || true); do
    if [ "$allow_demo" = 1 ] && [ "$f" = "$dist/demo-project.sealkey.json" ] && grep -q "\"address\": *\"$DEMO_PROJECT\"" "$f"; then
      echo "check-secrets: $f is the testnet demo project's seal key (allowed: decrypt-only, public by design)"
    else
      bad "seal-key seed in $f"
    fi
  done
  files=$(grep -r -l -E '\.mnemonic|BEGIN [A-Z ]*PRIVATE KEY|PRIVATE_KEY=|"([a-z]{3,8} ){11}[a-z]{3,8}"|"([a-z]{3,8} ){23}[a-z]{3,8}"' "$dist" || true)
  [ -z "$files" ] || bad "suspicious strings in $dist: $files"
  [ ! -e "$dist/.env" ] || bad "$dist/.env exists"
fi

[ "$fail" = 0 ] && echo "check-secrets: clean ($dist and tracked files)"
exit "$fail"
