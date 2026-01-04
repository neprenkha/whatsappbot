'use strict';

// FallbackMediaForwardQueueV1
// Purpose: forward DM media (best effort) with pacing to avoid burst failures.
// Notes:
// - Uses downloadMedia() from whatsapp-web.js if available on ctx.raw.
// - Sends media using first available send service in sendPrefer list (must accept (chatId, content, opts)).

const SafeSend = require('../Shared/SharedSafeSendV1');

function safeStr(v) {
  return String(v || '').trim();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function pickSendFn(meta, cfg) {
  const prefer = (cfg && cfg.sendPrefer) || ['outsend', 'sendout', 'send'];
  const picks = SafeSend.pickSend(meta, prefer);
  if (picks.length > 0) return picks[0].fn;
  const base = meta.getService('send');
  return typeof base === 'function' ? base : null;
}

async function extractMedia(ctx) {
  try {
    if (ctx && ctx.raw && typeof ctx.raw.downloadMedia === 'function') {
      const media = await ctx.raw.downloadMedia();
      if (media) return [media];
    }
  } catch (_) {}
  return [];
}

async function forward(meta, cfg, targetChatId, ctx, captionPrefix) {
  const enabled = Number(cfg && cfg.mediaForwardEnabled) || 0;
  if (!enabled) return { ok: true, sent: 0 };

  const sendFn = pickSendFn(meta, cfg);
  if (!sendFn) return { ok: false, sent: 0 };

  const list = await extractMedia(ctx);
  if (!list.length) return { ok: true, sent: 0 };

  const delayMs = Number(cfg && cfg.dmForwardDelayMs) || 300;
  let sent = 0;

  for (let i = 0; i < list.length; i++) {
    const cap = safeStr(captionPrefix);
    const caption = cap ? `${cap} (${i + 1}/${list.length})` : '';
    try {
      await sendFn(targetChatId, list[i], caption ? { caption } : {});
      sent++;
    } catch (_) {}

    if (i < list.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  return { ok: sent > 0, sent };
}

module.exports = {
  forward,
  extractMedia,
};
