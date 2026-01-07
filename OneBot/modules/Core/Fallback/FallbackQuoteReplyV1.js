'use strict';

/**
 * FallbackQuoteReplyV1
 * Control Group quote-reply -> Customer DM
 *
 * Step 2 (stable media):
 * - Supports sending image/document without requiring every media item to be quote-replied.
 * - Keeps a short-lived "sticky ticket" per staff sender so album/media bursts can reuse the ticket.
 *
 * Note: No bot-facing templates/keywords here. Only routing + logging.
 */

const SharedLog = require('../Shared/SharedLogV1');
const SharedTicketCore = require('../Shared/SharedTicketCoreV1');
const QuoteParse = require('./FallbackQuoteParseV1');
const ReplyText = require('./FallbackReplyTextV1');
const ReplyMedia = require('./FallbackReplyMediaV1');

const _sticky = new Map(); // key -> { ticket, exp }
const _seen = new Map();   // msgKey -> ts

function _n(v, d) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}
function _s(v) {
  return v === null || v === undefined ? '' : String(v);
}

function _getMsgType(rawMsg) {
  return _s(rawMsg && (rawMsg.type || (rawMsg._data && rawMsg._data.type))).toLowerCase();
}

function _getMsgKey(rawMsg) {
  if (!rawMsg) return '';
  const id = rawMsg.id;
  if (id && typeof id === 'object') {
    if (id._serialized) return _s(id._serialized);
    if (id.id) return _s(id.id);
  }
  if (rawMsg._data && rawMsg._data.id && rawMsg._data.id._serialized) return _s(rawMsg._data.id._serialized);
  const at = rawMsg.timestamp || (rawMsg._data && rawMsg._data.t) || '';
  const from = rawMsg.from || (rawMsg._data && rawMsg._data.from) || '';
  const author = rawMsg.author || (rawMsg._data && rawMsg._data.author) || '';
  return [from, author, at].filter(Boolean).join('|');
}

function _getSenderKey(ctx, rawMsg) {
  const s = ctx && ctx.sender;
  const k = (s && (s.id || s.phone || s.lid)) || rawMsg.author || '';
  return _s(k);
}

function _cleanupSticky(now) {
  for (const [k, v] of _sticky.entries()) {
    if (!v || !v.exp || v.exp <= now) _sticky.delete(k);
  }
}

function _cleanupSeen(now, ttlMs) {
  for (const [k, ts] of _seen.entries()) {
    if (!ts || (now - ts) > ttlMs) _seen.delete(k);
  }
}

function _isStableMedia(rawMsg) {
  if (!rawMsg) return false;
  if (rawMsg.hasMedia !== true) return false;
  const t = _getMsgType(rawMsg);
  // Step 2 scope: image + document
  return t === 'image' || t === 'document';
}

function _stripTicketFromText(text, ticket) {
  const t = _s(text);
  if (!t || !ticket) return t;
  const esc = ticket.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = t.replace(new RegExp('\\[\\s*Ticket\\s*:\\s*' + esc + '\\s*\\]', 'ig'), '');
  out = out.replace(new RegExp('\\bTicket\\s*:\\s*' + esc + '\\b', 'ig'), '');
  out = out.replace(new RegExp('^!r\\s+' + esc + '\\b', 'ig'), '');
  return out.trim();
}

