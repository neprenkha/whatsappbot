'use strict';

const TICKET_RE = /\b(\d{6}T\d{10}|\d{4}T\d{10})\b/;

function s(v) {
  return String(v || '').trim();
}

function getChatId(ctx) {
  return s(ctx?.chatId || ctx?.raw?.from || ctx?.raw?._data?.from);
}

function isGroup(ctx) {
  return !!(ctx?.isGroup || ctx?.raw?.isGroup || ctx?.raw?._data?.isGroup);
}

function getSenderId(ctx) {
  return s(ctx?.sender?.id || ctx?.raw?.author || ctx?.raw?._data?.author || ctx?.raw?.from || ctx?.raw?._data?.from);
}

function getSenderName(ctx) {
  return s(ctx?.sender?.name || ctx?.raw?._data?.notifyName || ctx?.raw?.notifyName);
}

function getText(ctx) {
  return s(ctx?.text || ctx?.raw?.body || ctx?.raw?._data?.body);
}

/**
 * getQuotedText(...)
 * Accepts:
 *  - getQuotedText(ctx)
 *  - getQuotedText(meta, ctx)  // tolerated for older callers
 */
function getQuotedText(a, b) {
  const ctx = b || a;
  if (!ctx) return '';
  try {
    const raw = ctx.raw || ctx;
    // whatsapp-web.js shape:
    // raw.hasQuotedMsg + raw.getQuotedMessage()
    if (raw && raw.hasQuotedMsg && typeof raw.getQuotedMessage === 'function') {
      // NOTE: This is async on whatsapp-web.js, but our callers use await anyway.
      // If it returns a promise, caller should await the promise.
      // Here we just return empty (sync) if promise not awaited.
    }
  } catch (_) {}

  // Our connector already tries to provide ctx.quotedText for convenience.
  const qt = s(ctx?.quotedText || ctx?.raw?.quotedText || ctx?.raw?._data?.quotedText);
  if (qt) return qt;

  // Fallback: if we have quotedTextBody-like fields
  const q2 = s(ctx?.raw?._data?.quotedMsg?.body || ctx?.raw?.quotedMsg?.body);
  return q2;
}

function extractTicket(text) {
  const m = s(text).match(TICKET_RE);
  return m ? m[0] : '';
}

/**
 * getPhoneFromWid(id)
 * Extract digits from:
 *  - lid:123456
 *  - 123456@lid
 *  - LID:123456
 *  - 60133335545@c.us
 */
function getPhoneFromWid(id) {
  const t = s(id);
  if (!t) return '';
  const m1 = /^lid:(\d+)$/i.exec(t);
  if (m1) return m1[1];
  const m2 = /^(\d+)@lid$/i.exec(t);
  if (m2) return m2[1];
  const m3 = /^(\d+)@c\.us$/i.exec(t);
  if (m3) return m3[1];
  const digits = t.replace(/\D/g, '');
  return digits || '';
}

module.exports = {
  getChatId,
  isGroup,
  getSenderId,
  getSenderName,
  getText,
  getQuotedText,
  extractTicket,
  getPhoneFromWid,
};
