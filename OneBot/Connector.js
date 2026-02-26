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
const TRACE_DIAG = TRACE_INBOUND || String(process.env.ONEBOT_TRACE_DIAG || '').trim() === '1';
const READY_WATCHDOG_MS = (function () {
  const n = parseInt(String(process.env.ONEBOT_READY_WATCHDOG_MS || ''), 10);
  return Number.isFinite(n) && n >= 5000 ? n : 60000;
})();

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

function traceInbound(stage, eventName, msg, err) {
  if (!TRACE_INBOUND) return;
  try {
    const m = msg || {};
    const chatId = String(m.from || '');
    const fromMe = m && m.fromMe ? 1 : 0;
    const isGroup = chatId.endsWith('@g.us') ? 1 : 0;
    const msgId = String((m.id && m.id._serialized) || m.id || '');
    const msgType = String((m.type || (m._data && m._data.type) || ''));
    const textLen = typeof m.body === 'string' ? m.body.length : 0;
    let line = '[connector][trace] stage=' + String(stage || '') +
      ' eventName=' + String(eventName || '') +
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
    console.error('[connector][trace] stage=error eventName=trace chatId= fromMe=0 isGroup=0 msgId= msgType= textLen=0 err=' + String(traceErr && traceErr.message ? traceErr.message : traceErr));
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

  const runtime = {
    authAt: 0,
    readyAt: 0,
    readyFired: 0,
    lastState: '',
    lastLoadingPct: -1,
    lastLoadingMsg: '',
    diagAttached: 0,
  };

  function logDiag(line) {
    if (!TRACE_DIAG) return;
    console.log('[connector] ' + line);
  }

  function startReadyWatchdog() {
    const startedAt = Date.now();
    setTimeout(async () => {
      if (runtime.readyFired) return;
      let state = '';
      try {
        if (client && typeof client.getState === 'function') {
          state = String(await client.getState());
        }
      } catch (_) {
        state = '';
      }
      const sinceAuthMs = runtime.authAt ? (Date.now() - runtime.authAt) : (Date.now() - startedAt);
      const loading = (runtime.lastLoadingPct >= 0) ? String(runtime.lastLoadingPct) : '';
      const loadingMsg = runtime.lastLoadingMsg ? runtime.lastLoadingMsg : '';
      console.log('[connector] ready_watchdog timeoutMs=' + READY_WATCHDOG_MS +
        ' ready=0 sinceAuthMs=' + sinceAuthMs +
        ' state=' + (state || runtime.lastState || '') +
        ' loadingPct=' + loading +
        ' loadingMsg=' + loadingMsg);
    }, READY_WATCHDOG_MS);
  }

  async function tryAttachPuppeteerDiagnostics() {
    if (runtime.diagAttached) return;
    const page = client && (client.pupPage || null);
    if (!page) return;
    runtime.diagAttached = 1;

    try {
      page.on('pageerror', (err) => {
        const msg = err && err.message ? err.message : String(err || '');
        console.log('[connector] pageerror ' + msg);
      });
    } catch (_) {}

    try {
      page.on('error', (err) => {
        const msg = err && err.message ? err.message : String(err || '');
        console.log('[connector] page_error ' + msg);
      });
    } catch (_) {}

    try {
      page.on('console', (msg) => {
        try {
          const type = msg && typeof msg.type === 'function' ? String(msg.type()) : '';
          if (type !== 'error' && type !== 'warning') return;
          const text = msg && typeof msg.text === 'function' ? String(msg.text()) : '';
          console.log('[connector] page_console type=' + type + ' text=' + text);
        } catch (_) {}
      });
    } catch (_) {}

    logDiag('puppeteer_diag attached=1');
  }

  function startDiagPoller() {
    if (runtime.diagAttached) return;
    let tries = 0;
    const t = setInterval(async () => {
      tries += 1;
      try {
        await tryAttachPuppeteerDiagnostics();
      } catch (_) {}
      if (runtime.diagAttached || tries >= 120) {
        clearInterval(t);
      }
    }, 1000);
  }

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

  client.on('qr', (qr) => {
    console.log('[connector] qr updated');
    if (qrcode) qrcode.generate(qr, { small: true });
    else console.log('[connector] QR:', qr);
    kernel.onEvent({ type: 'qr', qr, at: nowIso() });
  });

  client.on('authenticated', () => {
    runtime.authAt = Date.now();
    console.log('[connector] authenticated');
    kernel.onEvent({ type: 'authenticated', at: nowIso() });
    startReadyWatchdog();
    startDiagPoller();
  });

  client.on('auth_failure', (msg) => {
    console.log('[connector] auth_failure:', msg);
    kernel.onEvent({ type: 'auth_failure', message: String(msg || ''), at: nowIso() });
  });

  client.on('change_state', (state) => {
    runtime.lastState = String(state || '');
    logDiag('change_state state=' + runtime.lastState);
    kernel.onEvent({ type: 'change_state', state: runtime.lastState, at: nowIso() });
  });

  client.on('loading_screen', (percent, message) => {
    const pct = parseInt(String(percent || ''), 10);
    const msg = String(message || '');
    const bucket = Number.isFinite(pct) ? Math.floor(pct / 10) : -1;
    const lastBucket = (runtime.lastLoadingPct >= 0) ? Math.floor(runtime.lastLoadingPct / 10) : -2;
    if (bucket !== lastBucket || msg !== runtime.lastLoadingMsg) {
      runtime.lastLoadingPct = Number.isFinite(pct) ? pct : runtime.lastLoadingPct;
      runtime.lastLoadingMsg = msg;
      logDiag('loading_screen percent=' + String(percent) + ' message=' + msg);
    }
  });

  client.on('remote_session_saved', () => {
    logDiag('remote_session_saved');
  });

  client.on('ready', async () => {
    runtime.readyFired = 1;
    runtime.readyAt = Date.now();
    console.log('[connector] ready');
    kernel.onEvent({ type: 'ready', at: nowIso() });
    await minimizeBrowser(client.pupBrowser);
  });

  client.on('disconnected', (reason) => {
    console.log('[connector] disconnected:', reason);
    kernel.onEvent({ type: 'disconnected', reason: String(reason || ''), at: nowIso() });
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
    traceInbound('received', eventName, msg, null);
    if (!shouldForwardMessage(msg)) {
      traceInbound('dedupe', eventName, msg, null);
      return;
    }
    try {
      traceInbound('forward', eventName, msg, null);
      await kernel.onMessage(msg);
    } catch (e) {
      traceInbound('error', eventName, msg, e);
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