'use strict';

/**
 * SharedQuoteUtilV1
 * Small helper for building a safe, readable quote-preview text.
 * Used by Fallback to display quoted context in the Control Group.
 *
 * Notes:
 * - ASCII only (avoid emoji to prevent encoding issues on some consoles).
 * - Never throw (always fail-safe).
 */

function clipText(s, maxLen) {
  try {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    if (t.length <= maxLen) return t;
    return t.slice(0, Math.max(0, maxLen - 3)).trimEnd() + '...';
  } catch (_) {
    return '';
  }
}

function safeTypeLabel(type) {
  const t = String(type || '').trim().toLowerCase();
  if (!t) return 'message';
  return t;
}

/**
 * buildQuotePreview(msg) -> string
 * Returns a short text block describing the quoted message, or '' if none.
 *
 * Expected WhatsApp Web JS message shape:
 * - msg.hasQuotedMsg (boolean)
 * - msg.getQuotedMessage() (async) -> quotedMsg
 * - quotedMsg.body / quotedMsg.type / quotedMsg.from / quotedMsg.author / quotedMsg.fromMe
 */
async function buildQuotePreview(msg) {
  try {
    if (!msg) return '';
    if (!msg.hasQuotedMsg) return '';
    if (typeof msg.getQuotedMessage !== 'function') return '';

    const q = await msg.getQuotedMessage().catch(() => null);
    if (!q) return '';

    const qType = safeTypeLabel(q.type);
    const qBody = clipText(q.body, 220);

    // Identify who said the quoted message (best-effort).
    let who = '';
    if (q.fromMe) who = 'me';
    else if (q.author) who = String(q.author);
    else if (q.from) who = String(q.from);

    const header = who ? `[QUOTE from ${who}]` : '[QUOTE]';
    const body = qBody ? qBody : `[${qType}]`;

    return `\n${header}\n> ${body}\n`;
  } catch (_) {
    return '';
  }
}

module.exports = {
  buildQuotePreview,
};
