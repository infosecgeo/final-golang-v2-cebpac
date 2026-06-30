/**
 * AnasFlightsV2 – Telegram Bot
 *
 * Communicates with the Go backend via:
 *   - Authenticated REST API  (API_URL / API_KEY)
 *   - Webhook receiver        (listens for push notifications from Go)
 *
 * Required environment variables (set in .env or the process environment):
 *   BOT_TOKEN          – Telegram bot token from @BotFather
 *   ADMIN_CHAT_ID      – Telegram chat/group ID for admin alerts
 *   API_URL            – Base URL of the Go backend   (e.g. http://localhost:5000)
 *   API_KEY            – Shared secret used as X-Bot-Key header
 *   WEBHOOK_PORT       – Port this process listens on for push events (default 5100)
 *   WEBHOOK_SECRET     – Secret the Go backend must send as X-Webhook-Secret header
 *   ADMIN_IDS          – Comma-separated whitelisted Telegram user IDs for /admin_help
 *   PAYMENT_GROUP_ID   – Private group chat ID for forwarding payment requests
 *   QR_CODE_PATH       – Absolute path to the QR code image file for payments
 */

'use strict';

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const express     = require('express');
const fs          = require('fs');
const path        = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const BOT_TOKEN          = process.env.BOT_TOKEN           || '';
const ADMIN_CHAT_ID      = process.env.ADMIN_CHAT_ID       || '';
const API_URL            = (process.env.API_URL || process.env.PUSA_API_URL || 'http://localhost:5000').replace(/\/$/, '');
const API_KEY            = process.env.API_KEY  || process.env.PUSA_API_KEY || '';
const WEBHOOK_PORT       = parseInt(process.env.WEBHOOK_PORT   || '5100', 10);
const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET          || '';
const PAYMENT_GROUP_ID   = process.env.PAYMENT_GROUP_ID        || '';
const QR_CODE_PATH       = process.env.QR_CODE_PATH            || '';

// Warn if legacy env vars are in use
if (!process.env.API_URL && process.env.PUSA_API_URL) {
  console.warn('[WARN] PUSA_API_URL is deprecated. Please rename it to API_URL in your .env file.');
}
if (!process.env.API_KEY && process.env.PUSA_API_KEY) {
  console.warn('[WARN] PUSA_API_KEY is deprecated. Please rename it to API_KEY in your .env file.');
}

// Whitelisted admin Telegram user IDs (numeric strings)
const ADMIN_IDS = new Set(
  (process.env.ADMIN_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

if (!BOT_TOKEN) { console.error('[FATAL] BOT_TOKEN is required.'); process.exit(1); }

// ── Bot ────────────────────────────────────────────────────────────────────────

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log('[INFO] AnasFlightsV2 Telegram bot started (polling).');

// ── In-memory conversation state ───────────────────────────────────────────────

// userId → { pricePerCredit }  (user accepted T&C, waiting to enter credit count)
const awaitingCreditCount = new Map();

// userId → { credits, amountPHP }  (waiting for license key after credit count entered)
const awaitingLicenseKey = new Map();

// userId → { credits, amountPHP, licenseKey }  (waiting for proof-of-payment photo)
const awaitingReceipt = new Map();

// requestId (number) → { chatId, userId, credits, amountPHP, licenseKey, username }
const pendingApprovals = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────────

function isAdmin(userId) {
  return ADMIN_IDS.has(String(userId));
}

function escMd(str) {
  if (!str) return '';
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }); }
  catch (_) { return iso; }
}

