#!/usr/bin/env node
// NYZ Uptime — one pass over every site. Owned brain, rented muscle.
// Usage: node check.js            (checks, updates state, alerts on change)
//        node check.js --dry      (checks and prints, sends nothing, writes nothing)

import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { sendTelegram } from './notify.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry');
const TZ = process.env.NYZ_TZ || 'America/Toronto';
const HEARTBEAT_HOUR = Number(process.env.NYZ_HEARTBEAT_HOUR ?? 9);
const CONCURRENCY = Number(process.env.NYZ_CONCURRENCY ?? 8);
const UA = 'NYZ-Uptime/1.0 (+https://nyzdigitals.com; monitoring)';

const p = (...a) => path.join(ROOT, ...a);
const readJSON = (f, fb) => { try { return JSON.parse(fs.readFileSync(p(f), 'utf8')); } catch { return fb; } };
const now = () => new Date();
const iso = (d = now()) => d.toISOString();

const cfg = readJSON('sites.json', { defaults: {}, sites: [] });
const D = { timeoutMs: 15000, attempts: 3, attemptGapMs: 4000, expectBelow: 400, certWarnDays: 14, ...cfg.defaults };
const sites = cfg.sites.filter(s => s.enabled !== false);

const state = readJSON('state.json', {});

const sleep = ms => new Promise(r => setTimeout(r, ms));
const urlFor = s => s.url || `https://${s.domain}`;

function describeError(e) {
  const c = e?.cause?.code || e?.code;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `no response in ${D.timeoutMs / 1000}s`;
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'DNS lookup failed';
  if (c === 'ECONNREFUSED') return 'connection refused';
  if (c === 'ECONNRESET') return 'connection reset';
  if (c === 'CERT_HAS_EXPIRED') return 'SSL certificate expired';
  if (c === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'SSL certificate name mismatch';
  if (c === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || c === 'SELF_SIGNED_CERT_IN_CHAIN') return 'SSL certificate not trusted';
  return c || e?.message || 'unknown error';
}

async function attempt(site) {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), site.timeoutMs || D.timeoutMs);
  try {
    const res = await fetch(urlFor(site), {
      method: 'GET', redirect: 'follow', signal: ac.signal,
      headers: { 'user-agent': UA, 'accept': 'text/html,*/*' },
    });
    const ms = Date.now() - t0;
    const expected = site.expect
      ? site.expect.includes(res.status)
      : res.status < (site.expectBelow || D.expectBelow);
    if (!expected) return { ok: false, status: res.status, ms, reason: `HTTP ${res.status}` };
    if (site.keyword) {
      const body = await res.text();
      if (!body.includes(site.keyword)) {
        return { ok: false, status: res.status, ms, reason: `page loaded but "${site.keyword}" missing` };
      }
    }
    return { ok: true, status: res.status, ms };
  } catch (e) {
    return { ok: false, status: null, ms: Date.now() - t0, reason: describeError(e) };
  } finally {
    clearTimeout(timer);
  }
}

// A site is only called down after every attempt fails — filters transient blips.
async function checkSite(site) {
  const tries = site.attempts || D.attempts;
  let last;
  for (let i = 0; i < tries; i++) {
    last = await attempt(site);
    if (last.ok) return { ...last, attempts: i + 1 };
    if (i < tries - 1) await sleep(site.attemptGapMs || D.attemptGapMs);
  }
  return { ...last, attempts: tries };
}

function certInfo(hostname, timeout = 10000) {
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    try {
      const socket = tls.connect(
        { host: hostname, port: 443, servername: hostname, rejectUnauthorized: false },
        () => {
          const c = socket.getPeerCertificate();
          socket.end();
          if (!c || !c.valid_to) return finish(null);
          const expires = new Date(c.valid_to);
          if (isNaN(expires)) return finish(null);
          finish({
            expires: expires.toISOString(),
            daysLeft: Math.floor((expires.getTime() - Date.now()) / 86400000),
            issuer: c.issuer?.O || null,
          });
        }
      );
      socket.setTimeout(timeout, () => { socket.destroy(); finish(null); });
      socket.on('error', () => finish(null));
    } catch { finish(null); }
  });
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); }
  }));
  return out;
}

