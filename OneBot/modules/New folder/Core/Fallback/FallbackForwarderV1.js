'use strict';

/**
 * FallbackForwarderV1
 * - Forward inbound DM -> control group as a ticket card
 * - Best-effort forward media (if message hasMedia)
 */

const path = require('path');
const { sendOrQueue } = require('../Shared/SharedSafeSendV1');

function s(v) { return (v === undefined || v === null) ? '' : String(v); }
function b(v, def = false) {
  const x = s(v).trim().toLowerCase();
  if (!x) return def;
  return !(x === '0' || x === 'false' || x === 'no' || x === 'off');
}

function splitCsv(v) {
  return s(v).split(',').map(x => x.trim()).filter(Boolean);
}

function pickSend(meta, preferCsv) {
  const prefer = splitCsv(preferCsv || 'outsend,sendout,send');
  for (const n of prefer) {
    const fn = meta.getService(n);
    if (typeof fn === 'function') return fn;
  }
  const fallback = meta.getService('send');
  return (typeof fallback === 'function') ? fallback : null;
}

function toPhoneFromChatId(chatId) {
  const id = s(chatId);
  const at = id.indexOf('@');
  const base = (at >= 0) ? id.slice(0, at) : id;
  return base;
}

function getText(ctx) {
  return s(ctx.text || ctx.body || (ctx.message && ctx.message.body) || '').trim();
}

function getSenderName(ctx) {
  return s(ctx.senderName || (ctx.sender && ctx.sender.name) || (ctx.message && ctx.message._data && ctx.message._data.notifyName) || '').trim();
}

function getAttachmentInfo(ctx) {
  const msg = ctx.message;
  if (msg && msg.hasMedia) {
    const t = s(msg.type || 'media');
    return { count: 1, types: t };
  }
  const atts = Array.isArray(ctx.attachments) ? ctx.attachments : [];
  if (atts.length) {
    const types = atts.map(a => s(a.type || a.mimetype || 'file')).filter(Boolean).join(',');
    return { count: atts.length, types };
  }
  return { count: 0, types: '' };
}

async function bestEffortSendMedia(meta, chatId, media, caption, preferCsv) {
  const send = pickSend(meta, preferCsv);
  if (typeof send !== 'function') return { ok: false, reason: 'send.missing' };
  try {
    const res = await send(s(chatId).trim(), media, { caption: s(caption), source: 'fallback.media' });
    if (res && typeof res === 'object' && res.ok === false) return res;
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e && e.message) ? e.message : String(e) };
  }
}

module.exports.forward = async function forward(meta, ctx, capture) {
  const cfg = meta.implConf || {};

  const enabled = b(cfg.enabled, true);
  if (!enabled) return { ok: false, reason: 'disabled' };

  const groupId = s(cfg.controlGroupId).trim();
  if (!groupId) return { ok: false, reason: 'controlGroupId.missing' };

  const chatId = s(ctx.chatId).trim();
  if (!chatId) return { ok: false, reason: 'chatId.missing' };

  const state = meta.getService('fallback.state');
  if (!state || typeof state.getOrCreateTicket !== 'function') return { ok: false, reason: 'state.missing' };

  const tz = meta.getService('tz') || meta.getService('timezone');
  const time = tz && typeof tz.formatNow === 'function' ? tz.formatNow() : new Date().toISOString();

  const ticketObj = state.getOrCreateTicket(chatId);
  const ticket = s(ticketObj.ticket);
  const seq = s(ticketObj.seq);

  const fromName = getSenderName(ctx);
  const fromPhone = toPhoneFromChatId(chatId);
  const text = getText(ctx);

  const att = getAttachmentInfo(ctx);
  const attCount = s(att.count);
  const attTypes = s(att.types);

  const tplPath = s(cfg.ticketTemplate || 'ui/ticketsquence.txt').trim();
  const tplEngine = meta.getService('template');
  if (!tplEngine || typeof tplEngine.loadText !== 'function' || typeof tplEngine.render !== 'function') {
    return { ok: false, reason: 'template.missing' };
  }

  const tpl = await tplEngine.loadText(meta, tplPath);

  // Provide BOTH styles: uppercase tokens (ticketsquence.txt) + lowercase (legacy)
  const vars = {
    // required by ticketsquence.txt
    TICKET: ticket,
    SEQ: seq,
    FROM_NAME: fromName,
    FROM_PHONE: fromPhone,
    FROM_CHATID: chatId,
    TIME: time,
    TEXT: text,
    ATTACH_COUNT: attCount,
    ATTACH_TYPES: attTypes,
    // optional
    STATUS: s(capture && capture.status),

    // legacy lowercase aliases
    ticket,
    seq,
    from: chatId,
    name: fromName,
    phone: fromPhone,
    time,
    text,
    attachCount: attCount,
    attachTypes: attTypes,
  };

  const card = tplEngine.render(tpl, vars);
  const sendPrefer = s(cfg.groupSendPrefer || cfg.sendPrefer || 'outsend,sendout,send');

  const res = await sendOrQueue(meta, groupId, card, {
    source: 'fallback.card',
    ticket,
    chatId,
    seq,
  }, sendPrefer);

  // Best-effort media forward
  const msg = ctx.message;
  if (msg && msg.hasMedia && typeof msg.downloadMedia === 'function') {
    try {
      const media = await msg.downloadMedia();
      if (media) {
        const caption = `[${ticket}] ${fromName || fromPhone || ''}`.trim();
        await bestEffortSendMedia(meta, groupId, media, caption, s(cfg.groupMediaSendPrefer || cfg.groupSendPrefer || cfg.sendPrefer || 'sendout,send'));
      }
    } catch (_) {
      // ignore; card already sent
    }
  }

  return res;
};