function fmtPHP(amount) {
  return '₱' + Number(amount).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

async function apiGet(path) {
  const r = await axios.get(`${API_URL}${path}`, {
    headers: { 'X-Bot-Key': API_KEY },
    timeout: 8000,
  });
  return r.data;
}

async function apiPost(path, data) {
  const r = await axios.post(`${API_URL}${path}`, data, {
    headers: { 'X-Bot-Key': API_KEY, 'Content-Type': 'application/json' },
    timeout: 8000,
  });
  return r.data;
}

async function apiPut(path, data) {
  const r = await axios.put(`${API_URL}${path}`, data, {
    headers: { 'X-Bot-Key': API_KEY, 'Content-Type': 'application/json' },
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

async function registerSubscriber(msg) {
  if (!msg || !msg.from) return;
  try {
    await apiPost('/api/bot/subscribers', {
      telegramUserId: String(msg.from.id),
      username: msg.from.username || msg.from.first_name || '',
      chatId: String(msg.chat.id),
    });
  } catch (e) {
    console.warn('[WARN] registerSubscriber:', e.message);
  }
}

function buildTCMessage() {
  return [
    `📋 *Terms \\& Conditions*`,
    ``,
    `Before proceeding, please read and accept the following terms:`,
    ``,
    `• Credits are *NON\\-REFUNDABLE* once payment is confirmed`,
    `• Credits are consumed per successful booking transaction`,
    `• Keep your license key private and secure`,
    `• Service availability is subject to maintenance windows`,
    `• Payment must match the exact amount requested`,
    ``,
    `Do you agree to these Terms \\& Conditions?`,
  ].join('\n');
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

app.post('/webhook/event', verifyWebhook, async (req, res) => {
  const { type, payload } = req.body || {};
  res.json({ ok: true });

  try {
    switch (type) {

      case 'payment_success': {
        const p = payload || {};
        const msg = [
          `✅ *Payment Authorized*`,
          ``,
          `🎫 *Record Locator:* \`${escMd(p.recordLocator || 'N/A')}\``,
          `👤 *Passenger:* ${escMd(p.passengerName || 'N/A')}`,
          `✈️ *Flight:* ${escMd(p.flightRoute || 'N/A')} ${escMd(p.flightNumber ? '(' + p.flightNumber + ')' : '')}`,
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

      case 'maintenance_on':
        await sendAlert(`🔧 *Maintenance Mode Enabled*\n\nAll users have been blocked from accessing the system\\.`);
        break;

      case 'maintenance_off':
        await sendAlert(`✅ *Maintenance Mode Disabled*\n\nSystem is back online\\.`);
        break;

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

      case 'price_update': {
        const packages = Array.isArray(payload) ? payload : [];
        if (packages.length === 0) break;
        const lines = [
          `💰 *AnasFlightsV2 — Updated Credit Prices*`,
          ``,
          ...packages.filter(p => p.active !== false).map(p =>
            `🎟 *${escMd(p.name)}* — ${escMd(String(p.credits))} credits for *${escMd(fmtPHP(p.pricePHP))}*`
          ),
          ``,
          `Tap /help to purchase credits\\.`,
        ];
        const text = lines.join('\n');
        await broadcastToSubscribers(text);
        break;
      }

      case 'broadcast_online': {
        const text = [
          `✈️ *AnasFlightsV2 is now ONLINE and ready for lift\\-off\\!*`,
          ``,
          `🚀 Our booking automation service is live and accepting transactions\\.`,
          `💳 Use /help to subscribe or top up your credits\\.`,
          ``,
          `_Safe travels\\!_ 🌏`,
        ].join('\n');
        await broadcastToSubscribers(text);
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
app.get('/health', (_req, res) => res.json({ ok: true, bot: 'AnasFlightsV2', uptime: process.uptime() }));

app.listen(WEBHOOK_PORT, () => {
  console.log(`[INFO] Webhook server listening on port ${WEBHOOK_PORT}`);
});

// ── Broadcast helpers ──────────────────────────────────────────────────────────

async function broadcastToSubscribers(markdownText) {
  let subscribers = [];
  try {
    subscribers = await apiGet('/api/bot/subscribers');
  } catch (e) {
    console.error('[ERROR] broadcastToSubscribers fetch subscribers:', e.response ? `HTTP ${e.response.status}: ${JSON.stringify(e.response.data)}` : e.message);
    return;
  }
  if (!Array.isArray(subscribers) || subscribers.length === 0) return;
  let sent = 0, failed = 0;
  for (const sub of subscribers) {
    try {
      await bot.sendMessage(sub.chatId, markdownText, { parse_mode: 'MarkdownV2' });
      sent++;
    } catch (e) {
      failed++;
      console.error(`[ERROR] broadcastToSubscribers send to ${sub.chatId}:`, e.message);
    }
    // Small delay to avoid Telegram rate limits (max ~10 msg/sec to different users)
    await new Promise(r => setTimeout(r, 100));
  }
  console.log(`[INFO] Broadcast complete: ${sent} sent, ${failed} failed`);
}

// ── Bot Commands ───────────────────────────────────────────────────────────────

bot.setMyCommands([
  { command: 'start',      description: 'Welcome & registration info' },
  { command: 'register',   description: 'Link your Telegram account to a license key' },
  { command: 'help',       description: 'Help & buy credits' },
  { command: 'admin_help', description: 'Admin commands (authorized users only)' },
]);

// ── /start ─────────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  await registerSubscriber(msg);
  const text = [
    `✈️ *Welcome to AnasFlightsV2\\!*`,
    ``,
    `We provide automated flight booking assistance powered by credits\\.`,
    ``,
    buildTCMessage(),
  ].join('\n');
  await bot.sendMessage(msg.chat.id, text, {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ I Accept', callback_data: 'tc_accept_start' },
        { text: '❌ I Decline', callback_data: 'tc_deny' },
      ]],
    },
  });
});

// ── /register ──────────────────────────────────────────────────────────────────

bot.onText(/\/register(?:\s+(.+))?/, async (msg, match) => {
  await registerSubscriber(msg);
  const chatId  = msg.chat.id;
  const userId  = String(msg.from.id);
  const username = msg.from.username || msg.from.first_name || '';
  const licenseKey = (match[1] || '').trim();

  if (!licenseKey) {
    await bot.sendMessage(chatId,
      [
        `🔑 *Register Your License Key*`,
        ``,
        `Link your Telegram account to a license key so you can receive booking receipts and notifications directly here\\.`,
        ``,
        `Usage: /register LIC\\-XXXXXXXX`,
        ``,
        `_1 Telegram account per license key\\._`,
      ].join('\n'),
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  try {
    await apiPost('/api/bot/licenses/register', {
      licenseKey,
      telegramUserId: userId,
      chatId: String(chatId),
      username,
    });
    await bot.sendMessage(chatId,
      [
        `✅ *Registration Successful\\!*`,
        ``,
        `🔑 License \`${escMd(licenseKey)}\` is now linked to your Telegram account\\.`,
        ``,
        `You will receive booking receipts and notifications here automatically\\.`,
        ``,
        `Use /help to buy credits and start booking\\.`,
      ].join('\n'),
      { parse_mode: 'MarkdownV2' }
    );
  } catch (e) {
    const errMsg = e.response && e.response.data && e.response.data.error
      ? e.response.data.error
      : e.message;
    await bot.sendMessage(chatId,
      `❌ *Registration failed:* ${escMd(errMsg)}`,
      { parse_mode: 'MarkdownV2' }
    );
  }
});



bot.onText(/\/help/, async (msg) => {
  await registerSubscriber(msg);
  const text = [
    `✈️ *AnasFlightsV2 — Help*`,
    ``,
    `📋 *Terms \\& Conditions*`,
    `• Credits are *NON\\-REFUNDABLE* once payment is confirmed`,
    `• Credits are consumed per successful booking transaction`,
    `• Service availability may be interrupted for maintenance`,
    ``,
    `💳 *Buy Credits*`,
    `Choose how many credits to purchase\\. A QR code for payment will be shown\\.`,
    `After paying, send your proof of payment to complete the request\\.`,
    ``,
    `/start \\— Welcome \\& registration info`,
    `/register \\<LIC\\-KEY\\> \\— Link your license to receive receipts here`,
    `/help \\— This message`,
  ].join('\n');

  await bot.sendMessage(msg.chat.id, text, {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [[
        { text: '🛒 Buy Credits', callback_data: 'buy_credits' },
      ]],
    },
  });
});

// ── /admin_help ────────────────────────────────────────────────────────────────

bot.onText(/\/admin_help/, async (msg) => {
  if (!isAdmin(msg.from.id)) return; // silent — no reply to non-admins

  const text = [
    `🛡 *AnasFlightsV2 — Admin Commands*`,
    ``,
    `*License Management*`,
    `/credits \\<key\\> \\— Check details of a license`,
    `/addcredits \\<key\\> \\<amount\\> \\— Add credits to a license`,
    ``,
    `*System*`,
    `/status \\— System health \\& stats`,
    `/stats \\— Transaction statistics`,
    `/maintenance on\\|off \\— Toggle maintenance mode`,
    ``,
    `*Broadcast*`,
    `/broadcast \\<msg\\> \\— Send message to admin channel`,
    `/broadcast\\_online \\— Announce AnasFlightsV2 is online to all subscribers`,
    `/broadcast\\_prices \\— Send updated credit prices to all subscribers`,
  ].join('\n');

  await bot.sendMessage(msg.chat.id, text, { parse_mode: 'MarkdownV2' });
});

// ── /status ────────────────────────────────────────────────────────────────────

bot.onText(/\/status/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  try {
    const data = await apiGet('/api/admin/stats');
    const text = [
      `📊 *System Status*`,
      ``,
      `👥 Active Sessions: *${escMd(String(data.activeSessions ?? '?'))}*`,
      `🎫 Total Licenses: *${escMd(String(data.totalLicenses ?? '?'))}*`,
      `✅ Successful Txns: *${escMd(String(data.successTxns ?? '?'))}*`,
      `❌ Failed Txns: *${escMd(String((data.totalTxns ?? 0) - (data.successTxns ?? 0)))}*`,
      `🔧 Maintenance: *${data.maintenance ? 'ON' : 'OFF'}*`,
    ].join('\n');
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'MarkdownV2' });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Failed to fetch status: ${escMd(e.message)}`, { parse_mode: 'MarkdownV2' });
  }
});

// ── /credits ───────────────────────────────────────────────────────────────────

bot.onText(/\/credits (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const key = (match[1] || '').trim();
  if (!key) { await bot.sendMessage(msg.chat.id, 'Usage: /credits LIC\\-xxx', { parse_mode: 'MarkdownV2' }); return; }
  try {
    const data = await apiGet(`/api/admin/licenses`);
    const lic = (data || []).find(l => l.key === key);
    if (!lic) { await bot.sendMessage(msg.chat.id, `❌ License not found\\.`, { parse_mode: 'MarkdownV2' }); return; }
    const text = [
      `💳 *License Info*`,
      ``,
      `🔑 Key: \`${escMd(lic.key)}\``,
      `💰 Credits: *${escMd(String(lic.credits))}*`,
      `📋 Status: *${escMd(lic.suspended ? 'Suspended' : lic.active ? 'Active' : 'Inactive')}*`,
      `📅 Expires: *${escMd(lic.expiresAt ? fmtDate(lic.expiresAt) : 'Never')}*`,
      `📝 Notes: ${escMd(lic.notes || '—')}`,
    ].join('\n');
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'MarkdownV2' });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${escMd(e.message)}`, { parse_mode: 'MarkdownV2' });
  }
});

// ── /addcredits ────────────────────────────────────────────────────────────────

bot.onText(/\/addcredits (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const parts = (match[1] || '').trim().split(/\s+/);
  if (parts.length < 2) {
    await bot.sendMessage(msg.chat.id, 'Usage: /addcredits LIC\\-xxx 50', { parse_mode: 'MarkdownV2' });
    return;
  }
  const key = parts[0];
  const delta = parseInt(parts[1], 10);
  if (isNaN(delta)) {
    await bot.sendMessage(msg.chat.id, '❌ Amount must be a number\\.', { parse_mode: 'MarkdownV2' });
    return;
  }
  try {
    const result = await apiPost(`/api/bot/licenses/${encodeURIComponent(key)}/credits`, {
      delta,
      reason: `telegram_bot_addcredits by admin ${msg.from.id}`,
    });
    await bot.sendMessage(msg.chat.id,
      `✅ Credits updated\\!\n🔑 License: \`${escMd(key)}\`\n💰 New balance: *${escMd(String(result.balance))}*`,
      { parse_mode: 'MarkdownV2' }
    );
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${escMd(e.message)}`, { parse_mode: 'MarkdownV2' });
  }
});

// ── /stats ─────────────────────────────────────────────────────────────────────

bot.onText(/\/stats/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  try {
    const data = await apiGet('/api/admin/stats');
    const text = [
      `📈 *Transaction Stats*`,
      ``,
      `✅ Success: *${escMd(String(data.successTxns ?? 0))}*`,
      `📊 Total: *${escMd(String(data.totalTxns ?? 0))}*`,
      `👥 Sessions: *${escMd(String(data.activeSessions ?? 0))}*`,
    ].join('\n');
    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'MarkdownV2' });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${escMd(e.message)}`, { parse_mode: 'MarkdownV2' });
  }
});

