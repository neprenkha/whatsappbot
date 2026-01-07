'use strict';

/*
  FallbackReplyMediaV1.js
  - Media must NOT use outbox/send (text-only).
  - Uses outsend/sendout/transport only.
  - Returns boolean ok so caller logs are correct.
  - Hides ticket from customer caption when hideTicket=1.
*/

const SharedLog = require('../Shared/SharedLogV1');

function hasMediaContent(msg) {
  if (!msg) return false;
  if (msg.hasMedia) return true;
  const type = String(msg.type || '').toLowerCase();
  if (type === 'audio' || type === 'video' || type === 'ptt' || type === 'image' || type === 'document') return true;
  return false;
}

function splitCsv(str) {
  return String(str || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function getStr(cfg, key, defVal) {
  if (cfg && typeof cfg.getStr === 'function') return cfg.getStr(key, defVal);
  if (cfg && Object.prototype.hasOwnProperty.call(cfg, key)) return String(cfg[key]);
  return String(defVal || '');
}

function getInt(cfg, key, defVal) {
  if (cfg && typeof cfg.getInt === 'function') return Number(cfg.getInt(key, defVal));
  if (cfg && Object.prototype.hasOwnProperty.call(cfg, key)) return Number(cfg[key]);
  return Number(defVal || 0);
}

function mkLog(meta, cfg, tag) {
  const base = SharedLog.create(meta, tag);
  const debugOn = getInt(cfg, 'debugLog', 0) === 1;
  const traceOn = getInt(cfg, 'traceLog', 0) === 1;

  return {
    info: (...a) => base.info(...a),
    warn: (...a) => base.warn(...a),
    error: (...a) => base.error(...a),
    debug: (...a) => { if (debugOn) base.debug(...a); },
    trace: (...a) => { if (traceOn) base.trace(...a); }
  };
}

function stripTicket(text) {
  const s = String(text || '');
  // ticket format: 6 digits + 'T' + 10+ digits (e.g., 202601T2891165231)
  return s.replace(/\b\d{6}T\d{10,}\b/g, '').replace(/\s{2,}/g, ' ').trim();
}

function pickMediaSendFn(meta, preferCsv) {
  const prefer = splitCsv(preferCsv || 'outsend,sendout,transport');

  for (const rawName of prefer) {
    const name = String(rawName || '').toLowerCase();

    // Never for media:
    if (name === 'outbox' || name === 'send') continue;

    if (name === 'transport') break;

    try {
      const svc = meta.getService(name);
      if (typeof svc === 'function') return { via: name, fn: svc };
      if (svc && typeof svc.sendDirect === 'function') {
        return { via: name, fn: async (chatId, payload, opts) => svc.sendDirect(chatId, payload, opts || {}) };
      }
    } catch (_e) {}
  }

  try {
    const transport = meta.getService('transport');
    if (transport && typeof transport.sendDirect === 'function') {
      return { via: 'transport', fn: async (chatId, payload, opts) => transport.sendDirect(chatId, payload, opts || {}) };
    }
  } catch (_e) {}

  return { via: 'none', fn: async () => { throw new Error('No media send function'); } };
}

async function downloadMedia(meta, rawMsg) {
  if (!rawMsg) return null;

  // Preferred: rawMsg.downloadMedia (wwebjs)
  if (typeof rawMsg.downloadMedia === 'function') {
    return await rawMsg.downloadMedia();
  }

  // Alternate: transport helper if exists
  try {
    const transport = meta.getService('transport');
    if (transport && typeof transport.downloadMedia === 'function') {
      return await transport.downloadMedia(rawMsg);
    }
  } catch (_e) {}

  return null;
}

async function sendMedia(meta, cfg, toChatId, rawMsg, caption) {
  const log = mkLog(meta, cfg, 'FallbackReplyMediaV1');

  if (!toChatId) {
    log.warn('send.skip.missingChatId');
    return false;
  }
  if (!rawMsg || !hasMediaContent(rawMsg)) {
    log.warn('send.skip.noMedia', { type: rawMsg?.type, hasMedia: rawMsg?.hasMedia });
    return false;
  }

  const hideTicket = getInt(cfg, 'hideTicket', 1) === 1;
  const isToCustomer = String(toChatId).endsWith('@c.us');

  const preferKey = isToCustomer ? 'replyMediaSendPrefer' : 'forwardMediaSendPrefer';
  const prefer = getStr(cfg, preferKey, '');
  const fallbackPrefer = isToCustomer ? getStr(cfg, 'replySendPrefer', '') : getStr(cfg, 'sendPrefer', '');
  const finalPrefer = prefer || fallbackPrefer || 'outsend,sendout,transport';

  const sender = pickMediaSendFn(meta, finalPrefer);

  let media;
  try {
    media = await downloadMedia(meta, rawMsg);
  } catch (e) {
    log.warn('media.download.fail', { err: e && e.message ? e.message : String(e) });
    media = null;
  }

  if (!media) {
    log.warn('media.none');
    return false;
  }

  let cap = String(caption || '').trim();
  if (isToCustomer && hideTicket && cap) cap = stripTicket(cap);

  // Try preserve doc/ptt behavior
  const type = String(rawMsg.type || '').toLowerCase();
  const filename =
    rawMsg.filename ||
    (rawMsg._data && (rawMsg._data.filename || rawMsg._data.fileName)) ||
    '';

  const opts = {};
  if (cap) opts.caption = cap;

  if (type === 'document') {
    opts.sendMediaAsDocument = true;
    if (filename) opts.filename = String(filename);
  }

  // voice note
  if (type === 'ptt') {
    opts.sendAudioAsVoice = true;
  }

  try {
    await sender.fn(toChatId, media, opts);
    log.debug('send.ok', { via: sender.via, to: toChatId, type });
    return true;
  } catch (e) {
    log.error('send.fail', { via: sender.via, error: e && e.message ? e.message : String(e) });
    return false;
  }
}

module.exports = { sendMedia };
