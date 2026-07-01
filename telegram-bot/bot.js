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

// ── Purchase constants ────────────────────────────────────────────────────────

const MAX_CREDITS_PER_PURCHASE  = 500;
const DEFAULT_CREDIT_PRICE_PHP  = 250;   // must match config.go default (credit_price_php)
const CUSTOM_PACKAGE_ID         = 0;
const CUSTOM_PACKAGE_NAME       = 'Custom';
const LICENSE_KEY_REGEX         = /^LIC-[A-Za-z0-9]{6,}$/i;

// ── In-memory conversation state ───────────────────────────────────────────────

// userId → { pricePerCredit, requestType ('new_registration'|'topup'), licenseKey }
const awaitingCreditCount = new Map();

// userId → { credits, amountPHP, requestType, licenseKey }
const awaitingReceipt = new Map();

// userId → { credits, amountPHP, requestType, licenseKey, fileId, isPhoto }
const awaitingReferenceNumber = new Map();

// userId (in Set) — waiting for existing license key input
const awaitingExistingLicense = new Set();

// requestId (number) → { chatId, userId, credits, amountPHP, licenseKey, username, requestType }
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

// buildQrCodeUrl constructs a full URL from API_URL and a path like /image/qr/cashg.jpg.
function buildQrCodeUrl(apiUrl, qrPath) {
  if (!qrPath || !apiUrl) return null;
  if (qrPath.startsWith('http://') || qrPath.startsWith('https://')) return qrPath;
  const base = apiUrl.replace(/\/$/, '');
  const p    = qrPath.startsWith('/') ? qrPath : '/' + qrPath;
  return base + p;
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

// sendDashboard fetches the user's linked license and shows their dashboard.
async function sendDashboard(chatId, userId, username) {
  let lic = null;
  try {
    const data = await apiGet(`/api/bot/licenses/check-telegram/${encodeURIComponent(userId)}`);
    if (data && data.registered) {
      lic = data;
    }
  } catch (e) {
    console.warn('[WARN] sendDashboard fetch license:', e.message);
  }

  if (!lic) {
    await bot.sendMessage(chatId,
      `⚠️ No linked license found\\. Use /start to register\\.`,
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  const text = [
    `✈️ *AnasFlightsV2 — Dashboard*`,
    ``,
    `👤 Welcome back, ${escMd(username || 'User')}\\!`,
    `🔑 License: \`${escMd(lic.licenseKey)}\``,
    `💰 Credits: *${escMd(String(lic.credits))}*`,
    ``,
    `What would you like to do?`,
  ].join('\n');

  await bot.sendMessage(chatId, text, {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '💰 Check Balance',       callback_data: 'check_balance' },
          { text: '📋 Transaction History', callback_data: 'view_history' },
        ],
        [
          { text: '➕ Top-up Credits',      callback_data: 'topup_credits' },
          { text: '🔄 Refresh',             callback_data: 'refresh_account' },
        ],
      ],
    },
  });
}