const fmtDur = ms => {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};
const localTime = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric', hour12: false,
}).format(now());
const localHour = () => Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: '2-digit', hour12: false }).format(now()));

// ---- /status command support ----
// The bot listens by polling: each run consumes pending Telegram messages.
// A /status or /check from the owner chat gets a full report on this run.
async function pendingStatusRequest() {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;
  const offFile = p('.tg-offset');
  const offset = fs.existsSync(offFile) ? Number(fs.readFileSync(offFile, 'utf8').trim()) || 0 : 0;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=0`, { signal: AbortSignal.timeout(10000) });
    const j = await res.json();
    if (!j.ok || !j.result.length) return false;
    const last = j.result[j.result.length - 1].update_id;
    if (!DRY) fs.writeFileSync(offFile, String(last + 1));
    return j.result.some(u =>
      u.message && String(u.message.chat?.id) === String(chatId) &&
      /^\/(status|check)\b/.test(u.message.text || ''));
  } catch { return false; }
}

// ---- run ----
const runAt = iso();
const results = await pool(sites, CONCURRENCY, checkSite);

const wentDown = [], cameUp = [], stillDown = [], certWarn = [];

for (let i = 0; i < sites.length; i++) {
  const site = sites[i], r = results[i];
  const prev = state[site.domain] || { status: 'unknown', since: runAt, notified: false };
  const next = {
    label: site.label || site.domain,
    status: r.ok ? 'up' : 'down',
    since: prev.status === (r.ok ? 'up' : 'down') ? prev.since : runAt,
    lastCheck: runAt,
    lastStatus: r.status,
    lastMs: r.ms,
    reason: r.ok ? null : r.reason,
    lastOk: r.ok ? runAt : prev.lastOk || null,
    cert: prev.cert || null,
    certCheckedAt: prev.certCheckedAt || null,
    certNotifiedAt: prev.certNotifiedAt || null,
  };

  if (!r.ok && prev.status !== 'down') wentDown.push({ site, r, next });
  else if (!r.ok) stillDown.push({ site, r, next });
  else if (r.ok && prev.status === 'down') cameUp.push({ site, r, next, downFor: Date.parse(runAt) - Date.parse(prev.since) });

  state[site.domain] = next;
}

// Certificates: check each site once a day, warn once a day while inside the window.
const certTargets = sites.filter((s, i) =>
  results[i].ok &&
  urlFor(s).startsWith('https://') &&
  (!state[s.domain].certCheckedAt || Date.now() - Date.parse(state[s.domain].certCheckedAt) > 20 * 3600 * 1000)
);
const certs = await pool(certTargets, CONCURRENCY, s => certInfo(s.domain));
certTargets.forEach((s, i) => {
  const st = state[s.domain];
  st.certCheckedAt = runAt;
  if (!certs[i]) return;
  st.cert = certs[i];
  const warnAt = s.certWarnDays || D.certWarnDays;
  const notifiedRecently = st.certNotifiedAt && Date.now() - Date.parse(st.certNotifiedAt) < 20 * 3600 * 1000;
  if (certs[i].daysLeft <= warnAt && !notifiedRecently) {
    certWarn.push({ site: s, cert: certs[i] });
    st.certNotifiedAt = runAt;
  }
});

// Answer a pending /status request with the full board.
const statusRequested = await pendingStatusRequest();

// ---- message ----
const lines = [];
if (wentDown.length) {
  lines.push(`🔴 <b>DOWN — ${wentDown.length} site${wentDown.length > 1 ? 's' : ''}</b>`);
  for (const { site, r } of wentDown) lines.push(`• <b>${site.domain}</b> — ${r.reason}`);
  if (wentDown.length >= 3 && wentDown.length === sites.length - stillDown.length - cameUp.length) {
    lines.push(`\n⚠️ Everything failed at once — likely the host or your connection, not the sites.`);
  }
}
if (cameUp.length) {
  if (lines.length) lines.push('');
  lines.push(`🟢 <b>BACK UP — ${cameUp.length} site${cameUp.length > 1 ? 's' : ''}</b>`);
  for (const { site, r, downFor } of cameUp) lines.push(`• <b>${site.domain}</b> — down ${fmtDur(downFor)} · HTTP ${r.status} in ${r.ms}ms`);
}
if (certWarn.length) {
  if (lines.length) lines.push('');
  lines.push(`⚠️ <b>SSL expiring</b>`);
  for (const { site, cert } of certWarn) lines.push(`• <b>${site.domain}</b> — ${cert.daysLeft} day${cert.daysLeft === 1 ? '' : 's'} left`);
}

if (statusRequested) {
  const down = sites.filter(s => state[s.domain].status === 'down');
  const certSoon = sites
    .map(s => ({ d: s.domain, c: state[s.domain].cert }))
    .filter(x => x.c).sort((a, b) => a.c.daysLeft - b.c.daysLeft).slice(0, 3);
  if (lines.length) lines.push('');
  lines.push(`📊 <b>Status — ${sites.length - down.length}/${sites.length} up</b>`);
  for (const s of sites) {
    const st = state[s.domain];
    lines.push(st.status === 'down'
      ? `🔴 <b>${s.domain}</b> — ${st.reason} (since ${fmtDur(Date.parse(runAt) - Date.parse(st.since))} ago)`
      : `🟢 ${s.domain} — ${st.lastMs}ms`);
  }
  if (certSoon.length) lines.push(`\nSSL soonest: ${certSoon.map(x => `${x.d} ${x.c.daysLeft}d`).join(' · ')}`);
}

// Daily heartbeat so silence is never ambiguous.
let heartbeat = false;
const hbFile = p('.heartbeat');
if (HEARTBEAT_HOUR >= 0 && localHour() === HEARTBEAT_HOUR) {
  const lastHb = fs.existsSync(hbFile) ? fs.readFileSync(hbFile, 'utf8').trim() : '';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, dateStyle: 'short' }).format(now());
  if (lastHb !== today) {
    heartbeat = true;
    const down = sites.filter(s => state[s.domain].status === 'down');
    if (lines.length) lines.push('');
    lines.push(down.length
      ? `📋 <b>Daily check</b> — ${sites.length - down.length}/${sites.length} up. Still down: ${down.map(s => s.domain).join(', ')}`
      : `📋 <b>Daily check</b> — all ${sites.length} sites up.`);
    if (!DRY) fs.writeFileSync(hbFile, today);
  }
}

if (lines.length) lines.push(`\n<i>${localTime()} · NYZ Uptime</i>`);

// ---- persist ----
if (!DRY) {
  fs.writeFileSync(p('state.json'), JSON.stringify(state, null, 2) + '\n');
  const month = runAt.slice(0, 7);
  const row = { t: runAt, ms: {}, down: {} };
  sites.forEach((s, i) => {
    if (results[i].ok) row.ms[s.domain] = results[i].ms;
    else row.down[s.domain] = results[i].reason;
  });
  fs.mkdirSync(p('history'), { recursive: true });
  fs.appendFileSync(p('history', `${month}.jsonl`), JSON.stringify(row) + '\n');
}

// ---- report ----
const downNow = sites.filter(s => state[s.domain].status === 'down');
console.log(`[${runAt}] ${sites.length - downNow.length}/${sites.length} up` +
  (downNow.length ? ` · DOWN: ${downNow.map(s => `${s.domain} (${state[s.domain].reason})`).join(', ')}` : ''));
if (DRY) {
  sites.forEach((s, i) => {
    const r = results[i];
    console.log(`  ${r.ok ? '✓' : '✗'} ${s.domain.padEnd(30)} ${r.ok ? `${r.status} ${r.ms}ms` : r.reason}`);
  });
}

if (lines.length) {
  const msg = lines.join('\n');
  if (DRY) { console.log('\n--- telegram (dry run) ---\n' + msg.replace(/<[^>]+>/g, '')); }
  else await sendTelegram(msg);
}

// Exit non-zero only for a genuinely new outage, so the Actions run is visibly red.
process.exit(wentDown.length ? 1 : 0);