// ── /maintenance ───────────────────────────────────────────────────────────────

bot.onText(/\/maintenance (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
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

// ── /broadcast ─────────────────────────────────────────────────────────────────

bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  const text = (match[1] || '').trim();
  if (!text) { await bot.sendMessage(msg.chat.id, 'Usage: /broadcast message'); return; }
  await sendAlert(`📢 *Broadcast*\n\n${escMd(text)}`);
  await bot.sendMessage(msg.chat.id, '✅ Broadcast sent to admin channel\\.', { parse_mode: 'MarkdownV2' });
});

// ── /broadcast_online ──────────────────────────────────────────────────────────

bot.onText(/\/broadcast_online/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  const text = [
    `✈️ *AnasFlightsV2 is now ONLINE and ready for lift\\-off\\!*`,
    ``,
    `🚀 Our booking automation service is live and accepting transactions\\.`,
    `💳 Use /help to subscribe or top up your credits\\.`,
    ``,
    `_Safe travels\\!_ 🌏`,
  ].join('\n');
  await broadcastToSubscribers(text);
  await bot.sendMessage(msg.chat.id, '✅ Online announcement broadcast to all subscribers\\.', { parse_mode: 'MarkdownV2' });
});

// ── /broadcast_prices ─────────────────────────────────────────────────────────

