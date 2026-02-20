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
    if (TRACE_INBOUND) {
      console.error('[connector][trace] stage=error eventName=trace chatId= fromMe=0 isGroup=0 msgId= msgType= textLen=0 err=' + String(traceErr && traceErr.message ? traceErr.message : traceErr));
    }
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

  let transportReady = false;

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

    if (!transportReady) {
      const err = new Error('transport.not_ready');
      err.code = 'transport.not_ready';
      err.waitMs = 2000;
      throw err;
    }

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
    console.log('[connector] authenticated');
    kernel.onEvent({ type: 'authenticated', at: nowIso() });
  });

  client.on('auth_failure', (msg) => {
    transportReady = false;
    console.log('[connector] auth_failure:', msg);
    kernel.onEvent({ type: 'auth_failure', message: String(msg || ''), at: nowIso() });
  });

  client.on('ready', async () => {
    transportReady = true;
    console.log('[connector] ready');
    kernel.onEvent({ type: 'ready', at: nowIso() });
    await minimizeBrowser(client.pupBrowser);
  });

  client.on('disconnected', (reason) => {
    transportReady = false;
    console.log('[connector] disconnected:', reason);
    kernel.onEvent({ type: 'disconnected', reason: String(reason || ''), at: nowIso() });
  });

  client.on('message', async (msg) => {
    traceInbound('received', 'message', msg, null);
    try {
      traceInbound('forward', 'message', msg, null);
      await kernel.onMessage(msg);
    } catch (e) {
      traceInbound('error', 'message', msg, e);
      console.error('[connector] message handler error:', e && e.stack ? e.stack : e);
    }
  });

  client.on('message_create', async (msg) => {
    if (!(msg && msg.fromMe === true)) return;
    traceInbound('received', 'message_create', msg, null);
    try {
      traceInbound('forward', 'message_create', msg, null);
      await kernel.onMessage(msg);
    } catch (e) {
      traceInbound('error', 'message_create', msg, e);
      console.error('[connector] message_create handler error:', e && e.stack ? e.stack : e);
    }
  });

  await kernel.init();
  await client.initialize();
}

main().catch((e) => {
  console.error('[connector] fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
