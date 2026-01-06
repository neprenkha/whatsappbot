'use strict';

/*
FallbackQuoteReplyV1 (Router)
- Control Group -> Customer (DM) quote-reply handler.
*/

const SharedLog = require('../Shared/SharedLogV1');
const TicketCore = require('../Shared/SharedTicketCoreV1');

const QuoteParse = require('./FallbackQuoteParseV1');
const ReplyText = require('./FallbackReplyTextV1');
const ReplyMedia = require('./FallbackReplyMediaV1');
const ReplyAv = require('./FallbackReplyAVV1');

function _asString(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err && err.message) return String(err.message);
  try { return JSON.stringify(err); } catch (e) { return String(err); }
}

function _getRaw(ctx) {
  return ctx ? (ctx.raw || ctx.message || null) : null;
}

function _isMedia(raw) {
  if (!raw || !raw.type) return false;
  const t = String(raw.type).toLowerCase();
  return t !== 'chat' && t !== 'text';
}

function _isAv(raw) {
  if (!raw || !raw.type) return false;
  const t = String(raw.type).toLowerCase();
  return t === 'audio' || t === 'ptt' || t === 'video';
}

async function handle(meta, cfg, ctx) {
  const debugEnabled = !!(cfg && (cfg.debugLog || cfg.debug));
  const traceEnabled = !!(cfg && (cfg.traceLog || cfg.trace));
  const log = SharedLog.create(meta, 'FallbackQuoteReplyV1', { debugEnabled, traceEnabled });

  try {
    const q = await QuoteParse.getQuoted(ctx);
    if (!q || !q.ok) {
      return { ok: false, reason: 'noquote' };
    }

    const ticket = q.ticket;
    if (!ticket) {
      return { ok: false, reason: 'noticket' };
    }

    const resolved = await TicketCore.resolve(meta, cfg, ticket);
    if (!resolved || !resolved.chatId) {
      return { ok: false, reason: 'unknownTicket', ticket };
    }

    const toChatId = resolved.chatId;
    const raw = _getRaw(ctx);

    // Text body from current message (not quoted)
    const currentText = (ctx && typeof ctx.text === 'string') ? ctx.text : '';

    if (_isMedia(raw)) {
      const caption = currentText || '';
      if (_isAv(raw)) {
        const r = await ReplyAv.sendAv(meta, cfg, raw, toChatId, caption);
        return { ok: !!(r && r.ok), ticket, chatId: toChatId, kind: 'av', mode: r && r.mode };
      } else {
        const r = await ReplyMedia.sendMedia(meta, cfg, raw, toChatId, caption);
        return { ok: !!(r && r.ok), ticket, chatId: toChatId, kind: 'media', mode: r && r.mode };
      }
    }

    await ReplyText.sendText(meta, cfg, toChatId, currentText);
    return { ok: true, ticket, chatId: toChatId, kind: 'text' };

  } catch (e) {
    log.error('handle failed err=' + _asString(e));
    return { ok: false, reason: 'error', error: _asString(e) };
  }
}

module.exports = { handle };
