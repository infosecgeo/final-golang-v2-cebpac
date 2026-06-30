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

// userId (string) → { packageId, packageName, credits, amountPHP }
const awaitingLicenseKey = new Map();

// userId (string) → true  — set while waiting for the user to send their license key for /register
const awaitingRegistration = new Map();

// messageId in payment group → { requestId, userId, chatId, packageName, credits, amountPHP, licenseKey, username }
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

        // Forward receipt directly to the linked user (app → Telegram, no JWT).
        if (p.userChatId) {
          const userReceipt = [
            `🎉 *Payment Receipt*`,
            ``,
            `Your booking payment has been successfully authorized\\.`,
            ``,
            `🎫 *Record Locator:* \`${escMd(p.recordLocator || 'N/A')}\``,
            `👤 *Passenger:* ${escMd(p.passengerName || 'N/A')}`,
            `✈️ *Flight:* ${escMd(p.flightRoute || 'N/A')}${p.flightNumber ? ' \\(' + escMd(p.flightNumber) + '\\)' : ''}`,
            `💳 *Card:* \`${escMd(p.maskedCard || 'N/A')}\``,
            `📋 *Booking Status:* ${escMd(p.bookingStatus || 'N/A')}`,
            `✅ *Payment:* Authorized`,
            `🕐 *Time:* ${escMd(fmtDate(p.authTime))}`,
            ``,
            `💰 *Credits Remaining:* *${escMd(String(p.creditsRemaining ?? '?'))}*`,
          ].join('\n');
          try {
            await bot.sendMessage(p.userChatId, userReceipt, { parse_mode: 'MarkdownV2' });
          } catch (e) {
            console.error('[ERROR] Failed to send receipt to user:', e.message);
          }
        }
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

        // Notify the user directly if their TG account is linked.
        if (p.userChatId) {
          const userMsg = [
            `❌ *Payment Not Authorized*`,
            ``,
            `Your payment attempt was not authorized\\.`,
            ``,
            `💳 *Card:* \`${escMd(p.maskedCard || 'N/A')}\``,
            `📝 *Reason:* ${escMd(p.reason || 'Unknown')}`,
            `🕐 *Time:* ${escMd(fmtDate(p.time))}`,
            ``,
            `Please verify your card details and try again, or contact support if the issue persists\\.`,
          ].join('\n');
          try {
            await bot.sendMessage(p.userChatId, userMsg, { parse_mode: 'MarkdownV2' });
          } catch (e) {
            console.error('[ERROR] Failed to notify user of payment failure:', e.message);
          }
        }
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
    console.error('[ERROR] broadcastToSubscribers fetch:', e.message);
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
      console.error(`[WARN] broadcastToSubscribers: failed for chatId ${sub.chatId}: ${e.message}`);
    }
    // Small delay to avoid Telegram rate limits (max ~10 msg/sec to different users)
    await new Promise(r => setTimeout(r, 100));
  }
  console.log(`[INFO] Broadcast complete: ${sent} sent, ${failed} failed`);
}

// ── Bot Commands ───────────────────────────────────────────────────────────────

bot.setMyCommands([
  { command: 'start',      description: 'Welcome & registration info' },
  { command: 'register',   description: 'Link your license key to this Telegram account' },
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
    `📋 *Terms \\& Conditions*`,
    `• Credits are *NON\\-REFUNDABLE* once payment is confirmed`,
    `• Credits are consumed per successful booking transaction`,
    `• Keep your license key private and secure`,
    `• Service availability is subject to maintenance windows`,
    ``,
    `💡 Use /help to see how to subscribe or buy credits\\.`,
  ].join('\n');
  await bot.sendMessage(msg.chat.id, text, { parse_mode: 'MarkdownV2' });
});

// ── /register ──────────────────────────────────────────────────────────────────

bot.onText(/\/register/, async (msg) => {
  await registerSubscriber(msg);
  const userId = String(msg.from.id);
  awaitingRegistration.set(userId, true);
  await bot.sendMessage(msg.chat.id,
    [
      `🔑 *Register Your License*`,
      ``,
      `Please reply with your *license key* \\(e\\.g\\. LIC\\-XXXXXXXX\\) to link it to your Telegram account\\.`,
      ``,
      `_One license key per Telegram account\\._`,
    ].join('\n'),
    { parse_mode: 'MarkdownV2', reply_markup: { force_reply: true, input_field_placeholder: 'LIC-XXXXXXXX' } }
  );
});