// sendQRAndAskReceipt sends the QR code and moves the user to the receipt phase.
async function sendQRAndAskReceipt(chatId, userId, count, amountPHP, requestType, licenseKey) {
  const captionLines = [
    `🎟 *Credits requested: ${escMd(String(count))}*`,
    `💰 *Total to pay: ${escMd(fmtPHP(amountPHP))}*`,
    ``,
    `📱 *Scan the QR code below* to make your GCash/bank payment\\.`,
    ``,
    `⚠️ *IMPORTANT:*`,
    `• Pay the *exact amount* shown above`,
    `• Credits are *NON\\-REFUNDABLE* once confirmed`,
    ``,
    `After paying, send us a *photo* of your payment receipt\\.`,
  ];
  const caption = captionLines.join('\n');

  // Send QR code image: try filesystem path first, then URL, then text fallback.
  let qrSent = false;
  if (QR_CODE_PATH) {
    if (fs.existsSync(QR_CODE_PATH)) {
      try {
        await bot.sendPhoto(chatId, fs.createReadStream(QR_CODE_PATH), { caption, parse_mode: 'MarkdownV2' });
        qrSent = true;
      } catch (e) {
        console.error('[ERROR] sendPhoto (file) failed:', e.message);
      }
    }
    if (!qrSent && API_URL) {
      const qrUrl = buildQrCodeUrl(API_URL, QR_CODE_PATH);
      try {
        await bot.sendPhoto(chatId, qrUrl, { caption, parse_mode: 'MarkdownV2' });
        qrSent = true;
      } catch (e) {
        console.error('[ERROR] sendPhoto (url) failed:', e.message);
      }
    }
  }
  // Fallback: try the qr_code_url from system config
  if (!qrSent && API_URL) {
    try {
      const data = await apiGet('/api/bot/qr-code-url');
      if (data && data.url) {
        await bot.sendPhoto(chatId, data.url, { caption, parse_mode: 'MarkdownV2' });
        qrSent = true;
      }
    } catch (e) {
      console.error('[ERROR] sendPhoto (config qr_code_url) failed:', e.message);
    }
  }
  if (!qrSent) {
    await bot.sendMessage(chatId, caption, { parse_mode: 'MarkdownV2' });
  }

  awaitingReceipt.set(userId, { credits: count, amountPHP, requestType, licenseKey: licenseKey || '' });
  await bot.sendMessage(chatId,
    `📸 Please *send a photo* of your payment receipt as proof of payment\\.`,
    { parse_mode: 'MarkdownV2', reply_markup: { force_reply: true, input_field_placeholder: 'Send photo here' } }
  );
}

