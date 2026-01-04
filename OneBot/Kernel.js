'use strict';

/**
 * OneBot Kernel (Foundation - Freeze)
 * - Thin router + module loader
 * - Loads modules by scanning:
 *     %DATA_ROOT%\bots\%BOT_NAME%\config\modules\Core\*.conf
 *     %DATA_ROOT%\bots\%BOT_NAME%\config\modules\Features\*.conf
 * - NO business logic, NO commands
 */

const fs = require('fs');
const path = require('path');

function safeReadText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return '';
  }
}

function ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
}

function parseConf(text) {
  const out = {};
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    out[k] = v;
  }
  return out;
}

function toInt(v, def = 0) {
  const n = parseInt(String(v || '').trim(), 10);
  return Number.isFinite(n) ? n : def;
}

function asBool(v, def = false) {
  const s = String(v || '').trim();
  if (!s) return def;
  return s === '1' || s.toLowerCase() === 'true' || s.toLowerCase() === 'yes';
}

function nowIso() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function normalizePhoneDigits(s) {
  const digits = String(s || '').replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.startsWith('60')) return digits;
  if (digits.startsWith('0')) return '60' + digits.slice(1);
  return digits;
}

class Kernel {
  constructor({ botName, codeRoot, dataRoot }) {
    this.botName = botName;
    this.codeRoot = codeRoot;
    this.dataRoot = dataRoot;
    this.modules = [];
    this.services = {};
    this.transport = { sendDirect: null };
    this._inited = false;
  }

  attachTransport({ sendDirect }) {
    if (typeof sendDirect === 'function') this.transport.sendDirect = sendDirect;
  }

  log(tag, msg) {
    console.log(`${nowIso()} [${tag}] ${msg}`);
  }

  confRoot() {
    return path.join(this.dataRoot, 'bots', this.botName, 'config');
  }

  dataRootBot() {
    return path.join(this.dataRoot, 'bots', this.botName, 'data');
  }

  loadConfRel(relPath) {
    const abs = path.isAbsolute(relPath) ? relPath : path.join(this.confRoot(), relPath);
    const txt = safeReadText(abs);
    return { absPath: abs, conf: parseConf(txt) };
  }

