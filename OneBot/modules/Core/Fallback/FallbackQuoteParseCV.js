'use strict';

function text(value) {
  return String(value ?? '').trim();
}

function parseTicketId(sourceText, ticketIdRegex) {
  const raw = text(sourceText);
  const expr = text(ticketIdRegex);
  if (!raw || !expr) return '';
  try {
    const re = new RegExp(expr, 'i');
    const m = raw.match(re);
    return m && m[0] ? text(m[0]) : '';
  } catch (_) {
    return '';
  }
}

function pick(obj, path) {
  let cur = obj;
  for (let i = 0; i < path.length; i += 1) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[path[i]];
  }
  return cur;
}

function pushText(out, value) {
  const t = text(value);
  if (!t) return;
  if (!out.includes(t)) out.push(t);
}

function getBodyText(ctx) {
  return text(
    (ctx && ctx.text) ||
    (ctx && ctx.message && (ctx.message.body || ctx.message.caption)) ||
    (ctx && ctx.message && ctx.message._data && (ctx.message._data.body || ctx.message._data.caption)) ||
    (ctx && ctx.raw && ctx.raw._data && (ctx.raw._data.body || ctx.raw._data.caption)) ||
    ''
  );
}

function collectQuotedTextCandidates(ctx) {
  const out = [];

  pushText(out, ctx && ctx.quotedText);

  const msg = ctx && ctx.message && typeof ctx.message === 'object' ? ctx.message : {};
  const raw = ctx && ctx.raw && typeof ctx.raw === 'object' ? ctx.raw : {};
  const msgData = msg && msg._data && typeof msg._data === 'object' ? msg._data : {};
  const rawData = raw && raw._data && typeof raw._data === 'object' ? raw._data : {};

  const quotedSources = [
    ctx && ctx.quotedMsg,
    msg && msg.quotedMsg,
    msgData && msgData.quotedMsg,
    rawData && rawData.quotedMsg,
  ];

  for (const quoted of quotedSources) {
    if (!quoted || typeof quoted !== 'object') continue;
    pushText(out, quoted.body);
    pushText(out, quoted.caption);
    pushText(out, quoted.text);
    pushText(out, quoted.content);
    pushText(out, quoted.conversation);
    pushText(out, pick(quoted, ['extendedTextMessage', 'text']));
    pushText(out, pick(quoted, ['imageMessage', 'caption']));
    pushText(out, pick(quoted, ['videoMessage', 'caption']));
    pushText(out, pick(quoted, ['documentMessage', 'caption']));
    pushText(out, pick(quoted, ['documentWithCaptionMessage', 'message', 'documentMessage', 'caption']));
    pushText(out, pick(quoted, ['ephemeralMessage', 'message', 'conversation']));
    pushText(out, pick(quoted, ['ephemeralMessage', 'message', 'extendedTextMessage', 'text']));
    pushText(out, pick(quoted, ['ephemeralMessage', 'message', 'imageMessage', 'caption']));
    pushText(out, pick(quoted, ['ephemeralMessage', 'message', 'videoMessage', 'caption']));
    pushText(out, pick(quoted, ['ephemeralMessage', 'message', 'documentMessage', 'caption']));
    pushText(out, pick(quoted, ['viewOnceMessage', 'message', 'conversation']));
    pushText(out, pick(quoted, ['viewOnceMessage', 'message', 'extendedTextMessage', 'text']));
    pushText(out, pick(quoted, ['viewOnceMessage', 'message', 'imageMessage', 'caption']));
    pushText(out, pick(quoted, ['viewOnceMessage', 'message', 'videoMessage', 'caption']));
    pushText(out, pick(quoted, ['viewOnceMessage', 'message', 'documentMessage', 'caption']));
  }

  const containers = [msgData, rawData, msg, raw];
  for (const src of containers) {
    if (!src || typeof src !== 'object') continue;
    const contextInfo = pick(src, ['contextInfo']) || pick(src, ['messageContextInfo']) || {};
    const quotedMessage = pick(contextInfo, ['quotedMessage']) || {};

    pushText(out, pick(quotedMessage, ['conversation']));
    pushText(out, pick(quotedMessage, ['extendedTextMessage', 'text']));
    pushText(out, pick(quotedMessage, ['imageMessage', 'caption']));
    pushText(out, pick(quotedMessage, ['videoMessage', 'caption']));
    pushText(out, pick(quotedMessage, ['documentMessage', 'caption']));
    pushText(out, pick(quotedMessage, ['documentWithCaptionMessage', 'message', 'documentMessage', 'caption']));
    pushText(out, pick(quotedMessage, ['ephemeralMessage', 'message', 'conversation']));
    pushText(out, pick(quotedMessage, ['ephemeralMessage', 'message', 'extendedTextMessage', 'text']));
    pushText(out, pick(quotedMessage, ['ephemeralMessage', 'message', 'imageMessage', 'caption']));
    pushText(out, pick(quotedMessage, ['ephemeralMessage', 'message', 'videoMessage', 'caption']));
    pushText(out, pick(quotedMessage, ['ephemeralMessage', 'message', 'documentMessage', 'caption']));
    pushText(out, pick(quotedMessage, ['viewOnceMessage', 'message', 'conversation']));
    pushText(out, pick(quotedMessage, ['viewOnceMessage', 'message', 'extendedTextMessage', 'text']));
    pushText(out, pick(quotedMessage, ['viewOnceMessage', 'message', 'imageMessage', 'caption']));
    pushText(out, pick(quotedMessage, ['viewOnceMessage', 'message', 'videoMessage', 'caption']));
    pushText(out, pick(quotedMessage, ['viewOnceMessage', 'message', 'documentMessage', 'caption']));
  }

  return out;
}