// submitPurchaseRequest creates the request in the backend and forwards to admin group.
async function submitPurchaseRequest(chatId, userId, username, pending) {
  const { credits, amountPHP, requestType, licenseKey, fileId, isPhoto, referenceNumber } = pending;

  let requestId;
  try {
    const result = await apiPost('/api/bot/purchase-requests', {
      telegramUserId: userId,
      username,
      chatId: String(chatId),
      packageId: CUSTOM_PACKAGE_ID,
      packageName: CUSTOM_PACKAGE_NAME,
      credits,
      amountPHP,
      licenseKey: licenseKey || '',
      referenceNumber: referenceNumber || '',
      requestType: requestType || 'topup',
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
  const confirmLines = [
    `✅ *Purchase Request Submitted\\!*`,
    ``,
    `🎟 Credits: *${escMd(String(credits))}*`,
    `💰 Amount: *${escMd(fmtPHP(amountPHP))}*`,
    `📋 Request ID: \`${escMd(String(requestId))}\``,
  ];
  if (requestType === 'topup' && licenseKey) {
    confirmLines.push(`🔑 License: \`${escMd(licenseKey)}\``);
  }
  if (referenceNumber) {
    confirmLines.push(`📝 Ref \\#: ${escMd(referenceNumber)}`);
  }
  confirmLines.push(
    ``,
    `Your payment proof has been forwarded to our team for review\\.`,
    `You will be notified once it is approved or denied\\.`,
    ``,
    `⚠️ Reminder: Credits are *NON\\-REFUNDABLE* once confirmed\\.`
  );
  await bot.sendMessage(chatId, confirmLines.join('\n'), { parse_mode: 'MarkdownV2' });

  // Forward receipt to payment group with approve/deny buttons
  if (PAYMENT_GROUP_ID && fileId) {
    const licDisplay = (requestType === 'new_registration')
      ? `New Registration`
      : (licenseKey || 'N/A');

    const groupCaption = [
      `💳 *New Purchase Request \\#${escMd(String(requestId))}*`,
      ``,
      `👤 User: @${escMd(username || String(userId))} \\(ID: \`${escMd(userId)}\`\\)`,
      `🎟 Credits: *${escMd(String(credits))}*`,
      `💰 Amount due: *${escMd(fmtPHP(amountPHP))}*`,
      `🔑 License: \`${escMd(licDisplay)}\``,
      referenceNumber ? `📝 Ref \\#: ${escMd(referenceNumber)}` : null,
      `📌 Type: ${escMd(requestType === 'new_registration' ? 'New Registration' : 'Top\\-up')}`,
      `🕐 Time: ${escMd(fmtDate(new Date().toISOString()))}`,
      ``,
      `✅ Approve if payment amount matches\\. ❌ Deny if it does not\\.`,
    ].filter(Boolean).join('\n');

    const approvalKeyboard = {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${requestId}` },
        { text: '❌ Deny',    callback_data: `deny:${requestId}` },
      ]],
    };

    try {
      if (isPhoto) {
        await bot.sendPhoto(PAYMENT_GROUP_ID, fileId, {
          caption: groupCaption,
          parse_mode: 'MarkdownV2',
          reply_markup: approvalKeyboard,
        });
      } else {
        await bot.sendDocument(PAYMENT_GROUP_ID, fileId, {
          caption: groupCaption,
          parse_mode: 'MarkdownV2',
          reply_markup: approvalKeyboard,
        });
      }

      // Track for approve/deny callback
      pendingApprovals.set(requestId, {
        chatId:      String(chatId),
        userId,
        credits,
        amountPHP,
        licenseKey:  licenseKey || '',
        username:    username || '',
        requestType: requestType || 'topup',
      });
    } catch (e) {
      console.error('[ERROR] Forward to payment group failed:', e.message);
    }
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
  { command: 'start',      description: 'Welcome & registration' },
  { command: 'help',       description: 'Help & buy credits' },
  { command: 'register',   description: 'Link your Telegram account to a license key' },
  { command: 'admin_help', description: 'Admin commands (authorized users only)' },
]);

// ── /start ─────────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  await registerSubscriber(msg);
  const chatId   = msg.chat.id;
  const userId   = String(msg.from.id);
  const username = msg.from.username || msg.from.first_name || '';

  // Check if user already has a linked license
  try {
    const data = await apiGet(`/api/bot/licenses/check-telegram/${encodeURIComponent(userId)}`);
    if (data && data.registered) {
      await sendDashboard(chatId, userId, username);
      return;
    }
  } catch (e) {
    console.warn('[WARN] /start check-telegram:', e.message);
  }

  // New visitor — show welcome with New User / Existing User options
  const text = [
    `✈️ *Welcome to AnasFlightsV2\\!*`,
    ``,
    `We provide automated flight booking assistance powered by credits\\.`,
    ``,
    `Are you a new or existing user?`,
  ].join('\n');

  await bot.sendMessage(chatId, text, {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [[
        { text: '🆕 New User',      callback_data: 'user_new' },
        { text: '👤 Existing User', callback_data: 'user_existing' },
      ]],
    },
  });
});

// ── /register (manual license linking) ────────────────────────────────────────

bot.onText(/\/register(?:\s+(.+))?/, async (msg, match) => {
  await registerSubscriber(msg);
  const chatId   = msg.chat.id;
  const userId   = String(msg.from.id);
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
    await sendDashboard(chatId, userId, username);
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

// ── /help ──────────────────────────────────────────────────────────────────────

bot.onText(/\/help/, async (msg) => {
  await registerSubscriber(msg);
  const chatId   = msg.chat.id;
  const userId   = String(msg.from.id);
  const username = msg.from.username || msg.from.first_name || '';

  // If user has a linked license, show dashboard instead
  try {
    const data = await apiGet(`/api/bot/licenses/check-telegram/${encodeURIComponent(userId)}`);
    if (data && data.registered) {
      await sendDashboard(chatId, userId, username);
      return;
    }
  } catch (e) {
    console.warn('[WARN] /help check-telegram:', e.message);
  }

  const text = [
    `✈️ *AnasFlightsV2 — Help*`,
    ``,
    `📋 *Terms \\& Conditions*`,
    `• Credits are *NON\\-REFUNDABLE* once payment is confirmed`,
    `• Credits are consumed per successful booking transaction`,
    `• Service availability may be interrupted for maintenance`,
    ``,
    `Use /start to register or link your account\\.`,
    `/register \\<LIC\\-KEY\\> \\— Link your license directly`,
  ].join('\n');

  await bot.sendMessage(msg.chat.id, text, { parse_mode: 'MarkdownV2' });
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
      `You choose how many credits to purchase\\. Use /start to register or buy credits\\.`,
    ];
    await broadcastToSubscribers(lines.join('\n'));
    await bot.sendMessage(msg.chat.id, '✅ Prices broadcast to all subscribers\\.', { parse_mode: 'MarkdownV2' });
  } catch (e) {
    await bot.sendMessage(msg.chat.id, `❌ Error: ${escMd(e.message)}`, { parse_mode: 'MarkdownV2' });
  }
});

// ── Inline keyboard callback handler ──────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const chatId   = query.message.chat.id;
  const userId   = String(query.from.id);
  const username = query.from.username || query.from.first_name || '';
  const data     = query.data || '';

  // ── New User → show Terms & Conditions ───────────────────────────────────
  if (data === 'user_new') {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId, buildTCMessage(), {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ I Accept', callback_data: 'tc_accept_new' },
          { text: '❌ I Decline', callback_data: 'tc_deny' },
        ]],
      },
    });
    return;
  }

  // ── Existing User → ask for license key ──────────────────────────────────
  if (data === 'user_existing') {
    await bot.answerCallbackQuery(query.id);
    awaitingExistingLicense.add(userId);
    await bot.sendMessage(chatId,
      [
        `🔑 *Existing User Login*`,
        ``,
        `Please enter your license key to link your Telegram account\\.`,
        ``,
        `_Format: LIC\\-XXXXXXXXXXXXXXXX_`,
      ].join('\n'),
      { parse_mode: 'MarkdownV2', reply_markup: { force_reply: true, input_field_placeholder: 'LIC-XXXXXXXXXXXXXXXX' } }
    );
    return;
  }

  // ── T&C accepted — New Registration ──────────────────────────────────────
  if (data === 'tc_accept_new') {
    await bot.answerCallbackQuery(query.id);
    let pricePerCredit = DEFAULT_CREDIT_PRICE_PHP;
    try {
      const priceData = await apiGet('/api/bot/credit-price');
      pricePerCredit = priceData.pricePerCredit || DEFAULT_CREDIT_PRICE_PHP;
    } catch (e) {
      console.warn('[WARN] Failed to fetch credit price:', e.message);
    }

    awaitingCreditCount.set(userId, { pricePerCredit, requestType: 'new_registration', licenseKey: null });

    await bot.sendMessage(chatId,
      [
        `✅ *Terms \\& Conditions Accepted\\!*`,
        ``,
        `💰 *Price per credit: ${escMd(fmtPHP(pricePerCredit))}*`,
        ``,
        `How many credits would you like to purchase?`,
        `_Minimum: 1 credit \\| Maximum: ${escMd(String(MAX_CREDITS_PER_PURCHASE))} credits_`,
        ``,
        `Please reply with a number \\(e\\.g\\. 5\\)\\.`,
      ].join('\n'),
      { parse_mode: 'MarkdownV2', reply_markup: { force_reply: true, input_field_placeholder: 'e.g. 5' } }
    );
    return;
  }

  // ── T&C accepted — Top-up (existing user) ────────────────────────────────
  if (data === 'tc_accept_topup') {
    await bot.answerCallbackQuery(query.id);
    let pricePerCredit = DEFAULT_CREDIT_PRICE_PHP;
    try {
      const priceData = await apiGet('/api/bot/credit-price');
      pricePerCredit = priceData.pricePerCredit || DEFAULT_CREDIT_PRICE_PHP;
    } catch (e) {
      console.warn('[WARN] Failed to fetch credit price:', e.message);
    }

    // Fetch the user's linked license key
    let licenseKey = null;
    try {
      const licData = await apiGet(`/api/bot/licenses/check-telegram/${encodeURIComponent(userId)}`);
      if (licData && licData.registered) {
        licenseKey = licData.licenseKey || null;
      }
    } catch (e) {
      console.warn('[WARN] tc_accept_topup fetch license:', e.message);
    }

    awaitingCreditCount.set(userId, { pricePerCredit, requestType: 'topup', licenseKey });

    await bot.sendMessage(chatId,
      [
        `✅ *Terms \\& Conditions Accepted\\!*`,
        ``,
        `💰 *Price per credit: ${escMd(fmtPHP(pricePerCredit))}*`,
        licenseKey ? `🔑 *License:* \`${escMd(licenseKey)}\`` : null,
        ``,
        `How many credits would you like to top up?`,
        `_Minimum: 1 credit \\| Maximum: ${escMd(String(MAX_CREDITS_PER_PURCHASE))} credits_`,
        ``,
        `Please reply with a number \\(e\\.g\\. 5\\)\\.`,
      ].filter(Boolean).join('\n'),
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
        `Use /start if you change your mind\\.`,
      ].join('\n'),
      { parse_mode: 'MarkdownV2' }
    );
    return;
  }

  // ── Dashboard — Check Balance ─────────────────────────────────────────────
  if (data === 'check_balance') {
    await bot.answerCallbackQuery(query.id);
    try {
      const licData = await apiGet(`/api/bot/licenses/check-telegram/${encodeURIComponent(userId)}`);
      if (licData && licData.registered) {
        await bot.sendMessage(chatId,
          [
            `💰 *Your Credit Balance*`,
            ``,
            `🔑 License: \`${escMd(licData.licenseKey)}\``,
            `💳 Credits available: *${escMd(String(licData.credits))}*`,
          ].join('\n'),
          { parse_mode: 'MarkdownV2' }
        );
      } else {
        await bot.sendMessage(chatId, `⚠️ No linked license found\\.`, { parse_mode: 'MarkdownV2' });
      }
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Error: ${escMd(e.message)}`, { parse_mode: 'MarkdownV2' });
    }
    return;
  }

  // ── Dashboard — Transaction History ──────────────────────────────────────
  if (data === 'view_history') {
    await bot.answerCallbackQuery(query.id);
    try {
      const history = await apiGet(`/api/bot/purchase-requests/by-telegram/${encodeURIComponent(userId)}`);
      if (!Array.isArray(history) || history.length === 0) {
        await bot.sendMessage(chatId, `📋 No transaction history found\\.`, { parse_mode: 'MarkdownV2' });
        return;
      }
      const lines = [`📋 *Transaction History* \\(last ${escMd(String(history.length))}\\)`, ``];
      for (const tx of history) {
        const statusIcon = tx.status === 'approved' ? '✅' : tx.status === 'denied' ? '❌' : '⏳';
        lines.push(
          `${statusIcon} *\\#${escMd(String(tx.id))}* — ${escMd(String(tx.credits))} credits \\(${escMd(fmtPHP(tx.amountPHP))}\\)`,
          `   ${escMd(fmtDate(tx.createdAt))} — ${escMd(tx.status)}`,
          ``
        );
      }
      await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'MarkdownV2' });
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Error: ${escMd(e.message)}`, { parse_mode: 'MarkdownV2' });
    }
    return;
  }

  // ── Dashboard — Top-up Credits ────────────────────────────────────────────
  if (data === 'topup_credits') {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId, buildTCMessage(), {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ I Accept', callback_data: 'tc_accept_topup' },
          { text: '❌ I Decline', callback_data: 'tc_deny' },
        ]],
      },
    });
    return;
  }

  // ── Dashboard — Refresh ───────────────────────────────────────────────────
  if (data === 'refresh_account') {
    await bot.answerCallbackQuery(query.id, { text: 'Refreshing...' });
    await sendDashboard(chatId, userId, username);
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

    const status     = action === 'approve' ? 'approved' : 'denied';
    const reviewedBy = `@${query.from.username || String(query.from.id)}`;
    const adminNote  = `Action by ${reviewedBy} on ${fmtDate(new Date().toISOString())}`;

    let apiResult;
    try {
      apiResult = await apiPut(`/api/bot/purchase-requests/${reqIdNum}/status`, { status, adminNote, reviewedBy });
    } catch (e) {
      await bot.answerCallbackQuery(query.id, { text: `❌ Failed to update: ${e.message}`, show_alert: true });
      return;
    }

    await bot.answerCallbackQuery(query.id, { text: status === 'approved' ? '✅ Approved!' : '❌ Denied!' });

    // Edit the group message to remove action buttons
    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
      });
    } catch (_) {}

    // Determine request info for user notification
    const info = pendingInfo || (apiResult && apiResult.request ? {
      chatId:      apiResult.request.chatId,
      credits:     apiResult.request.credits,
      amountPHP:   apiResult.request.amountPHP,
      licenseKey:  apiResult.request.licenseKey,
      requestType: apiResult.request.requestType || 'topup',
    } : null);

    if (info && info.chatId) {
      if (status === 'approved') {
        const newLicenseKey = apiResult && apiResult.newLicenseKey ? apiResult.newLicenseKey : null;
        const creditAdded   = apiResult && apiResult.creditAdded === true;
        const reqType       = (info.requestType || apiResult?.request?.requestType || 'topup');

        if (reqType === 'new_registration' && newLicenseKey) {
          // New registration approved — send the generated license key
          await bot.sendMessage(info.chatId,
            [
              `🎉 *Welcome to AnasFlightsV2\\!*`,
              ``,
              `Your payment has been *APPROVED* and your account is ready\\!`,
              ``,
              `🎟 Credits purchased: *${escMd(String(info.credits))}*`,
              `💰 Amount: *${escMd(fmtPHP(info.amountPHP))}*`,
              ``,
              `🔑 *Your License Key:*`,
              `\`${escMd(newLicenseKey)}\``,
              ``,
              `⚠️ *Please save this key\\!* It is your account identifier\\.`,
              `Use /start to access your dashboard\\.`,
              ``,
              `Thank you for joining AnasFlightsV2\\! ✈️`,
            ].join('\n'),
            { parse_mode: 'MarkdownV2' }
          );
        } else {
          // Top-up approved
          const creditNote = creditAdded
            ? `✅ *${escMd(String(info.credits))} credits* have been added to your license\\.`
            : `⚠️ Credits could not be added automatically\\. Please contact support with your Request ID\\.`;

          // Fetch updated balance
          let updatedBalance = null;
          try {
            const licData = await apiGet(`/api/bot/licenses/check-telegram/${encodeURIComponent(userId)}`);
            if (licData && licData.registered) updatedBalance = licData.credits;
          } catch (_) {}

          const approvalLines = [
            `🎉 *Top\\-up Approved\\!*`,
            ``,
            `💰 Amount paid: *${escMd(fmtPHP(info.amountPHP))}*`,
            `🔑 License: \`${escMd(info.licenseKey || 'N/A')}\``,
            ``,
            creditNote,
          ];
          if (updatedBalance !== null) {
            approvalLines.push(`💳 *Updated balance: ${escMd(String(updatedBalance))} credits*`);
          }
          approvalLines.push(``, `Thank you for your purchase\\! ✈️`);

          await bot.sendMessage(info.chatId, approvalLines.join('\n'), { parse_mode: 'MarkdownV2' });
        }
      } else {
        // Denied
        const reason = (apiResult && apiResult.request && apiResult.request.adminNote)
          ? apiResult.request.adminNote
          : null;
        const denialLines = [
          `❌ *Your purchase request has been DENIED\\.*`,
          ``,
          `🎟 Credits: *${escMd(String(info.credits))}*`,
          `💰 Amount: *${escMd(fmtPHP(info.amountPHP))}*`,
        ];
        if (reason) {
          denialLines.push(``, `📝 *Reason:* ${escMd(reason)}`);
        }
        denialLines.push(
          ``,
          `If you believe this is a mistake, please contact support\\.`,
          `You may submit a new payment at any time using /start\\.`
        );
        await bot.sendMessage(info.chatId, denialLines.join('\n'), { parse_mode: 'MarkdownV2' });
      }
    }
    pendingApprovals.delete(reqIdNum);
    return;
  }
});