// ── /help ──────────────────────────────────────────────────────────────────────

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
    `Choose a package below to subscribe or top up your account\\.`,
    `After selecting a package you will receive a QR code for payment\\.`,
    ``,
    `/start \\— Welcome \\& registration info`,
    `/register \\— Link your license key to this Telegram account`,
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
    const packages = await apiGet('/api/bot/packages');
    if (!Array.isArray(packages) || packages.length === 0) {
      await bot.sendMessage(msg.chat.id, '⚠️ No active packages found\\.', { parse_mode: 'MarkdownV2' });
      return;
    }
    const lines = [
      `💰 *AnasFlightsV2 — Credit Packages*`,
      ``,
      ...packages.map(p => `🎟 *${escMd(p.name)}* — ${escMd(String(p.credits))} credits for *${escMd(fmtPHP(p.pricePHP))}*`),
      ``,
      `Tap /help to purchase\\.`,
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

  // ── Buy Credits — show package list ────────────────────────────────────────
  if (data === 'buy_credits') {
    await bot.answerCallbackQuery(query.id);
    try {
      const packages = await apiGet('/api/bot/packages');
      if (!Array.isArray(packages) || packages.length === 0) {
        await bot.sendMessage(chatId,
          '⚠️ No credit packages are available at the moment\\. Please check back later\\.', { parse_mode: 'MarkdownV2' });
        return;
      }
      const keyboard = packages.map(p => [{
        text: `${p.name} — ${p.credits} credits @ ${fmtPHP(p.pricePHP)}`,
        callback_data: `pkg:${p.id}:${p.name}:${p.credits}:${p.pricePHP}`,
      }]);
      keyboard.push([{ text: '🔙 Back', callback_data: 'back_help' }]);
      await bot.sendMessage(chatId,
        `💳 *Choose a Credit Package*\n\n_Select the package you want to purchase:_`,
        { parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: keyboard } }
      );
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Failed to load packages: ${escMd(e.message)}`, { parse_mode: 'MarkdownV2' });
    }
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

  // ── Package selected ───────────────────────────────────────────────────────
  if (data.startsWith('pkg:')) {
    await bot.answerCallbackQuery(query.id);
    const parts = data.split(':');
    // pkg:<id>:<name>:<credits>:<price>
    const pkgId       = parts[1];
    const pkgName     = parts[2];
    const pkgCredits  = parts[3];
    const pkgPrice    = parseFloat(parts[4]);

    // Store pending state
    awaitingLicenseKey.set(userId, {
      packageId:   pkgId,
      packageName: pkgName,
      credits:     parseInt(pkgCredits, 10),
      amountPHP:   pkgPrice,
    });

    // Send QR code with amount if available
    const caption = [
      `✅ *You selected: ${escMd(pkgName)}*`,
      `💰 *Amount to pay: ${escMd(fmtPHP(pkgPrice))}*`,
      `🎟 Credits: *${escMd(pkgCredits)}*`,
      ``,
      `📱 *Scan the QR code below* to make your payment\\.`,
      ``,
      `⚠️ *IMPORTANT:* Credits are *NON\\-REFUNDABLE* once payment is confirmed\\.`,
      ``,
      `After paying, please reply with your *license key* so we can process your request\\.`,
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
      `🔑 Please reply with your *license key* \\(e\\.g\\. LIC\\-XXXXXXXX\\) to submit your purchase request\\.`,
      { parse_mode: 'MarkdownV2', reply_markup: { force_reply: true, input_field_placeholder: 'LIC-XXXXXXXX' } }
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
      await bot.editMessageText(
        query.message.text + `\n\n${status === 'approved' ? '✅ APPROVED' : '❌ DENIED'} by @${query.from.username || query.from.id}`,
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      );
    } catch (_) {}

    // Notify user — use in-memory state or fall back to DB response data
    const info = pendingInfo || (apiResult && apiResult.request ? {
      chatId:      apiResult.request.chatId,
      packageName: apiResult.request.packageName,
      credits:     apiResult.request.credits,
      amountPHP:   apiResult.request.amountPHP,
      licenseKey:  apiResult.request.licenseKey,
    } : null);

    if (info && info.chatId) {
      if (status === 'approved') {
        await bot.sendMessage(info.chatId,
          [
            `🎉 *Your purchase request has been APPROVED\\!*`,
            ``,
            `📦 Package: *${escMd(info.packageName)}*`,
            `🎟 Credits: *${escMd(String(info.credits))}*`,
            `💰 Amount: *${escMd(fmtPHP(info.amountPHP))}*`,
            `🔑 License: \`${escMd(info.licenseKey || 'N/A')}\``,
            ``,
            `Credits have been added to your license\\. Thank you for your purchase\\! ✈️`,
          ].join('\n'),
          { parse_mode: 'MarkdownV2' }
        );
      } else {
        await bot.sendMessage(info.chatId,
          [
            `❌ *Your purchase request has been DENIED\\.*`,
            ``,
            `📦 Package: *${escMd(info.packageName)}*`,
            `💰 Amount: *${escMd(fmtPHP(info.amountPHP))}*`,
            ``,
            `If you believe this is a mistake, please contact support\\.`,
          ].join('\n'),
          { parse_mode: 'MarkdownV2' }
        );
      }
    }
    pendingApprovals.delete(reqIdNum);
    return;
  }
});

