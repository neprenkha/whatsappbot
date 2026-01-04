'use strict';

// FallbackForwardingV1
// Purpose: forward inbound DM to control group with ticket card + optional media forwarding.

const SafeSend = require('../Shared/SharedSafeSendV1');
const MediaQ = require('./FallbackMediaForwardQueueV1');

function safeStr(v) {
  return String(v || '').trim();
}

async function forward(meta, cfg, targetGroupId, cardText, ctx, ticketId) {
  const gid = safeStr(targetGroupId);
  if (!gid) return { ok: false, reason: 'nogroup' };

  const textRes = await SafeSend.sendOrQueue(meta, cfg, gid, safeStr(cardText), {});
  const prefix = ticketId ? `🎫 Ticket: ${ticketId}` : '';
  const mediaRes = await MediaQ.forward(meta, cfg, gid, ctx, prefix);

  return { ok: !!textRes.ok, text: textRes, media: mediaRes };
}

module.exports = {
  forward,
};
