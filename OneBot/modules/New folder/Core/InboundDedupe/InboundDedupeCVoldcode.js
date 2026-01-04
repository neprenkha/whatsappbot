'use strict';

// InboundDedupeCV.js
// Drop duplicate inbound messages within a short window.
// NOTE: ctx.at is a processing timestamp (changes every dispatch). Prefer message timestamp/id for dedupe.

const crypto = require('crypto');

function toInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function toBool(v, def) {
  if (v === undefined || v === null || v === '') return !!def;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return !!def;
}

function safeStr(v) {
  if (v === undefined || v === null) return '';
  return (typeof v === 'string') ? v : String(v);
}

function normalizeChatId(chatId) {
  chatId = safeStr(chatId);
  if (!chatId) return '';
  if (chatId === 'status@broadcast') return chatId;
  const at = chatId.indexOf('@');
  return at > 0 ? chatId.substring(0, at) : chatId;
}


function hashKey(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function getMsgId(ctx) {
  const m = (ctx && (ctx.message || ctx.raw)) || null;
  if (!m) return '';
  try {
    if (m.id) {
      if (typeof m.id === 'string') return m.id;
      if (m.id._serialized) return safeStr(m.id._serialized);
      if (m.id.id) return safeStr(m.id.id);
    }
    const d = m._data || null;
    if (d && d.id) {
      if (typeof d.id === 'string') return d.id;
      if (d.id._serialized) return safeStr(d.id._serialized);
      if (d.id.id) return safeStr(d.id.id);
    }
  } catch (_) {}
  return '';
}

function getMsgTs(ctx) {
  const m = (ctx && (ctx.message || ctx.raw)) || null;
  if (!m) return '';
  try {
    // whatsapp-web.js commonly uses seconds epoch on msg.timestamp or msg._data.t
    const ts = m.timestamp || (m._data && (m._data.t || m._data.timestamp));
    if (ts !== undefined && ts !== null && ts !== '') return safeStr(ts);
  } catch (_) {}
  // fallback (not ideal): processing time string
  return safeStr(ctx && ctx.at);
}

module.exports.init = async function init(meta) {
  const cfg = (meta && meta.implConf) ? meta.implConf : {};

  const enabled = toBool(cfg.enabled, true);

  // cfg.dedupeSec is in SECONDS
  const dedupeSec = Math.max(1, toInt(cfg.dedupeSec, 4));
  const dedupeMs = dedupeSec * 1000; // FIX: convert to ms

  const maxKeys = Math.max(1000, toInt(cfg.maxKeys, 8000));
  const logDrops = toBool(cfg.logDrops, false);

  // optional flags
  const hashForFromMe = toBool(cfg.hashForFromMe, true);
  const hashForCommands = toBool(cfg.hashForCommands, true);

  const tag = 'InboundDedupeV1';
  const seen = new Map();

  function sweep(now) {
    // remove expired
    for (const [k, exp] of seen) {
      if (!exp || exp <= now) seen.delete(k);
    }
    // cap size (delete oldest)
    if (seen.size > maxKeys) {
      const extra = seen.size - maxKeys;
      let i = 0;
      for (const k of seen.keys()) {
        if (i >= extra) break;
        seen.delete(k);
        i++;
      }
    }
  }

  try {
    meta.log(
      tag,
      `ready build=20260102a enabled=${enabled ? 1 : 0} dedupeSec=${dedupeSec} maxKeys=${maxKeys} logDrops=${logDrops ? 1 : 0} hashForFromMe=${hashForFromMe ? 1 : 0} hashForCommands=${hashForCommands ? 1 : 0}`
    );
  } catch (_) {}

  if (!enabled) return { onMessage: async () => {}, onEvent: async () => {} };

  return {
    onMessage: async (ctx) => {
      try {
        const now = Date.now();

        // housekeeping
        if (seen.size > maxKeys) sweep(now);

        const chatIdFull = safeStr(ctx && ctx.chatId);
        const chatId = normalizeChatId(chatIdFull);
        const senderId = safeStr(ctx && ctx.sender && (ctx.sender.phone || ctx.sender.id || ctx.sender.lid));
        const text = safeStr(ctx && ctx.text);

        const ts = getMsgTs(ctx);
        const msgId = getMsgId(ctx);

        const isFromMe = !!(ctx && (ctx.fromMe || (ctx.message && ctx.message.fromMe)));
        const isCmd = (text || '').startsWith('!');

        const useFlags = (isFromMe && hashForFromMe) || (isCmd && hashForCommands);
        const raw = useFlags
          ? [chatId, senderId, text, ts, isFromMe ? 'ME' : 'U', isCmd ? 'CMD' : 'TXT'].join('|')
          : [chatId, senderId, text, ts].join('|');

        // Always compute hash key even if msgId exists (covers cases where duplicate emits produce different ids)
        const keyHash = `h:${hashKey(raw)}`;
        const keyId = msgId ? `id:${msgId}` : '';

        const expHash = seen.get(keyHash);
        const expId = keyId ? seen.get(keyId) : null;

        if ((expHash && expHash > now) || (expId && expId > now)) {
          if (logDrops) {
            try { meta.log(tag, `drop duplicate chatId=${chatId} key=${keyId || keyHash}`); } catch (_) {}
          }
          if (ctx) {
            ctx.drop = true;
            ctx.stop = true;
            if (typeof ctx.stopPropagation === 'function') ctx.stopPropagation();
          }
        }

        const exp = now + dedupeMs;
        seen.set(keyHash, exp);
        if (keyId) seen.set(keyId, exp);
      } catch (e) {
        try { meta.log(tag, `error ${e && e.message ? e.message : String(e)}`); } catch (_) {}
      }
    },
    onEvent: async () => {},
  };
};