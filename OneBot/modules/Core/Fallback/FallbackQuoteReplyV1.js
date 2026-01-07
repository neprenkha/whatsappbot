'use strict';

/*
  FallbackQuoteReplyV1.js
  - Staff reply via quote-reply in Control Group.
  - Sticky ticket support even when message has filename/caption (document/image).
  - Media replies routed via FallbackReplyMediaV1 (media-safe).
  - Text replies routed via replySendPrefer (can use outbox).
  - Uses message ID mapping to resolve tickets from quoted messages.
*/

const SharedLog = require('../Shared/SharedLogV1');
const TicketCore = require('../Shared/SharedTicketCoreV1');
const ReplyMedia = require('./FallbackReplyMediaV1');
const MessageTicketMap = require('../Shared/SharedMessageTicketMapV1');

function hasMediaContent(msg) {
  if (!msg) return false;
  if (msg.hasMedia) return true;
  const type = String(msg.type || '').toLowerCase();
  if (type === 'audio' || type === 'video' || type === 'ptt' || type === 'image' || type === 'document') return true;
  return false;
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

function splitCsv(str) {
  return String(str || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function stripTicket(text) {
  const s = String(text || '');
  return s.replace(/\b\d{6}T\d{10,}\b/g, '').replace(/\s{2,}/g, ' ').trim();
}

function extractTicket(text) {
  const s = String(text || '');
  const m = s.match(/\b(\d{6}T\d{10,})\b/);
  return m ? m[1] : '';
}

function pickTextSendFn(meta, preferCsv) {
  const prefer = splitCsv(preferCsv || 'outbox,outsend,sendout,send');

  for (const rawName of prefer) {
    const name = String(rawName || '').toLowerCase();
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

  return { via: 'none', fn: async () => { throw new Error('No text send function'); } };
}

// Sticky per sender (memory only)
const sticky = new Map(); // senderKey -> { ticketId, expAt }

function stickyGet(senderKey) {
  const it = sticky.get(senderKey);
  if (!it) return '';
  if (Date.now() > it.expAt) {
    sticky.delete(senderKey);
    return '';
  }
  return it.ticketId || '';
}

function stickySet(senderKey, ticketId, ttlSec) {
  if (!senderKey || !ticketId) return;
  sticky.set(senderKey, { ticketId, expAt: Date.now() + (ttlSec * 1000) });
}

async function getQuotedInfo(msg) {
  try {
    if (msg && typeof msg.getQuotedMessage === 'function') {
      const q = await msg.getQuotedMessage();
      if (!q) return { text: '', msgId: '' };
      
      const text = String(q.body || (q._data && q._data.caption) || '').trim();
      
      // Extract message ID for mapping lookup
      let msgId = '';
      if (q.id) {
        msgId = String(q.id);
      } else if (q._data && q._data.id) {
        if (q._data.id._serialized) {
          msgId = String(q._data.id._serialized);
        } else if (typeof q._data.id === 'string') {
          msgId = String(q._data.id);
        }
      }
      
      return { text, msgId };
    }
  } catch (_e) {}
  return { text: '', msgId: '' };
}

async function handle(meta, cfg, ctx) {
  const log = mkLog(meta, cfg, 'FallbackQuoteReplyV1');

  const msg = ctx.message || ctx.msg || ctx.raw || ctx.rawMsg;
  if (!msg) return { handled: false };

  // Only for group messages
  if (!ctx.isGroup) return { handled: false };

  const ticketType = getStr(cfg, 'ticketType', 'fallback');
  const hideTicket = getInt(cfg, 'hideTicket', 1) === 1;

  const allowSticky = getInt(cfg, 'allowStickyReply', 1) === 1;
  const stickyTtlSec = Number(getInt(cfg, 'stickyTtlSec', 900));

  const replyPrefer = getStr(cfg, 'replySendPrefer', 'outbox,outsend,sendout,send');
  const textSender = pickTextSendFn(meta, replyPrefer);

  const senderKey =
    (ctx.sender && (ctx.sender.lid || ctx.sender.id)) ||
    (msg.author || '') ||
    (ctx.sender && ctx.sender.phone) ||
    '';

  const textNow = String(ctx.text || msg.body || '').trim();

  // 1) try quoted message ID mapping (most reliable)
  const quotedInfo = await getQuotedInfo(msg);
  let ticketId = '';
  
  if (quotedInfo.msgId) {
    ticketId = MessageTicketMap.get(quotedInfo.msgId);
    if (ticketId) {
      log.trace('ticket.from.msgmap', { msgId: quotedInfo.msgId, ticketId });
    }
  }
  
  // 2) try quoted text ticket extraction
  if (!ticketId) {
    ticketId = extractTicket(quotedInfo.text);
    if (ticketId) {
      log.trace('ticket.from.quoted.text', { ticketId });
    }
  }

  // 3) try direct text/caption
  if (!ticketId) {
    ticketId = extractTicket(textNow);
    if (ticketId) {
      log.trace('ticket.from.direct.text', { ticketId });
    }
  }

  // 4) sticky fallback (IMPORTANT: even if filename exists)
  if (!ticketId && allowSticky) {
    ticketId = stickyGet(senderKey);
    if (ticketId) log.trace('sticky.use', { senderKey, ticketId });
  }

  if (!ticketId) {
    log.debug('noTicket', { 
      reason: (quotedInfo.msgId ? 'noMapping' : (quotedInfo.text ? 'noMatch' : 'noQuoted')), 
      type: msg.type || '',
      hadQuotedMsg: !!quotedInfo.msgId
    });
    return { handled: false };
  }

  if (allowSticky) {
    stickySet(senderKey, ticketId, stickyTtlSec);
    log.trace('sticky.set', { senderKey, ticketId, ttlSec: stickyTtlSec });
  }

  // Resolve ticket -> customer chatId
  const res = await TicketCore.resolve(meta, cfg, ticketType, ticketId, {});
  if (!res || !res.ok || !res.ticket || !res.ticket.chatId) {
    log.warn('ticket.resolve.fail', { ticketId, hasTicket: !!(res && res.ticket) });
    return { handled: false };
  }

  const toChatId = res.ticket.chatId;

  // MEDIA reply (enhanced detection for audio/video/ptt)
  if (hasMediaContent(msg)) {
    const ok = await ReplyMedia.sendMedia(meta, cfg, toChatId, msg, textNow);
    log.info('replyMedia', { ok, ticketId, toChatId, type: msg.type || '' });
    return { handled: true, ok };
  }

  // TEXT reply
  let outText = textNow;
  if (hideTicket && outText) outText = stripTicket(outText);
  if (!outText) return { handled: true, ok: true };

  try {
    await textSender.fn(toChatId, outText, {});
    log.info('replyText', { ok: true, ticketId, toChatId, via: textSender.via });
    return { handled: true, ok: true };
  } catch (e) {
    log.error('replyText.fail', { via: textSender.via, error: e && e.message ? e.message : String(e) });
    return { handled: true, ok: false };
  }
}

module.exports = { handle };
