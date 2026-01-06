'use strict';

/*
FallbackReplyTextV1
- Send text replies to customer (DM).
*/

function _stripTicket(text) {
  if (!text) return '';
  // Remove ticket tokens from outgoing customer message
  return String(text)
    .replace(/\b\d{6}T\d{10}\b/g, '')
    .replace(/\b\d{8}[A-Z]{2,3}\d{3,10}\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function sendText(meta, cfg, toChatId, text) {
  const Outbound = meta.getService('outsend') || meta.getService('sendout') || meta.getService('send');
  if (!Outbound || typeof Outbound !== 'function') {
    throw new Error('No text sender service found (outsend/sendout/send)');
  }

  let out = String(text || '');
  if (cfg && cfg.stripTicketInCustomerReply) out = _stripTicket(out);

  if (!out) return { ok: true, skipped: true };

  await Outbound(toChatId, out);
  return { ok: true };
}

module.exports = {
  sendText
};