// ── Handle text and photo messages ────────────────────────────────────────────

bot.on('message', async (msg) => {
  if (!msg.from) return;

  const userId   = String(msg.from.id);
  const chatId   = msg.chat.id;
  const username = msg.from.username || msg.from.first_name || '';

  // ── Phase: awaiting existing license key ─────────────────────────────────
  if (awaitingExistingLicense.has(userId)) {
    if (!msg.text || msg.text.startsWith('/')) return;

    const licenseKey = msg.text.trim();

    if (!LICENSE_KEY_REGEX.test(licenseKey)) {
      await bot.sendMessage(chatId,
        `⚠️ Invalid license key format\\. Keys look like *LIC\\-XXXXXXXXXXXXXXXX*\\.\\n\\nPlease try again\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    // Try to link it
    try {
      await apiPost('/api/bot/licenses/register', {
        licenseKey,
        telegramUserId: userId,
        chatId: String(chatId),
        username,
      });
      awaitingExistingLicense.delete(userId);
      await bot.sendMessage(chatId,
        [
          `✅ *Account Linked Successfully\\!*`,
          ``,
          `🔑 License \`${escMd(licenseKey)}\` is now linked to your Telegram account\\.`,
          ``,
          `Loading your dashboard\\.\\.\\.`,
        ].join('\n'),
        { parse_mode: 'MarkdownV2' }
      );
      await sendDashboard(chatId, userId, username);
    } catch (e) {
      const errMsg = e.response && e.response.data && e.response.data.error
        ? e.response.data.error
        : e.message;
      // Do NOT delete from awaitingExistingLicense — let them retry
      await bot.sendMessage(chatId,
        [
          `❌ *Could not link license:* ${escMd(errMsg)}`,
          ``,
          `Please enter a valid license key, or use /start to go back\\.`,
        ].join('\n'),
        { parse_mode: 'MarkdownV2' }
      );
    }
    return;
  }

  // ── Phase 1: awaiting credit count ────────────────────────────────────────
  if (awaitingCreditCount.has(userId)) {
    if (!msg.text || msg.text.startsWith('/')) return;

    const pending = awaitingCreditCount.get(userId);
    const count = parseInt(msg.text.trim(), 10);

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

    await sendQRAndAskReceipt(chatId, userId, count, amountPHP, pending.requestType, pending.licenseKey);
    return;
  }

  // ── Phase 2: awaiting receipt photo ───────────────────────────────────────
  if (awaitingReceipt.has(userId)) {
    const pending = awaitingReceipt.get(userId);

    const hasPhoto    = Array.isArray(msg.photo) && msg.photo.length > 0;
    const hasDocument = msg.document != null;

    if (!hasPhoto && !hasDocument) {
      if (msg.text && !msg.text.startsWith('/')) {
        await bot.sendMessage(chatId,
          `📸 Please *send a photo* of your payment receipt as proof of payment\\.`,
          { parse_mode: 'MarkdownV2' }
        );
      }
      return;
    }

    awaitingReceipt.delete(userId);

    const fileId  = hasPhoto ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
    const isPhoto = hasPhoto;

    // Move to reference number phase
    awaitingReferenceNumber.set(userId, {
      credits:     pending.credits,
      amountPHP:   pending.amountPHP,
      requestType: pending.requestType,
      licenseKey:  pending.licenseKey || '',
      fileId,
      isPhoto,
    });

    await bot.sendMessage(chatId,
      [
        `✅ *Receipt received\\!*`,
        ``,
        `Please enter your GCash or bank *reference number* for verification\\.`,
        ``,
        `_If you don't have one, type_ *skip* _to continue without it\\._`,
      ].join('\n'),
      { parse_mode: 'MarkdownV2', reply_markup: { force_reply: true, input_field_placeholder: 'e.g. 123456789 or skip' } }
    );
    return;
  }

  // ── Phase 3: awaiting reference number ────────────────────────────────────
  if (awaitingReferenceNumber.has(userId)) {
    if (!msg.text || msg.text.startsWith('/')) return;

    const pending = awaitingReferenceNumber.get(userId);
    awaitingReferenceNumber.delete(userId);

    const referenceNumber = msg.text.trim().toLowerCase() === 'skip' ? '' : msg.text.trim();

    await submitPurchaseRequest(chatId, userId, username, {
      ...pending,
      referenceNumber,
    });
    return;
  }

  // ── No active state ────────────────────────────────────────────────────────
  if (msg.text && !msg.text.startsWith('/')) {
    await bot.sendMessage(chatId,
      `💡 Use /start to register or access your dashboard\\.`,
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
