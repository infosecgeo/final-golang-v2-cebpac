/**
 * Pusa Pacific – Telegram Notification Bot
 *
 * Communicates with the Go backend via:
 *   - Authenticated REST API  (PUSA_API_URL / PUSA_API_KEY)
 *   - Webhook receiver        (listens for push notifications from Go)
 *
 * Required environment variables (set in .env or the process environment):
 *   BOT_TOKEN          – Telegram bot token from @BotFather
 *   ADMIN_CHAT_ID      – Telegram chat/group ID for admin alerts
 *   PUSA_API_URL       – Base URL of the Go backend   (e.g. http://localhost:5000)
 *   PUSA_API_KEY       – Shared secret used as X-Bot-Key header
 *   WEBHOOK_PORT       – Port this process listens on for push events (default 5100)
 *   WEBHOOK_SECRET     – Secret the Go backend must send as X-Webhook-Secret header
 */

'use strict';

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const express     = require('express');
const crypto      = require('crypto');

// ── Config ────────────────────────────────────────────────────────────────────

const BOT_TOKEN      = process.env.BOT_TOKEN       || '';
const ADMIN_CHAT_ID  = process.env.ADMIN_CHAT_ID   || '';
const API_URL        = (process.env.PUSA_API_URL   || 'http://localhost:5000').replace(/\/$/, '');
const API_KEY        = process.env.PUSA_API_KEY     || '';
const WEBHOOK_PORT   = parseInt(process.env.WEBHOOK_PORT || '5100', 10);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET   || '';

if (!BOT_TOKEN) { console.error('[FATAL] BOT_TOKEN is required.'); process.exit(1); }

// ── Bot ────────────────────────────────────────────────────────────────────────

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log('[INFO] Telegram bot started (polling).');

// ── Helpers ────────────────────────────────────────────────────────────────────

function escMd(str) {
  if (!str) return '';
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }); }
  catch (_) { return iso; }
}

async function apiGet(path) {
  const r = await axios.get(`${API_URL}${path}`, {
    headers: { 'X-Bot-Key': API_KEY },
    timeout: 8000,
  });
  return r.data;
}

async function sendAlert(text, chatId) {
  const target = chatId || ADMIN_CHAT_ID;
  if (!target) return;
  try {
    await bot.sendMessage(target, text, { parse_mode: 'MarkdownV2' });
  } catch (e) {
    console.error('[ERROR] sendAlert failed:', e.message);
  }
}

// ── Webhook receiver (for push events from Go backend) ─────────────────────────

const app = express();
app.use(express.json());