// ── Handle text messages (for license key input and /register flow) ────────────

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (!msg.from) return;

  const userId  = String(msg.from.id);
  const chatId  = msg.chat.id;

  // ── /register flow: link license key to this Telegram account ─────────────
  const pendingReg = awaitingRegistration.get(userId);
  if (pendingReg) {
    awaitingRegistration.delete(userId);
    const licenseKey = msg.text.trim();
    try {
      await apiPost('/api/bot/licenses/link', { telegramUserId: userId, licenseKey });
      await bot.sendMessage(chatId,
        [
          `✅ *Registration Successful\\!*`,
          ``,
          `🔑 License \`${escMd(licenseKey)}\` is now linked to your Telegram account\\.`,
          ``,
          `You will receive payment receipts here after each successful transaction\\.`,
        ].join('\n'),
        { parse_mode: 'MarkdownV2' }
      );
    } catch (e) {
      const errMsg = e.response?.data?.error || e.message;
      await bot.sendMessage(chatId,
        `❌ Registration failed: ${escMd(errMsg)}\\. Please check your license key and try again\\.`,
        { parse_mode: 'MarkdownV2' }
      );
    }
    return;
  }

  const pending = awaitingLicenseKey.get(userId);

  if (!pending) return;

  const licenseKey = msg.text.trim();
  awaitingLicenseKey.delete(userId);

  // Create purchase request in backend
  let requestId;
  try {
    const result = await apiPost('/api/bot/purchase-requests', {
      telegramUserId: userId,
      username: msg.from.username || msg.from.first_name || '',
      chatId: String(chatId),
      packageId: parseInt(pending.packageId, 10),
      packageName: pending.packageName,
      credits: pending.credits,
      amountPHP: pending.amountPHP,
      licenseKey,
    });
    requestId = result.id;
  } catch (e) {
    await bot.sendMessage(chatId,
      `❌ Failed to submit your request: ${escMd(e.message)}\\. Please try again\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // Confirm to user
  await bot.sendMessage(chatId,
    [
      `✅ *Purchase Request Submitted\\!*`,
      ``,
      `📦 Package: *${escMd(pending.packageName)}*`,
      `🎟 Credits: *${escMd(String(pending.credits))}*`,
      `💰 Amount: *${escMd(fmtPHP(pending.amountPHP))}*`,
      `🔑 License: \`${escMd(licenseKey)}\``,
      `📋 Request ID: \`${escMd(String(requestId))}\``,
      ``,
      `Your request is now pending review\\. You will be notified once it is approved or denied\\.`,
      ``,
      `⚠️ Reminder: Credits are *NON\\-REFUNDABLE* once confirmed\\.`,
    ].join('\n'),
    { parse_mode: 'MarkdownV2' }
  );

  // Forward to payment group
  if (PAYMENT_GROUP_ID) {
    const groupMsg = [
      `💳 *New Purchase Request \\#${escMd(String(requestId))}*`,
      ``,
      `👤 User: @${escMd(msg.from.username || String(userId))} \\(ID: \`${escMd(userId)}\`\\)`,
      `📦 Package: *${escMd(pending.packageName)}*`,
      `🎟 Credits: *${escMd(String(pending.credits))}*`,
      `💰 Amount: *${escMd(fmtPHP(pending.amountPHP))}*`,
      `🔑 License: \`${escMd(licenseKey)}\``,
      `🕐 Time: ${escMd(fmtDate(new Date().toISOString()))}`,
    ].join('\n');

    try {
      const sentMsg = await bot.sendMessage(PAYMENT_GROUP_ID, groupMsg, {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `approve:${requestId}` },
            { text: '❌ Deny',    callback_data: `deny:${requestId}` },
          ]],
        },
      });

      // Track for approve/deny callback
      pendingApprovals.set(requestId, {
        chatId:      String(chatId),
        userId,
        packageName: pending.packageName,
        credits:     pending.credits,
        amountPHP:   pending.amountPHP,
        licenseKey,
        username:    msg.from.username || '',
      });
    } catch (e) {
      console.error('[ERROR] Forward to payment group failed:', e.message);
    }
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

