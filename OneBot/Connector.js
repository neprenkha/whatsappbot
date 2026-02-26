'use strict';

/**
 * OneBot Connector (Foundation - Freeze)
 * - WhatsApp Web connector only: login + forward raw message/events to Kernel
 * - NO business logic, NO commands, NO hardcoded modules
 *
 * Requirements:
 *   npm i whatsapp-web.js qrcode-terminal
 */

const path = require('path');
const fs = require('fs');

let Client, LocalAuth;
try {
  ({ Client, LocalAuth } = require('whatsapp-web.js'));
} catch (e) {
  console.error('[connector] Missing dependency whatsapp-web.js. Install it in X:\\OneBot (npm i whatsapp-web.js).');
  process.exit(2);
}

let qrcode;
try {
  qrcode = require('qrcode-terminal');
} catch (e) {
  qrcode = null;
}

const Kernel = require('./Kernel');

const BOT_NAME = (process.env.BOT_NAME || 'ONEBOT').trim();
const CODE_ROOT = (process.env.CODE_ROOT || __dirname).trim();
const DATA_ROOT = (process.env.DATA_ROOT || 'X:\\OneData').trim();
const TRACE_INBOUND = String(process.env.ONEBOT_TRACE_INBOUND || '').trim() === '1';

const botDataRoot = path.join(DATA_ROOT, 'bots', BOT_NAME);
const sessionRoot = path.join(botDataRoot, 'session');
const qrRoot = path.join(botDataRoot, 'qr');

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
}
ensureDir(sessionRoot);
ensureDir(qrRoot);

function nowIso() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function traceInbound(eventName, result, msg, err) {
  if (!TRACE_INBOUND) return;
  try {
    const m = msg || {};
    const chatId = String(m.from || '');
    const fromMe = m && m.fromMe ? 1 : 0;
    const isGroup = chatId.endsWith('@g.us') ? 1 : 0;
    const msgId = String((m.id && m.id._serialized) || m.id || '');
    const msgType = String((m.type || (m._data && m._data.type) || ''));
    const textLen = typeof m.body === 'string' ? m.body.length : 0;
    let line = '[connector][trace] eventName=' + String(eventName || '') +
      ' result=' + String(result || '') +
      ' chatId=' + chatId +
      ' fromMe=' + fromMe +
      ' isGroup=' + isGroup +
      ' msgId=' + msgId +
      ' msgType=' + msgType +
      ' textLen=' + textLen;
    if (err) {
      line += ' err=' + String(err && err.message ? err.message : err);
    }
    console.log(line);
  } catch (traceErr) {
    console.error('[connector][trace] eventName=trace result=error chatId= fromMe=0 isGroup=0 msgId= msgType= textLen=0 err=' + String(traceErr && traceErr.message ? traceErr.message : traceErr));
  }
}

const kernel = new Kernel({
  botName: BOT_NAME,
  codeRoot: CODE_ROOT,
  dataRoot: DATA_ROOT,
});

// Force-minimize Chrome window via CDP (fallback if flag does not work)
async function minimizeBrowser(browser) {
  if (!browser) return;
  try {
    const pages = await browser.pages();
    const page = pages && pages[0];
    if (!page) return;
    const session = await page.target().createCDPSession();
    const x = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', { windowId: x.windowId, bounds: { windowState: 'minimized' } });
    console.log('[connector] browser minimized via CDP');
  } catch (e) {
    console.log('[connector] minimize via CDP failed:', e && e.message ? e.message : e);
  }
}