function hasQuotedMarkers(ctx) {
  const msg = ctx && ctx.message && typeof ctx.message === 'object' ? ctx.message : {};
  const raw = ctx && ctx.raw && typeof ctx.raw === 'object' ? ctx.raw : {};
  const msgData = msg && msg._data && typeof msg._data === 'object' ? msg._data : {};
  const rawData = raw && raw._data && typeof raw._data === 'object' ? raw._data : {};

  if (text(ctx && ctx.quotedText)) return true;
  if (ctx && ctx.quotedMsg && typeof ctx.quotedMsg === 'object') return true;
  if (msg && msg.hasQuotedMsg) return true;
  if (msgData && (msgData.quotedMsg || msgData.quotedStanzaID || msgData.quotedParticipant)) return true;
  if (rawData && (rawData.quotedMsg || rawData.quotedStanzaID || rawData.quotedParticipant)) return true;

  const containers = [msgData, rawData, msg, raw];
  for (const src of containers) {
    if (!src || typeof src !== 'object') continue;
    const contextInfo = pick(src, ['contextInfo']) || pick(src, ['messageContextInfo']) || {};
    if (
      pick(contextInfo, ['stanzaId']) ||
      pick(contextInfo, ['quotedStanzaID']) ||
      pick(contextInfo, ['participant']) ||
      pick(contextInfo, ['quotedParticipant']) ||
      pick(contextInfo, ['quotedMessage'])
    ) {
      return true;
    }
  }

  return false;
}

function parse(ctx, cfg) {
  const quotedTexts = collectQuotedTextCandidates(ctx);
  const quotedText = quotedTexts.join('\n');
  const quotedDetected = hasQuotedMarkers(ctx) || !!quotedText;
  if (!quotedDetected) return null;

  const ticketId = parseTicketId(quotedText, cfg.ticketIdRegex);
  const body = getBodyText(ctx);

  return {
    source: 'quote',
    quotedDetected: true,
    quotedText,
    ticketId,
    body,
  };
}

module.exports = {
  parse,
  parseTicketId,
};