'use strict';

const SafeSend = require('../Shared/SharedSafeSendV1');

async function handle(meta, cfg, toChatId, text) {
  const t = String(text || '').trim();
  if (!t) return { ok: true, sent: 0 };

  await SafeSend.send(meta, cfg, toChatId, t, {});
  return { ok: true, sent: 1 };
}

module.exports = { handle };
