'use strict';

function toBool(v, d) {
  if (v === undefined || v === null || v === '') return d;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return d;
}

function toInt(v, d) {
  const n = parseInt(String(v === undefined || v === null ? '' : v), 10);
  return Number.isFinite(n) ? n : d;
}

function toStr(v, d) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return s || d;
}

function toList(v, d) {
  const raw = toStr(v, '');
  if (!raw) return Array.isArray(d) ? d.slice() : [];
  const parts = raw.split(',');
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const item = String(parts[i] || '').trim();
    if (item) out.push(item);
  }
  return out;
}

function loadGlobalConf(meta, cfg, bugLog) {
  const rel = toStr(cfg.globalConfRel, '');
  if (!rel) {
    if (bugLog) meta.log('InboundDedupeCV', 'global_conf_missing_key globalConfRel');
    return {};
  }
  try {
    const loaded = meta.loadConfRel(rel);
    return loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
  } catch (e) {
    if (bugLog) meta.log('InboundDedupeCV', 'global_conf_load_failed err=' + String(e && e.message ? e.message : e));
    return {};
  }
}

function getByPath(obj, pathExpr) {
  if (!obj || !pathExpr) return '';
  const parts = String(pathExpr).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length; i += 1) {
    const key = String(parts[i] || '').trim();
    if (!key) return '';
    if (!cur || typeof cur !== 'object' || !(key in cur)) return '';
    cur = cur[key];
  }
  if (cur === undefined || cur === null) return '';
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  try {
    return JSON.stringify(cur);
  } catch (e) {
    return '';
  }
}