bot.onText(/\/broadcast_prices/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  try {
    const priceData = await apiGet('/api/bot/credit-price');
    const price = priceData.pricePerCredit || 250;
    const lines = [
      `💰 *AnasFlightsV2 — Credit Pricing*`,
      ``,
      `🎟 *Price per credit: ${escMd(fmtPHP(price))}*`,
      ``,
      `You choose how many credits to purchase\\. Tap /help to buy\\.`,
    ];
    await broadcastToSubscribers(lines.join('\n'));
    await bot.sendMessage(msg.chat.id, '✅ Prices broadcast to all subscribers\\.', { parse_mode: 'MarkdownV2' });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${escMd(e.message)}`, { parse_mode: 'MarkdownV2' });
  }
});

// ── Inline keyboard callback handler ──────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const chatId  = query.message.chat.id;
  const userId  = String(query.from.id);
  const data    = query.data || '';

  // ── Buy Credits — show T&C first ──────────────────────────────────────────
  if (data === 'buy_credits') {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId, buildTCMessage(), {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ I Accept', callback_data: 'tc_accept' },
          { text: '❌ I Decline', callback_data: 'tc_deny' },
        ]],
      },
    });
    return;
  }

  // ── T&C accepted from /start welcome ──────────────────────────────────────
  if (data === 'tc_accept_start') {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId,
      [
        `✅ *Terms \\& Conditions Accepted\\!*`,
        ``,
        `To get started:`,
        ``,
        `1️⃣ Register your license key:`,
        `   /register LIC\\-XXXXXXXX`,
        ``,
        `2️⃣ Then use /help to buy credits\\.`,
        ``,
        `_If you don't have a license key yet, please contact the admin\\._`,
      ].join('\n'),
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // ── T&C accepted — proceed to credit count ────────────────────────────────
  if (data === 'tc_accept') {
    await bot.answerCallbackQuery(query.id);
    let pricePerCredit = 250;
    try {
      const priceData = await apiGet('/api/bot/credit-price');
      pricePerCredit = priceData.pricePerCredit || 250;
    } catch (e) {
      console.warn('[WARN] Failed to fetch credit price:', e.message);
    }
    // Store state
    awaitingCreditCount.set(userId, { pricePerCredit });
    await bot.sendMessage(chatId,
      [
        `✅ *Terms \\& Conditions Accepted\\!*`,
        ``,
        `💰 *Price per credit: ${escMd(fmtPHP(pricePerCredit))}*`,
        ``,
        `How many credits would you like to purchase?`,
        `_Minimum: 1 credit_`,
        ``,
        `Please reply with a number \\(e\\.g\\. 5\\)\\.`,
      ].join('\n'),
      { parse_mode: 'MarkdownV2', reply_markup: { force_reply: true, input_field_placeholder: 'e.g. 5' } }
    );
    return;
  }

  // ── T&C declined ──────────────────────────────────────────────────────────
  if (data === 'tc_deny') {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId,
      [
        `❌ *Terms \\& Conditions Declined\\.*`,
        ``,
        `You cannot proceed without accepting the Terms \\& Conditions\\.`,
        ``,
        `Use /help if you change your mind\\.`,
      ].join('\n'),
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // ── Back to help ───────────────────────────────────────────────────────────
  if (data === 'back_help') {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId,
      `✈️ *AnasFlightsV2 — Help*\n\nUse /help to see available commands and buy credits\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // ── Approve / Deny from payment group ─────────────────────────────────────
  if (data.startsWith('approve:') || data.startsWith('deny:')) {
    if (!isAdmin(query.from.id)) {
      await bot.answerCallbackQuery(query.id, { text: '⛔ Not authorized.', show_alert: true });
      return;
    }
    const [action, requestId] = data.split(':');
    const reqIdNum = parseInt(requestId, 10);
    const pendingInfo = pendingApprovals.get(reqIdNum);

    const status = action === 'approve' ? 'approved' : 'denied';
    const adminNote = `Action by admin @${query.from.username || query.from.id} on ${fmtDate(new Date().toISOString())}`;

    let apiResult;
    try {
      apiResult = await apiPut(`/api/bot/purchase-requests/${reqIdNum}/status`, { status, adminNote });
    } catch (e) {
      await bot.answerCallbackQuery(query.id, { text: `❌ Failed to update: ${e.message}`, show_alert: true });
      return;
    }

    await bot.answerCallbackQuery(query.id, { text: status === 'approved' ? '✅ Approved!' : '❌ Denied!' });

    // Edit the group message to show outcome
    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      });
    } catch (_) {}

    // Notify user — use in-memory state or fall back to DB response data
    const info = pendingInfo || (apiResult && apiResult.request ? {
      chatId:     apiResult.request.chatId,
      credits:    apiResult.request.credits,
      amountPHP:  apiResult.request.amountPHP,
      licenseKey: apiResult.request.licenseKey,
    } : null);

    if (info && info.chatId) {
      if (status === 'approved') {
        // The backend auto-adds credits; creditAdded flag indicates success
        const creditAdded = apiResult && apiResult.creditAdded !== false;
        const creditNote = creditAdded
          ? `✅ Credits have been added to your license\\.`
          : `⚠️ Credits could not be added automatically\\. Please contact support with your Request ID\\.`;
        await bot.sendMessage(info.chatId,
          [
            `🎉 *Your purchase request has been APPROVED\\!*`,
            ``,
            `🎟 Credits: *${escMd(String(info.credits))}*`,
            `💰 Amount: *${escMd(fmtPHP(info.amountPHP))}*`,
            `🔑 License: \`${escMd(info.licenseKey || 'N/A')}\``,
            ``,
            creditNote,
            `Thank you for your purchase\\! ✈️`,
          ].join('\n'),
          { parse_mode: 'MarkdownV2' }
        );
      } else {
        await bot.sendMessage(info.chatId,
          [
            `❌ *Your purchase request has been DENIED\\.*`,
            ``,
            `🎟 Credits: *${escMd(String(info.credits))}*`,
            `💰 Amount: *${escMd(fmtPHP(info.amountPHP))}*`,
            ``,
            `If you believe this is a mistake or have questions, please contact support\\.`,
          ].join('\n'),
          { parse_mode: 'MarkdownV2' }
        );
      }
    }
    pendingApprovals.delete(reqIdNum);
    return;
  }
});

