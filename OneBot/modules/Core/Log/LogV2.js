'use strict';

const fs = require('fs');
const path = require('path');

function toInt(v, d) {
  const n = parseInt(String(v || ''), 10);
  return Number.isFinite(n) ? n : d;
}
function toBool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return d;
}
function toStr(v, d) {
  const s = (v === undefined || v === null) ? '' : String(v);
  return s === '' ? d : s;
}
function asciiSafe(s) {
  const str = String(s === undefined || s === null ? '' : s);
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    out += (c >= 32 && c <= 126) ? str[i] : '?';
  }
  return out;
}
function clamp(s, maxLen) {
  const str = String(s === undefined || s === null ? '' : s);
  if (maxLen <= 0) return '';
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

function levelNum(name, dflt) {
  const k = String(name || '').trim().toLowerCase();
  return LEVELS[k] !== undefined ? LEVELS[k] : dflt;
}

function formatLocalTs(d) {
  const pad = (n, w) => String(n).padStart(w, '0');
  return (
    pad(d.getFullYear(), 4) + '-' +
    pad(d.getMonth() + 1, 2) + '-' +
    pad(d.getDate(), 2) + ' ' +
    pad(d.getHours(), 2) + ':' +
    pad(d.getMinutes(), 2) + ':' +
    pad(d.getSeconds(), 2) + '.' +
    pad(d.getMilliseconds(), 3)
  );
}

function formatTzTs(d, timeZone) {
  // Keep simple and stable: use Intl if available, else local.
  try {
    const dtf = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const parts = dtf.formatToParts(d);
    const map = {};
    for (const p of parts) map[p.type] = p.value;
    return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  } catch (e) {
    return formatLocalTs(d);
  }
}

class LogV2 {
  constructor(meta, conf) {
    this.meta = meta || {};
    this.conf = conf || {};

    this.enabled = toBool(this.conf.enabled, true);

    this.tz = toStr(this.conf.tz, 'Asia/Kuala_Lumpur');

    this.fileEnabled = toBool(this.conf.fileEnabled, false);
    this.dir = toStr(this.conf.dir, '');
    this.mode = toStr(this.conf.mode, 'daily');
    this.fileLevel = levelNum(this.conf.fileLevel, LEVELS.info);

    this.consoleEnabled = toBool(this.conf.consoleEnabled, true);
    this.consoleLevel = levelNum(this.conf.consoleLevel, LEVELS.info);

    this.logMessages = toBool(this.conf.logMessages, false);
    this.logEvents = toBool(this.conf.logEvents, false);

    this.messagePreviewLen = toInt(this.conf.messagePreviewLen, 160);
    this.metaMaxLen = toInt(this.conf.metaMaxLen, 600);

    this.asciiOnly = toBool(this.conf.asciiOnly, true);
    this.redactPhone = toBool(this.conf.redactPhone, false);

    this.purgeDays = toInt(this.conf.purgeDays, 0);

    this.currentDateKey = null;
    this.stream = null;
    this.pending = [];
    this.flushing = false;

    if (this.enabled && this.fileEnabled && this.dir) {
      this.ensureDir(this.dir);
      if (this.purgeDays > 0) this.purgeOldFilesSafe(this.dir, this.purgeDays);
    }

    this.logInfo('LogV2', `ready fileEnabled=${this.fileEnabled ? 1 : 0} dir=${this.dir || '(none)'} mode=${this.mode} tz=${this.tz} logEvents=${this.logEvents ? 1 : 0} logMessages=${this.logMessages ? 1 : 0}`);
  }

  ensureDir(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      // If cannot create, disable file output safely
      this.fileEnabled = false;
      this.dir = '';
      this.logWarn('LogV2', `file disabled (mkdir failed) err=${asciiSafe(e && e.message ? e.message : e)}`);
    }
  }

  purgeOldFilesSafe(dir, days) {
    try {
      const now = Date.now();
      const maxAge = days * 86400000;
      const files = fs.readdirSync(dir);
      for (const f of files) {
        const full = path.join(dir, f);
        let st;
        try { st = fs.statSync(full); } catch (_) { continue; }
        if (!st.isFile()) continue;
        if (now - st.mtimeMs > maxAge) {
          try { fs.unlinkSync(full); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  getDateKey(d) {
    if (this.mode === 'daily') {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    // fallback daily
    return this.getDateKey(new Date(d.getTime()));
  }

  getFilePath(dateKey) {
    const base = `onebot-${dateKey}.log`;
    return path.join(this.dir, base);
  }

  ensureStream(d) {
    if (!this.fileEnabled || !this.dir) return;
    const key = this.getDateKey(d);
    if (this.currentDateKey === key && this.stream) return;
    this.currentDateKey = key;
    if (this.stream) {
      try { this.stream.end(); } catch (_) {}
      this.stream = null;
    }
    const fp = this.getFilePath(key);
    try {
      this.stream = fs.createWriteStream(fp, { flags: 'a' });
    } catch (e) {
      this.fileEnabled = false;
      this.stream = null;
      this.logWarn('LogV2', `file disabled (open failed) err=${asciiSafe(e && e.message ? e.message : e)}`);
    }
  }

  enqueueLine(line) {
    if (!this.fileEnabled || !this.dir) return;
    this.pending.push(line);
    if (!this.flushing) {
      this.flushing = true;
      setImmediate(() => this.flush());
    }
  }

  flush() {
    this.flushing = false;
    if (!this.pending.length) return;
    const chunk = this.pending.join('');
    this.pending.length = 0;
    const d = new Date();
    this.ensureStream(d);
    if (!this.stream) return;
    try {
      this.stream.write(chunk);
    } catch (_) {}
  }

  emit(levelName, tag, message, metaObj) {
    const d = new Date();
    const ts = formatTzTs(d, this.tz);
    const lvl = String(levelName || 'info').toLowerCase();
    const lvlN = levelNum(lvl, LEVELS.info);

    const cleanTag = this.asciiOnly ? asciiSafe(tag) : String(tag || '');
    const cleanMsg = this.asciiOnly ? asciiSafe(message) : String(message || '');

    let metaStr = '';
    if (metaObj !== undefined) {
      try {
        metaStr = JSON.stringify(metaObj);
      } catch (e) {
        metaStr = '{"meta":"unstringifiable"}';
      }
      metaStr = clamp(metaStr, this.metaMaxLen);
      metaStr = this.asciiOnly ? asciiSafe(metaStr) : metaStr;
    }

    const line = `${ts} [${lvl}] [${cleanTag}] ${cleanMsg}${metaStr ? ' meta=' + metaStr : ''}\n`;

    if (this.consoleEnabled && lvlN <= this.consoleLevel) {
      // Use kernel meta.log if present (keeps style consistent)
      if (this.meta && typeof this.meta.log === 'function') {
        this.meta.log(`${cleanTag}`, `${lvl} ${cleanMsg}${metaStr ? ' meta=' + metaStr : ''}`);
      } else {
        // fallback
        console.log(line.trimEnd());
      }
    }

    if (this.fileEnabled && lvlN <= this.fileLevel) {
      this.enqueueLine(line);
    }
  }

  logInfo(tag, msg, meta) { this.emit('info', tag, msg, meta); }
  logWarn(tag, msg, meta) { this.emit('warn', tag, msg, meta); }
  logError(tag, msg, meta) { this.emit('error', tag, msg, meta); }
  logDebug(tag, msg, meta) { this.emit('debug', tag, msg, meta); }

  safeSender(sender) {
    const s = sender || {};
    const phone = this.redactPhone && s.phone ? (String(s.phone).slice(0, 4) + '****' + String(s.phone).slice(-2)) : (s.phone || '');
    return {
      id: s.id || '',
      phone: phone || '',
      lid: s.lid || '',
      name: s.name || '',
    };
  }

  onMsg(ctx) {
    const chatId = ctx.chatId || '';
    const isGroup = ctx.isGroup ? 1 : 0;
    const sender = this.safeSender(ctx.sender);
    const text = clamp(ctx.text || '', this.messagePreviewLen);

    this.logInfo('msg', `chatId=${chatId} isGroup=${isGroup} sender=${JSON.stringify(sender)} text=${JSON.stringify(text)}`, {
      chatId,
      isGroup: !!ctx.isGroup,
      sender,
    });
  }

  onEvent(ctx) {
    const ev = ctx.event || '';
    const keys = Object.keys(ctx || {}).join(',');
    this.logInfo('event', `event=${ev} keys=${keys}`);
  }

  build() {
    const self = this;

    if (!this.enabled) {
      return {
        onEvent: async function noop() {},
      };
    }

    return {
      onEvent: async function onEvent(ctx) {
        if (!ctx) return;

        // Only tap when configured
        if (ctx.event === 'msg') {
          if (self.logMessages) self.onMsg(ctx);
          return;
        }
        if (self.logEvents) self.onEvent(ctx);
      },
    };
  }
}

module.exports = LogV2;