function verifyWebhook(req, res, next) {
  const secret = req.headers['x-webhook-secret'] || '';
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/**
 * POST /webhook/event
 * Body: { type, payload }
 *
 * Supported event types:
 *   payment_success  – payment authorized
 *   payment_failure  – payment declined
 *   credit_low       – license credits below threshold
 *   maintenance_on   – maintenance mode enabled
 *   maintenance_off  – maintenance mode disabled
 *   admin_alert      – arbitrary admin broadcast
 *   new_session      – new user session started
 */
app.post('/webhook/event', verifyWebhook, async (req, res) => {
  const { type, payload } = req.body || {};
  res.json({ ok: true });          // respond immediately

  try {
    switch (type) {

      case 'payment_success': {
        const p = payload || {};
        const msg = [
          `✅ *Payment Authorized*`,
          ``,
          `🎫 *Record Locator:* \`${escMd(p.recordLocator || 'N/A')}\``,
          `👤 *Passenger:* ${escMd(p.passengerName || 'N/A')}`,
          `✈️ *Flight:* ${escMd(p.flightRoute || 'N/A')} ${escMd(p.flightNumber ? '('+p.flightNumber+')' : '')}`,
          `💳 *Card:* \`${escMd(p.maskedCard || 'N/A')}\``,
          `📋 *Booking:* ${escMd(p.bookingStatus || 'N/A')}`,
          `💰 *Payment:* ${escMd(p.paymentStatus || 'Authorized')}`,
          `🕐 *Time:* ${escMd(fmtDate(p.authTime))}`,
          ``,
          `🔑 *License:* \`${escMd(p.licenseKey || 'N/A')}\`  Credits remaining: *${escMd(String(p.creditsRemaining ?? '?'))}*`,
        ].join('\n');
        await sendAlert(msg);
        break;
      }

      case 'payment_failure': {
        const p = payload || {};
        const msg = [
          `❌ *Payment Declined*`,
          ``,
          `💳 *Card:* \`${escMd(p.maskedCard || 'N/A')}\``,
          `📝 *Reason:* ${escMd(p.reason || 'Unknown')}`,
          `🕐 *Time:* ${escMd(fmtDate(p.time))}`,
          `🔑 *License:* \`${escMd(p.licenseKey || 'N/A')}\``,
        ].join('\n');
        await sendAlert(msg);
        break;
      }

      case 'credit_low': {
        const p = payload || {};
        const msg = [
          `⚠️ *Low Credits Alert*`,
          ``,
          `🔑 License \`${escMd(p.licenseKey)}\` has only *${escMd(String(p.credits))}* credit\\(s\\) remaining\\.`,
        ].join('\n');
        await sendAlert(msg);
        break;
      }

      case 'maintenance_on': {
        await sendAlert(`🔧 *Maintenance Mode Enabled*\n\nAll users have been blocked from accessing the system\\.`);
        break;
      }

      case 'maintenance_off': {
        await sendAlert(`✅ *Maintenance Mode Disabled*\n\nSystem is back online\\.`);
        break;
      }

      case 'admin_alert': {
        const p = payload || {};
        await sendAlert(`📢 *Admin Alert*\n\n${escMd(p.message || '')}`, p.chatId || ADMIN_CHAT_ID);
        break;
      }

      case 'new_session': {
        const p = payload || {};
        const msg = [
          `🔐 *New Session*`,
          ``,
          `🔑 License: \`${escMd(p.licenseKey || 'N/A')}\``,
          `🌐 IP: \`${escMd(p.ip || 'N/A')}\``,
          `🕐 Time: ${escMd(fmtDate(p.time))}`,
        ].join('\n');
        await sendAlert(msg);
        break;
      }

      default:
        console.warn('[WARN] Unknown event type:', type);
    }
  } catch (e) {
    console.error('[ERROR] Webhook handler error:', e.message);
  }
});

// Health check
app.get('/health', (_req, res) => res.json({ ok: true, bot: 'pusa-pacific', uptime: process.uptime() }));

app.listen(WEBHOOK_PORT, () => {
  console.log(`[INFO] Webhook server listening on port ${WEBHOOK_PORT}`);
});

// ── Bot Commands ───────────────────────────────────────────────────────────────

bot.setMyCommands([
  { command: 'start',      description: 'Show welcome message' },
  { command: 'status',     description: 'System status' },
  { command: 'credits',    description: 'Check credits for a license — /credits LIC-xxx' },
  { command: 'stats',      description: 'Transaction statistics' },
  { command: 'maintenance',description: 'Toggle maintenance mode — /maintenance on|off' },
  { command: 'broadcast',  description: 'Broadcast a message to all admins — /broadcast message' },
  { command: 'help',       description: 'Show help' },
]);

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `✈️ *Pusa Pacific Bot*\n\nUse /help to see available commands\\.`,
    { parse_mode: 'MarkdownV2' }
  );
});

bot.onText(/\/help/, async (msg) => {
  const text = [
    `✈️ *Pusa Pacific Bot \\— Commands*`,
    ``,
    `/status \\— System health status`,
    `/credits \\<key\\> \\— Check credits for a license`,
    `/stats \\— Transaction stats`,
    `/maintenance on\\|off \\— Toggle maintenance mode`,
    `/broadcast \\<msg\\> \\— Send message to admin channel`,
    `/help \\— This message`,
  ].join('\n');
  await bot.sendMessage(msg.chat.id, text, { parse_mode: 'MarkdownV2' });
});