function normalizeValue(v) {
  return String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function text(v) {
  return String(v === undefined || v === null ? '' : v).trim();
}

function rawObj(ctx) {
  return ctx && ctx.raw && typeof ctx.raw === 'object' ? ctx.raw : {};
}

function rawDataObj(ctx) {
  const raw = rawObj(ctx);
  return raw && raw._data && typeof raw._data === 'object' ? raw._data : {};
}

function messageObj(ctx) {
  return ctx && ctx.message && typeof ctx.message === 'object' ? ctx.message : {};
}

function bool01(v) {
  return v ? '1' : '0';
}

function normalizeMessageType(ctx) {
  const msg = messageObj(ctx);
  const raw = rawObj(ctx);
  const rawData = rawDataObj(ctx);
  return text(msg.type || (msg._data && msg._data.type) || raw.type || rawData.type || rawData.mediaKeyType).toLowerCase();
}

function normalizeSenderId(ctx) {
  const raw = rawObj(ctx);
  return text(
    (ctx && (ctx.senderId || ctx.author || ctx.from)) ||
    raw.participant ||
    raw.author ||
    raw.from ||
    ''
  );
}

function normalizeChatId(ctx) {
  return text((ctx && ctx.chatId) || rawObj(ctx).from || rawDataObj(ctx).from || '');
}

function normalizeFromMe(ctx) {
  const msg = messageObj(ctx);
  const raw = rawObj(ctx);
  const rawData = rawDataObj(ctx);
  return !!(
    (ctx && ctx.fromMe) ||
    msg.fromMe ||
    (msg.id && msg.id.fromMe) ||
    raw.fromMe ||
    (raw.id && raw.id.fromMe) ||
    rawData.fromMe
  );
}

function normalizeText(ctx) {
  const msg = messageObj(ctx);
  const rawData = rawDataObj(ctx);
  return text((ctx && ctx.text) || msg.body || rawData.body || '');
}

function normalizeCaption(ctx) {
  const msg = messageObj(ctx);
  const rawData = rawDataObj(ctx);
  return text(msg.caption || rawData.caption || '');
}

function normalizeFilename(ctx) {
  const msg = messageObj(ctx);
  const rawData = rawDataObj(ctx);
  return text(msg.filename || (msg._data && msg._data.filename) || rawData.filename || '');
}

function normalizeMimeType(ctx) {
  const msg = messageObj(ctx);
  const rawData = rawDataObj(ctx);
  return text(msg.mimetype || (msg._data && msg._data.mimetype) || rawData.mimetype || '');
}

function normalizeRawId(ctx) {
  const msg = messageObj(ctx);
  const raw = rawObj(ctx);
  const rawData = rawDataObj(ctx);
  return text(
    (raw.id && raw.id._serialized) ||
    raw.id ||
    (msg.id && (msg.id._serialized || msg.id.id || msg.id.remote)) ||
    rawData.id ||
    ''
  );
}

function normalizeHasMedia(ctx) {
  const msg = messageObj(ctx);
  const rawData = rawDataObj(ctx);
  return !!(
    msg.hasMedia ||
    msg.ptt ||
    (msg._data && msg._data.ptt) ||
    rawData.ptt ||
    rawData.mediaKey ||
    rawData.directPath ||
    rawData.clientUrl ||
    normalizeFilename(ctx) ||
    normalizeMimeType(ctx)
  );
}

function buildCanonicalEvent(ctx) {
  return {
    chatId: normalizeChatId(ctx),
    senderId: normalizeSenderId(ctx),
    fromMe: bool01(normalizeFromMe(ctx)),
    text: normalizeText(ctx),
    body: normalizeText(ctx),
    caption: normalizeCaption(ctx),
    messageType: normalizeMessageType(ctx),
    filename: normalizeFilename(ctx),
    mimetype: normalizeMimeType(ctx),
    rawId: normalizeRawId(ctx),
    hasMedia: bool01(normalizeHasMedia(ctx)),
    raw: rawObj(ctx),
    message: messageObj(ctx),
    sender: { id: normalizeSenderId(ctx) },
  };
}

module.exports.init = async function init(meta) {
  const cfg = meta && meta.implConf ? meta.implConf : {};

  const enabled = toBool(cfg.enabled, true);
  const moduleLog = toBool(cfg.moduleLog, true);
  const bugLog = toBool(cfg.bugLog, true);
  const detailLog = toBool(cfg.detailLog, false);
  const traceLog = toBool(cfg.traceLog, false);

  if (!enabled) {
    if (moduleLog) meta.log('InboundDedupeCV', 'disabled');
    return { onMessage: async () => {}, onEvent: async () => {} };
  }

  loadGlobalConf(meta, cfg, bugLog);

  const dedupeMs = Math.max(1, toInt(cfg.dedupeMs, 6000));
  const maxKeys = Math.max(100, toInt(cfg.maxKeys, 8000));
  const keyFields = toList(cfg.keyFields, ['chatId', 'senderId', 'fromMe', 'messageType', 'text', 'caption', 'filename', 'mimetype', 'rawId']);
  const keyMode = toStr(cfg.keyMode, 'all');
  const skipWhenFromMe = toBool(cfg.skipWhenFromMe, false);
  const skipWhenCommand = toBool(cfg.skipWhenCommand, false);
  const commandPrefixes = toList(cfg.commandPrefixes, ['!', '/', '#']);

  const seenMap = new Map();

  function cleanup(nowMs) {
    for (const row of seenMap.entries()) {
      const k = row[0];
      const exp = row[1];
      if (exp <= nowMs) seenMap.delete(k);
    }
    if (seenMap.size > maxKeys) {
      const overflow = seenMap.size - maxKeys;
      let removed = 0;
      for (const k of seenMap.keys()) {
        seenMap.delete(k);
        removed += 1;
        if (removed >= overflow) break;
      }
    }
  }

  function isCommand(textValue) {
    const s = String(textValue || '').trim();
    if (!s) return false;
    for (let i = 0; i < commandPrefixes.length; i += 1) {
      const p = String(commandPrefixes[i] || '');
      if (p && s.indexOf(p) === 0) return true;
    }
    return false;
  }

  function resolveFieldValue(ev, fieldName) {
    const field = String(fieldName || '').trim();
    if (!field) return '';
    if (field in ev) return ev[field];
    if (field === 'type') return ev.messageType;
    if (field === 'raw.id._serialized') return ev.rawId;
    if (field === 'sender.id') return ev.senderId;
    return getByPath(ev, field);
  }

  function buildParts(ev) {
    const parts = [];
    for (let i = 0; i < keyFields.length; i += 1) {
      const p = keyFields[i];
      const val = normalizeValue(resolveFieldValue(ev, p));
      if (keyMode === 'all') {
        parts.push(val || '-');
      } else if (val) {
        parts.push(val);
      }
    }
    return parts;
  }

  function shouldSkip(ev) {
    if (skipWhenFromMe && ev.fromMe === '1') return true;
    if (skipWhenCommand && isCommand(ev.text || ev.body || ev.caption)) return true;
    return false;
  }

  async function onMessage(ctx) {
    try {
      if (!ctx || typeof ctx !== 'object') return;

      const ev = buildCanonicalEvent(ctx);
      if (shouldSkip(ev)) return;

      const parts = buildParts(ev);
      if (!parts.length) return;

      const key = parts.join('|');
      const nowMs = Date.now();

      cleanup(nowMs);

      const exp = Number(seenMap.get(key) || 0);
      if (exp > nowMs) {
        if (traceLog || detailLog) {
          meta.log('InboundDedupeCV', 'dedupe_drop chatId=' + toStr(ev.chatId, '') + ' key=' + key.slice(0, 160));
        }
        if (ctx && typeof ctx.stopPropagation === 'function') ctx.stopPropagation();
        return;
      }

      seenMap.set(key, nowMs + dedupeMs);
    } catch (e) {
      if (bugLog) meta.log('InboundDedupeCV', 'onMessage_error err=' + String(e && e.message ? e.message : e));
    }
  }

  if (moduleLog) {
    meta.log('InboundDedupeCV', 'ready dedupeMs=' + String(dedupeMs) + ' maxKeys=' + String(maxKeys) + ' keyMode=' + keyMode + ' keyFields=' + keyFields.join(','));
  }

  return {
    onMessage,
    onEvent: async () => {}
  };
};