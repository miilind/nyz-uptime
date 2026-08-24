#!/usr/bin/env bash
# One-shot deploy: public repo + secrets + first run. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")"

echo "1/4 creating public repo miilind/nyz-uptime and pushing..."
if gh repo view miilind/nyz-uptime >/dev/null 2>&1; then
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/miilind/nyz-uptime.git"
  git push -u origin main
else
  gh repo create nyz-uptime --public --source=. --push
fi

echo "2/4 setting Telegram secrets from .env (values never printed)..."
grep '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2- | gh secret set TELEGRAM_BOT_TOKEN --repo miilind/nyz-uptime
grep '^TELEGRAM_CHAT_ID='   .env | cut -d= -f2- | gh secret set TELEGRAM_CHAT_ID   --repo miilind/nyz-uptime

echo "3/4 triggering the first cloud run..."
sleep 3
gh workflow run uptime --repo miilind/nyz-uptime 2>/dev/null || echo "  (push already triggered it)"

echo "4/4 latest runs:"
sleep 5
gh run list --repo miilind/nyz-uptime --limit 3 2>/dev/null || true

echo
echo "Done. Live board: https://github.com/miilind/nyz-uptime/blob/main/status.md"
