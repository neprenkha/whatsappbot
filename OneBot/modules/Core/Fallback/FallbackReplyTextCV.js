'use strict';

function text(value) {
  return String(value ?? '').trim();
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

function bugEnabled(value) {
  const v = text(value).toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
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

  try {
    const state2 = await store.get(ticketStoreKey, { tickets: [] });
    const tickets2 = Array.isArray(state2.tickets) ? state2.tickets : [];
    const ticket2 = tickets2.find((x) => text(x.ticketId) === ticketId);
    if (ticket2) {
      ticket2.lastStaffReplyAt = Date.now();
      ticket2.awaitingStaff = 0;
      await store.set(ticketStoreKey, { tickets: tickets2 });
    }
  } catch (e) {
    if (bugEnabled(cfg.bugLog) && meta && typeof meta.log === 'function') {
      meta.log('FallbackReplyTextCV', 'bug ticket_update_failed err=' + text(e && e.message ? e.message : e));
    }
  }

  return { ok: 1, code: 'sent', targetChatId: customerChatId };
}

module.exports = {
  sendToCustomer,
};