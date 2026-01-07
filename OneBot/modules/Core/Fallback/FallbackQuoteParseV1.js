'use strict';

/**
 * FallbackQuoteParseV1
 * - Extract ticket ID from Quoted Message or Text.
 * - Supports: [Ticket:ID], Ticket:ID, !r ID, Ticket ID.
 */

const SharedLog = require('../Shared/SharedLogV1');

function _s(v) { return v === null || v === undefined ? '' : String(v); }
function _trim(v) { return _s(v).trim(); }

function _extractTicket(text) {
  const t = _s(text);

  // 1. Bracket: [Ticket: XYZ]
  let m = t.match(/\[\s*Ticket\s*:\s*([A-Za-z0-9]+)\s*\]/i);
  if (m && m[1]) return _trim(m[1]);

  // 2. Label: Ticket: XYZ
  m = t.match(/\bTicket\s*:\s*([A-Za-z0-9]+)\b/i);
  if (m && m[1]) return _trim(m[1]);

  // 3. Command: !r XYZ (at start of text)
  m = t.match(/^!r\s+([A-Za-z0-9]+)/i);
  if (m && m[1]) return _trim(m[1]);

  // 4. Loose: Ticket XYZ
  m = t.match(/\bTicket\s+([A-Za-z0-9]+)\b/i);
  if (m && m[1]) return _trim(m[1]);

  return '';
}

async function parse(meta, cfg, ctx) {
  const log = SharedLog.makeLog(meta, 'FallbackQuoteParseV1');
  const msg = ctx && ctx.message;

  // PRIORITY 1: Check if user typed ticket manually (e.g. !r <ticket> <text>)
  let ticket = _extractTicket(ctx.text);
  if (ticket) {
    // If ticket found in text, we consider the whole text (minus ticket) as the reply?
    // Actually, caller handles text. We just return ticket.
    return { ok: true, ticket, quotedText: '' };
  }

  // PRIORITY 2: Check Quoted Message
  if (!msg || typeof msg.getQuotedMessage !== 'function') {
    return { ok: false, reason: 'noQuotedSupport' };
  }

  let quoted = null;
  try { quoted = await msg.getQuotedMessage(); }
  catch (e) { return { ok: false, reason: 'getQuotedFailed' }; }

  if (!quoted) return { ok: false, reason: 'noQuoted' };

  let quotedText = _s(quoted.body);
  // Check caption if body is empty
  if (!quotedText && quoted._data && quoted._data.caption) {
    quotedText = _s(quoted._data.caption);
  }

  ticket = _extractTicket(quotedText);
  
  if (!ticket) return { ok: false, reason: 'noTicketInQuote', quotedText: _trim(quotedText) };

  return { ok: true, ticket, quotedText: _trim(quotedText) };
}

module.exports = { parse };