bot.onText(/\/status/, async (msg) => {
  try {
    const data = await apiGet('/api/admin/stats');
    const text = [
      `📊 *System Status*`,
      ``,
      `👥 Active Sessions: *${escMd(String(data.activeSessions ?? '?'))}*`,
      `🎫 Total Licenses: *${escMd(String(data.totalLicenses ?? '?'))}*`,
      `✅ Successful Txns: *${escMd(String(data.successfulTransactions ?? '?'))}*`,
      `❌ Failed Txns: *${escMd(String(data.failedTransactions ?? '?'))}*`,
      `🔧 Maintenance: *${data.maintenanceMode ? 'ON' : 'OFF'}*`,
    ].join('\n');
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'MarkdownV2' });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Failed to fetch status: ${escMd(e.message)}`, { parse_mode: 'MarkdownV2' });
  }
});

bot.onText(/\/credits (.+)/, async (msg, match) => {
  const key = (match[1] || '').trim();
  if (!key) { await bot.sendMessage(msg.chat.id, 'Usage: /credits LIC\\-xxx', { parse_mode: 'MarkdownV2' }); return; }
  try {
    const data = await apiGet(`/api/admin/licenses`);
    const lic = (data || []).find(l => l.licenseKey === key);
    if (!lic) { await bot.sendMessage(msg.chat.id, `❌ License not found\\.`, { parse_mode: 'MarkdownV2' }); return; }
    const text = [
      `💳 *License Info*`,
      ``,
      `🔑 Key: \`${escMd(lic.licenseKey)}\``,
      `💰 Credits: *${escMd(String(lic.credits))}*`,
      `📋 Status: *${escMd(lic.active ? 'Active' : 'Inactive')}*`,
      `📅 Expires: *${escMd(lic.expiresAt ? fmtDate(lic.expiresAt) : 'Never')}*`,
    ].join('\n');
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'MarkdownV2' });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${escMd(e.message)}`, { parse_mode: 'MarkdownV2' });
  }
});

bot.onText(/\/stats/, async (msg) => {
  try {
    const data = await apiGet('/api/admin/stats');
    const text = [
      `📈 *Transaction Stats*`,
      ``,
      `✅ Success: *${escMd(String(data.successfulTransactions ?? 0))}*`,
      `❌ Failed: *${escMd(String(data.failedTransactions ?? 0))}*`,
      `👥 Sessions: *${escMd(String(data.activeSessions ?? 0))}*`,
    ].join('\n');
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'MarkdownV2' });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${escMd(e.message)}`, { parse_mode: 'MarkdownV2' });
  }
});

bot.onText(/\/maintenance (.+)/, async (msg, match) => {
  const arg = (match[1] || '').trim().toLowerCase();
  if (arg !== 'on' && arg !== 'off') {
    await bot.sendMessage(msg.chat.id, 'Usage: /maintenance on\\|off', { parse_mode: 'MarkdownV2' }); return;
  }
  try {
    await axios.post(`${API_URL}/api/admin/maintenance`, { enabled: arg === 'on' }, {
      headers: { 'X-Bot-Key': API_KEY, 'Content-Type': 'application/json' },
      timeout: 8000,
    });
    await bot.sendMessage(msg.chat.id,
      `🔧 Maintenance mode turned *${escMd(arg.toUpperCase())}*`,
      { parse_mode: 'MarkdownV2' }
    );
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${escMd(e.message)}`, { parse_mode: 'MarkdownV2' });
  }
});

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  const text = (match[1] || '').trim();
  if (!text) { await bot.sendMessage(msg.chat.id, 'Usage: /broadcast message'); return; }
  await sendAlert(`📢 *Broadcast*\n\n${escMd(text)}`);
  await bot.sendMessage(msg.chat.id, '✅ Broadcast sent\\.', { parse_mode: 'MarkdownV2' });
});

bot.on('polling_error', (err) => {
  console.error('[ERROR] Polling error:', err.message);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  console.log('[INFO] Shutting down bot...');
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[INFO] Shutting down bot...');
  bot.stopPolling();
  process.exit(0);
});
