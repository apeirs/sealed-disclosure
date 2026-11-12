#!/usr/bin/env bash
# Put the demo online as one Cloudflare Worker (static app + read-only chain gateway).
#   ./deploy.sh                      test, build, secret check, deploy to https://sealed-disclosure.<account>.workers.dev
#   ./deploy.sh --with-demo-key      also serve the testnet demo project's seal key, so visitors can open its inbox
#                                    with "Use the demo seal key" (needs public/demo-project.sealkey.json locally)
#                                    (the hosted demo at sealed-disclosure.apeir.workers.dev is deployed this way)
#   ./deploy.sh --dry-run            same checks, only bundles the Worker (no Cloudflare login, nothing uploaded)
# Login: `npx wrangler login` once, or export CLOUDFLARE_API_TOKEN (Workers Scripts: Edit) and CLOUDFLARE_ACCOUNT_ID.
set -euo pipefail
cd "$(dirname "$0")"
WRANGLER="npx --yes wrangler@4.160.0"

dry=0
demo=0
pass=()
for a in "$@"; do
  case "$a" in
    --dry-run) dry=1 ;;
    --with-demo-key) demo=1 ;;
    *) pass+=("$a") ;;
  esac
done

[ -d node_modules ] || npm ci --no-audit --no-fund
npm test
nice -n 19 npm run build
# Vite copies public/ into dist/. The demo seal key only ships when asked for.
if [ "$demo" = 1 ]; then
  [ -f dist/demo-project.sealkey.json ] || { echo "public/demo-project.sealkey.json is missing." >&2; exit 1; }
  scripts/check-secrets.sh dist --allow-demo-seal-key
else
  rm -f dist/demo-project.sealkey.json
  scripts/check-secrets.sh dist
fi

if [ "$dry" = 1 ]; then
  out=$(mktemp -d)
  $WRANGLER deploy --dry-run --outdir "$out" "${pass[@]}"
  echo "Dry run OK: Worker bundle in $out, assets from ./dist. Nothing was uploaded."
  exit 0
fi

if $WRANGLER whoami 2>&1 | grep -q -i 'not authenticated'; then
  echo "Not logged in to Cloudflare: run 'npx wrangler login' or export CLOUDFLARE_API_TOKEN." >&2
  exit 1
fi
$WRANGLER deploy "${pass[@]}"
