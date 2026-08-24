# NYZ Uptime

Checks every NYZ Digitals client site every 5 minutes. Pings Telegram the moment one goes down,
and again when it comes back. Runs on GitHub Actions, so it works when your Mac is closed.

**Owned:** the site list, every check ever run, the up/down state. All plain files in this repo.
**Rented:** Telegram (a mouth) and GitHub Actions (a clock). Delete either tomorrow and no data is lost.

---

## What it watches for

| Signal | Behaviour |
|---|---|
| Site down | Alerts once, on the transition. No repeat spam while it stays down. |
| Site recovered | Alerts once, with how long it was out. |
| SSL cert expiring | Warns at 14 days, once a day. Catches the outage before it happens. |
| Whole host down | If everything fails at once, the alert says so instead of firing 17 pings. |
| Monitor itself dead | Daily 09:00 heartbeat. Silence is never ambiguous. |

A site is only called down after **3 failed attempts, 4 seconds apart**. Single blips don't page you.

---

## Setup (about 10 minutes, one time)

### 1. Telegram bot

1. Open Telegram, message **@BotFather**, send `/newbot`. Name it `NYZ Uptime`.
2. Copy the token it gives you (looks like `8123456789:AAH...`).
3. Message **@userinfobot** — it replies with your numeric chat ID.

Test it locally before going further:

```bash
cd "BUILD/uptime-monitor" && TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=yyy node notify.js
```

You should get a message. If not, send your bot any message first (`/start`) — Telegram won't
let a bot open a conversation.

### 2. Push this folder as its own GitHub repo

```bash
cd "BUILD/uptime-monitor" && git init -b main && git add -A && git commit -m "NYZ Uptime v1" && gh repo create nyz-uptime --public --source=. --push
```

**Make it public.** Not for openness — for cost. GitHub Actions is unlimited and free on public
repos; on a private repo, 288 runs a day blows through the 2,000 free minutes in under four days.
Nothing secret lives here: the domains are public records, and the Telegram token goes in
encrypted secrets, never in a file.

### 3. Add the secrets

In the repo: **Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the BotFather token |
| `TELEGRAM_CHAT_ID` | your numeric chat ID |

Optional, under the **Variables** tab: `NYZ_TZ` (default `America/Toronto`),
`NYZ_HEARTBEAT_HOUR` (default `9`, set `-1` to turn the daily ping off).

### 4. Confirm

**Actions → uptime → Run workflow.** Watch it go green, and check Telegram.
From then on it runs itself every 5 minutes.

---

## Day-to-day

**From Telegram:** send `/status` (or `/check`) to the bot. The next run — within
about 5 minutes — replies with the full board: every site up/down, response times,
and the certificates expiring soonest. It only answers your own chat; strangers who
find the bot get silence.


```bash
npm run dry       # check everything now, print results, send and save nothing
npm run status    # uptime table for the last 24h / 7d / 30d
npm run check     # a real run: alerts and records state
```

`status.md` in this repo is regenerated on every run — open it on GitHub for the live board.

### Adding or removing a site

Edit `sites.json`, commit, push. Per-site overrides:

```jsonc
{
  "domain": "example.ca",
  "label": "Example Client",
  "url": "https://example.ca/booking",  // check a specific page instead of the homepage
  "keyword": "Book an appointment",      // fail if the page loads but this text is gone
  "expect": [200, 301],                  // exact status codes to accept
  "enabled": false                       // pause without deleting the history
}
```

The `keyword` option is the one worth using on client sites — it catches a site that returns
HTTP 200 while showing a blank page or a database error, which is the failure mode a plain
ping misses.

---

## Notes and limits

- **Cron drift.** GitHub schedules are best-effort; under load a `*/5` job can land 5–15 minutes
  late. Detection is typically under 10 minutes, occasionally 20. If you ever need
  sub-minute detection, move `check.js` to Cloudflare Workers Cron — same code, `state.json`
  becomes a KV entry.
- **Commit noise.** Each run commits state and history. That's ~280 commits a day in this repo,
  by design — it's how the history stays owned rather than living in a vendor's dashboard.
  Halve it by changing the cron to `*/10`.
- **Blind spot.** The monitor checks from GitHub's US datacentres. It sees what a visitor sees
  over the public internet, not what's happening inside cPanel.