// ── Handle text and photo messages ────────────────────────────────────────────

bot.on('message', async (msg) => {
  if (!msg.from) return;

  const userId  = String(msg.from.id);
  const chatId  = msg.chat.id;

  // ── Phase 1: awaiting credit count ────────────────────────────────────────
  if (awaitingCreditCount.has(userId)) {
    // Only handle non-command text in this phase
    if (!msg.text || msg.text.startsWith('/')) return;

    const pending = awaitingCreditCount.get(userId);
    const count = parseInt(msg.text.trim(), 10);
    const MAX_CREDITS_PER_PURCHASE = 500;

    if (isNaN(count) || count < 1) {
      await bot.sendMessage(chatId,
        `⚠️ Please enter a valid number of credits \\(minimum 1\\)\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    if (count > MAX_CREDITS_PER_PURCHASE) {
      await bot.sendMessage(chatId,
        `⚠️ Maximum *${escMd(String(MAX_CREDITS_PER_PURCHASE))}* credits per purchase\\. Please enter a smaller amount\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    awaitingCreditCount.delete(userId);

    const amountPHP = count * pending.pricePerCredit;

    // Move to license key phase
    awaitingLicenseKey.set(userId, { credits: count, amountPHP });

    // Show QR code and payment details
    const caption = [
      `🎟 *Credits requested: ${escMd(String(count))}*`,
      `💰 *Total to pay: ${escMd(fmtPHP(amountPHP))}*`,
      ``,
      `📱 *Scan the QR code below* to make your GCash/bank payment\\.`,
      ``,
      `⚠️ *IMPORTANT:*`,
      `• Pay the *exact amount* shown above`,
      `• Credits are *NON\\-REFUNDABLE* once confirmed`,
      ``,
      `After paying, reply with your *license key* \\(e\\.g\\. LIC\\-XXXXXXXX\\)\\.`,
    ].join('\n');

    if (QR_CODE_PATH && fs.existsSync(QR_CODE_PATH)) {
      try {
        await bot.sendPhoto(chatId, fs.createReadStream(QR_CODE_PATH), {
          caption,
          parse_mode: 'MarkdownV2',
        });
      } catch (e) {
        console.error('[ERROR] sendPhoto failed:', e.message);
        await bot.sendMessage(chatId, caption, { parse_mode: 'MarkdownV2' });
      }
    } else {
      await bot.sendMessage(chatId, caption, { parse_mode: 'MarkdownV2' });
    }

    await bot.sendMessage(chatId,
      `🔑 Please reply with your *license key* \\(e\\.g\\. LIC\\-XXXXXXXX\\)\\.`,
      { parse_mode: 'MarkdownV2', reply_markup: { force_reply: true, input_field_placeholder: 'LIC-XXXXXXXX' } }
    );
    return;
  }

  // ── Phase 2: awaiting license key ─────────────────────────────────────────
  if (awaitingLicenseKey.has(userId)) {
    if (!msg.text || msg.text.startsWith('/')) return;

    const pending = awaitingLicenseKey.get(userId);
    const licenseKey = msg.text.trim();

    // Basic format validation: must start with LIC- and have at least 6 chars after
    if (!/^LIC-[A-Za-z0-9]{6,}$/i.test(licenseKey)) {
      await bot.sendMessage(chatId,
        `⚠️ Invalid license key format\\. License keys look like *LIC\\-XXXXXXXX*\\.\n\nPlease reply with your correct license key\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    awaitingLicenseKey.delete(userId);

    // Move to receipt phase
    awaitingReceipt.set(userId, {
      credits: pending.credits,
      amountPHP: pending.amountPHP,
      licenseKey,
    });

    await bot.sendMessage(chatId,
      [
        `✅ *License key received:* \`${escMd(licenseKey)}\``,
        ``,
        `📸 Now please *send a photo* of your payment receipt or proof of payment\\.`,
        ``,
        `_Make sure the amount and reference number are clearly visible\\._`,
      ].join('\n'),
      { parse_mode: 'MarkdownV2', reply_markup: { force_reply: true, input_field_placeholder: 'Send photo here' } }
    );
    return;
  }

  // ── Phase 3: awaiting receipt photo ───────────────────────────────────────
  if (awaitingReceipt.has(userId)) {
    const pending = awaitingReceipt.get(userId);

    // Accept photo or document as proof of payment
    const hasPhoto    = Array.isArray(msg.photo) && msg.photo.length > 0;
    const hasDocument = msg.document != null;

    if (!hasPhoto && !hasDocument) {
      // If the user sends text instead of a photo, remind them
      if (msg.text && !msg.text.startsWith('/')) {
        await bot.sendMessage(chatId,
          `📸 Please *send a photo* of your payment receipt as proof of payment\\.`,
          { parse_mode: 'MarkdownV2' }
        );
      }
      return;
    }

    awaitingReceipt.delete(userId);

    // Create purchase request in backend
    let requestId;
    try {
      const result = await apiPost('/api/bot/purchase-requests', {
        telegramUserId: userId,
        username: msg.from.username || msg.from.first_name || '',
        chatId: String(chatId),
        packageId: 0,
        packageName: 'Custom',
        credits: pending.credits,
        amountPHP: pending.amountPHP,
        licenseKey: pending.licenseKey,
      });
      requestId = result.id;
    } catch (e) {
      await bot.sendMessage(chatId,
        `❌ Failed to submit your request: ${escMd(e.message)}\\. Please try again with /help\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    // Confirm to user
    await bot.sendMessage(chatId,
      [
        `✅ *Purchase Request Submitted\\!*`,
        ``,
        `🎟 Credits: *${escMd(String(pending.credits))}*`,
        `💰 Amount: *${escMd(fmtPHP(pending.amountPHP))}*`,
        `🔑 License: \`${escMd(pending.licenseKey)}\``,
        `📋 Request ID: \`${escMd(String(requestId))}\``,
        ``,
        `Your payment proof has been forwarded to our team for review\\.`,
        `You will be notified once it is approved or denied\\.`,
        ``,
        `⚠️ Reminder: Credits are *NON\\-REFUNDABLE* once confirmed\\.`,
      ].join('\n'),
      { parse_mode: 'MarkdownV2' }
    );

    // Forward receipt photo to payment group with approve/deny buttons
    if (PAYMENT_GROUP_ID) {
      const groupCaption = [
        `💳 *New Purchase Request \\#${escMd(String(requestId))}*`,
        ``,
        `👤 User: @${escMd(msg.from.username || String(userId))} \\(ID: \`${escMd(userId)}\`\\)`,
        `🎟 Credits: *${escMd(String(pending.credits))}*`,
        `💰 Amount due: *${escMd(fmtPHP(pending.amountPHP))}*`,
        `🔑 License: \`${escMd(pending.licenseKey)}\``,
        `🕐 Time: ${escMd(fmtDate(new Date().toISOString()))}`,
        ``,
        `✅ Approve if payment amount matches\\. ❌ Deny if it does not\\.`,
      ].join('\n');

      const approvalKeyboard = {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `approve:${requestId}` },
          { text: '❌ Deny',    callback_data: `deny:${requestId}` },
        ]],
      };

      try {
        if (hasPhoto) {
          // Use the highest-quality photo (last item in array)
          const fileId = msg.photo[msg.photo.length - 1].file_id;
          await bot.sendPhoto(PAYMENT_GROUP_ID, fileId, {
            caption: groupCaption,
            parse_mode: 'MarkdownV2',
            reply_markup: approvalKeyboard,
          });
        } else {
          // Document (PDF, etc.)
          await bot.sendDocument(PAYMENT_GROUP_ID, msg.document.file_id, {
            caption: groupCaption,
            parse_mode: 'MarkdownV2',
            reply_markup: approvalKeyboard,
          });
        }

        // Track for approve/deny callback
        pendingApprovals.set(requestId, {
          chatId:     String(chatId),
          userId,
          credits:    pending.credits,
          amountPHP:  pending.amountPHP,
          licenseKey: pending.licenseKey,
          username:   msg.from.username || '',
        });
      } catch (e) {
        console.error('[ERROR] Forward to payment group failed:', e.message);
      }
    }
    return;
  }

  // ── No active state ────────────────────────────────────────────────────────
  // Ignore commands; for any other non-command text give a helpful nudge
  if (msg.text && !msg.text.startsWith('/')) {
    await bot.sendMessage(chatId,
      `💡 Use /help to buy credits or /register to link your license key\\.`,
      { parse_mode: 'MarkdownV2' }
    );
  }
});

// ── Polling error handler ──────────────────────────────────────────────────────

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

