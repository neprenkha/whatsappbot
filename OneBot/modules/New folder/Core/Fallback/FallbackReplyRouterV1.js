'use strict';

/**
 * FallbackReplyRouterV1
 * - Send back to customer from control group via:
 *     - Command: !r <ticket> <text>
 *     - Quote reply: reply-to-card with normal text
 * - Best-effort media reply: if staff message hasMedia, download and send to customer
 */

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

async function bestEffortSendMedia(meta, chatId, media, caption, preferCsv, opts) {
  const send = pickSend(meta, preferCsv);
  if (typeof send !== 'function') return { ok: false, reason: 'send.missing' };
  try {
    const res = await send(s(chatId).trim(), media, Object.assign({ caption: s(caption) }, (opts || {})));
    if (res && typeof res === 'object' && res.ok === false) return res;
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e && e.message) ? e.message : String(e) };
  }
}

function extractTicketFromText(text) {
  const m = s(text).match(/\b\d{4}T\d{7}\b/);
  return m ? m[0] : '';
}

function parseReply(text) {
  const t = s(text).trim();
  if (!t) return null;
  if (!t.toLowerCase().startswith('!r')) return null;
  // !r <ticket> <body...>
  const rest = t.slice(2).trim();
  if (!rest) return { ticket: '', body: '' };
  const parts = rest.split(/\s+/);
  const ticket = parts.shift() || '';
  const body = rest.slice(ticket.length).trim();
  return { ticket, body };
}

function getQuotedText(ctx) {
  const q = ctx.quoted || (ctx.message && ctx.message._data && ctx.message._data.quotedMsg) || null;
  if (!q) return '';
  if (typeof q.body === 'string') return q.body;
  if (typeof q.text === 'string') return q.text;
  if (q._data && typeof q._data.body === 'string') return q._data.body;
  return '';
}

function getText(ctx) {
  return s(ctx.text || ctx.body || (ctx.message && ctx.message.body) || '').trim();
}

module.exports.route = async function route(meta, ctx) {
  const cfg = meta.implConf || {};
  const enabled = b(cfg.enabled, true);
  if (!enabled) return { ok: false, reason: 'disabled' };

  const controlGroupId = s(cfg.controlGroupId).trim();
  if (!controlGroupId) return { ok: false, reason: 'controlGroupId.missing' };

  const chatId = s(ctx.chatId).trim();
  if (chatId !== controlGroupId) return { ok: false, reason: 'not.control.group' };

  const state = meta.getService('fallback.state');
  if (!state || typeof state.resolveChatIdByTicket !== 'function') return { ok: false, reason: 'state.missing' };

  const roleGate = meta.getService('fallback.rolegate');
  if (roleGate && typeof roleGate.check === 'function') {
    const gate = await roleGate.check(meta, ctx);
    if (gate && gate.ok === false) return gate;
  }

  const text = getText(ctx);
  const msg = ctx.message;
  const hasMedia = !!(msg && msg.hasMedia && typeof msg.downloadMedia === 'function');

  let parsed = parseReply(text);
  let ticket = parsed ? s(parsed.ticket).trim() : '';
  let body = parsed ? s(parsed.body).trim() : '';

  if (!ticket) {
    // quote-reply route: try extract ticket from quoted card
    const qt = getQuotedText(ctx);
    ticket = extractTicketFromText(qt);
    if (!parsed) body = text; // normal reply text
  }

  if (!ticket) {
    return { ok: false, reason: 'ticket.missing' };
  }

  const toChatId = s(state.resolveChatIdByTicket(ticket)).trim();
  if (!toChatId) {
    return { ok: false, reason: 'ticket.unknown' };
  }

  const prefer = s(cfg.replySendPrefer || cfg.sendPrefer || 'outsend,sendout,send');

  // If media exists, prefer sending media with caption (body). If body empty and only media, still send.
  if (hasMedia) {
    let media = null;
    try { media = await msg.downloadMedia(); } catch (_) { media = null; }
    if (!media) return { ok: false, reason: 'media.download.failed' };

    const caption = body; // may be ''
    const r = await bestEffortSendMedia(meta, toChatId, media, caption, s(cfg.replyMediaSendPrefer || cfg.replySendPrefer || cfg.sendPrefer || 'sendout,send'), {
      source: 'fallback.reply.media',
      ticket,
      fromGroup: controlGroupId,
    });

    if (!r || r.ok === false) return r;

    // ACK back to group
    const ack = `✅ Sent media to customer\n🎫 Ticket: ${ticket}`;
    await sendOrQueue(meta, controlGroupId, ack, { source: 'fallback.ack', ticket }, prefer);

    return { ok: true };
  }

  // Text-only
  if (!body) {
    return { ok: false, reason: 'text.empty' };
  }

  const r = await sendOrQueue(meta, toChatId, body, { source: 'fallback.reply', ticket }, prefer);
  if (!r || r.ok === false) return r;

  const ack = `✅ Sent to customer\n🎫 Ticket: ${ticket}`;
  await sendOrQueue(meta, controlGroupId, ack, { source: 'fallback.ack', ticket }, prefer);

  return { ok: true };
};
