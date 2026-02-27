'use strict';

const SafeSend = require('../Shared/SharedSafeSendV1');

function toBool(v, dflt) {
  if (v === undefined || v === null || v === '') return !!dflt;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return !!dflt;
}

async function handle(meta, cfg, toChatId, text) {
  const t = String(text || '').trim();
  if (!t) return { ok: true, sent: 0 };

  const c = cfg || {};
  const opts = {
    manualReply: toBool(c.replyManualReply, true) ? 1 : 0,
    allowOutsideWindow: toBool(c.replyAllowOutsideWindow, true) ? 1 : 0,
    bypassRateLimit: toBool(c.replyBypassRateLimit, false) ? 1 : 0,
  };

  await SafeSend.send(meta, c, toChatId, t, opts);
  return { ok: true, sent: 1 };
}

module.exports = { handle };