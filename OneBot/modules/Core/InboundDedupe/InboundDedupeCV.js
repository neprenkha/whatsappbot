'use strict';

// InboundDedupeCV
// Fix: do not drop burst media messages (pictures/documents) that have empty text.
// We include message id in the dedupe key when available, so each media item in a burst
// is treated uniquely while true duplicates (same id) are still dropped.

let _meta = null;
let _cfg = null;

let _enabled = true;
let _dedupeMs = 4000;
let _maxKeys = 8000;
let _logDrops = false;
let _hashForFromMe = true;
let _hashForCommands = true;

const _seen = new Map(); // key -> expiresAt

function toInt(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

function toBool(v, d) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'on') return true;
    if (s === '0' || s === 'false' || s === 'no' || s === 'n' || s === 'off') return false;
  }
  return d;
}

function safeStr(v) {
  return typeof v === 'string' ? v : '';
}

function getMsgId(raw) {
  try {
    if (!raw) return '';
    // whatsapp-web.js style
    if (raw.id) {
      if (typeof raw.id === 'string') return raw.id;
      if (raw.id._serialized) return String(raw.id._serialized);
      if (raw.id.id) return String(raw.id.id);
    }
    // some wrappers
    if (raw._data) {
      const id = raw._data.id;
      if (id) {
        if (typeof id === 'string') return id;
        if (id._serialized) return String(id._serialized);
        if (id.id) return String(id.id);
      }
    }
  } catch (_) {
    // ignore
  }
  return '';
}

function normalizeText(t) {
  const s = safeStr(t).trim();
  if (!s) return '';
  return s.replace(/\s+/g, ' ').toLowerCase();
}

function isCommand(text) {
  const s = safeStr(text).trim();
  return s.startsWith('!') || s.startsWith('/') || s.startsWith('#');
}

function makeKey(ev) {
  const chatId = safeStr(ev.chatId);
  const senderId = safeStr(ev.sender && ev.sender.id);
  const text = safeStr(ev.text);

  // Keep base behavior
  const fromMe = toBool(ev.fromMe, false);
  const hasMedia = toBool(ev.hasMedia, false);

  // quoted
  const quotedKey = safeStr(ev.quoted && (ev.quoted.id || ev.quoted.chatId || ''));

  // message id: this prevents dropping burst media with empty text
  const msgId = getMsgId(ev.raw);

  // text normalization, optionally skip dedupe for commands
  const textNorm = normalizeText(text);
  if (!_hashForCommands && isCommand(textNorm)) {
    return '';
  }

  // If not hashing fromMe, skip those
  if (!_hashForFromMe && fromMe) {
    return '';
  }

  // Priority: msgId if available; fallback to normalized content
  const core = msgId ? ('id:' + msgId) : ('txt:' + textNorm);

  return [
    'm',
    chatId,
    senderId,
    core,
    quotedKey,
    hasMedia ? '1' : '0',
    fromMe ? '1' : '0',
  ].join('|');
}

function prune(now) {
  if (_seen.size <= 0) return;
  // cheap pruning: remove expired keys until size below maxKeys or no expired keys found
  const keys = _seen.keys();
  for (let i = 0; i < 200; i++) {
    const k = keys.next();
    if (k.done) break;
    const exp = _seen.get(k.value) || 0;
    if (exp <= now) _seen.delete(k.value);
  }

  // hard cap
  if (_seen.size > _maxKeys) {
    const extra = _seen.size - _maxKeys;
    let removed = 0;
    for (const k of _seen.keys()) {
      _seen.delete(k);
      removed++;
      if (removed >= extra) break;
    }
  }
}

function log(level, msg, fields) {
  try {
    if (_meta && typeof _meta.log === 'function') {
      _meta.log('InboundDedupeV1', level, msg, fields || undefined);
    }
  } catch (_) {
    // ignore
  }
}

function init(meta, cfg) {
  _meta = meta;
  _cfg = cfg || {};

  _enabled = toBool(_cfg.enabled, true);
  _dedupeMs = Math.max(1, toInt(_cfg.dedupeSec, 4)) * 1000;
  _maxKeys = Math.max(100, toInt(_cfg.maxKeys, 8000));
  _logDrops = toBool(_cfg.logDrops, false);
  _hashForFromMe = toBool(_cfg.hashForFromMe, true);
  _hashForCommands = toBool(_cfg.hashForCommands, true);

  log('info', 'ready', {
    enabled: _enabled ? 1 : 0,
    dedupeSec: Math.floor(_dedupeMs / 1000),
    maxKeys: _maxKeys,
    logDrops: _logDrops ? 1 : 0,
    hashForFromMe: _hashForFromMe ? 1 : 0,
    hashForCommands: _hashForCommands ? 1 : 0,
  });

  return { ok: true };
}

function onMessage(ctx) {
  try {
    if (!_enabled) return { ok: true };

    const ev = ctx && ctx.message ? ctx.message : null;
    if (!ev) return { ok: true };

    const key = makeKey(ev);
    if (!key) return { ok: true };

    const now = Date.now();
    prune(now);

    const exp = _seen.get(key) || 0;
    if (exp > now) {
      if (_logDrops) {
        log('debug', 'drop duplicate', {
          chatId: safeStr(ev.chatId),
          fromMe: toBool(ev.fromMe, false) ? 1 : 0,
          hasMedia: toBool(ev.hasMedia, false) ? 1 : 0,
          text: safeStr(ev.text).slice(0, 80),
          key: key.slice(0, 120),
        });
      }
      return { ok: true, stopPropagation: true };
    }

    _seen.set(key, now + _dedupeMs);
    return { ok: true };
  } catch (e) {
    log('error', 'onMessage error', { err: String(e && e.message ? e.message : e) });
    return { ok: true };
  }
}

module.exports = {
  init,
  onMessage,
};
