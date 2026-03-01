'use strict';

function text(value) {
  return String(value ?? '').trim();
}

function parseTicketId(sourceText, ticketIdRegex) {
  const raw = text(sourceText);
  if (!raw) return '';
  const re = new RegExp(text(ticketIdRegex), 'i');
  const m = raw.match(re);
  return m && m[0] ? text(m[0]) : '';
}

function getQuotedText(ctx) {
  const fromCtx = text(ctx && ctx.quotedText);
  if (fromCtx) return fromCtx;

  const raw = ctx && ctx.raw ? ctx.raw : {};
  const data = raw && raw._data ? raw._data : {};
  const quoted = data && data.quotedMsg ? data.quotedMsg : {};
  const body = text(quoted.body);
  if (body) return body;
  return text(quoted.caption);
}

function getBodyText(ctx) {
  return text(
    (ctx && ctx.text) ||
    (ctx && ctx.message && (ctx.message.body || ctx.message.caption)) ||
    (ctx && ctx.raw && ctx.raw._data && (ctx.raw._data.body || ctx.raw._data.caption)) ||
    ''
  );
}

function parse(ctx, cfg) {
  const quotedText = getQuotedText(ctx);
  const ticketId = parseTicketId(quotedText, cfg.ticketIdRegex);
  const body = getBodyText(ctx);
  return {
    source: 'quote',
    ticketId,
    body,
  };
}

module.exports = {
  parse,
  parseTicketId,
};