async function handle(meta, cfg, ctx) {
  const log = SharedLog.makeLog(meta, 'FallbackQuoteReplyV1');

  cfg = cfg || {};
  ctx = ctx || {};

  const controlGroupId = _s(cfg.controlGroupId);
  if (!controlGroupId) return false;

  if (ctx.chatId !== controlGroupId) return false;
  if (ctx.isGroup !== true) return false;

  const rawMsg = ctx.raw || ctx.msg || ctx.message;
  if (!rawMsg) return false;

  const now = Date.now();
  const eventDedupeMs = _n(cfg.replyEventDedupeMs, 5000);
  const stickyMs = _n(cfg.replyStickyMs, _n(cfg.albumWindowMs, 3000));
  const stickyEnabled = _n(cfg.replyStickyEnabled, 1) === 1;

  _cleanupSticky(now);
  _cleanupSeen(now, eventDedupeMs);

  const msgKey = _getMsgKey(rawMsg);
  if (msgKey) {
    const last = _seen.get(msgKey);
    if (last && (now - last) < eventDedupeMs) {
      log.trace('dedupe drop msgKey=' + msgKey);
      return true;
    }
    _seen.set(msgKey, now);
  }

  const senderKey = _getSenderKey(ctx, rawMsg);
  const stickyKey = controlGroupId + '|' + senderKey;

  let parseRes = null;
  try {
    parseRes = await QuoteParse.parse(meta, cfg, ctx);
  } catch (e) {
    log.warn('QuoteParse threw: ' + (e && e.message ? e.message : e));
    return false;
  }

  let ticket = '';
  let fromSticky = false;

  // 1) Normal path: quoted/explicit ticket
  if (parseRes && parseRes.ok && parseRes.ticket) {
    ticket = _s(parseRes.ticket);
    if (stickyEnabled && ticket && senderKey) {
      _sticky.set(stickyKey, { ticket, exp: now + stickyMs });
      log.trace('sticky set ticket=' + ticket + ' sender=' + senderKey);
    }
  }
  // 2) Sticky path: next media without quote (album / burst)
  else if (stickyEnabled && senderKey && _isStableMedia(rawMsg)) {
    const st = _sticky.get(stickyKey);
    if (st && st.ticket && st.exp > now) {
      ticket = _s(st.ticket);
      fromSticky = true;
      st.exp = now + stickyMs; // extend while media still coming
      _sticky.set(stickyKey, st);
      log.trace('sticky use ticket=' + ticket + ' sender=' + senderKey);
    } else {
      const reason = parseRes && parseRes.reason ? parseRes.reason : 'noTicket';
      log.info('noTicket ' + JSON.stringify({ reason, sender: senderKey, type: _getMsgType(rawMsg) }));
      return false;
    }
  } else {
    // Avoid accidental routing for random unquoted text
    return false;
  }

  if (!ticket) return false;

  const ticketType = _s(cfg.ticketType || 'fallback');
  const strictType = _n(cfg.strictTicketType, 1) === 1;
  const typeForResolve = strictType ? ticketType : '';

  let tinfo = null;
  try {
    tinfo = await SharedTicketCore.resolve(meta, cfg, typeForResolve, ticket);
  } catch (e) {
    log.warn('Ticket resolve error: ' + (e && e.message ? e.message : e));
    return true;
  }

  if (!tinfo || !tinfo.ok) {
    log.info('ticketNotResolved ' + JSON.stringify({ ticket, reason: tinfo && tinfo.reason ? tinfo.reason : 'unknown' }));
    return true;
  }

  const toChatId = _s(tinfo.chatId);
  if (!toChatId) {
    log.warn('ticket resolved but missing chatId ticket=' + ticket);
    return true;
  }

  const hideTicket = _n(cfg.hideTicket, 1) === 1;
  const msgType = _getMsgType(rawMsg);

  try {
    // Stable media (image/document)
    if (_isStableMedia(rawMsg)) {
      const caption = hideTicket ? _stripTicketFromText(ctx.text, ticket) : _s(ctx.text);
      const ok = await ReplyMedia.sendMedia(meta, cfg, toChatId, rawMsg, caption);
      log.info('replyMedia ' + JSON.stringify({ ticket, ok: !!ok, type: msgType, sticky: fromSticky ? 1 : 0 }));
      return true;
    }

    // Text
    const txt = hideTicket ? _stripTicketFromText(ctx.text, ticket) : _s(ctx.text);
    const ok = await ReplyText.sendText(meta, cfg, toChatId, txt);
    log.info('replyText ' + JSON.stringify({ ticket, ok: !!ok, type: msgType, sticky: fromSticky ? 1 : 0 }));
    return true;
  } catch (e) {
    log.warn('replyError ' + JSON.stringify({ ticket, type: msgType, err: (e && e.message) ? e.message : _s(e) }));
    return true;
  }
}

module.exports = { handle };