  scanModuleConfs() {
    const coreDir = path.join(this.confRoot(), 'modules', 'Core');
    const featDir = path.join(this.confRoot(), 'modules', 'Features');

    const list = [];
    for (const dir of [coreDir, featDir]) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.conf'));
      for (const f of files) {
        const abs = path.join(dir, f);
        const conf = parseConf(safeReadText(abs));
        conf.__confPath = abs;
        list.push(conf);
      }
    }
    return list;
  }

  async init() {
    if (this._inited) return;
    this._inited = true;

    ensureDir(this.confRoot());
    ensureDir(path.join(this.confRoot(), 'modules', 'Core'));
    ensureDir(path.join(this.confRoot(), 'modules', 'Features'));
    ensureDir(this.dataRootBot());

    this.services.transport = {
      sendDirect: async (chatId, text, options = {}) => {
        if (!this.transport.sendDirect) throw new Error('transport.sendDirect not attached');
        return this.transport.sendDirect(chatId, text, options);
      },
    };

    const moduleConfs = this.scanModuleConfs()
      .filter((c) => asBool(c.enabled, false))
      .map((c) => {
        const id = String(c.id || '').trim();
        const file = String(c.file || '').trim();
        const cfg = String(c.config || '').trim();
        const prio = toInt(c.priority, 0);
        return { id, file, config: cfg, priority: prio, raw: c };
      })
      .filter((m) => m.id && m.file);

    moduleConfs.sort((a, b) => b.priority - a.priority);

    for (const m of moduleConfs) {
      await this._loadModule(m);
    }

    this.log('kernel', `ready modules=${this.modules.length}`);
  }

  async _loadModule({ id, file, config, priority, raw }) {
    const absFile = path.isAbsolute(file) ? file : path.join(this.codeRoot, file);
    let mod;
    try {
      mod = require(absFile);
    } catch (e) {
      this.log('kernel', `module.load_failed id=${id} file=${file} err=${e && e.message ? e.message : e}`);
      return;
    }

    const hubCfg = config ? this.loadConfRel(config) : { absPath: '', conf: {} };

    const meta = {
      id,
      priority,
      botName: this.botName,
      codeRoot: this.codeRoot,
      dataRoot: this.dataRoot,
      confRoot: this.confRoot(),
      dataRootBot: this.dataRootBot(),
      moduleConf: raw,
      hubConf: hubCfg.conf,
      hubConfPath: hubCfg.absPath,
      loadConfRel: (p) => this.loadConfRel(p),
      log: (tag, msg) => this.log(tag, msg),
      registerService: (name, impl) => { if (name) this.services[name] = impl; },
      getService: (name) => this.services[name],
    };

    const instance = typeof mod.init === 'function' ? await mod.init(meta) : null;
    if (!instance) {
      this.log('kernel', `module.init_failed id=${id} file=${file}`);
      return;
    }

    this.modules.push({
      id,
      priority,
      file,
      onEvent: typeof instance.onEvent === 'function' ? instance.onEvent : null,
      onMessage: typeof instance.onMessage === 'function' ? instance.onMessage : null,
    });

    this.log('kernel', `module.loaded id=${id} file=${file} prio=${priority}`);
  }

  _buildCtxFromMsg(msg) {
    const chatId = msg.from || '';
    const isGroup = String(chatId).endsWith('@g.us');
    const body = typeof msg.body === 'string' ? msg.body : '';
    const senderId = isGroup ? (msg.author || '') : (msg.from || '');
    const pushName = msg._data && msg._data.notifyName ? msg._data.notifyName : (msg._data && msg._data.pushname ? msg._data.pushname : '');
    const lid = msg._data && msg._data.sender && msg._data.sender.lid ? String(msg._data.sender.lid) : (msg.lid ? String(msg.lid) : '');

    const senderPhone = normalizePhoneDigits(senderId);

    const ctx = {
      event: 'message',
      at: nowIso(),
      message: msg,
      text: body,
      chatId,
      isGroup,
      sender: {
        id: senderId,
        phone: senderPhone,
        lid: String(lid || '').replace(/[^\d]/g, ''),
        name: pushName || '',
      },
      botName: this.botName,
      codeRoot: this.codeRoot,
      dataRoot: this.dataRoot,
      services: this.services,
      stop: false,
      stopPropagation: () => { ctx.stop = true; },
      reply: async (text, options = {}) => {
        const send = this.services.send;
        if (typeof send === 'function') return send(chatId, text, options);
        return this.services.transport.sendDirect(chatId, text, options);
      },
    };

    return ctx;
  }

  async onMessage(msg) {
    const ctx = this._buildCtxFromMsg(msg);
    for (const m of this.modules) {
      if (ctx.stop) break;
      if (!m.onMessage) continue;
      try {
        await m.onMessage(ctx);
      } catch (e) {
        this.log('kernel', `module.msg_error id=${m.id} err=${e && e.message ? e.message : e}`);
      }
    }
  }

  async onEvent(evt) {
    const ctx = {
      event: 'event',
      at: nowIso(),
      data: evt,
      botName: this.botName,
      codeRoot: this.codeRoot,
      dataRoot: this.dataRoot,
      services: this.services,
      stop: false,
      stopPropagation: () => { ctx.stop = true; },
    };

    for (const m of this.modules) {
      if (ctx.stop) break;
      if (!m.onEvent) continue;
      try {
        await m.onEvent(ctx);
      } catch (e) {
        this.log('kernel', `module.event_error id=${m.id} err=${e && e.message ? e.message : e}`);
      }
    }
  }
}

module.exports = Kernel;
