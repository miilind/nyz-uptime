#!/usr/bin/env bash
# Paste your Telegram bot token here, not into the chat. It goes straight to .env (chmod 600).
set -euo pipefail
cd "$(dirname "$0")"

echo "NYZ Uptime — Telegram setup"
echo

read -rsp "Bot token from @BotFather: " TOKEN; echo
[ -z "$TOKEN" ] && { echo "No token entered. Aborted."; exit 1; }

echo "Verifying token..."
NAME=$(curl -s --max-time 15 "https://api.telegram.org/bot${TOKEN}/getMe" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d||"{}");if(!j.ok){console.error("REJECTED: "+(j.description||"unknown"));process.exit(1)}console.log("@"+j.result.username)})') \
  || { echo "Token rejected by Telegram. Check you copied the whole thing."; exit 1; }
echo "  ✓ token valid — bot is $NAME"

echo
echo "Now open Telegram, find $NAME, and press START (or send it any message)."
echo "A bot cannot message you until you speak to it first."
read -rp "Done? Press Enter to auto-detect your chat ID: "

CHAT=$(curl -s --max-time 15 "https://api.telegram.org/bot${TOKEN}/getUpdates" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d||"{}");const u=(j.result||[]).filter(x=>x.message&&x.message.chat);if(!u.length){process.exit(1)}const c=u[u.length-1].message.chat;console.log(c.id)})') \
  || { read -rp "Could not auto-detect. Paste your chat ID (from @userinfobot): " CHAT; }
echo "  ✓ chat id: $CHAT"

umask 077
cat > .env <<ENVEOF
TELEGRAM_BOT_TOKEN=$TOKEN
TELEGRAM_CHAT_ID=$CHAT
NYZ_TZ=America/Toronto
NYZ_HEARTBEAT_HOUR=9
ENVEOF
chmod 600 .env
echo "  ✓ wrote .env (chmod 600, gitignored)"

echo
echo "Sending a test alert..."
TELEGRAM_BOT_TOKEN="$TOKEN" TELEGRAM_CHAT_ID="$CHAT" node notify.js "✅ <b>NYZ Uptime</b> — wiring works. You'll get an alert here the moment a client site goes down."

echo
echo "Done. Next:  set -a; . ./.env; set +a; npm run check"
echo "For GitHub Actions, push the token into secrets WITHOUT it touching your shell history:"
echo "  gh secret set TELEGRAM_BOT_TOKEN   # paste when prompted"
echo "  gh secret set TELEGRAM_CHAT_ID     # paste $CHAT"
