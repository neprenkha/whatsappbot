'use strict';

function text(value) {
  return String(value ?? '').trim();
}

function toInt(value, fallback) {
  const n = Number.parseInt(text(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function fill(template, vars) {
  let out = String(template || '');
  Object.keys(vars || {}).forEach((name) => {
    out = out.split(`{${name}}`).join(String(vars[name] ?? ''));
  });
  return out;
}

function parseTicketId(raw, ticketIdRegex) {
  const source = text(raw);
  if (!source) return '';
  const re = new RegExp(text(ticketIdRegex), 'i');
  const m = source.match(re);
  return m && m[0] ? text(m[0]) : '';
}

function stripTicketId(textBody, ticketIdRegex) {
  const re = new RegExp(text(ticketIdRegex), 'ig');
  return text(textBody).replace(re, ' ').replace(/\s+/g, ' ').trim();
}

function renderBatch(meta, cfg, input) {
  const ticketId = text(input && input.ticketId);
  const customerName = text(input && input.customerName);
  const customerChatId = text(input && input.customerChatId);
  const rawMessages = Array.isArray(input && input.messages) ? input.messages : [];
  const messages = rawMessages.map((x) => text(x).replace(/\s+/g, ' ')).filter(Boolean);

  if (!messages.length) return '';

  const header = fill(text(cfg && cfg.forwardTextPrefixTemplate), {
    TICKETID: ticketId,
    FROM: customerName,
    CHATID: customerChatId,
    COUNT: String(messages.length),
  });

  const lines = messages.map((msg, idx) => `${idx + 1}) ${msg}`);
  const merged = [header].concat(lines).filter(Boolean).join('\n');

  const maxLen = Math.max(1, toInt(cfg && cfg.forwardTextMaxLen, 3500));
  if (merged.length <= maxLen) return merged;
  return merged.slice(0, maxLen);
}

async function sendToCustomer(input) {
  const cfg = input.cfg;
  const meta = input.meta;
  const store = input.store;
  const ticketStoreKey = input.ticketStoreKey;

  const ticketId = parseTicketId(input.ticketId, cfg.ticketIdRegex);
  if (!ticketId) {
    return { ok: 0, code: 'need_ticket' };
  }

  const bodyStripped = stripTicketId(input.body, cfg.ticketIdRegex);
  if (!bodyStripped) {
    return { ok: 0, code: 'need_text' };
  }

  const state = await store.get(ticketStoreKey, { tickets: [] });
  const tickets = Array.isArray(state.tickets) ? state.tickets : [];
  const ticket = tickets.find((x) => text(x.ticketId) === ticketId);

  if (!ticket) {
    return { ok: 0, code: 'ticket_not_found' };
  }

  if (text(ticket.status) === text(cfg.ticketStatusClosed)) {
    return { ok: 0, code: 'ticket_closed' };
  }

  const customerChatId = text(ticket.customerChatId);
  if (!customerChatId) {
    return { ok: 0, code: 'ticket_not_found' };
  }

  let globalConf = {};
  if (typeof meta.loadConfRel === 'function' && text(cfg.globalConfRel)) {
    const loaded = meta.loadConfRel(text(cfg.globalConfRel)) || {};
    globalConf = loaded && loaded.conf && typeof loaded.conf === 'object' ? loaded.conf : {};
  }

  const serviceName = String(globalConf.sendPrefer || '')
    .split(',')
    .map((x) => text(x))
    .filter(Boolean)[0] || '';

  if (!serviceName) {
    return { ok: 0, code: 'send_missing' };
  }

  const send = meta.getService(serviceName);
  if (typeof send !== 'function') {
    return { ok: 0, code: 'send_missing' };
  }

  try {
    await send(customerChatId, bodyStripped, {
      isAuto: 0,
      manualReply: 1,
      bypassRateLimit: 1,
    });
  } catch (e) {
    return { ok: 0, code: 'send_error', error: text(e && e.message ? e.message : e) };
  }

  return { ok: 1, code: 'sent', targetChatId: customerChatId };
}

module.exports = {
  renderBatch,
  sendToCustomer,
};