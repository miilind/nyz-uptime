// Telegram is a mouth. Nothing is stored here — state lives in state.json, which we own.
const API = 'https://api.telegram.org';

export async function sendTelegram(html) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('! TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — alert not sent:\n' + html.replace(/<[^>]+>/g, ''));
    return false;
  }
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${API}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: html,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) { console.log('→ telegram sent'); return true; }
      console.error(`! telegram ${res.status}: ${body.description || 'unknown'}`);
    } catch (e) {
      console.error('! telegram error: ' + (e?.message || e));
    }
    if (i < 2) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
  }
  return false;
}

// node notify.js "test message"  → verifies token + chat id end to end
if (process.argv[1] && process.argv[1].endsWith('notify.js')) {
  const text = process.argv.slice(2).join(' ') || '✅ NYZ Uptime — test alert. Wiring works.';
  const ok = await sendTelegram(text);
  process.exit(ok ? 0 : 1);
}
