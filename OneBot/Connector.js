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

const kernel = new Kernel({
  botName: BOT_NAME,
  codeRoot: CODE_ROOT,
  dataRoot: DATA_ROOT,
});

// Force-minimize Chrome window via CDP (fallback jika flag tidak berkesan)
async function minimizeBrowser(browser) {
  if (!browser) return;
  try {
    const pages = await browser.pages();
    const page = pages && pages[0];
    if (!page) return;
    const session = await page.target().createCDPSession();
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
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
      headless: false, // keep UI visible
      args: [
        '--start-minimized',          // auto-minimize on launch/restart
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        // Optional: keep small/off-screen if needed
        // '--window-position=9999,9999',
        // '--window-size=400,300',
      ],
    },
  });

  const sendDirect = async (chatId, text, options = {}) => {
    return client.sendMessage(chatId, text, options);
  };

  kernel.attachTransport({ sendDirect });

  client.on('qr', (qr) => {
    console.log('[connector] qr updated');
    if (qrcode) {
      qrcode.generate(qr, { small: true });
    } else {
      console.log('[connector] QR:', qr);
    }
    kernel.onEvent({ type: 'qr', qr, at: nowIso() });
  });

  client.on('authenticated', () => {
    console.log('[connector] authenticated');
    kernel.onEvent({ type: 'authenticated', at: nowIso() });
  });

  client.on('auth_failure', (msg) => {
    console.log('[connector] auth_failure:', msg);
    kernel.onEvent({ type: 'auth_failure', message: String(msg || ''), at: nowIso() });
  });

  client.on('ready', async () => {
    console.log('[connector] ready');
    kernel.onEvent({ type: 'ready', at: nowIso() });
    await minimizeBrowser(client.pupBrowser); // force minimize if flag not honored
  });

  client.on('disconnected', (reason) => {
    console.log('[connector] disconnected:', reason);
    kernel.onEvent({ type: 'disconnected', reason: String(reason || ''), at: nowIso() });
  });

  client.on('message', async (msg) => {
    try {
      await kernel.onMessage(msg);
    } catch (e) {
      console.error('[connector] message handler error:', e && e.stack ? e.stack : e);
    }
  });

  await kernel.init(); // load modules before WhatsApp starts
  await client.initialize();
}

main().catch((e) => {
  console.error('[connector] fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});