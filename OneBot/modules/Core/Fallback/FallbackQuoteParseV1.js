'use strict';

const SharedLog = require('../Shared/SharedLogV1');

function safeStr(x) {
  if (x === undefined || x === null) return '';
  return String(x);
}

function getTextFromQuoted(quotedMsg) {
  if (!quotedMsg) return '';
  if (typeof quotedMsg.body === 'string' && quotedMsg.body) return quotedMsg.body;
  if (typeof quotedMsg.caption === 'string' && quotedMsg.caption) return quotedMsg.caption;
  if (typeof quotedMsg.text === 'string' && quotedMsg.text) return quotedMsg.text;
  return '';
}

function extractTicketFromText(text) {
  if (!text) return '';
  const m = String(text).match(/\b([A-Z]{3}\d{2}[A-Z0-9]{10,})\b/);
  if (m && m[1]) return m[1];
  const m2 = String(text).match(/Ticket:\s*([A-Z0-9]+)/i);
  if (m2 && m2[1]) return m2[1];
  return '';
}

function _getQuotedFromRawData(raw) {
  try {
    const d = raw && raw._data ? raw._data : null;
    const ctx = d && d._data ? d._data : d;
    const ci = ctx && ctx.contextInfo ? ctx.contextInfo : null;
    const qm = ci && ci.quotedMessage ? ci.quotedMessage : null;
    return qm || null;
  } catch (e) {
    return null;
  }
}

async function getQuoted(ctx) {
  const log = SharedLog.create(null, 'FallbackQuoteParseV1');
  const raw = (ctx && (ctx.raw || ctx.message)) ? (ctx.raw || ctx.message) : null;
  if (!raw) return { ok: false, reason: 'noraw' };

  // Most reliable: whatsapp-web.js API
  if (typeof raw.getQuotedMessage === 'function') {
    try {
      const quoted = await raw.getQuotedMessage();
      if (!quoted) return { ok: false, reason: 'noquoted' };
      const qt = getTextFromQuoted(quoted);
      const ticket = extractTicketFromText(qt);
      return {
        ok: true,
        ticket,
        quotedText: qt,
        quotedRaw: quoted
      };
    } catch (e) {
      log.error('getQuotedMessage error err=' + safeStr(e && e.message ? e.message : e));
      // fallback below
    }
  }

  // Fallback: raw internal data
  const q2 = _getQuotedFromRawData(raw);
  if (!q2) return { ok: false, reason: 'noquoted' };

  const qt2 = getTextFromQuoted(q2);
  const ticket2 = extractTicketFromText(qt2);

  return {
    ok: true,
    ticket: ticket2,
    quotedText: qt2,
    quotedRaw: q2
  };
}

module.exports = {
  getQuoted
};