async function main() {
  console.log('========================');
  console.log('ONEBOT START');
  console.log('Bot :', BOT_NAME);
  console.log('Code:', CODE_ROOT);
  console.log('Data:', DATA_ROOT);
  console.log('========================');

  console.log('[connector] initializing...');

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: BOT_NAME, dataPath: sessionRoot }),
    puppeteer: {
      headless: false,
      args: [
        '--start-minimized',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    },
  });

  function sanitizeTransportOptions(options) {
    const optIn = options && typeof options === 'object' ? options : {};
    const opts = Object.assign({}, optIn);

    const internalKeys = new Set([
      'manualReply',
      'allowOutsideWindow',
      'bypassWindow',
      'bypassRateLimit',
      'moduleLog',
      'bugLog',
      'detailLog',
      'traceLog',
      'trace',
      'debug',
    ]);

    for (const key of Object.keys(opts)) {
      if (internalKeys.has(key)) delete opts[key];
    }

    if (opts.sendSeen === undefined || opts.sendSeen === null) opts.sendSeen = false;
    return opts;
  }

  const sendDirect = async (chatId, payload, options) => {
    const outChatId = typeof chatId === 'string' ? chatId.trim() : '';
    if (!outChatId) {
      const err = new Error('transport.invalid_chatId');
      err.code = 'transport.invalid_chatId';
      throw err;
    }

    let outPayload = payload;
    if (typeof payload === 'string') {
      outPayload = payload.trim();
      if (!outPayload) {
        const err = new Error('transport.empty_body');
        err.code = 'transport.empty_body';
        throw err;
      }
    }

    const opts = sanitizeTransportOptions(options);

    try {
      return await client.sendMessage(outChatId, outPayload, opts);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e || 'unknown_error');
      const err = new Error('transport.send_failed: ' + msg);
      err.code = 'transport.send_failed';
      throw err;
    }
  };

  kernel.attachTransport({ sendDirect });

  const runtimeState = {
    authenticatedAt: 0,
    readyAt: 0,
    waState: '',
    loadingPercent: -1,
    loadingMessage: '',
    watchdogTimer: null,
  };

  function clearReadyWatchdog() {
    if (runtimeState.watchdogTimer) {
      clearTimeout(runtimeState.watchdogTimer);
      runtimeState.watchdogTimer = null;
    }
  }

  function scheduleReadyWatchdog() {
    clearReadyWatchdog();
    runtimeState.watchdogTimer = setTimeout(() => {
      if (runtimeState.readyAt > 0) return;
      const sinceAuthMs = runtimeState.authenticatedAt > 0 ? (Date.now() - runtimeState.authenticatedAt) : -1;
      console.warn('[connector] ready_watchdog timeout=60000 ready=0 sinceAuthMs=' + String(sinceAuthMs) + ' state=' + String(runtimeState.waState || '') + ' loading=' + String(runtimeState.loadingPercent) + ' loadingMsg=' + String(runtimeState.loadingMessage || ''));
    }, 60000);
  }

  function attachBrowserDiagnostics(browser) {
    if (!browser || browser.__onebotDiagAttached) return;
    browser.__onebotDiagAttached = true;

    try {
      browser.on('disconnected', () => {
        console.warn('[connector] browser.disconnected');
      });
    } catch (_) {}

    try {
      browser.on('targetcreated', async (target) => {
        try {
          const type = String(target && target.type ? target.type() : '');
          if (type !== 'page') return;
          const page = await target.page();
          if (!page || page.__onebotDiagAttached) return;
          page.__onebotDiagAttached = true;

          page.on('pageerror', (err) => {
            console.warn('[connector] page.pageerror err=' + String(err && err.message ? err.message : err));
          });
          page.on('error', (err) => {
            console.warn('[connector] page.error err=' + String(err && err.message ? err.message : err));
          });
          page.on('console', (msg) => {
            try {
              const t = String(msg && msg.type ? msg.type() : 'log');
              const text = String(msg && msg.text ? msg.text() : '');
              if (!text) return;
              if (text.indexOf('webpack') >= 0 || text.indexOf('DevTools') >= 0) return;
              console.log('[connector] page.console type=' + t + ' text=' + text);
            } catch (_) {}
          });
        } catch (_) {}
      });
    } catch (_) {}
  }

  client.on('qr', (qr) => {
    console.log('[connector] qr updated');
    if (qrcode) qrcode.generate(qr, { small: true });
    else console.log('[connector] QR:', qr);
    kernel.onEvent({ type: 'qr', qr, at: nowIso() });
  });

  client.on('authenticated', () => {
    runtimeState.authenticatedAt = Date.now();
    console.log('[connector] authenticated');
    scheduleReadyWatchdog();
    kernel.onEvent({ type: 'authenticated', at: nowIso() });
  });

  client.on('auth_failure', (msg) => {
    clearReadyWatchdog();
    console.log('[connector] auth_failure:', msg);
    kernel.onEvent({ type: 'auth_failure', message: String(msg || ''), at: nowIso() });
  });

  client.on('ready', async () => {
    runtimeState.readyAt = Date.now();
    clearReadyWatchdog();
    console.log('[connector] ready');
    kernel.onEvent({ type: 'ready', at: nowIso() });
    attachBrowserDiagnostics(client.pupBrowser);
    await minimizeBrowser(client.pupBrowser);
  });

  client.on('disconnected', (reason) => {
    clearReadyWatchdog();
    console.log('[connector] disconnected:', reason);
    kernel.onEvent({ type: 'disconnected', reason: String(reason || ''), at: nowIso() });
  });

  client.on('change_state', (state) => {
    runtimeState.waState = String(state || '');
    console.log('[connector] state=' + runtimeState.waState);
  });

  client.on('loading_screen', (percent, message) => {
    runtimeState.loadingPercent = Number.isFinite(Number(percent)) ? Number(percent) : -1;
    runtimeState.loadingMessage = String(message || '');
    console.log('[connector] loading_screen percent=' + String(runtimeState.loadingPercent) + ' msg=' + runtimeState.loadingMessage);
  });

  const inboundSeen = new Map();

  function msgKey(msg) {
    try {
      if (!msg) return '';
      if (msg.id && msg.id._serialized) return String(msg.id._serialized);
      if (msg.id) return String(msg.id);
      if (msg._data && msg._data.id && msg._data.id._serialized) return String(msg._data.id._serialized);
      return '';
    } catch (_) {
      return '';
    }
  }

  function shouldForwardMessage(msg) {
    const key = msgKey(msg);
    if (!key) return true;
    const now = Date.now();

    for (const [k, exp] of inboundSeen.entries()) {
      if (exp <= now) inboundSeen.delete(k);
    }

    const exp = inboundSeen.get(key) || 0;
    if (exp > now) return false;
    inboundSeen.set(key, now + 10000);
    return true;
  }

  async function forwardInbound(eventName, msg) {
    if (!shouldForwardMessage(msg)) {
      traceInbound(eventName, 'dedupe', msg, null);
      return;
    }
    try {
      await kernel.onMessage(msg);
      traceInbound(eventName, 'forward', msg, null);
    } catch (e) {
      traceInbound(eventName, 'error', msg, e);
      console.error('[connector] ' + eventName + ' handler error:', e && e.stack ? e.stack : e);
    }
  }

  client.on('message', async (msg) => {
    await forwardInbound('message', msg);
  });

  client.on('message_create', async (msg) => {
    await forwardInbound('message_create', msg);
  });

  await kernel.init();
  await client.initialize();
}

main().catch((e) => {
  console.error('[connector] fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
